import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.js';
import { provisionPlan } from '../src/provisioning.js';
import { hash } from '../src/contracts.js';
import { config, evidence } from './helpers.js';

const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;
const exec = promisify(execFile);
const execute: typeof exec = ((file: string, args: string[], options: object = {}) =>
  exec(file, args, { ...options, env: childEnvironment })) as typeof exec;

test('local customer journey: setup → scan → Relay → isolated worker → restart → verified completion', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-chief-proof-'));
  const workerDirectory = join(root, 'execution-worker');
  mkdirSync(workerDirectory);
  writeFileSync(join(workerDirectory, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  writeFileSync(join(workerDirectory, 'sum.test.mjs'), `import { strict as assert } from 'node:assert';
import { test } from 'node:test'; import { sum } from './sum.mjs';
test('sum adds both positive and negative operands', () => { assert.equal(sum(2,3),5); assert.equal(sum(-2,3),1); });\n`);
  const before = await execute(process.execPath, ['--test', join(workerDirectory, 'sum.test.mjs')]).then(() => false, () => true);
  assert.equal(before, true, 'the execution project starts with a real failing test');
  const c = config();
  writeFileSync(join(root, 'config.json'), JSON.stringify(c));
  const configPath = join(root, 'config.json');
  const database = join(root, 'chief.db');
  const assignmentPath = join(root, 'assignment.json');
  let posts = 0;
  let classifications = 0;
  let checks = 0;
  let setupCalls = 0;
  let assigned: { chief_assignment: Record<string, unknown>; assignment_digest: string } | undefined;
  const messages: { id: string; agent_id: string; metadata: unknown }[] = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://127.0.0.1');
      requests.push(`${request.method} ${url.pathname}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const auth = request.headers.authorization;
      const json = (data: unknown, envelope = true) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(envelope ? { ok: true, data } : data)); };
      if (url.pathname === '/setup' && request.method === 'POST') {
        assert.equal(auth, 'Bearer local-customer-token');
        setupCalls++;
        json(provisionPlan(body), false); return;
      }
      if (url.pathname === '/v1/systemone') {
        assert.equal(auth, 'Bearer local-jev-token');
        assert.equal(body.model, 'jev-latest');
        assert.equal(body.questions.classification.type, 'choice');
        assert.ok(body.questions.classification.criteria.uncertain);
        classifications++;
        json({ answers: { classification: { type: 'choice', choice: 'blocked', confidence: 0.99 } } }, false); return;
      }
      if (url.pathname.startsWith('/chief/v1/')) {
        assert.equal(auth, 'Bearer local-control-plane-token');
        if (url.pathname.endsWith('/evidence')) {
          json({ cursor: 'page-1', evidence: url.searchParams.has('cursor') ? [] : [
            evidence({ observedAt: Date.now() }), evidence({ sessionId: 'session-2', observedAt: Date.now() }),
          ] }, false); return;
        }
        if (url.pathname.endsWith('/verification')) {
          checks++;
          assert.ok(assigned);
          const taskId = assigned.chief_assignment.taskId;
          assert.ok(url.pathname.includes(String(taskId)));
          assert.equal(url.searchParams.get('sequence'), '3');
          // This authority independently executes checks; it does not trust worker prose.
          const run = await execute(process.execPath, ['--test', join(workerDirectory, 'sum.test.mjs')]);
          assert.match(run.stdout, /pass 1/);
          json({ taskId, assignmentDigest: assigned.assignment_digest, sequence: 3, ok: true,
            checks: [`fixture-node-test:${hash(readFileSync(join(workerDirectory, 'sum.mjs'), 'utf8'))}`] }, false); return;
        }
      }
      assert.ok(auth === 'Bearer local-chief-token' || auth === 'Bearer local-worker-token');
      if (url.pathname === '/v1/agent') { json({ id: 'agent-chief', workspace_id: 'workspace-1' }); return; }
      if (url.pathname === '/v1/dm/conversations') {
        json(assigned ? [{ id: 'conversation-1', type: '1:1', participants: [{ agent_id: 'agent-chief' }, { agent_id: 'agent-worker' }] }] : []); return;
      }
      if (url.pathname === '/v1/dm/conversation-1/messages') {
        const after = url.searchParams.get('after');
        const beforeId = url.searchParams.get('before');
        json(messages.filter(m => (!after || m.id > after) && (!beforeId || m.id < beforeId)).slice().reverse().slice(0, 100)); return;
      }
      if (url.pathname === '/v1/dm' && request.method === 'POST') {
        if (auth === 'Bearer local-chief-token') {
          posts++;
          assert.equal(body.address, 'worker@host');
          assert.equal(request.headers['idempotency-key'], body.data.chief_assignment.taskId);
          assigned = body.data;
          writeFileSync(assignmentPath, JSON.stringify(body.data));
          // Admit work, then lose the POST acknowledgment. The restarted chief must not resend.
          request.socket.destroy(); return;
        }
        assert.equal(body.to, 'chief');
        const id = String(1_000_000_000_000_000_000n + BigInt(messages.length + 1));
        messages.push({ id, agent_id: 'agent-worker', metadata: body.data });
        json({ conversation_id: 'conversation-1', message: { id, agent_id: 'agent-worker' }, delivery: null }); return;
      }
      response.statusCode = 404; response.end();
    } catch {
      response.statusCode = 500; response.end(JSON.stringify({ error: 'local_fixture_assertion_failed' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string' && address.port !== 3737);
  const base = `http://127.0.0.1:${address.port}`;
  const cycle = async () => {
    const result = await execute(process.execPath, ['--import', 'tsx', resolve('test/fixtures/cycle.ts'), configPath, database, base], { cwd: resolve('.'), timeout: 10_000 });
    for (const token of ['local-chief-token', 'local-worker-token', 'local-control-plane-token', 'local-jev-token']) assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    return JSON.parse(result.stdout) as { tasks: { id: string; status: string }[]; decisions: { outcome: string }[]; reports: { processed: number } };
  };
  try {
    const setup = { requestId: 'customer-setup-1', config: c, region: 'us-east-1', instanceType: 't4g.small' };
    const setupRequest = async () => (await fetch(`${base}/setup`, { method: 'POST', headers: {
      authorization: 'Bearer local-customer-token', 'content-type': 'application/json',
    }, body: JSON.stringify(setup) })).json() as Promise<ReturnType<typeof provisionPlan>>;
    const plan = await setupRequest();
    assert.deepEqual(await setupRequest(), plan);
    assert.equal(plan.compute.tags['relay:chief-id'], c.chiefId);
    assert.equal(plan.runtime.implementationCapability, false);
    assert.deepEqual(plan.approvalRequired, ['deployment', 'iam', 'secret_bindings']);
    t.diagnostic('Customer setup produces a stable, tagged EC2 plan; no AWS API is called.');
    const first = await cycle();
    assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0]?.status, 'uncertain');
    assert.deepEqual(first.decisions.map(d => d.outcome), ['reserved', 'duplicate']);
    assert.equal(posts, 1);
    assert.equal(classifications, 2);
    assert.equal(readFileSync(join(workerDirectory, 'sum.mjs'), 'utf8'), 'export const sum = (a, b) => a - b;\n');
    t.diagnostic('Two sessions produce one Relay assignment. Lost acknowledgment retains the claim.');
    const restarted = await cycle();
    assert.equal(restarted.tasks[0]?.status, 'uncertain');
    assert.equal(posts, 1);
    t.diagnostic('A fresh chief process resumes the ledger and does not repeat the POST.');
    const worker = await execute(process.execPath, ['--import', 'tsx', resolve('test/fixtures/worker.ts'), assignmentPath, workerDirectory, base]);
    assert.match(worker.stdout, /implementation and local checks passed/);
    const duplicate = await execute(process.execPath, ['--import', 'tsx', resolve('test/fixtures/worker.ts'), assignmentPath, workerDirectory, base]);
    assert.match(duplicate.stdout, /duplicate assignment refused/);
    assert.equal(messages.length, 3);
    const completed = await cycle();
    assert.equal(completed.tasks[0]?.status, 'completed');
    assert.equal(completed.reports.processed, 3);
    assert.equal(checks, 1);
    t.diagnostic('A separate worker fixes a real failing test and reports over HTTP Relay; independent checks verify completion.');
    const replayed = await cycle();
    assert.equal(replayed.reports.processed, 0);
    assert.equal(posts, 1);
    assert.equal(checks, 1);
    assert.equal(classifications, 2);
    assert.equal(setupCalls, 2);
    assert.ok(requests.every(path => !/spawn|task\.run|exec|shell/.test(path)));
    const ledger = new Ledger(database);
    assert.equal(ledger.tasks()[0]?.verification?.ok, true);
    assert.equal(ledger.cursor('project-sessions-v1'), 'page-1');
    // Synthetic provider accounting demonstrates attribution without a paid API call.
    ledger.usage({ eventId: 'fixture-provider-line-1', chiefId: c.chiefId, workspaceId: c.workspaceId,
      taskId: ledger.tasks()[0]!.id, actor: 'worker', provider: 'anthropic', providerIdentityId: 'fixture-api-key-id',
      occurredAt: Date.now(), costMicros: 125_000, inputTokens: 1000, outputTokens: 500 });
    assert.equal(ledger.accounting().knownCostMicros, 125_000);
    assert.equal(ledger.accounting().committedReservationMicros, 1_000_000);
    ledger.close();
    t.diagnostic('Final proof: one dispatch, one worker execution, one verification, durable cursors, attributed synthetic usage, no repeated provider call.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
