#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chief } from './chief.js';
import { chiefConfigSchema } from './contracts.js';
import { ControlPlaneClient } from './control-plane.js';
import type { CyclePorts } from './cycle.js';
import { isPhase, runCycle, runPhase } from './cycle.js';
import { checkLedger } from './invariants.js';
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
async function withPorts(configPath: string, ledgerPath: string, work: (ports: CyclePorts) => Promise<void>): Promise<void> {
  const config = chiefConfigSchema.parse(readJson(configPath));
  const ledger = new Ledger(resolve(ledgerPath));
  try {
    const source = new ControlPlaneClient({ config, baseUrl: credential('CHIEF_CONTROL_PLANE_URL'),
      token: credential('CHIEF_CONTROL_PLANE_TOKEN') });
    const relay = new RelayClient({ token: credential('RELAY_AGENT_TOKEN'), baseUrl: process.env.RELAY_BASE_URL });
    const chief = new Chief(config, ledger, { relay, classifier: new JevClassifier({ token: credential('TYPESAFE_API_KEY') }), verifier: source, assignments: source });
    await work({ chief, reports: relay, source });
  } finally { ledger.close(); }
}
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
  if (command === 'check' && args.length === 2) {
    // Read-only and always exit 0 when it ran: the caller's gate decides what a violation means.
    const config = chiefConfigSchema.parse(readJson(args[0]!));
    const ledger = new Ledger(resolve(args[1]!), { readOnly: true });
    try { console.log(JSON.stringify(checkLedger(ledger, config))); } finally { ledger.close(); }
    return;
  }
  if (command === 'run-once' && (args.length === 2 || (args.length === 3 && args[2] === '--dispatch'))) {
    await withPorts(args[0]!, args[1]!, async ports => {
      console.log(JSON.stringify(await runCycle(ports, { dispatch: args.length === 3 })));
    });
    return;
  }
  if (command === 'phase' && args.length === 3 && isPhase(args[0]!)) {
    const phase = args[0];
    await withPorts(args[1]!, args[2]!, async ports => { console.log(JSON.stringify(await runPhase(phase, ports))); });
    return;
  }
  console.log('relay-chief plan <setup.json>\nrelay-chief inspect <ledger.db>\nrelay-chief run-once <config.json> <ledger.db> [--dispatch]\nrelay-chief phase <reports|verify|scan|dispatch> <config.json> <ledger.db>\nrelay-chief check <config.json> <ledger.db>');
  if (command && command !== '--help') process.exitCode = 1;
}
main().catch(() => {
  // No provider exception, validation input or request body is safe to print.
  console.error('relay-chief: operation failed; inspect configuration, credential bindings and local ledger state.');
  process.exitCode = 1;
});
