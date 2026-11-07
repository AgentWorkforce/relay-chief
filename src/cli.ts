#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chief } from './chief.js';
import { chiefConfigSchema } from './contracts.js';
import { ControlPlaneClient } from './control-plane.js';
import { JevClassifier } from './jev.js';
import { Ledger } from './ledger.js';
import { provisionPlan } from './provisioning.js';
import { RelayClient } from './relay.js';

function credential(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}
function readJson(path: string): unknown { return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown; }
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan' && args.length === 1) {
    console.log(JSON.stringify(provisionPlan(readJson(args[0]!)), null, 2)); return;
  }
  if (command === 'inspect' && args.length === 1) {
    const ledger = new Ledger(resolve(args[0]!), { readOnly: true });
    try {
      // Summary deliberately omits transcripts, task payloads and credentials.
      console.log(JSON.stringify({ tasks: ledger.tasks().map(task => ({ id: task.id, status: task.status,
        action: task.assignment.action, workKey: task.assignment.workKey, messageId: task.messageId })),
        decisions: ledger.decisions(), accounting: ledger.accounting() }, null, 2));
    } finally { ledger.close(); }
    return;
  }
  if (command === 'run-once' && args.length === 3 && args[2] === '--dispatch') {
    const config = chiefConfigSchema.parse(readJson(args[0]!));
    const ledger = new Ledger(resolve(args[1]!));
    try {
      const source = new ControlPlaneClient({ config, baseUrl: credential('CHIEF_CONTROL_PLANE_URL'),
        token: credential('CHIEF_CONTROL_PLANE_TOKEN') });
      const relay = new RelayClient({ token: credential('RELAY_AGENT_TOKEN'), baseUrl: process.env.RELAY_BASE_URL });
      const chief = new Chief(config, ledger, { relay, classifier: new JevClassifier({ token: credential('TYPESAFE_API_KEY') }), verifier: source });
      const reports = await relay.poll(chief);
      // Retry incomplete verification independently of report redelivery.
      for (const task of ledger.tasks()) if (task.status === 'awaiting_verification') await chief.verify(task.id);
      const decisions = await chief.scan(source);
      const dispatched = await chief.dispatchReserved();
      console.log(JSON.stringify({ decisions, dispatched: dispatched.map(task => ({ id: task.id, status: task.status })), reports }));
    } finally { ledger.close(); }
    return;
  }
  console.log('relay-chief plan <setup.json>\nrelay-chief inspect <ledger.db>\nrelay-chief run-once <config.json> <ledger.db> --dispatch');
  if (command && command !== '--help') process.exitCode = 1;
}
main().catch(() => {
  // No provider exception, validation input or request body is safe to print.
  console.error('relay-chief: operation failed; inspect configuration, credential bindings and local ledger state.');
  process.exitCode = 1;
});
