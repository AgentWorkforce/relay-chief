import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).transform(s => s.toLowerCase());
export const findingKinds = ['follow_up', 'overlap', 'blocked', 'no_action', 'uncertain'] as const;
export const actionSchema = z.enum(['investigate', 'coordinate', 'unblock']);
export type Action = z.infer<typeof actionSchema>;
export const policySchema = z.strictObject({
  version: id,
  allowedActions: z.array(actionSchema),
  maxEvidenceAgeMs: z.number().int().positive().max(86_400_000),
  minConfidence: z.number().min(0).max(1),
  maxConcurrentTasks: z.number().int().positive().max(100),
  budgetMicros: count,
  taskReservationMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /**
   * Lets a worker-reported cost lower a finished task's budget charge below its reservation.
   * Off (the default), a worker's figure is recorded but can only ever raise a charge.
   */
  settleWorkerReportedUsage: z.boolean().optional(),
});
export const chiefConfigSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chiefId: id,
  organizationId: id,
  workspaceId: id,
  projectId: id,
  relayCallerId: id,
  /** Relay names workspaces separately from Control. Omitted when both use one identifier. */
  relayWorkspaceId: id.optional(),
  repositories: z.array(repo).min(1),
  workers: z.array(z.strictObject({
    agentId: id,
    address: z.string().regex(/^[^\s@]+@[^\s@]+$/).max(200),
    actions: z.array(actionSchema).min(1),
  })),
  policy: policySchema,
}).superRefine((c, ctx) => {
  if (new Set(c.workers.map(w => w.agentId)).size !== c.workers.length ||
      new Set(c.workers.map(w => w.address)).size !== c.workers.length) {
    ctx.addIssue({ code: 'custom', message: 'Worker identities and addresses must be unique' });
  }
  if (c.workers.some(w => w.agentId === c.relayCallerId)) {
    ctx.addIssue({ code: 'custom', message: 'The chief cannot be an execution worker' });
  }
});
export type ChiefConfig = z.infer<typeof chiefConfigSchema>;
/** The workspace Relay must report for this chief's agent token. */
export function relayWorkspaceOf(config: Pick<ChiefConfig, 'workspaceId' | 'relayWorkspaceId'>): string {
  return config.relayWorkspaceId ?? config.workspaceId;
}
export const evidenceSchema = z.strictObject({
  sourceId: id,
  sessionId: id,
  version: id,
  organizationId: id,
  workspaceId: id,
  projectId: id,
  repository: repo,
  // Source adapters assign objective identity; the classifier cannot mint it.
  workKey: id,
  resourceKeys: z.array(id).min(1).max(100),
  observedAt: count,
  summary: z.string().min(1).max(16_000),
  references: z.array(z.string().url().max(2000)).max(20),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const classificationSchema = z.strictObject({
  kind: z.enum(findingKinds),
  confidence: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof classificationSchema>;
export interface Classifier { classify(evidence: Evidence): Promise<Classification> }
export interface EvidencePage { evidence: Evidence[]; cursor: string }
export interface EvidenceSource {
  /** Trusted adapter: authorizes scope and derives work/resource keys from structured project data. */
  id: string;
  read(cursor: string | undefined): Promise<EvidencePage>;
}
export interface Assignment {
  protocol: 'relay-chief.assignment.v1';
  taskId: string;
  chiefId: string;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  repository: string;
  workKey: string;
  resourceKeys: string[];
  action: Action;
  worker: ChiefConfig['workers'][number];
  policyVersion: string;
  configurationRevision: number;
  policyDigest: string;
  reservationMicros: number;
  evidenceDigest: string;
  evidence: Evidence;
  acceptance: string[];
}
/** Authority that must know an assignment before it can verify the work. */
export interface AssignmentRegistry {
  /** Idempotent. Any rejection means the assignment must not be sent. */
  register(assignment: Assignment, digest: string): Promise<void>;
}
export interface RelayIdentity {
  origin: string;
  workspaceId: string;
  callerId: string;
}
export interface RelayTransport {
  identity(): Promise<RelayIdentity>;
  /** One attempt only. Success means delivery, never task completion. */
  send(assignment: Assignment, digest: string): Promise<{ messageId: string }>;
}
/** Why a bridge ended a task. Authored by the bridge, never by worker text. */
export const reportReasons = ['runtime_exceeded', 'result_marker_missing', 'agent_failed', 'spawn_failed', 'stop_failed'] as const;
/** What the execution side says a task cost. A claim, not a bill: it is capped by the reservation. */
export const reportUsageSchema = z.strictObject({
  costMicros: count,
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  source: z.literal('worker_reported'),
});
export type ReportUsage = z.infer<typeof reportUsageSchema>;
export const reportSchema = z.strictObject({
  protocol: z.literal('relay-chief.report.v1'),
  taskId: id,
  assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive(),
  state: z.enum(['accepted', 'running', 'completed', 'failed']),
  artifactRefs: z.array(z.string().url().max(2000)).max(100),
  /** Untrusted worker text. Data only: never instructions, never logged. */
  findings: z.string().min(1).max(3000).optional(),
  reason: z.enum(reportReasons).optional(),
  /**
   * Read on `completed` and `failed` reports only. An invalid value is dropped rather than
   * refusing the report, so a bad figure never loses a terminal report; the task is then
   * charged its full reservation, as without the field.
   */
  usage: reportUsageSchema.optional().catch(undefined),
});
export type WorkerReport = z.infer<typeof reportSchema>;
export interface AuthenticatedReport {
  // These fields come from verified Relay delivery metadata, NOT the report body.
  workspaceId: string;
  agentId: string;
  report: WorkerReport;
}
export interface Verification {
  ok: boolean;
  /** Authoritative checks bound to this assignment; never raw worker prose. */
  checks: string[];
}
export interface CompletionVerifier {
  verify(assignment: Assignment, report: WorkerReport): Promise<Verification>;
}
/** Puts an investigation's findings where a maintainer can accept them. Idempotent per task. */
export interface FindingsPublisher {
  publish(assignment: Assignment, report: WorkerReport & { findings: string }): Promise<void>;
}
export type TaskStatus = 'reserved' | 'sending' | 'uncertain' | 'delivered' |
  'accepted' | 'running' | 'awaiting_verification' | 'needs_attention' | 'completed' | 'canceled';
export interface Task {
  id: string;
  assignment: Assignment;
  digest: string;
  status: TaskStatus;
  messageId?: string;
  report?: WorkerReport;
  verification?: Verification;
}
export interface Decision {
  evidenceDigest: string;
  kind: Classification['kind'];
  outcome: 'reserved' | 'deferred' | 'ignored' | 'duplicate';
  reason: string;
  taskId?: string;
}
export const usageSchema = z.strictObject({
  eventId: id,
  chiefId: id,
  workspaceId: id,
  taskId: id.optional(),
  actor: z.enum(['chief', 'worker', 'classifier']),
  /** `unknown` only on a worker-reported event: the execution side does not name who billed it. */
  provider: z.enum(['anthropic', 'typesafe', 'aws', 'unknown']),
  providerIdentityId: id.optional(),
  occurredAt: count,
  costMicros: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  /** Set only by the ledger, from a worker report. Absent means trusted accounting. */
  source: z.literal('worker_reported').optional(),
});
export type UsageEvent = z.infer<typeof usageSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function scope(config: ChiefConfig): object {
  return { chiefId: config.chiefId, organizationId: config.organizationId,
    workspaceId: config.workspaceId, projectId: config.projectId, relayCallerId: config.relayCallerId };
}
export function actionFor(kind: Classification['kind']): Action | undefined {
  const actions: Partial<Record<Classification['kind'], Action>> = { follow_up: 'investigate', overlap: 'coordinate', blocked: 'unblock' };
  return actions[kind];
}
