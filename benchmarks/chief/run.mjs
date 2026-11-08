#!/usr/bin/env node
// Real Flows runtime benchmark against a local fake of Relay, Control and Jev. No cloud or model calls.
// Usage: node benchmarks/chief/run.mjs [--reps N] [--out report.json]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, checkLedger } from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const FLOWS = join(root, 'flows/node_modules/.bin/flows');
const FLOW = join(root, 'flows/chief-cycle.flow.ts');
const CLI = join(here, 'fixture-cli.mjs');
const argValue = (flag, fallback) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : fallback; };
const REPS = Number(argValue('--reps', 3));
if (!Number.isInteger(REPS) || REPS < 1) throw new Error('--reps must be a positive integer');
const OUT = argValue('--out');
const STRUCTURES = ['direct', 'monolith', 'phased', 'gated'];
const FIRINGS = 4;
// Flows reports a local run to Cloud whenever a Cloud login exists, so run it with no login at all.
const LOCAL_ENV = { ...process.env, NODE_NO_WARNINGS: '1', HOME: mkdtempSync(join(tmpdir(), 'chief-bench-home-')), FLOWS_NO_OBSERVER: '1' };
for (const name of Object.keys(LOCAL_ENV)) if (/^(FLOWS_CLOUD_|RELAYCAST_WORKSPACE|AGENT_RELAY_)/.test(name)) delete LOCAL_ENV[name];

const work = (n, extra = {}) => ({ sessionId: `s-${n}`, workKey: `issue-${n}`, resourceKeys: [`issue-${n}`, `src/${n}.ts`], ...extra });
const SCENARIOS = {
  happy: { batches: [[work(1), work(2), work(3)]], expectPosts: 3 },
  duplicate_evidence: { batches: [[work(1), work(1, { sessionId: 's-1b' }), work(2)]], expectPosts: 2 },
  lost_ack: { batches: [[work(1), work(2), work(3)]], lostAck: 1, expectPosts: 3 },
  // Deferred evidence backs off for longer than this window, so only the unaffected task is sent.
  classifier_outage: { batches: [[work(1), work(2), work(3)]], jevFailures: 2, expectPosts: 1 },
  crash_on_send: { batches: [[work(1), work(2), work(3)]], crashOnPost: 1, expectPosts: 3 },
  // Corrupts state the chief's own guards do not read, then offers new work.
  poisoned_ledger: { batches: [[work(1)], [work(2)]], poisonAfterFiring: 1, expectPosts: 1 },
};

function fixture(scenario, hooks) {
  const posts = new Map();
  const messages = [];
  const assignments = new Map();
  let jevFailures = scenario.jevFailures ?? 0;
  let posted = 0;
  let classifications = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (data, envelope = true, status = 200) => {
      response.statusCode = status; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(envelope ? { ok: true, data } : data));
    };
    if (url.pathname === '/v1/systemone') {
      classifications++;
      if (jevFailures-- > 0) return send({ error: 'unavailable' }, false, 503);
      return send({ answers: { classification: { type: 'choice', choice: 'blocked', confidence: 0.99 } } }, false);
    }
    if (url.pathname.endsWith('/evidence')) {
      const index = Number((url.searchParams.get('cursor') ?? 'page-0').slice(5));
      const evidence = (scenario.batches[index] ?? []).map(item => ({ sourceId: 'project-sessions-v1', version: '1',
        organizationId: 'org-1', workspaceId: 'workspace-1', projectId: 'project-1', repository: 'acme/project',
        observedAt: Date.now(), summary: 'Assigned work is blocked by a failing test.',
        references: ['https://github.com/acme/project/issues/1'], ...item }));
      return send({ cursor: `page-${scenario.batches[index] ? index + 1 : index}`, evidence }, false);
    }
    if (url.pathname.endsWith('/verification')) {
      const taskId = decodeURIComponent(url.pathname.split('/').at(-2));
      return send({ taskId, assignmentDigest: assignments.get(taskId), sequence: Number(url.searchParams.get('sequence')), ok: true, checks: ['fixture-check@rev'] }, false);
    }
    if (url.pathname === '/v1/agent') return send({ id: 'agent-chief', workspace_id: 'workspace-1' });
    if (url.pathname === '/v1/dm/conversations') {
      return send(messages.length ? [{ id: 'conversation-1', type: '1:1', participants: [{ agent_id: 'agent-chief' }, { agent_id: 'agent-worker' }] }] : []);
    }
    if (url.pathname === '/v1/dm/conversation-1/messages') {
      const after = url.searchParams.get('after');
      const before = url.searchParams.get('before');
      return send(messages.filter(m => (!after || m.id > after) && (!before || m.id < before)).slice().reverse().slice(0, 100));
    }
    if (url.pathname === '/v1/dm' && request.method === 'POST') {
      posted++;
      const { taskId } = body.data.chief_assignment;
      posts.set(taskId, (posts.get(taskId) ?? 0) + 1);
      assignments.set(taskId, body.data.assignment_digest);
      const report = (sequence, state) => messages.push({ id: String(1_000_000_000_000_000_000n + BigInt(messages.length + 1)), agent_id: 'agent-worker',
        metadata: { chief_report: { protocol: 'relay-chief.report.v1', taskId, assignmentDigest: body.data.assignment_digest, sequence, state, artifactRefs: [] } } });
      report(1, 'accepted'); report(2, 'completed');
      if (scenario.crashOnPost === posted) { await hooks.crash(); return; }
      if (scenario.lostAck === posted) { request.socket.destroy(); return; }
      return send({ conversation_id: 'conversation-1', message: { id: `posted-${posted}`, agent_id: 'agent-chief' }, delivery: null });
    }
    response.statusCode = 404; response.end();
  });
  return { server, posts, total: () => posted, classifications: () => classifications };
}

