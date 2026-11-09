import type { Assignment } from '../src/contracts.js';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ControlPlaneClient } from '../src/control-plane.js';
import { JevClassifier } from '../src/jev.js';
import { RelayClient } from '../src/relay.js';
import { origin, requestJson } from '../src/http.js';
import { hash } from '../src/contracts.js';
import { provisionPlan } from '../src/provisioning.js';
import { readAssignment } from '../src/worker-protocol.js';
import { config, evidence, harness, NOW, report } from './helpers.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('Jev uses bounded closed choices; invalid answers and provider diagnostics fail closed', async () => {
  const calls: RequestInit[] = [];
  const classifier = new JevClassifier({ token: 'secret-sentinel', fetch: async (url, init) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    calls.push(init!);
    return json({ answers: { classification: { type: 'choice', choice: 'overlap', confidence: 0.9 } } });
  } });
  assert.deepEqual(await classifier.classify(evidence()), { kind: 'overlap', confidence: 0.9 });
  assert.equal(calls[0]?.redirect, 'error');
  const body = JSON.parse(calls[0]?.body as string);
  assert.equal(body.model, 'jev-latest');
  assert.ok(!body.state.includes('secret-sentinel'));
  assert.deepEqual(Object.keys(body.questions.classification.criteria), ['follow_up', 'overlap', 'blocked', 'no_action', 'uncertain']);
  for (const result of [
    { type: 'choice', choice: 'implement-anything', confidence: 1 },
    { type: 'choice', choice: 'overlap', confidence: 2 },
    { type: 'choice', choice: 'overlap' },
  ]) {
    await assert.rejects(new JevClassifier({ token: 'secret-sentinel', fetch: async () => json({ answers: { classification: result } }) }).classify(evidence()), /jev_answer_invalid/);
  }
  await assert.rejects(new JevClassifier({ token: 'secret-sentinel', fetch: async () => {
    throw new Error('secret-sentinel');
  } }).classify(evidence()), error => error instanceof Error && error.message === 'upstream_unavailable' && !String(error.stack).includes('secret-sentinel'));
});

test('transport refuses insecure, credential-bearing and reserved endpoints', () => {
  for (const value of ['http://relay.example', 'https://name:password@relay.example', 'https://relay.example/path',
    'https://relay.example?token=secret', 'file:///tmp/relay', 'http://localhost:3000', 'http://127.0.0.1:3737']) {
    assert.throws(() => origin(value));
  }
  assert.equal(origin('http://127.0.0.1:4001'), 'http://127.0.0.1:4001');
  assert.equal(origin('https://relay.example/'), 'https://relay.example');
});

test('bounded HTTP responses and provider errors do not leak response bodies', async () => {
  for (const response of [new Response('credential-secret', { status: 403 }),
    new Response('not-json-credential-secret'), new Response('x'.repeat(1_048_577))]) {
    await assert.rejects(requestJson(new URL('https://example.com'), {}, async () => response), /upstream_unavailable/);
  }
});

test('Relay sends one structured assignment with a stable idempotency key and no local execution', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = h.ledger.task(decision.taskId!);
  let sends = 0;
  const relay = new RelayClient({ token: 'secret-sentinel', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/agent') return json({ ok: true, data: { id: 'agent-chief', workspace_id: 'workspace-1' } });
    assert.equal(path, '/v1/dm'); sends++;
    assert.equal((init?.headers as Record<string, string>)['Idempotency-Key'], task.id);
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.mode, 'wait');
    assert.equal(body.address, 'worker@host');
    assert.equal(body.data.assignment_digest, hash(body.data.chief_assignment));
    assert.equal(body.data.chief_assignment.evidenceDigest, hash(evidence()));
    return json({ ok: true, data: { message: { id: 'message-id', agent_id: 'agent-chief' } } });
  } });
  await relay.identity();
  assert.deepEqual(await relay.send(task.assignment, task.digest), { messageId: 'message-id' });
  assert.equal(sends, 1);
  h.ledger.close();
});

test('verification uses the configured authority and exact task/digest/sequence, never a worker URL', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = h.ledger.task(decision.taskId!);
  const done = report(task);
  let calls = 0;
  const plane = new ControlPlaneClient({ baseUrl: 'https://control.example', token: 'secret-sentinel', config: config(),
    fetch: async url => { assert.equal(new URL(String(url)).origin, 'https://control.example'); calls++;
      return json({ taskId: task.id, assignmentDigest: '0'.repeat(64), sequence: 1, ok: true, checks: ['passed'] }); } });
  await assert.rejects(plane.verify(task.assignment, { ...done, artifactRefs: ['http://169.254.169.254/latest/meta-data/'] }), /verification_identity_mismatch/);
  assert.equal(calls, 1);
  h.ledger.close();
});

