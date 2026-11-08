import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Chief } from '../src/chief.js';
import { Ledger } from '../src/ledger.js';
import { chiefConfigSchema } from '../src/contracts.js';
import { runCycle } from '../src/cycle.js';
import { checkLedger } from '../src/invariants.js';
import { config, evidence, harness, NOW, report } from './helpers.js';

test('a delivery is not acceptance; authenticated reports and authoritative checks complete work', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  assert.equal(decision.outcome, 'reserved');
  const task = await h.chief.dispatch(decision.taskId!);
  assert.equal(task.status, 'delivered');
  assert.equal(h.counts().verifications, 0);
  const event = { workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'accepted') };
  assert.equal((await h.chief.receive(event)).status, 'accepted');
  const completed = await h.chief.receive({ ...event, report: report(task, 'completed', 2) });
  assert.equal(completed.status, 'completed');
  assert.equal(h.counts().sends, 1);
  h.ledger.close();
});

test('same objective across sessions has one assignment; shared resources block distinct work', async () => {
  const h = harness();
  const first = await h.chief.observe(evidence());
  const duplicate = await h.chief.observe(evidence({ sessionId: 'session-2' }));
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(duplicate.taskId, first.taskId);
  assert.equal((await h.chief.observe(evidence({ sessionId: 'session-3', workKey: 'issue-55' }))).reason, 'resource_claimed');
  assert.equal(h.ledger.tasks().length, 1);
  const task = await h.chief.dispatch(first.taskId!);
  await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task) });
  assert.equal((await h.chief.observe(evidence({ sessionId: 'session-3', workKey: 'issue-55' }))).outcome, 'reserved');
  h.ledger.close();
});

test('uncertain sends retain ownership and are never sent again', async () => {
  const h = harness({ relayError: true });
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  assert.equal(task.status, 'uncertain');
  await h.chief.dispatch(task.id);
  assert.equal(h.counts().sends, 1);
  assert.equal((await h.chief.observe(evidence({ sessionId: 'other', workKey: 'other' }))).reason, 'resource_claimed');
  // Worker acceptance can reconcile a lost delivery acknowledgment.
  assert.equal((await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task) })).status, 'completed');
  h.ledger.close();
});

