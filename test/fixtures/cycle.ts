// Separate process used only by the local proof. Production has no endpoint override for Jev.
import { readFileSync } from 'node:fs';
import { Chief } from '../../src/chief.js';
import { chiefConfigSchema } from '../../src/contracts.js';
import { ControlPlaneClient } from '../../src/control-plane.js';
import { JevClassifier } from '../../src/jev.js';
import { Ledger } from '../../src/ledger.js';
import { RelayClient } from '../../src/relay.js';

const [configPath, database, baseUrl] = process.argv.slice(2) as [string, string, string];
const config = chiefConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
const ledger = new Ledger(database);
try {
  const plane = new ControlPlaneClient({ baseUrl, token: 'local-control-plane-token', config });
  const relay = new RelayClient({ baseUrl, token: 'local-chief-token' });
  const classifier = new JevClassifier({ token: 'local-jev-token', fetch: async (input, init) => {
    if (String(input) !== 'https://api.typesafe.ai/v1/systemone') throw new Error('unexpected_classifier_endpoint');
    return fetch(new URL('/v1/systemone', baseUrl), init);
  } });
  const chief = new Chief(config, ledger, { classifier, relay, verifier: plane });
  const reports = await relay.poll(chief);
  for (const task of ledger.tasks()) if (task.status === 'awaiting_verification') await chief.verify(task.id);
  const decisions = await chief.scan(plane);
  await chief.dispatchReserved();
  console.log(JSON.stringify({ decisions, reports, tasks: ledger.tasks().map(t => ({ id: t.id, status: t.status })) }));
} finally { ledger.close(); }
