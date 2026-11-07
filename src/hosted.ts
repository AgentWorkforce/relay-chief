import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Chief } from "./chief.js";
import type {
  ChiefConfig,
  Classifier,
  CompletionVerifier,
  EvidenceSource,
  RelayTransport,
} from "./contracts.js";
import { actionSchema, canonical, hash } from "./contracts.js";
import { Ledger } from "./ledger.js";
import type { RepositorySource } from "./repositories.js";
import { provisionPlan } from "./provisioning.js";

export interface WorkspaceContext {
  organizationId: string;
  workspaceId: string;
}
export const projectSetupSchema = z.strictObject({
  requestId: z.string().uuid(),
  repositoryIds: z
    .array(z.string().regex(/^[0-9]+$/))
    .min(1)
    .max(100)
    .transform((ids) => [...new Set(ids)].sort()),
  region: z.enum(["us-east-1", "us-west-2", "eu-west-1"]),
  budgetDollars: z.number().min(1).max(10_000),
  maxConcurrentTasks: z.number().int().min(1).max(10),
  allowedActions: z.array(actionSchema).min(1).max(3),
});
export interface ProjectRuntime {
  classifier: Classifier;
  relay: RelayTransport;
  verifier: CompletionVerifier;
  source: EvidenceSource;
  reconcile?: (chief: Chief) => Promise<void>;
}
export interface ProjectRuntimeFactory {
  identities(
    context: WorkspaceContext,
    chiefId: string,
  ): Pick<ChiefConfig, "relayCallerId" | "workers">;
  connect(config: ChiefConfig): Promise<ProjectRuntime>;
}
export class SetupError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
type SetupRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  repository: string;
  request_id: string;
  digest: string;
  config: string;
  plan: string;
  state: string;
  scan_state: string;
  created_at: string;
  last_scan: string | null;
};