test('two runtimes sharing a durable database reserve and send once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-concurrent-'));
  const path = join(dir, 'ledger.db');
  const a = harness({ ledger: new Ledger(path) });
  const b = harness({ ledger: new Ledger(path) });
  try {
    const [one, two] = await Promise.all([a.chief.observe(evidence()), b.chief.observe(evidence())]);
    assert.deepEqual(new Set([one.outcome, two.outcome]), new Set(['reserved', 'duplicate']));
    await Promise.all([a.chief.dispatch(one.taskId!), b.chief.dispatch(two.taskId!)]);
    assert.equal(a.counts().sends + b.counts().sends, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { a.ledger.close(); b.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('crash after durable send claim never causes a second send on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-crash-'));
  const path = join(dir, 'ledger.db');
  let h = harness({ ledger: new Ledger(path) });
  const decision = await h.chief.observe(evidence());
  assert.equal(h.ledger.claimSend(config(), decision.taskId!, NOW)?.status, 'sending');
  h.ledger.close();
  h = harness({ ledger: new Ledger(path) });
  try {
    assert.equal((await h.chief.dispatch(decision.taskId!)).status, 'sending');
    assert.equal(h.counts().sends, 0);
    assert.equal((await h.chief.observe(evidence())).outcome, 'duplicate');
    assert.equal(h.counts().classifications, 0);
  } finally { h.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, change, reason] of [
  ['other organization', { organizationId: 'other' }, 'scope_mismatch'],
  ['other workspace', { workspaceId: 'other' }, 'scope_mismatch'],
  ['other project', { projectId: 'other' }, 'scope_mismatch'],
  ['other repository', { repository: 'acme/other' }, 'repository_not_allowed'],
  ['old evidence', { observedAt: NOW - 60_001 }, 'stale_evidence'],
  ['future evidence', { observedAt: NOW + 1 }, 'stale_evidence'],
] as const) test(`preflight rejects ${name} before invoking the classifier`, async () => {
  const h = harness();
  assert.equal((await h.chief.observe(evidence(change))).reason, reason);
  assert.equal(h.counts().classifications, 0);
  assert.equal(h.ledger.tasks().length, 0);
  h.ledger.close();
});

test('provider failures, uncertain results, and disabled actions cannot authorize work', async () => {
  for (const [options, expected] of [
    [{ classifierError: true }, 'classifier_unavailable'],
    [{ classification: { kind: 'blocked', confidence: 0.1 } }, 'classification_uncertain'],
    [{ classification: { kind: 'uncertain', confidence: 1 } }, 'classification_uncertain'],
  ] as const) {
    const h = harness(options);
    assert.equal((await h.chief.observe(evidence())).reason, expected);
    assert.equal(h.ledger.tasks().length, 0);
    h.ledger.close();
  }
  const c = config(); c.policy.allowedActions = ['investigate'];
  const h = harness({ config: c });
  assert.equal((await h.chief.observe(evidence())).reason, 'action_not_allowed');
  h.ledger.close();
});

test('missing execution capacity never falls back to chief implementation', async () => {
  const c = config(); c.workers = [];
  const h = harness({ config: c });
  assert.equal((await h.chief.observe(evidence())).reason, 'no_eligible_worker');
  assert.equal(h.ledger.tasks().length, 0);
  assert.throws(() => chiefConfigSchema.parse({ ...config(), workers: [{ ...config().workers[0], agentId: 'agent-chief' }] }));
  h.ledger.close();
});

test('budget and concurrent capacity include uncertain work and survive completion', async () => {
  const c = config(); c.policy.maxConcurrentTasks = 1; c.policy.budgetMicros = 1_000_000;
  const h = harness({ config: c });
  const first = await h.chief.observe(evidence());
  const other = evidence({ sessionId: 'other', workKey: 'other', resourceKeys: ['other'] });
  assert.equal((await h.chief.observe(other)).reason, 'capacity_exhausted');
  const task = await h.chief.dispatch(first.taskId!);
  await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task) });
  assert.equal((await h.chief.observe(other)).reason, 'budget_exhausted');
  h.ledger.close();
});

test('dispatch revalidates freshness and configuration; canceled unsent work can be assigned under new policy', async () => {
  let now = NOW;
  const h = harness({ now: () => now });
  const first = await h.chief.observe(evidence());
  now += 60_001;
  assert.equal((await h.chief.dispatch(first.taskId!)).status, 'canceled');
  assert.equal(h.counts().sends, 0);
  const c = config(); c.policy.version = 'v2'; c.revision = 2;
  const newer = harness({ config: c, ledger: h.ledger });
  const second = await newer.chief.observe(evidence({ version: '2' }));
  assert.equal(second.outcome, 'reserved');
  assert.notEqual(second.taskId, first.taskId);
  assert.equal((await h.chief.observe(evidence({ version: '3', observedAt: now }))).reason, 'configuration_changed');
  assert.throws(() => harness({ config: config(), ledger: h.ledger }), /configuration_stale/);
  assert.throws(() => harness({ config: { ...c, repositories: ['acme/other'] }, ledger: h.ledger }), /configuration_revision_conflict/);
  h.ledger.close();
});

test('principal pin prevents credential or endpoint drift', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  h.relay.identity = async () => ({ origin: 'https://other.example', workspaceId: 'workspace-other', callerId: 'agent-chief' });
  await assert.rejects(h.chief.dispatch(decision.taskId!), /relay_scope_mismatch/);
  assert.equal(h.counts().sends, 0);
  h.ledger.bindRelay({ origin: 'https://relay.example', workspaceId: 'workspace-1', callerId: 'agent-chief' });
  h.relay.identity = async () => ({ origin: 'https://other.example', workspaceId: 'workspace-1', callerId: 'agent-chief' });
  await assert.rejects(h.chief.dispatch(decision.taskId!), /relay_identity_changed/);
  assert.throws(() => harness({ ledger: h.ledger, config: { ...config(), projectId: 'other' } }), /ledger_scope_mismatch/);
  h.ledger.close();
});

