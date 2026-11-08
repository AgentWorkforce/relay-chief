// Benchmark-only worker adapter: validates an assignment and reports over the fake Relay.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAssignment } from '../../dist/index.js';

const args = process.argv.slice(2);
const take = flag => { const i = args.indexOf(flag); const v = args[i + 1]; args.splice(i, 2); return v; };
const base = take('--base');
const state = take('--state');
const project = take('--project');
const [command, value] = args;
const statePath = join(state, 'worker.json');
const post = async (phase, sequence, saved) => {
  const response = await fetch(new URL('/v1/dm', base), { method: 'POST', headers: { authorization: 'Bearer fixture-worker', 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'chief', text: `Worker ${phase}`, mode: 'wait', data: { chief_report: { protocol: 'relay-chief.report.v1', taskId: saved.taskId,
      assignmentDigest: saved.digest, sequence, state: phase, artifactRefs: [`${base}/artifacts/${saved.taskId}`] } } }) });
  if (!response.ok) throw new Error('worker_report_failed');
};
if (command === 'accept') {
  const { assignment, digest } = readAssignment({ workspaceId: 'workspace-1', senderAgentId: 'agent-chief', recipientAgentId: 'agent-worker', recipientAddress: 'worker@host' },
    JSON.parse(readFileSync(value, 'utf8')), { chiefAgentId: 'agent-chief', chiefId: 'chief-1', organizationId: 'org-1', projectId: 'project-1',
      repositories: ['acme/project'], actions: ['investigate', 'coordinate', 'unblock'], maxReservationMicros: 1_000_000, maxEvidenceAgeMs: 3_600_000 });
  // Persist the receipt before starting work; a repeated assignment is never executed.
  try { closeSync(openSync(join(state, `${assignment.taskId}.receipt`), 'wx', 0o600)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(JSON.stringify({ duplicate: true })); process.exit(0);
  }
  const saved = { taskId: assignment.taskId, digest };
  writeFileSync(statePath, JSON.stringify(saved));
  await post('accepted', 1, saved);
  console.log(JSON.stringify({ duplicate: false, objective: assignment.evidence.summary }));
} else if (command === 'test') {
  execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: project, stdio: 'inherit' });
} else if (command === 'report') {
  await post(value, 2, JSON.parse(readFileSync(statePath, 'utf8')));
} else throw new Error('unknown_command');
