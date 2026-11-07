// Isolated deterministic execution worker for the proof. It is not part of the chief package.
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readAssignment } from '../../src/worker-protocol.js';
import { chiefConfigSchema } from '../../src/contracts.js';
import { setTimeout as delay } from 'node:timers/promises';

const [assignmentPath, directory, baseUrl, configPath] = process.argv.slice(2) as [string, string, string, string?];
const config = configPath ? chiefConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))) : undefined;
const { assignment, digest } = readAssignment({ workspaceId: config?.workspaceId ?? 'workspace-1', senderAgentId: config?.relayCallerId ?? 'agent-chief',
  recipientAgentId: config?.workers[0]?.agentId ?? 'agent-worker', recipientAddress: config?.workers[0]?.address ?? 'worker@host' }, JSON.parse(readFileSync(assignmentPath, 'utf8')), {
  chiefAgentId: config?.relayCallerId ?? 'agent-chief', chiefId: config?.chiefId ?? 'chief-1', organizationId: config?.organizationId ?? 'org-1', projectId: config?.projectId ?? 'project-1',
  repositories: config?.repositories ?? ['acme/project'], actions: config?.policy.allowedActions ?? ['unblock'], maxReservationMicros: 1_000_000, maxEvidenceAgeMs: config?.policy.maxEvidenceAgeMs ?? 60_000,
});
// Persist receipt before implementation; never execute a repeated assignment.
const claim = join(directory, `${assignment.taskId}.receipt`);
if (existsSync(claim)) { console.log('worker: duplicate assignment refused'); process.exit(0); }
closeSync(openSync(claim, 'wx', 0o600));
async function send(state: 'accepted' | 'running' | 'completed', sequence: number): Promise<void> {
  const response = await fetch(new URL('/v1/dm', baseUrl), { method: 'POST',
    headers: { authorization: `Bearer ${process.env.LOCAL_WORKER_TOKEN ?? 'local-worker-token'}`, 'content-type': 'application/json',
      'Idempotency-Key': `${assignment.taskId}-${sequence}` },
    body: JSON.stringify({ to: 'chief', text: `Worker ${state}`, mode: 'wait', data: { chief_report: {
      protocol: 'relay-chief.report.v1', taskId: assignment.taskId, assignmentDigest: digest, sequence, state,
      artifactRefs: [`${baseUrl}/artifacts/${assignment.taskId}`],
    } } }),
  });
  if (!response.ok) throw new Error('worker_report_failed');
}
await send('accepted', 1);
if (process.env.LOCAL_WORKER_PACE) await delay(1200);
await send('running', 2);
if (process.env.LOCAL_WORKER_PACE) await delay(1200);
// The fixture worker owns this change. The chief process never receives a shell or file-write capability.
writeFileSync(join(directory, 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
execFileSync(process.execPath, ['--test', join(directory, 'sum.test.mjs')], { cwd: directory, stdio: 'pipe' });
await send('completed', 3);
console.log('worker: implementation and local checks passed');
