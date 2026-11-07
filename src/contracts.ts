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
});
export const chiefConfigSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chiefId: id,
  organizationId: id,
  workspaceId: id,
  projectId: id,
  relayCallerId: id,
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
export const reportSchema = z.strictObject({
  protocol: z.literal('relay-chief.report.v1'),
  taskId: id,
  assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive(),
  state: z.enum(['accepted', 'running', 'completed', 'failed']),
  artifactRefs: z.array(z.string().url().max(2000)).max(100),
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
  provider: z.enum(['anthropic', 'typesafe', 'aws']),
  providerIdentityId: id.optional(),
  occurredAt: count,
  costMicros: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
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
