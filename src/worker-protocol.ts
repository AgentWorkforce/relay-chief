import { z } from 'zod';
import type { Action, Assignment } from './contracts.js';
import { actionSchema, evidenceSchema, hash } from './contracts.js';

const assignmentSchema = z.strictObject({
  protocol: z.literal('relay-chief.assignment.v1'), taskId: z.string().min(1).max(200),
  chiefId: z.string().min(1), organizationId: z.string().min(1), workspaceId: z.string().min(1), projectId: z.string().min(1),
  repository: z.string().min(1), workKey: z.string().min(1), resourceKeys: z.array(z.string().min(1)).min(1).max(100),
  action: actionSchema,
  worker: z.strictObject({ agentId: z.string().min(1), address: z.string().min(1), actions: z.array(actionSchema).min(1) }),
  policyVersion: z.string().min(1), configurationRevision: z.number().int().positive(), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reservationMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), evidence: evidenceSchema,
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20),
});

/** Execution-side validation helper only. The chief never runs the worker's implementation. */
export function readAssignment(delivery: {
  workspaceId: string; senderAgentId: string; recipientAgentId: string; recipientAddress: string;
}, raw: unknown, policy: {
  chiefAgentId: string; chiefId: string; organizationId: string; projectId: string;
  repositories: string[]; actions: Action[]; maxReservationMicros: number; maxEvidenceAgeMs: number;
}, now = Date.now()): { assignment: Assignment; digest: string } {
  const parsed = z.object({ chief_assignment: assignmentSchema, assignment_digest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(raw);
  if (!parsed.success) throw new Error('worker_assignment_invalid');
  const assignment = parsed.data.chief_assignment;
  const digest = parsed.data.assignment_digest;
  if (hash(assignment) !== digest || hash(assignment.evidence) !== assignment.evidenceDigest ||
      delivery.workspaceId !== assignment.workspaceId || delivery.senderAgentId !== policy.chiefAgentId ||
      delivery.recipientAgentId !== assignment.worker.agentId || delivery.recipientAddress !== assignment.worker.address ||
      assignment.chiefId !== policy.chiefId || assignment.organizationId !== policy.organizationId || assignment.projectId !== policy.projectId ||
      !policy.repositories.includes(assignment.repository) || !policy.actions.includes(assignment.action) ||
      assignment.reservationMicros > policy.maxReservationMicros || assignment.evidence.observedAt > now ||
      now - assignment.evidence.observedAt > policy.maxEvidenceAgeMs ||
      assignment.evidence.organizationId !== assignment.organizationId || assignment.evidence.workspaceId !== assignment.workspaceId ||
      assignment.evidence.projectId !== assignment.projectId || assignment.evidence.repository !== assignment.repository ||
      assignment.evidence.workKey !== assignment.workKey ||
      hash([...new Set(assignment.evidence.resourceKeys)].sort()) !== hash(assignment.resourceKeys)) throw new Error('worker_assignment_not_authorized');
  return { assignment, digest };
}
