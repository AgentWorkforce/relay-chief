import { flow } from '@relayflows/surface';

interface CycleInput {
  /** Command prefix for the chief CLI, set by the operator. Never derived from evidence. */
  cli: string;
  config: string;
  ledger: string;
  structure?: 'monolith' | 'phased' | 'gated';
  dispatch?: boolean;
}
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
function passed(output: string): boolean {
  try { return (JSON.parse(output.trim().split('\n').at(-1) ?? '') as { ok?: unknown }).ok === true; }
  catch { return false; }
}

/**
 * One bounded chief cycle. The ledger stays the authority for claims and sends; the
 * journal only records progress, so a step re-run after a crash cannot send twice.
 */
export default flow<CycleInput>('relay-chief-cycle', async (f, input) => {
  const files = `${quote(input.config)} ${quote(input.ledger)}`;
  // Fail before any step: a loose value must never enable sends or pick another structure.
  if (input.dispatch !== undefined && typeof input.dispatch !== 'boolean') throw new Error('invalid_dispatch');
  const structure = input.structure ?? 'phased';
  if (!['monolith', 'phased', 'gated'].includes(structure)) throw new Error('invalid_structure');
  const dispatch = input.dispatch === true;
  if (structure === 'monolith') {
    await f.run(`${input.cli} run-once ${files}${dispatch ? ' --dispatch' : ''}`);
    return f.done('success');
  }
  const phase = (name: string) => f.run(`${input.cli} phase ${name} ${files}`);
  const check = () => f.run(`${input.cli} check ${files}`)
    .gate(passed, 'ledger safety invariants failed');
  await phase('reports');
  await phase('verify');
  await phase('scan');
  if (!dispatch) return f.done('success');
  if (structure === 'gated') await check();
  await phase('dispatch');
  f.done('success');
});