function exec(file, args, options = {}) {
  return new Promise(done => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: LOCAL_ENV });
    options.onChild?.(child);
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, options.timeout ?? 90_000);
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code, signal, output }); });
  });
}
const killPid = pid => { if (!(pid > 1)) return; try { process.kill(pid, 'SIGKILL'); } catch {} };
const readPid = path => { try { return Number(readFileSync(path, 'utf8')); } catch { return 0; } };

async function trial(structure, name) {
  const scenario = SCENARIOS[name];
  const dir = mkdtempSync(join(tmpdir(), 'chief-bench-'));
  const data = join(dir, 'flows');
  const pidfile = join(dir, 'step.pid');
  const database = join(dir, 'chief.db');
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ revision: 1, chiefId: 'chief-1', organizationId: 'org-1', workspaceId: 'workspace-1', projectId: 'project-1',
    relayCallerId: 'agent-chief', repositories: ['acme/project'],
    workers: [{ agentId: 'agent-worker', address: 'worker@host', actions: ['investigate', 'coordinate', 'unblock'] }],
    policy: { version: 'v1', allowedActions: ['investigate', 'coordinate', 'unblock'], maxEvidenceAgeMs: 3_600_000, minConfidence: 0.8,
      maxConcurrentTasks: 5, budgetMicros: 100_000_000, taskReservationMicros: 1_000_000 } }));
  let current;
  let crashed = false;
  const daemonPid = () => { try { return JSON.parse(readFileSync(join(data, 'connection.json'), 'utf8')).pid; } catch { return 0; } };
  const hooks = { crash: async () => {
    crashed = true;
    // Environment loss: the step, the CLI and the daemon all die together.
    killPid(readPid(pidfile)); killPid(daemonPid());
    if (current?.pid) { try { process.kill(-current.pid, 'SIGKILL'); } catch {} }
  } };
  const fake = fixture(scenario, hooks);
  await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  const cliArgs = ['--base', base, '--pidfile', pidfile];
  const shellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  const cli = [process.execPath, CLI, ...cliArgs].map(shellQuote).join(' ');
  const onChild = child => { current = child; };
  const runsDir = join(data, 'runs');
  const listRuns = () => existsSync(runsDir) ? readdirSync(runsDir).filter(f => f.endsWith('.sqlite3')).map(f => f.slice(0, -8)) : [];
  const fire = async () => {
    if (structure === 'direct') return exec(process.execPath, [CLI, ...cliArgs, 'run-once', configPath, database, '--dispatch'], { onChild });
    const before = new Set(listRuns());
    const input = JSON.stringify({ cli, config: configPath, ledger: database, structure, dispatch: true });
    const result = await exec(FLOWS, ['run', '--no-observer-link', '--data-dir', data, FLOW, '--input', input], { onChild });
    if (crashed && result.signal) {
      crashed = false;
      const rootRun = listRuns().filter(id => !before.has(id)).sort()[0];
      const started = performance.now();
      const resumed = await exec(FLOWS, ['resume', '--no-observer-link', '--data-dir', data, rootRun], { onChild });
      return { ...resumed, resumed: true, resumeMs: performance.now() - started };
    }
    return result;
  };
  const firings = [];
  const out = { structure, scenario: name, firingMs: [], failedFirings: 0, resumed: false, resumeOk: undefined };
  try {
    for (let i = 1; i <= FIRINGS; i++) {
      const started = performance.now();
      const result = await fire();
      out.firingMs.push(performance.now() - started);
      if (result.resumed) { out.resumed = true; out.resumeOk = result.code === 0; out.resumeMs = Math.round(result.resumeMs); }
      if (/Dashboard: https?:|\/cloud\/dashboard\//.test(result.output) || existsSync(join(data, 'cloud-runs')) && readdirSync(join(data, 'cloud-runs')).length) {
        throw new Error('benchmark_run_reached_cloud');
      }
      if (result.code !== 0) { out.failedFirings++; firings.push(result.output.slice(-400)); }
      if (scenario.poisonAfterFiring === i) {
        const db = new DatabaseSync(database);
        db.exec("UPDATE tasks SET status='completed', verification=NULL");
        db.close();
      }
    }
    if (existsSync(database)) {
      const ledger = new Ledger(database, { readOnly: true });
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      out.check = checkLedger(ledger, config);
      out.statuses = ledger.tasks().map(t => t.status).sort();
      ledger.close();
    } else {
      out.check = { ok: false, violations: ['ledger_never_created'], attention: [] };
      out.statuses = [];
    }
    out.posts = fake.total();
    out.maxPostsPerTask = Math.max(0, ...fake.posts.values());
    out.classifications = fake.classifications();
    out.unsafeDispatches = scenario.poisonAfterFiring ? Math.max(0, fake.total() - scenario.expectPosts) : 0;
    out.errors = firings;
  } finally {
    killPid(daemonPid());
    fake.server.closeAllConnections();
    await new Promise(r => fake.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };

mkdirSync(tmpdir(), { recursive: true });
const trials = [];
for (const name of Object.keys(SCENARIOS)) {
  for (const structure of STRUCTURES) {
    for (let rep = 0; rep < REPS; rep++) {
      const result = await trial(structure, name);
      trials.push(result);
      console.error(`${name} ${structure} #${rep}: posts=${result.posts} max=${result.maxPostsPerTask} failed=${result.failedFirings} statuses=${result.statuses} ${result.errors?.[0] ?? ''}`);
    }
  }
}
const summary = [];
for (const structure of STRUCTURES) {
  const own = trials.filter(t => t.structure === structure);
  const happy = own.filter(t => t.scenario === 'happy').flatMap(t => t.firingMs);
  summary.push({ structure, trials: own.length,
    duplicateSends: own.filter(t => t.maxPostsPerTask > 1).length,
    safetyViolationsAtEnd: own.filter(t => t.scenario !== 'poisoned_ledger' && !t.check.ok).length,
    wrongPostCount: own.filter(t => t.scenario !== 'poisoned_ledger' && t.posts !== SCENARIOS[t.scenario].expectPosts).length,
    incomplete: own.filter(t => t.scenario !== 'poisoned_ledger' && t.statuses.some(s => s !== 'completed')).length,
    unsafeDispatchesAfterPoison: own.filter(t => t.scenario === 'poisoned_ledger').reduce((n, t) => n + t.unsafeDispatches, 0),
    resumeFailures: own.filter(t => t.resumed && !t.resumeOk).length,
    firingMedianMs: Math.round(percentile(happy, 0.5)), firingP95Ms: Math.round(percentile(happy, 0.95)) });
}
const flowsVersion = JSON.parse(readFileSync(join(root, 'flows/node_modules/relayflows/package.json'), 'utf8')).version;
const report = { flowsVersion, node: process.version, platform: `${process.platform}-${process.arch}`, reps: REPS, firings: FIRINGS, summary, trials };
if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
rmSync(LOCAL_ENV.HOME, { recursive: true, force: true });
