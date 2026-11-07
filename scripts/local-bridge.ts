/** Local integration provider only. This file and execution fixtures are excluded from the package. */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { NangoGithubRepositories } from "../src/repositories.js";
import { ProjectCoordinators } from "../src/hosted.js";
import type { ChiefConfig } from "../src/contracts.js";
import { hash } from "../src/contracts.js";
import { ControlPlaneClient } from "../src/control-plane.js";
import { RelayClient } from "../src/relay.js";
import { JevClassifier } from "../src/jev.js";
import { readAssignment } from "../src/worker-protocol.js";

const exec = promisify(execFile);
export async function createChiefBackend(options: { dataDir: string }) {
  const dir = options.dataDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "local-provider.key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const key = readFileSync(keyPath);
  const token = (chief: string, actor: string) =>
    createHmac("sha256", key).update(`${chief}:${actor}`).digest("hex");
  const dbPath = join(dir, "local-relay.db");
  if (!existsSync(dbPath)) closeSync(openSync(dbPath, "wx", 0o600));
  chmodSync(dbPath, 0o600);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chief TEXT NOT NULL, sender TEXT NOT NULL, message_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, chief TEXT NOT NULL, body TEXT NOT NULL);`);
  const principals = new Map<string, { config: ChiefConfig; actor: string }>();
  const workers = new Map<string, Promise<void>>();
  const baseUrl = "http://127.0.0.1:8811";
  const pathFor = (config: ChiefConfig) => join(dir, config.chiefId);
  function prepare(config: ChiefConfig) {
    for (const actor of ["chief", "worker", "classifier", "control"])
      principals.set(token(config.chiefId, actor), { config, actor });
    const project = pathFor(config);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, "config.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    if (!existsSync(join(project, "sum.mjs"))) {
      writeFileSync(
        join(project, "sum.mjs"),
        "export const sum = (a, b) => a - b;\n",
      );
      writeFileSync(
        join(project, "sum.test.mjs"),
        `import { strict as assert } from 'node:assert'; import { test } from 'node:test';