test('execution-side protocol refuses wrong principals, changed scope, stale evidence and modified payloads', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = h.ledger.task(decision.taskId!);
  const delivery = { workspaceId: 'workspace-1', senderAgentId: 'agent-chief', recipientAgentId: 'agent-worker', recipientAddress: 'worker@host' };
  const policy = { chiefAgentId: 'agent-chief', chiefId: 'chief-1', organizationId: 'org-1', projectId: 'project-1',
    repositories: ['acme/project'], actions: ['unblock' as const], maxReservationMicros: 1_000_000, maxEvidenceAgeMs: 60_000 };
  const raw = { chief_assignment: task.assignment, assignment_digest: task.digest };
  assert.equal(readAssignment(delivery, raw, policy, NOW).digest, task.digest);
  assert.throws(() => readAssignment({ ...delivery, senderAgentId: 'other' }, raw, policy, NOW), /worker_assignment_not_authorized/);
  assert.throws(() => readAssignment(delivery, raw, policy, NOW + 60_001), /worker_assignment_not_authorized/);
  assert.throws(() => readAssignment(delivery, { ...raw, chief_assignment: { ...task.assignment, action: 'investigate' } }, policy, NOW), /worker_assignment_not_authorized/);
  assert.throws(() => readAssignment(delivery, raw, { ...policy, projectId: 'other' }, NOW), /worker_assignment_not_authorized/);
  h.ledger.close();
});

test('setup plans are deterministic and contain resource tags, references to credentials and explicit rollout gates', () => {
  const request = { requestId: 'setup-1', config: config(), placement: 'default', sizeClass: 'small' };
  const plan = provisionPlan(request);
  assert.deepEqual(provisionPlan(request), plan);
  assert.equal(plan.compute.publicAccess, false);
  assert.equal(plan.compute.hostCredentialIsolation, 'required');
  assert.equal(plan.compute.labels['relay:chief-id'], 'chief-1');
  assert.equal(plan.runtime.implementationCapability, false);
  assert.ok(plan.approvalRequired.includes('iam'));
  assert.throws(() => provisionPlan({ ...request, config: { ...config(), token: 'secret' } }));
});

test('accounting is scoped, idempotent, separate from reservations, and preserves unknown costs', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const event = { eventId: 'invoice-line-1', chiefId: 'chief-1', workspaceId: 'workspace-1', taskId: decision.taskId,
    actor: 'worker', provider: 'anthropic', providerIdentityId: 'apikey-id-only', occurredAt: NOW,
    costMicros: 125_000, inputTokens: 2000, outputTokens: 1000 };
  h.ledger.usage(event); h.ledger.usage(event);
  h.ledger.usage({ ...event, eventId: 'jev-1', actor: 'classifier', provider: 'typesafe', costMicros: null, inputTokens: null, outputTokens: null });
  assert.deepEqual(h.ledger.accounting(), { knownCostMicros: 125_000, unknownCostEvents: 1, events: 2, committedReservationMicros: 1_000_000 });
  assert.throws(() => h.ledger.usage({ ...event, costMicros: 0 }), /usage_event_conflict/);
  assert.throws(() => h.ledger.usage({ ...event, chiefId: 'other' }), /usage_scope_mismatch/);
  assert.throws(() => h.ledger.usage({ ...event, actor: 'worker', taskId: undefined }), /usage_task_required/);
  h.ledger.usage({ ...event, eventId: 'optional-metadata', actor: 'chief', taskId: undefined, providerIdentityId: undefined, costMicros: 0 });
  assert.equal(h.ledger.accounting().events, 3);
  h.ledger.close();
});

test('report polling never checkpoints an unexpected storage failure and durably quarantines invalid reports', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  const messageId = '1000000000000000001';
  let payload = report(task);
  const relay = new RelayClient({ token: 'local-token', baseUrl: 'https://relay.example', fetch: async url => {
    const request = new URL(String(url));
    if (request.pathname === '/v1/agent') return json({ ok: true, data: { id: 'agent-chief', workspace_id: 'workspace-1' } });
    if (request.pathname.endsWith('/conversations')) return json({ ok: true, data: [{ id: 'dm-1', type: '1:1',
      participants: [{ agent_id: 'agent-chief' }, { agent_id: 'agent-worker' }] }] });
    return json({ ok: true, data: [{ id: messageId, agent_id: 'agent-worker', metadata: { chief_report: payload } }] });
  } });
  const receive = h.chief.receive.bind(h.chief);
  h.chief.receive = async () => { throw new Error('sqlite_disk_unavailable'); };
  await assert.rejects(relay.poll(h.chief), /sqlite_disk_unavailable/);
  const key = 'relay:https://relay.example:dm-1';
  assert.equal(h.ledger.cursor(key), undefined);
  h.chief.receive = receive;
  payload = { ...payload, assignmentDigest: '0'.repeat(64) };
  const result = await relay.poll(h.chief);
  assert.deepEqual(result, { processed: 0, rejected: 1 });
  assert.equal(h.ledger.cursor(key), messageId);
  assert.ok(h.ledger.decisions().some(d => d.reason === 'relay_report_rejected'));
  assert.equal(h.ledger.task(task.id).status, 'delivered');
  h.ledger.close();
});

