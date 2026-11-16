import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ChiefConfig, Task, WorkerReport } from '../src/contracts.js';
import { reportSchema } from '../src/contracts.js';
import { checkLedger } from '../src/invariants.js';
import { config, evidence, harness, NOW, report } from './helpers.js';

const worker = { workspaceId: 'workspace-1', agentId: 'agent-worker' };
const usage = (costMicros: number) => ({ costMicros, inputTokens: 1200, outputTokens: 300, source: 'worker_reported' as const });
const withPolicy = (policy: Partial<ChiefConfig['policy']>): ChiefConfig => ({ ...config(), policy: { ...config().policy, ...policy } });
const next = (n: number) => evidence({ sessionId: `s-${n}`, workKey: `issue-${n}`, resourceKeys: [`issue-${n}`] });
const finished = (task: Task, state: WorkerReport['state'], sequence: number, extra: Partial<WorkerReport> = {}) =>
  ({ ...worker, report: { ...report(task, state, sequence), ...extra } });

async function dispatched(h: ReturnType<typeof harness>, n = 1): Promise<Task> {
  const { taskId } = await h.chief.observe(n === 1 ? evidence() : next(n));
  return h.chief.dispatch(taskId!);
}

test('reports may carry worker-reported usage; an invalid figure is dropped, never the report', () => {
  const base = { protocol: 'relay-chief.report.v1', taskId: 't', assignmentDigest: 'a'.repeat(64), sequence: 1, state: 'completed', artifactRefs: [] };
  assert.deepEqual(reportSchema.parse({ ...base, usage: usage(72_000) }).usage, usage(72_000));
  assert.deepEqual(reportSchema.parse({ ...base, usage: { costMicros: 0, source: 'worker_reported' } }).usage, { costMicros: 0, source: 'worker_reported' });
  assert.equal('usage' in reportSchema.parse(base) && reportSchema.parse(base).usage !== undefined, false);
  for (const bad of [{ costMicros: -1, source: 'worker_reported' }, { costMicros: 1.5, source: 'worker_reported' },
    { costMicros: 10, source: 'provider_invoice' }, { costMicros: 10 }, { ...usage(10), totalCostUsd: 0.07 }, 'free', null]) {
    const parsed = reportSchema.safeParse({ ...base, usage: bad });
    assert.equal(parsed.success, true, JSON.stringify(bad));
    assert.equal(parsed.data!.usage, undefined, JSON.stringify(bad));
  }
});

test('a worker-reported cost is recorded, labelled, and kept apart from trusted accounting', async () => {
  const h = harness();
  const task = await dispatched(h);
  await h.chief.receive(finished(task, 'running', 1, { usage: usage(10) }));
  assert.equal(h.ledger.accounting().workerReportedEvents, 0, 'only a terminal report settles');
  await h.chief.receive(finished(task, 'completed', 2, { usage: usage(72_000) }));
  await h.chief.receive(finished(task, 'completed', 2, { usage: usage(72_000) }));
  assert.equal(h.ledger.task(task.id).status, 'completed');
  assert.deepEqual(h.ledger.accounting(), { knownCostMicros: 0, unknownCostEvents: 0, events: 0,
    committedReservationMicros: 1_000_000, workerReportedCostMicros: 72_000, workerReportedEvents: 1 });
  // Off by default: the claim is evidence only, and the full reservation stays charged.
  assert.deepEqual(h.ledger.charges(config()), [{ taskId: task.id, status: 'completed', reservationMicros: 1_000_000,
    workerReportedCostMicros: 72_000, chargedMicros: 1_000_000 }]);
  h.ledger.close();
});

test('trusted ingestion cannot write or impersonate worker-reported usage', async () => {
  const h = harness();
  const { taskId } = await h.chief.observe(evidence());
  const event = { eventId: 'e-1', chiefId: 'chief-1', workspaceId: 'workspace-1', taskId, actor: 'worker', provider: 'anthropic',
    occurredAt: NOW, costMicros: 1, inputTokens: null, outputTokens: null };
  assert.throws(() => h.ledger.usage({ ...event, source: 'worker_reported' }), /usage_source_reserved/);
  assert.throws(() => h.ledger.usage({ ...event, provider: 'unknown' }), /usage_source_reserved/);
  h.ledger.close();
});

