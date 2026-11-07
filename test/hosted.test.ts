import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProjectCoordinators,
  type ProjectRuntimeFactory,
} from "../src/hosted.js";
import { evidence } from "./helpers.js";

const repositories = {
  list: async () => ({
    connected: true,
    repositories: [
      { id: "1", fullName: "acme/project", private: true },
      { id: "2", fullName: "acme/backend", private: false },
      { id: "0", fullName: "acme/new", private: true },
    ],
  }),
};
const context = { organizationId: "org-1", workspaceId: "workspace-1" };
const input = () => ({
  requestId: randomUUID(),
  repositoryIds: ["1"],
  region: "us-east-1",
  budgetDollars: 10,
  maxConcurrentTasks: 2,
  allowedActions: ["investigate", "coordinate", "unblock"],
});

test("workspace setup is durable, scoped and idempotent; managed mode never starts infrastructure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-setup-"));
  let backend = new ProjectCoordinators({ dataDir: dir, repositories });
  try {
    const setup = input();
    const created = await backend.create(context, setup);
    assert.equal(created.status, "awaiting_approval");
    assert.equal(created.mode, "plan_only");
    assert.equal((await backend.create(context, setup)).id, created.id);
    await assert.rejects(
      backend.create(context, { ...setup, budgetDollars: 20 }),
      /already used/,
    );
    await assert.rejects(
      backend.create(context, { ...setup, requestId: randomUUID() }),
      /already has a chief/,
    );
    await assert.rejects(
      backend.scan(context, created.id),
      /Finish runtime setup/,
    );
    assert.throws(
      () => backend.get({ ...context, workspaceId: "other" }, created.id),
      /not found/,
    );
    assert.equal(
      backend.list({ ...context, organizationId: "other" }).chiefs.length,
      0,
    );
    await backend.close();
    backend = new ProjectCoordinators({ dataDir: dir, repositories });
    assert.equal(backend.get(context, created.id).status, "awaiting_approval");
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project setup connects a local runtime; scanning deduplicates and verifies the delegated result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-hosted-"));
  let sends = 0;
  const factory: ProjectRuntimeFactory = {
    identities: () => ({
      relayCallerId: "chief-agent",
      workers: [
        {
          agentId: "worker-agent",
          address: "worker@host",
          actions: ["unblock"],
        },
      ],
    }),
    connect: async (config) => ({
      classifier: {
        classify: async () => ({ kind: "blocked", confidence: 1 }),
      },
      relay: {
        identity: async () => ({
          origin: "https://relay.test",
          workspaceId: config.workspaceId,
          callerId: config.relayCallerId,
        }),
        send: async () => {
          sends++;
          return { messageId: "message-1" };
        },
      },
      verifier: {
        verify: async () => ({
          ok: true,
          checks: ["authoritative-check@revision"],
        }),
      },
      source: {
        id: "project-sessions-v1",
        read: async (cursor) => ({
          cursor: "1",
          evidence: cursor
            ? []
            : [
                evidence({
                  projectId: config.projectId,
                  observedAt: Date.now(),
                }),
                evidence({
                  projectId: config.projectId,
                  sessionId: "second",
                  observedAt: Date.now(),
                }),
              ],
        }),
      },
      reconcile: async (chief) => {
        for (const task of chief.ledger.tasks())
          if (task.status === "delivered")
            await chief.receive({
              workspaceId: config.workspaceId,
              agentId: "worker-agent",
              report: {
                protocol: "relay-chief.report.v1",
                taskId: task.id,
                assignmentDigest: task.digest,
                sequence: 1,
                state: "completed",
                artifactRefs: [],
              },
            });
      },
    }),
  };
  const backend = new ProjectCoordinators({
    dataDir: dir,
    localRuntime: factory,
    repositories,
  });
  try {
    const created = await backend.create(context, input());
    await backend.settled();
    assert.equal(backend.get(context, created.id).status, "ready");
    await backend.scan(context, created.id);
    await assert.rejects(backend.scan(context, created.id), /already running/);
    await backend.settled();
    const result = backend.get(context, created.id);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.status, "completed");
    assert.equal(result.accounting.committedReservationMicros, 1_000_000);
    assert.ok(
      result.decisions.some((decision) => decision.outcome === "duplicate"),
    );
    await backend.scan(context, created.id);
    await backend.settled();
    assert.equal(sends, 1);
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-repository setup validates current App access and claims the full scope atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-repositories-"));
  let accessible = true;
  let backend = new ProjectCoordinators({
    dataDir: dir,
    repositories: {
      list: async () =>
        accessible
          ? repositories.list()
          : { connected: true, repositories: [] },
    },
  });
  try {
    await assert.rejects(
      backend.create(context, { ...input(), repositoryIds: ["999"] }),
      { code: "repository_access_changed" },
    );
    assert.equal(backend.list(context).chiefs.length, 0);
    const setup = { ...input(), repositoryIds: ["2", "1", "2"] };
    const results = await Promise.all([
      backend.create(context, setup),
      backend.create(context, setup),
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.deepEqual(results[0].repositories, ["acme/backend", "acme/project"]);
    assert.equal(results[0].name, "acme · 2 repositories");
    await assert.rejects(
      backend.create(context, { ...input(), repositoryIds: ["2"] }),
      { code: "project_already_configured" },
    );
    assert.equal(backend.list(context).chiefs.length, 1);
    await backend.close();
    backend = new ProjectCoordinators({
      dataDir: dir,
      repositories: {
        list: async () =>
          accessible
            ? repositories.list()
            : { connected: true, repositories: [] },
      },
    });
    assert.deepEqual(backend.get(context, results[0].id).repositories, [
      "acme/backend",
      "acme/project",
    ]);
    await assert.rejects(
      backend.create(context, { ...input(), repositoryIds: ["0", "2"] }),
      { code: "project_already_configured" },
    );
    const separate = await backend.create(context, {
      ...input(),
      repositoryIds: ["0"],
    });
    assert.equal(separate.name, "new");
    // A copied browser selection cannot be used after access is removed, or in another workspace.
    accessible = false;
    await assert.rejects(
      backend.create({ ...context, workspaceId: "other" }, setup),
      { code: "repository_access_changed" },
    );
    await assert.rejects(
      backend.create(context, { ...input(), repository: "forged/repository" }),
      { code: "invalid_setup" },
    );
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository rename retains its immutable ID claim; disconnected discovery fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-repository-rename-"));
  let fullName = "acme/project";
  let connected = true;
  const backend = new ProjectCoordinators({
    dataDir: dir,
    repositories: {
      list: async () => ({
        connected,
        repositories: [{ id: "1", fullName, private: true }],
      }),
    },
  });
  try {
    await backend.create(context, input());
    fullName = "acme/renamed";
    await assert.rejects(backend.create(context, input()), {
      code: "project_already_configured",
    });
    connected = false;
    await assert.rejects(
      backend.create({ ...context, workspaceId: "other" }, input()),
      { code: "github_disconnected" },
    );
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