test('a worker completion claim cannot close work when verification fails', async () => {
  const h = harness({ verification: false });
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  const done = await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task) });
  assert.equal(done.status, 'awaiting_verification');
  assert.equal((await h.chief.observe(evidence({ sessionId: 'other', workKey: 'other' }))).reason, 'resource_claimed');
  h.ledger.close();
});

test('reports require exact sender, workspace, assignment, sequence and monotone state', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  for (const event of [
    { workspaceId: 'other', agentId: 'agent-worker', report: report(task) },
    { workspaceId: 'workspace-1', agentId: 'other', report: report(task) },
    { workspaceId: 'workspace-1', agentId: 'agent-worker', report: { ...report(task), assignmentDigest: '0'.repeat(64) } },
  ]) await assert.rejects(h.chief.receive(event), /report_identity_mismatch/);
  await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'running', 2) });
  await assert.rejects(h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'accepted', 3) }), /report_state_regression/);
  await assert.rejects(h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'completed', 2) }), /report_sequence_conflict/);
  await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'completed', 3) });
  assert.equal((await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task, 'completed', 3) })).status, 'completed');
  assert.equal(h.counts().verifications, 1);
  h.ledger.close();
});

test('source cursor advances only after durable decisions; deferred evidence is retried', async () => {
  let now = NOW;
  const c = config(); c.workers = [];
  const h = harness({ config: c, now: () => now });
  const source = { id: 'project-sessions-v1', read: async (cursor: string | undefined) => ({
    cursor: 'page-1', evidence: cursor ? [] : [evidence()],
  }) };
  assert.equal((await h.chief.scan(source))[0]?.reason, 'no_eligible_worker');
  assert.equal(h.ledger.cursor(source.id), 'page-1');
  const enabled = harness({ config: { ...config(), revision: 2 }, ledger: h.ledger, now: () => now });
  now += 30_001;
  assert.equal((await enabled.chief.scan(source))[0]?.outcome, 'reserved');
  assert.equal(enabled.counts().classifications, 0);
  await assert.rejects(enabled.chief.scan({ ...source, read: async () => ({ cursor: 'bad', evidence: [{ ...evidence(), sourceId: 'forged' }] }) }), /source_identity_mismatch/);
  assert.equal(h.ledger.cursor(source.id), 'page-1');
  h.ledger.close();
});

test('changing evidence under the same source version is rejected', async () => {
  const h = harness();
  await h.chief.observe(evidence());
  await assert.rejects(h.chief.observe(evidence({ summary: 'A different source body' })), /evidence_version_conflict/);
  h.ledger.close();
});

test('verification can recover on the next cycle without worker execution or a repeated report', async () => {
  const h = harness({ verification: false });
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  await h.chief.receive({ workspaceId: 'workspace-1', agentId: 'agent-worker', report: report(task) });
  const restarted = harness({ ledger: h.ledger, verification: true });
  assert.equal((await restarted.chief.verify(task.id)).status, 'completed');
  assert.equal(restarted.counts().sends, 0);
  assert.equal(restarted.counts().classifications, 0);
  h.ledger.close();
});