/** Single-host hosted adapter. All runtime behavior stays in relay-chief; auth stays in the product gateway. */
export class ProjectCoordinators {
  private registry: DatabaseSync;
  private directory: string;
  private runtime?: ProjectRuntimeFactory;
  private repositorySource?: RepositorySource;
  private jobs = new Map<string, Promise<void>>();
  readonly mode: "local" | "plan_only";
  constructor(options: {
    dataDir: string;
    localRuntime?: ProjectRuntimeFactory;
    repositories?: RepositorySource;
  }) {
    this.directory = options.dataDir;
    this.runtime = options.localRuntime;
    this.repositorySource = options.repositories;
    this.mode = options.localRuntime ? "local" : "plan_only";
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "projects.db");
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    chmodSync(path, 0o600);
    this.registry = new DatabaseSync(path);
    this.registry
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        name TEXT NOT NULL, repository TEXT NOT NULL, request_id TEXT NOT NULL,
        digest TEXT NOT NULL, config TEXT NOT NULL, plan TEXT NOT NULL,
        state TEXT NOT NULL, scan_state TEXT NOT NULL, created_at TEXT NOT NULL, last_scan TEXT,
        UNIQUE(workspace_id, repository), UNIQUE(workspace_id, request_id)
      );`);
    this.registry.exec(`CREATE TABLE IF NOT EXISTS project_repositories (
      organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, repository TEXT NOT NULL,
      chief_id TEXT NOT NULL, UNIQUE(workspace_id, repository));
      CREATE TABLE IF NOT EXISTS project_github_repositories (
        workspace_id TEXT NOT NULL, repository_id TEXT NOT NULL, chief_id TEXT NOT NULL,
        UNIQUE(workspace_id, repository_id));`);
    const saved = this.registry
      .prepare("SELECT * FROM projects")
      .all() as SetupRow[];
    for (const row of saved) {
      const config = JSON.parse(row.config) as ChiefConfig;
      for (const repository of config.repositories)
        this.registry
          .prepare(
            "INSERT OR IGNORE INTO project_repositories VALUES (?, ?, ?, ?)",
          )
          .run(
            row.organization_id,
            row.workspace_id,
            repository.toLowerCase(),
            row.id,
          );
    }
    // Interrupted setup/scan remains explicit. No dispatch is retried on restart.
    this.registry.exec(
      "UPDATE projects SET scan_state='interrupted' WHERE scan_state='running'; UPDATE projects SET state='interrupted' WHERE state='preparing';",
    );
  }
  private row(context: WorkspaceContext, id: string): SetupRow {
    const row = this.registry
      .prepare(
        "SELECT * FROM projects WHERE id=? AND organization_id=? AND workspace_id=?",
      )
      .get(id, context.organizationId, context.workspaceId) as
      SetupRow | undefined;
    if (!row)
      throw new SetupError(
        404,
        "chief_not_found",
        "Chief not found in this workspace.",
      );
    return row;
  }
  list(context: WorkspaceContext) {
    const rows = this.registry
      .prepare(
        "SELECT * FROM projects WHERE organization_id=? AND workspace_id=? ORDER BY created_at DESC",
      )
      .all(context.organizationId, context.workspaceId) as SetupRow[];
    return { mode: this.mode, chiefs: rows.map((row) => this.view(row)) };
  }
  async repositories(context: WorkspaceContext) {
    if (!this.repositorySource)
      throw new SetupError(
        503,
        "github_unavailable",
        "GitHub repository discovery is not configured.",
      );
    return this.repositorySource.list(context);
  }
  get(context: WorkspaceContext, id: string) {
    return this.view(this.row(context, id));
  }
  private view(row: SetupRow) {
    const config = JSON.parse(row.config) as ChiefConfig;
    const ledger = new Ledger(join(this.directory, `${row.id}.db`));
    try {
      return {
        id: row.id,
        name: row.name,
        repository: row.repository,
        repositories: config.repositories,
        mode: this.mode,
        status: row.state,
        scanStatus: row.scan_state,
        createdAt: row.created_at,
        lastScanAt: row.last_scan,
        region: (JSON.parse(row.plan) as ReturnType<typeof provisionPlan>)
          .compute.region,
        budgetDollars: config.policy.budgetMicros / 1_000_000,
        maxConcurrentTasks: config.policy.maxConcurrentTasks,
        allowedActions: config.policy.allowedActions,
        accounting: ledger.accounting(),
        tasks: ledger.tasks().map((task) => ({
          id: task.id,
          action: task.assignment.action,
          status: task.status,
          title: task.assignment.evidence.summary,
          worker: task.assignment.worker.address,
          verified: task.verification?.ok ?? false,
          checks: task.verification?.checks ?? [],
        })),
        decisions: ledger.decisions().slice(-50).reverse(),
        setupSteps: [
          { label: "Project and policy saved", complete: true },
          {
            label:
              this.mode === "local"
                ? "Local runtime connected"
                : "EC2 provisioning approved",
            complete: row.state === "ready",
          },
          { label: "Relay identity verified", complete: row.state === "ready" },
          {
            label: "Execution worker connected",
            complete: row.state === "ready",
          },
        ],
      };
    } finally {
      ledger.close();
    }
  }
  async create(context: WorkspaceContext, raw: unknown) {
    const parsed = projectSetupSchema.safeParse(raw);
    if (!parsed.success)
      throw new SetupError(
        400,
        "invalid_setup",
        "Check the project, repository, region and operating policy.",
      );
    const input = parsed.data;
    const digest = hash(input);
    const existing = this.registry
      .prepare("SELECT * FROM projects WHERE workspace_id=? AND request_id=?")
      .get(context.workspaceId, input.requestId) as SetupRow | undefined;
    if (existing) {
      if (
        existing.organization_id !== context.organizationId ||
        existing.digest !== digest
      )
        throw new SetupError(
          409,
          "setup_conflict",
          "This setup request was already used with different settings.",
        );
      return this.view(existing);
    }
    const catalog = await this.repositories(context);
    if (!catalog.connected)
      throw new SetupError(
        409,
        "github_disconnected",
        "Connect GitHub before setting up a chief.",
      );
    const selected = input.repositoryIds.map((id) =>
      catalog.repositories.find((repo) => repo.id === id),
    );
    if (selected.some((repo) => !repo))
      throw new SetupError(
        400,
        "repository_access_changed",
        "Refresh repositories and select an accessible repository.",
      );
    const repositories = selected
      .map((repo) => repo!.fullName.toLowerCase())
      .sort();
    const name =
      selected.length === 1
        ? selected[0]!.fullName.split("/")[1]!
        : `${selected[0]!.fullName.split("/")[0]} · ${selected.length} repositories`;
    const chiefId = `chief-${hash([context.organizationId, context.workspaceId, repositories]).slice(0, 24)}`;
    const identities = this.runtime?.identities(context, chiefId) ?? {
      relayCallerId: `pending-${chiefId}`,
      workers: [],
    };
    const config: ChiefConfig = {
      revision: 1,
      chiefId,
      ...context,
      projectId: chiefId,
      repositories,
      ...identities,
      policy: {
        version: "1",
        allowedActions: input.allowedActions,
        maxEvidenceAgeMs: 3_600_000,
        minConfidence: 0.8,
        maxConcurrentTasks: input.maxConcurrentTasks,
        budgetMicros: Math.round(input.budgetDollars * 1_000_000),
        taskReservationMicros: 1_000_000,
      },
    };
    const plan = provisionPlan({
      requestId: input.requestId,
      config,
      region: input.region,
      instanceType: "t4g.small",
    });
    // The catalog read is asynchronous; claim every repository atomically afterwards.
    this.registry.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.registry
        .prepare("SELECT * FROM projects WHERE workspace_id=? AND request_id=?")
        .get(context.workspaceId, input.requestId) as SetupRow | undefined;
      if (replay) {
        if (
          replay.organization_id !== context.organizationId ||
          replay.digest !== digest
        )
          throw new SetupError(
            409,
            "setup_conflict",
            "This setup request was already used with different settings.",
          );
        this.registry.exec("COMMIT");
        return this.view(replay);
      }
      for (const id of input.repositoryIds) {
        if (
          this.registry
            .prepare(
              "SELECT chief_id FROM project_github_repositories WHERE workspace_id=? AND repository_id=?",
            )
            .get(context.workspaceId, id)
        )
          throw new SetupError(
            409,
            "project_already_configured",
            "A selected repository already has a chief in this workspace.",
          );
        this.registry
          .prepare("INSERT INTO project_github_repositories VALUES (?, ?, ?)")
          .run(context.workspaceId, id, chiefId);
      }
      for (const repository of repositories) {
        if (
          this.registry
            .prepare(
              "SELECT chief_id FROM project_repositories WHERE workspace_id=? AND repository=?",
            )
            .get(context.workspaceId, repository)
        )
          throw new SetupError(
            409,
            "project_already_configured",
            "A selected repository already has a chief in this workspace.",
          );
        this.registry
          .prepare("INSERT INTO project_repositories VALUES (?, ?, ?, ?)")
          .run(
            context.organizationId,
            context.workspaceId,
            repository,
            chiefId,
          );
      }
      this.registry
        .prepare(
          "INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          chiefId,
          context.organizationId,
          context.workspaceId,
          name,
          repositories[0]!,
          input.requestId,
          digest,
          canonical(config),
          canonical(plan),
          this.runtime ? "preparing" : "awaiting_approval",
          "idle",
          new Date().toISOString(),
        );
      this.registry.exec("COMMIT");
    } catch (error) {
      this.registry.exec("ROLLBACK");
      throw error;
    }
    if (this.runtime)
      this.launch(
        chiefId,
        async () => {
          const runtime = await this.runtime!.connect(config);
          const identity = await runtime.relay.identity();
          if (
            identity.workspaceId !== context.workspaceId ||
            identity.callerId !== config.relayCallerId ||
            !config.workers.length
          )
            throw new Error("runtime_not_ready");
          const ledger = new Ledger(join(this.directory, `${chiefId}.db`));
          try {
            ledger.configure(config);
            ledger.bindRelay(identity);
          } finally {
            ledger.close();
          }
          this.registry
            .prepare("UPDATE projects SET state='ready' WHERE id=?")
            .run(chiefId);
        },
        "setup",
      );
    return this.get(context, chiefId);
  }
  async scan(context: WorkspaceContext, id: string) {
    const row = this.row(context, id);
    if (row.state !== "ready" || !this.runtime)
      throw new SetupError(
        409,
        "chief_not_ready",
        "Finish runtime setup before scanning sessions.",
      );
    if (this.jobs.has(id))
      throw new SetupError(
        409,
        "scan_in_progress",
        "A coordination scan is already running.",
      );
    this.registry
      .prepare("UPDATE projects SET scan_state='running' WHERE id=?")
      .run(id);
    this.launch(
      id,
      async () => {
        const config = JSON.parse(row.config) as ChiefConfig;
        const runtime = await this.runtime!.connect(config);
        const ledger = new Ledger(join(this.directory, `${id}.db`));
        try {
          const chief = new Chief(config, ledger, runtime);
          await runtime.reconcile?.(chief);
          for (const task of ledger.tasks())
            if (task.status === "awaiting_verification")
              await chief.verify(task.id);
          await chief.scan(runtime.source);
          await chief.dispatchReserved();
          await runtime.reconcile?.(chief);
          this.registry
            .prepare(
              "UPDATE projects SET scan_state='idle', last_scan=? WHERE id=?",
            )
            .run(new Date().toISOString(), id);
        } finally {
          ledger.close();
        }
      },
      "scan",
    );
    return this.get(context, id);
  }
  private launch(
    id: string,
    work: () => Promise<void>,
    kind: "setup" | "scan",
  ): void {
    const job = Promise.resolve()
      .then(work)
      .catch(() => {
        this.registry
          .prepare(
            kind === "setup"
              ? "UPDATE projects SET state='failed' WHERE id=?"
              : "UPDATE projects SET scan_state='failed' WHERE id=?",
          )
          .run(id);
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
  }
  async settled(): Promise<void> {
    await Promise.all(this.jobs.values());
  }
  async close(): Promise<void> {
    await this.settled();
    this.registry.close();
  }
}
