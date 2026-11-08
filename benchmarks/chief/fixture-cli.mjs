// Benchmark-only chief CLI. Same phases as dist/cli.js, with Jev redirected to the local fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { Chief, ControlPlaneClient, JevClassifier, Ledger, RelayClient, checkLedger, chiefConfigSchema, isPhase, runCycle, runPhase } from '../../dist/index.js';

const args = process.argv.slice(2);
const take = flag => { const i = args.indexOf(flag); const v = args[i + 1]; args.splice(i, 2); return v; };
const base = take('--base');
writeFileSync(take('--pidfile'), String(process.pid));
const [command, ...rest] = args;
const phase = command === 'phase' ? rest.shift() : undefined;
if (phase !== undefined && !isPhase(phase)) throw new Error('unknown_phase');
const [configPath, database, flag] = rest;
const config = chiefConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
if (command === 'check') {
  const ledger = new Ledger(database, { readOnly: true });
  try { console.log(JSON.stringify(checkLedger(ledger, config))); } finally { ledger.close(); }
} else {
  const ledger = new Ledger(database);
  try {
    const source = new ControlPlaneClient({ baseUrl: base, token: 'fixture-control', config });
    const relay = new RelayClient({ baseUrl: base, token: 'fixture-chief' });
    const classifier = new JevClassifier({ token: 'fixture-jev', fetch: (_input, init) => fetch(new URL('/v1/systemone', base), init) });
    const chief = new Chief(config, ledger, { classifier, relay, verifier: source });
    const ports = { chief, reports: relay, source };
    const result = phase ? await runPhase(phase, ports) : await runCycle(ports, { dispatch: flag === '--dispatch' });
    console.log(JSON.stringify({ ok: true, dispatched: result.dispatched?.length }));
  } finally { ledger.close(); }
}