test('report polling drains descending pages oldest first without skipping a full page', async () => {
  const h = harness();
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  const messages = Array.from({ length: 105 }, (_, i) => ({
    id: String(1_000_000_000_000_000_000n + BigInt(i + 1)), agent_id: 'agent-worker',
    metadata: { chief_report: report(task, i === 104 ? 'completed' : 'running', i + 1) },
  }));
  let pages = 0;
  const relay = new RelayClient({ token: 'local-token', baseUrl: 'https://relay.example', fetch: async url => {
    const request = new URL(String(url));
    if (request.pathname === '/v1/agent') return json({ ok: true, data: { id: 'agent-chief', workspace_id: 'workspace-1' } });
    if (request.pathname.endsWith('/conversations')) return json({ ok: true, data: [{ id: 'dm-1', type: '1:1',
      participants: [{ agent_id: 'agent-chief' }, { agent_id: 'agent-worker' }] }] });
    pages++;
    const after = request.searchParams.get('after'); const before = request.searchParams.get('before');
    return json({ ok: true, data: messages.filter(m => (!after || m.id > after) && (!before || m.id < before)).reverse().slice(0, 100) });
  } });
  assert.deepEqual(await relay.poll(h.chief), { processed: 105, rejected: 0 });
  assert.equal(pages, 2);
  assert.equal(h.ledger.task(task.id).status, 'completed');
  assert.equal(h.counts().verifications, 1);
  assert.deepEqual(await relay.poll(h.chief), { processed: 0, rejected: 0 });
  h.ledger.close();
});

test('relay checks its own workspace while reports stay in the control workspace', async () => {
  const h = harness({ config: { ...config(), relayWorkspaceId: '245411583121604608' } });
  const decision = await h.chief.observe(evidence());
  const task = await h.chief.dispatch(decision.taskId!);
  assert.equal(task.assignment.workspaceId, 'workspace-1');
  const relayWith = (workspace: string) => new RelayClient({ token: 'local-token', baseUrl: 'https://relay.example',
    workspaceId: '245411583121604608', fetch: async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/agent') return json({ ok: true, data: { id: 'agent-chief', workspace_id: workspace } });
      if (request.pathname.endsWith('/conversations')) return json({ ok: true, data: [{ id: 'dm-1', type: '1:1',
        participants: [{ agent_id: 'agent-chief' }, { agent_id: 'agent-worker' }] }] });
      return json({ ok: true, data: [{ id: '1000000000000000001', agent_id: 'agent-worker',
        metadata: { chief_report: report(task, 'completed') } }] });
    } });
  await assert.rejects(relayWith('workspace-1').poll(h.chief), /relay_/);
  await assert.rejects(relayWith('245999999999999999').poll(h.chief), /relay_/);
  assert.equal(h.ledger.task(task.id).status, 'delivered');
  assert.deepEqual(await relayWith('245411583121604608').poll(h.chief), { processed: 1, rejected: 0 });
  assert.equal(h.ledger.task(task.id).status, 'completed');
  h.ledger.close();
});

test('a chief refuses to dispatch when relay reports another workspace', async () => {
  const h = harness({ config: { ...config(), relayWorkspaceId: 'relay-workspace' } });
  const decision = await h.chief.observe(evidence());
  h.relay.identity = async () => ({ origin: 'https://relay.example', workspaceId: 'workspace-1', callerId: 'agent-chief' });
  await assert.rejects(h.chief.dispatch(decision.taskId!), /relay_scope/);
  assert.equal(h.counts().sends, 0);
  h.ledger.close();
});

test('the reference systemd unit does not dispatch by default', () => {
  const unit = readFileSync('deploy/relay-chief.service', 'utf8');
  const exec = unit.split('\n').find(line => line.startsWith('ExecStart='));
  assert.ok(exec?.endsWith('$RELAY_CHIEF_RUN_FLAGS'));
  assert.ok(!exec?.includes('--dispatch'));
});

test('the provisioning contract names no cloud', () => {
  const plan = JSON.stringify(provisionPlan({ requestId: 'setup-1', config: config(), placement: 'default', sizeClass: 'small' }));
  assert.doesNotMatch(plan, /ec2|aws|t4g|arm64|metadataTokens/i);
  assert.throws(() => provisionPlan({ requestId: 'setup-1', config: config(), region: 'us-east-1', instanceType: 't4g.small' }));
});

test('assignment registration sends the exact digest and treats a conflict as failure', async () => {
  const c = config();
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 201;
  const client = new ControlPlaneClient({ baseUrl: 'https://control.example', token: 'tok', config: c,
    fetch: (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response('{}', { status }); }) as typeof fetch });
  const assignment = { taskId: 'task/1' } as Assignment;
  const digest = hash(assignment);
  await client.register(assignment, digest);
  assert.equal(calls[0]?.url, 'https://control.example/chief/v1/projects/project-1/tasks/task%2F1/assignment');
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { assignmentDigest: digest, assignment });
  status = 409;
  await assert.rejects(client.register(assignment, hash({ taskId: 'task/2' })));
});