import { sum } from './sum.mjs'; test('addition handles positive and negative inputs', () => { assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1); });\n`,
      );
      const common = {
        sourceId: "project-sessions-v1",
        version: "1",
        organizationId: config.organizationId,
        workspaceId: config.workspaceId,
        projectId: config.projectId,
        repository: config.repositories[0],
        workKey: "local-validation-addition",
        resourceKeys: ["local-validation:sum.mjs"],
        observedAt: Date.now(),
        summary:
          "The isolated validation project has a failing addition test. Two sessions describe the same blocked objective.",
        references: ["https://github.com/AgentWorkforce/relay-chief"],
      };
      writeFileSync(
        join(project, "evidence.json"),
        JSON.stringify([
          { ...common, sessionId: "validation-session-1" },
          { ...common, sessionId: "validation-session-2" },
        ]),
        { mode: 0o600 },
      );
    }
  }
  const server = createServer(async (request, response) => {
    const json = (data: unknown, envelope = true, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(envelope ? { ok: true, data } : data));
    };
    try {
      const url = new URL(request.url!, baseUrl);
      if (url.pathname === "/healthz") {
        json({ status: "local-provider" });
        return;
      }
      const principal = principals.get(
        (request.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      if (!principal) {
        json({ error: "unauthorized" }, false, 401);
        return;
      }
      const { config, actor } = principal;
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 1_048_576) throw new Error("body_too_large");
        buffers.push(Buffer.from(part));
      }
      const raw = Buffer.concat(buffers).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      if (url.pathname === "/v1/systemone" && actor === "classifier") {
        json(
          {
            answers: {
              classification: {
                type: "choice",
                choice: "blocked",
                confidence: 0.99,
              },
            },
          },
          false,
        );
        return;
      }
      if (
        actor === "control" &&
        url.pathname.startsWith(`/chief/v1/projects/${config.projectId}/`)
      ) {
        if (url.pathname.endsWith("/evidence")) {
          json(
            {
              cursor: "validation-v1",
              evidence:
                url.searchParams.get("cursor") === "validation-v1"
                  ? []
                  : JSON.parse(
                      readFileSync(
                        join(pathFor(config), "evidence.json"),
                        "utf8",
                      ),
                    ),
            },
            false,
          );
          return;
        }
        if (url.pathname.endsWith("/verification")) {
          const id = url.pathname.split("/").at(-2)!;
          const row = db
            .prepare("SELECT body FROM assignments WHERE id=? AND chief=?")
            .get(id, config.chiefId) as { body: string } | undefined;
          if (!row) {
            json({ error: "not_found" }, false, 404);
            return;
          }
          const data = JSON.parse(row.body);
          let ok = false;
          try {
            await exec(
              process.execPath,
              ["--test", join(pathFor(config), "sum.test.mjs")],
              { timeout: 10_000 },
            );
            ok = true;
          } catch {
            /* check remains failed */
          }
          json(
            {
              taskId: id,
              assignmentDigest: data.assignment_digest,
              sequence: Number(url.searchParams.get("sequence")),
              ok,
              checks: ok
                ? [
                    `node-test@${hash(readFileSync(join(pathFor(config), "sum.mjs"), "utf8"))}`,
                  ]
                : [],
            },
            false,
          );
          return;
        }
      }
      if (url.pathname === "/v1/agent" && actor === "chief") {
        json({ id: config.relayCallerId, workspace_id: config.workspaceId });
        return;
      }
      if (url.pathname === "/v1/dm/conversations" && actor === "chief") {
        const count = db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE chief=?")
          .get(config.chiefId) as { n: number };
        json(
          count.n
            ? [
                {
                  id: config.chiefId,
                  type: "1:1",
                  participants: [
                    { agent_id: config.relayCallerId },
                    { agent_id: config.workers[0]!.agentId },
                  ],
                },
              ]
            : [],
        );
        return;
      }
      if (
        url.pathname === `/v1/dm/${config.chiefId}/messages` &&
        actor === "chief"
      ) {
        const rows = db
          .prepare(
            "SELECT id, sender, body FROM messages WHERE chief=? AND id>? AND id<? ORDER BY id DESC LIMIT 100",
          )
          .all(
            config.chiefId,
            url.searchParams.get("after") ?? "",
            url.searchParams.get("before") ?? "z",
          ) as { id: string; sender: string; body: string }[];
        json(
          rows.map((row) => ({
            id: row.id,
            agent_id: row.sender,
            metadata: JSON.parse(row.body).data,
          })),
        );
        return;
      }
      if (
        url.pathname === "/v1/dm" &&
        request.method === "POST" &&
        ["chief", "worker"].includes(actor)
      ) {
        const messageKey = `${config.chiefId}:${actor}:${String(request.headers["idempotency-key"])}`;
        const previous = db
          .prepare("SELECT * FROM messages WHERE message_key=?")
          .get(messageKey) as { id: string; body: string } | undefined;
        if (previous && previous.body !== raw) {
          json({ error: "idempotency_conflict" }, false, 409);
          return;
        }
        if (actor === "chief") {
          readAssignment(
            {
              workspaceId: config.workspaceId,
              senderAgentId: config.relayCallerId,
              recipientAgentId: config.workers[0]!.agentId,
              recipientAddress: config.workers[0]!.address,
            },
            body.data,
            {
              chiefAgentId: config.relayCallerId,
              chiefId: config.chiefId,
              organizationId: config.organizationId,
              projectId: config.projectId,
              repositories: config.repositories,
              actions: config.policy.allowedActions,
              maxReservationMicros: config.policy.taskReservationMicros,
              maxEvidenceAgeMs: config.policy.maxEvidenceAgeMs,
            },
          );
        }
        const sender =
          actor === "chief" ? config.relayCallerId : config.workers[0]!.agentId;
        const count = db
          .prepare("SELECT COUNT(*) AS n FROM messages")
          .get() as { n: number };
        const id =
          previous?.id ??
          String(1_000_000_000_000_000_000n + BigInt(count.n + 1));
        if (!previous)
          db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)").run(
            id,
            config.chiefId,
            sender,
            messageKey,
            raw,
          );
        if (actor === "chief" && !previous) {
          const taskId = body.data.chief_assignment.taskId as string;
          db.prepare("INSERT INTO assignments VALUES (?, ?, ?)").run(
            taskId,
            config.chiefId,
            JSON.stringify(body.data),
          );
          const assignmentPath = join(pathFor(config), "assignment.json");
          writeFileSync(assignmentPath, JSON.stringify(body.data), {
            mode: 0o600,
          });
          const workerScript = fileURLToPath(
            new URL("../test/fixtures/worker.ts", import.meta.url),
          );
          const pending = exec(
            process.execPath,
            [
              "--import",
              "tsx",
              workerScript,
              assignmentPath,
              pathFor(config),
              baseUrl,
              join(pathFor(config), "config.json"),
            ],
            {
              cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
              env: {
                ...process.env,
                LOCAL_WORKER_TOKEN: token(config.chiefId, "worker"),
                LOCAL_WORKER_PACE: "1",
              },
              timeout: 20_000,
            },
          )
            .then(() => {})
            .catch(() => {})
            .finally(() => workers.delete(config.chiefId));
          workers.set(config.chiefId, pending);
        }
        json({
          conversation_id: config.chiefId,
          message: { id, agent_id: sender },
          delivery: null,
        });
        return;
      }
      json({ error: "not_found" }, false, 404);
    } catch {
      if (!response.headersSent)
        json({ error: "local_provider_failed" }, false, 503);
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8811, "127.0.0.1", resolve);
  });
  const backend = new ProjectCoordinators({
    dataDir: join(dir, "chiefs"),
    // Explicit local provider fixture; no customer GitHub/Nango credentials or calls.
    repositories: new NangoGithubRepositories({
      binding: async () => ({
        connectionId: "local-app",
        providerConfigKey: "github-relay",
      }),
      nango: {
        get: async () => ({
          data: {
            total_count: 4,
            repositories: [
              {
                id: 1001,
                full_name: "AgentWorkforce/relay-chief",
                private: true,
              },
              {
                id: 1002,
                full_name: "AgentWorkforce/relay-app",
                private: true,
              },
              {
                id: 1003,
                full_name: "AgentWorkforce/relaycontrol",
                private: true,
              },
              { id: 1004, full_name: "AgentWorkforce/flows", private: false },
            ],
          },
        }),
      },
    }),
    localRuntime: {
      identities: (_, id) => ({
        relayCallerId: `${id}-lead`,
        workers: [
          {
            agentId: `${id}-worker`,
            address: `worker-${id}@local`,
            actions: ["investigate", "coordinate", "unblock"],
          },
        ],
      }),
      connect: async (config) => {
        prepare(config);
        const relay = new RelayClient({
          baseUrl,
          token: token(config.chiefId, "chief"),
        });
        const plane = new ControlPlaneClient({
          baseUrl,
          token: token(config.chiefId, "control"),
          config,
        });
        return {
          relay,
          verifier: plane,
          source: plane,
          classifier: new JevClassifier({
            token: token(config.chiefId, "classifier"),
            fetch: (url, init) => {
              if (String(url) !== "https://api.typesafe.ai/v1/systemone")
                throw new Error("classifier_endpoint_invalid");
              return fetch(new URL("/v1/systemone", baseUrl), init);
            },
          }),
          reconcile: async (chief) => {
            const running = workers.get(config.chiefId);
            if (running) {
              let done = false;
              void running.finally(() => {
                done = true;
              });
              while (!done) {
                await relay.poll(chief);
                await delay(250);
              }
            }
            await relay.poll(chief);
          },
        };
      },
    },
  });
  return backend;
}
