import type { ChiefConfig, Classification, Evidence } from './contracts.js';
import { actionFor } from './contracts.js';

/** Pure gates. Live ownership and budget checks run in the ledger transaction. */
export function evaluate(config: ChiefConfig, evidence: Evidence, classification: Classification, now: number): string | undefined {
  if (evidence.organizationId !== config.organizationId || evidence.workspaceId !== config.workspaceId ||
      evidence.projectId !== config.projectId) return 'scope_mismatch';
  if (!config.repositories.includes(evidence.repository)) return 'repository_not_allowed';
  if (evidence.observedAt > now || now - evidence.observedAt > config.policy.maxEvidenceAgeMs) return 'stale_evidence';
  if (classification.kind === 'uncertain' || classification.confidence < config.policy.minConfidence) return 'classification_uncertain';
  const action = actionFor(classification.kind);
  if (action && !config.policy.allowedActions.includes(action)) return 'action_not_allowed';
  return undefined;
}
