import type { ChiefConfig, Task } from './contracts.js';
import { hash } from './contracts.js';
import type { Ledger } from './ledger.js';

export interface LedgerCheck {
  ok: boolean;
  /** Safety breaches. Further dispatch must not proceed while any exist. */
  violations: string[];
  /** Legitimate states an operator should look at. They never block a cycle. */
  attention: string[];
}

/** Read-only safety check over durable state. Contains identifiers only, never payloads. */
export function checkLedger(ledger: Ledger, config: ChiefConfig): LedgerCheck {
  const violations: string[] = [];
  const attention: string[] = [];
  let tasks: Task[];
  try { tasks = ledger.tasks(); }
  catch (error) {
    if (error instanceof Error && error.message === 'assignment_corrupt') return { ok: false, violations: ['assignment_corrupt'], attention };
    throw error;
  }
  const live = tasks.filter(task => task.status !== 'canceled');
  const active = live.filter(task => task.status !== 'completed');
  // Reservation enforces these limits. Exceeding them here means a policy was lowered, which is not a breach.
  if (active.length > config.policy.maxConcurrentTasks) attention.push('over_capacity');
  const reserved = live.reduce((sum, task) => sum + task.assignment.reservationMicros, 0);
  if (reserved > config.policy.budgetMicros) attention.push('over_budget');
  const objectives = new Set<string>();
  const resources = new Set<string>();
  for (const task of live) {
    const objective = hash([task.assignment.repository, task.assignment.workKey]);
    if (objectives.has(objective)) violations.push(`duplicate_objective:${task.id}`);
    objectives.add(objective);
    if (task.status === 'completed' && !(task.verification?.ok === true && task.verification.checks.length > 0 && task.verification.checks.every(check => typeof check === 'string' && check.trim()))) {
      violations.push(`completed_without_verification:${task.id}`);
    }
  }
  for (const task of active) {
    for (const resource of task.assignment.resourceKeys) {
      const key = hash([task.assignment.repository, resource]);
      if (resources.has(key)) violations.push(`resource_double_claimed:${task.id}`);
      resources.add(key);
    }
    if (task.status === 'sending') attention.push(`send_unresolved:${task.id}`);
    if (task.status === 'uncertain') attention.push(`delivery_uncertain:${task.id}`);
    if (task.status === 'needs_attention') attention.push(`needs_attention:${task.id}`);
    if (task.status === 'awaiting_verification') attention.push(`verification_pending:${task.id}`);
  }
  return { ok: violations.length === 0, violations, attention };
}
