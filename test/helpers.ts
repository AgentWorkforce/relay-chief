import type { ChiefConfig, Classification, Evidence, RelayTransport, Task, WorkerReport } from '../src/contracts.js';
import { Chief } from '../src/chief.js';
import { Ledger } from '../src/ledger.js';

export const NOW = 1_800_000_000_000;
export function config(): ChiefConfig {
  return { revision: 1, chiefId: 'chief-1', organizationId: 'org-1', workspaceId: 'workspace-1', projectId: 'project-1',
    relayCallerId: 'agent-chief', repositories: ['acme/project'],
    workers: [{ agentId: 'agent-worker', address: 'worker@host', actions: ['investigate', 'coordinate', 'unblock'] }],
    policy: { version: 'v1', allowedActions: ['investigate', 'coordinate', 'unblock'], maxEvidenceAgeMs: 60_000,
      minConfidence: 0.8, maxConcurrentTasks: 3, budgetMicros: 3_000_000, taskReservationMicros: 1_000_000 } };
}
export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { sourceId: 'project-sessions-v1', sessionId: 'session-1', version: '1', organizationId: 'org-1',
    workspaceId: 'workspace-1', projectId: 'project-1', repository: 'acme/project', workKey: 'issue-42',
    resourceKeys: ['issue-42', 'src/auth.ts'], observedAt: NOW, summary: 'The assigned work is blocked by a failing test.',
    references: ['https://github.com/acme/project/issues/42'], ...overrides };
}
export function report(task: Task, state: WorkerReport['state'] = 'completed', sequence = 1): WorkerReport {
  return { protocol: 'relay-chief.report.v1', taskId: task.id, assignmentDigest: task.digest, sequence, state,
    artifactRefs: ['https://github.com/acme/project/pull/43'] };
}
export function harness(options: { config?: ChiefConfig; ledger?: Ledger; classification?: Classification;
  classifierError?: boolean; relayError?: boolean; verification?: boolean; now?: () => number } = {}) {
  let classifications = 0;
  let sends = 0;
  let verifications = 0;
  const relay: RelayTransport = {
    identity: async () => ({ origin: 'https://relay.example', workspaceId: options.config?.relayWorkspaceId ?? 'workspace-1', callerId: 'agent-chief' }),
    send: async () => { sends++; if (options.relayError) throw new Error('provider-secret-in-error'); return { messageId: 'message-1' }; },
  };
  const ledger = options.ledger ?? new Ledger(':memory:');
  const chief = new Chief(options.config ?? config(), ledger, {
    classifier: { classify: async () => { classifications++; if (options.classifierError) throw new Error('provider secret');
      return options.classification ?? { kind: 'blocked', confidence: 0.99 }; } }, relay,
    verifier: { verify: async () => { verifications++; return { ok: options.verification ?? true, checks: ['check-123@revision-abc'] }; } },
    now: options.now ?? (() => NOW),
  });
  return { chief, ledger, relay, counts: () => ({ classifications, sends, verifications }) };
}