test('read-only inspection cannot create a missing database or modify an existing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-inspect-'));
  const path = join(dir, 'ledger.db');
  assert.throws(() => new Ledger(path, { readOnly: true }), /ledger_not_found/);
  const h = harness({ ledger: new Ledger(path) });
  await h.chief.observe(evidence());
  const reader = new Ledger(path, { readOnly: true });
  try {
    assert.equal(reader.tasks().length, 1);
    assert.throws(() => reader.configure(config()), /readonly/);
    assert.equal(h.ledger.tasks().length, 1);
  } finally { reader.close(); h.ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a no-dispatch cycle reserves work without sending it', async () => {
  const h = harness();
  const ports = { chief: h.chief, reports: { poll: async () => ({ processed: 0, rejected: 0 }) },
    source: { id: 'project-sessions-v1', read: async () => ({ cursor: 'page-1', evidence: [evidence()] }) } };
  const result = await runCycle(ports, { dispatch: false });
  assert.equal(result.dispatched, undefined);
  assert.equal(h.counts().sends, 0);
  assert.equal(h.ledger.tasks()[0]?.status, 'reserved');
  assert.equal((await runCycle({ ...ports, source: { ...ports.source, read: async () => ({ cursor: 'page-2', evidence: [] }) } }, { dispatch: true })).dispatched?.[0]?.status, 'delivered');
  assert.equal(h.counts().sends, 1);
  h.ledger.close();
});

test('dispatch halts on a ledger safety violation and keeps work reserved', async () => {
  const h = harness();
  const db = (h.ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db;
  const first = await h.chief.observe(evidence());
  const second = await h.chief.observe(evidence({ sessionId: 'session-2', workKey: 'issue-55', resourceKeys: ['issue-55'] }));
  db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(first.taskId!);
  await assert.rejects(h.chief.dispatchReserved(), /dispatch_halted/);
  assert.equal(h.counts().sends, 0);
  assert.equal(h.ledger.task(second.taskId!).status, 'reserved');
  db.prepare('UPDATE tasks SET digest=? WHERE id=?').run('0'.repeat(64), second.taskId!);
  assert.deepEqual(checkLedger(h.ledger, config()).violations, ['assignment_corrupt']);
  h.ledger.close();
});

test('a lowered policy is surfaced without halting dispatch', async () => {
  const h = harness();
  await h.chief.observe(evidence());
  await h.chief.observe(evidence({ sessionId: 'session-2', workKey: 'issue-55', resourceKeys: ['issue-55'] }));
  const lowered = config();
  lowered.policy.maxConcurrentTasks = 1;
  const check = checkLedger(h.ledger, lowered);
  assert.equal(check.ok, true);
  assert.deepEqual(check.attention, ['over_capacity']);
  h.ledger.close();
});

test('the ledger check reports tampering and surfaces uncertain sends without blocking', async () => {
  const h = harness({ relayError: true });
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  const clean = checkLedger(h.ledger, config());
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.attention, [`delivery_uncertain:${task.id}`]);
  (h.ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
    .prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.id);
  assert.deepEqual(checkLedger(h.ledger, config()).violations, [`completed_without_verification:${task.id}`]);
  h.ledger.close();
});

test('an assignment is registered before its send, and a failed registration sends nothing', async () => {
  const base = harness();
  const order: string[] = [];
  let failures = 1;
  const chief = new Chief(config(), base.ledger, { now: () => NOW,
    classifier: { classify: async () => ({ kind: 'blocked', confidence: 0.99 }) },
    verifier: { verify: async () => ({ ok: true, checks: ['check@rev'] }) },
    relay: { ...base.relay, send: async () => { order.push('send'); return { messageId: 'm-1' }; } },
    assignments: { register: async (_assignment, digest) => { order.push(`register:${digest}`); if (failures-- > 0) throw new Error('down'); } } });
  const { taskId } = await chief.observe(evidence());
  const blocked = await chief.dispatch(taskId!);
  assert.equal(blocked.status, 'reserved');
  await chief.dispatch(taskId!);
  assert.equal(base.ledger.task(taskId!).status, 'delivered');
  assert.deepEqual(order, [`register:${blocked.digest}`, `register:${blocked.digest}`, 'send']);
  await chief.dispatch(taskId!);
  assert.equal(order.length, 3, 'a sent task is neither registered nor sent again');
  assert.equal(base.ledger.decisions().filter(d => d.reason === 'assignment_registration_failed').length, 1);
  base.ledger.close();
});
