// Seeded fault simulation over fake adapters. No network, cloud or model calls.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Chief } from '../src/chief.js';
import type { Assignment, EvidenceSource, Task } from '../src/contracts.js';
import type { CyclePorts, Phase } from '../src/cycle.js';
import { PHASES, runPhase } from '../src/cycle.js';
import { checkLedger } from '../src/invariants.js';
import { Ledger } from '../src/ledger.js';
import { config, evidence, NOW } from './helpers.js';

class Crash extends Error {}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Structure = 'monolith' | 'phased';
type Mutant = 'none' | 'replay_uncertain' | 'send_before_claim';
const DIRECTORY = mkdtempSync(join(tmpdir(), 'relay-chief-sim-'));
after(() => rmSync(DIRECTORY, { recursive: true, force: true }));
const TERMINAL_KINDS = ['blocked', 'follow_up', 'overlap', 'no_action', 'uncertain'] as const;

async function simulate(seed: number, structure: Structure, mutant: Mutant = 'none') {
  const random = rng(seed);
  const chance = (p: number) => random() < p;
  const base = config();
  const cfg = { ...base, policy: { ...base.policy, budgetMicros: 100_000_000, maxEvidenceAgeMs: 3_600_000 } };
  const path = join(DIRECTORY, `${seed}-${structure}-${mutant}.db`);
  let crashingSend = false;
  // A crash between the send and persisting its outcome leaves the task in `sending`.
  const open = () => {
    const opened = new Ledger(path);
    const delivery = opened.delivery.bind(opened);
    opened.delivery = (...args) => {
      if (crashingSend) throw new Crash();
      if (chance(0.05)) { crashingSend = true; crashes++; throw new Crash(); }
      delivery(...args);
    };
    return opened;
  };
  let crashes = 0;
  let ledger = open();
  let clock = NOW;
  const sends = new Map<string, number>();
  const breaches: string[] = [];
  const reports = new Map<string, { digest: string; next: number }>();
  let batch: ReturnType<typeof evidence>[] = [];
  let cursor = 0;
  const sendOne = async (assignment: Assignment) => {
    const status = ledger.task(assignment.taskId).status;
    if (status !== 'sending') breaches.push(`send_without_claim:${status}`);
    sends.set(assignment.taskId, (sends.get(assignment.taskId) ?? 0) + 1);
  };
  const source: EvidenceSource = { id: 'project-sessions-v1', read: async () => ({ cursor: `page-${++cursor}`, evidence: batch }) };
  const makeChief = () => new Chief(cfg, ledger, {
    now: () => clock,
    classifier: { classify: async () => {
      if (chance(0.15)) throw new Error('unavailable');
      return { kind: TERMINAL_KINDS[Math.floor(random() * TERMINAL_KINDS.length)]!, confidence: 0.5 + random() / 2 };
    } },
    verifier: { verify: async () => { if (chance(0.15)) throw new Error('down'); return { ok: chance(0.8), checks: ['check@rev'] }; } },
    relay: {
      identity: async () => ({ origin: 'https://relay.example', workspaceId: cfg.workspaceId, callerId: cfg.relayCallerId }),
      send: async (assignment, digest) => {
        const r = random();
        if (r < 0.1) throw new Error('refused before admission');
        await sendOne(assignment);
        if (r > 0.75) reports.set(assignment.taskId, { digest, next: 1 });
        if (r < 0.25) throw new Error('acknowledgment lost');
        if (r >= 0.25 && r < 0.3) reports.set(assignment.taskId, { digest, next: 1 });
        return { messageId: `m-${assignment.taskId}` };
      },
    },
  });
  let chief = makeChief();
  const ports = (): CyclePorts => ({ chief, source, reports: { poll: async c => {
    let processed = 0;
    for (const [taskId, state] of reports) {
      if (!chance(0.7)) continue;
      const report = { protocol: 'relay-chief.report.v1' as const, taskId, assignmentDigest: state.digest,
        sequence: state.next, state: (state.next === 1 ? 'accepted' : 'completed') as 'accepted' | 'completed', artifactRefs: [] };
      await c.receive({ workspaceId: cfg.workspaceId, agentId: 'agent-worker', report });
      processed++;
      if (state.next === 2) reports.delete(taskId); else state.next = 2;
    }
    return { processed, rejected: 0 };
  } } });
  // A crash at a phase boundary: committed ledger state survives and the process does not.
  const maybeCrash = () => { if (chance(0.08)) { crashes++; throw new Crash(); } };
  // A restart reopens the file, so only committed state survives.
  const restart = () => { crashingSend = false; ledger.close(); ledger = open(); chief = makeChief(); };
  const runFrom = async (start: number) => {
    for (let i = start; i < PHASES.length; i++) {
      const phase = PHASES[i] as Phase;
      if (phase === 'dispatch' && mutant === 'send_before_claim') {
        for (const task of ledger.tasks()) if (task.status === 'reserved') await sendOne(task.assignment);
      }
      try { maybeCrash(); await runPhase(phase, ports()); }
      catch (error) { if (error instanceof Crash) { restart(); return structure === 'monolith' ? 0 : i; } throw error; }
    }
    return -1;
  };
  for (let round = 0; round < 8; round++) {
    clock += 120_000;
    batch = Array.from({ length: Math.floor(random() * 4) }, (_, i) => {
      const key = Math.floor(random() * 8);
      return evidence({ sessionId: `s-${round}-${i}`, version: `${round}`, workKey: `issue-${key}`, observedAt: clock,
        resourceKeys: [`issue-${key}`, `src/${Math.floor(random() * 5)}.ts`] });
    });
    let at = 0;
    for (let attempts = 0; at >= 0 && attempts < 6; attempts++) at = await runFrom(at);
    if (mutant === 'replay_uncertain') {
      for (const task of ledger.tasks() as Task[]) if (task.status === 'uncertain') await sendOne(task.assignment);
    }
    const check = checkLedger(ledger, cfg);
    if (!check.ok) breaches.push(...check.violations);
  }
  for (const [id, count] of sends) if (count > 1) breaches.push(`duplicate_send:${id}`);
  const tasks = ledger.tasks();
  const summary = { breaches, sends: [...sends.values()].reduce((a, b) => a + b, 0), crashes,
    tasks: tasks.length, completed: tasks.filter(t => t.status === 'completed').length,
    uncertain: tasks.filter(t => t.status === 'uncertain' || t.status === 'sending').length };
  ledger.close();
  return summary;
}
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

for (const structure of ['monolith', 'phased'] as const) {
  test(`simulation: ${structure} holds every safety invariant across seeded faults`, async t => {
    const totals = { sends: 0, crashes: 0, tasks: 0, completed: 0, uncertain: 0 };
    for (const seed of SEEDS) {
      const r = await simulate(seed, structure);
      assert.deepEqual(r.breaches, [], `seed ${seed}`);
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += r[key];
    }
    assert.ok(totals.crashes > 50 && totals.sends > 50 && totals.completed > 10, 'faults and progress were exercised');
    t.diagnostic(JSON.stringify({ structure, seeds: SEEDS.length, ...totals }));
  });
}
for (const mutant of ['replay_uncertain', 'send_before_claim'] as const) {
  test(`simulation oracle detects the ${mutant} mutant`, async () => {
    let caught = 0;
    for (const seed of SEEDS) if ((await simulate(seed, 'phased', mutant)).breaches.length) caught++;
    assert.ok(caught > 0, 'a mutant that breaks the send rules must be caught');
  });
}