test('with settlement on, a verified task is charged its reported cost and frees the rest of its reservation', async () => {
  for (const settle of [false, true]) {
    const c = withPolicy({ budgetMicros: 2_100_000, settleWorkerReportedUsage: settle });
    const h = harness({ config: c });
    const first = await dispatched(h, 1);
    await dispatched(h, 2);
    assert.equal((await h.chief.observe(next(3))).reason, 'budget_exhausted');
    await h.chief.receive(finished(first, 'completed', 1, { usage: usage(72_000) }));
    assert.equal(h.ledger.task(first.id).status, 'completed');
    assert.equal(h.ledger.committed(c), settle ? 1_072_000 : 2_000_000);
    assert.equal((await h.chief.observe(next(4))).outcome, settle ? 'reserved' : 'deferred', `settle=${settle}`);
    assert.equal(checkLedger(h.ledger, c).ok, true);
    h.ledger.close();
  }
});

test('settlement never goes above the reservation, and only a verified completion settles', async () => {
  const c = withPolicy({ settleWorkerReportedUsage: true });
  const capped = harness({ config: c });
  const over = await dispatched(capped);
  await capped.chief.receive(finished(over, 'completed', 1, { usage: usage(5_000_000) }));
  assert.equal(capped.ledger.charges(c)[0]!.chargedMicros, 1_000_000);
  assert.ok(checkLedger(capped.ledger, c).attention.includes(`worker_cost_over_reservation:${over.id}`));
  capped.ledger.close();

  const pending = harness({ config: c, verification: false });
  const task = await dispatched(pending);
  await pending.chief.receive(finished(task, 'completed', 1, { usage: usage(50_000) }));
  assert.equal(pending.ledger.task(task.id).status, 'awaiting_verification');
  assert.equal(pending.ledger.committed(c), 1_000_000, 'unverified work keeps its full reservation');
  // A later terminal report can raise the recorded figure but never lower it.
  await pending.chief.receive(finished(task, 'failed', 2, { usage: usage(30_000), reason: 'agent_failed' }));
  assert.equal(pending.ledger.charges(c)[0]!.workerReportedCostMicros, 50_000);
  assert.equal(pending.ledger.task(task.id).status, 'needs_attention');
  assert.equal(pending.ledger.committed(c), 1_000_000, 'a failed task may still run, so it keeps its reservation');
  pending.ledger.close();
});

test('a failed report that ran is still charged its reported cost after an operator releases it', async () => {
  const h = harness();
  const ran = await dispatched(h, 1);
  await h.chief.receive(finished(ran, 'failed', 1, { usage: usage(250_000), reason: 'runtime_exceeded' }));
  const silent = await dispatched(h, 2);
  await h.chief.receive(finished(silent, 'failed', 1, { reason: 'spawn_failed' }));
  h.ledger.cancelFailed(ran.id, NOW);
  h.ledger.cancelFailed(silent.id, NOW);
  assert.deepEqual(h.ledger.charges(config()).map(c => c.chargedMicros), [250_000, 0]);
  assert.equal(h.ledger.committed(config()), 250_000);
  h.ledger.close();
});

test('a report with invalid usage still completes and is charged the full reservation', async () => {
  const c = withPolicy({ settleWorkerReportedUsage: true });
  const h = harness({ config: c });
  const task = await dispatched(h);
  const done = await h.chief.receive(finished(task, 'completed', 1, { usage: { costMicros: -5, source: 'worker_reported' } as never }));
  assert.equal(done.status, 'completed');
  assert.equal(h.ledger.accounting().workerReportedEvents, 0);
  assert.equal(h.ledger.committed(c), 1_000_000);
  h.ledger.close();
});
