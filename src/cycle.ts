import type { Chief } from './chief.js';
import type { Decision, EvidenceSource, TaskStatus } from './contracts.js';

/** Ordered cycle phases. Each is safe to re-run: durable state lives in the ledger. */
export const PHASES = ['reports', 'verify', 'scan', 'dispatch'] as const;
export type Phase = (typeof PHASES)[number];
export function isPhase(value: string): value is Phase { return (PHASES as readonly string[]).includes(value); }

export interface CyclePorts {
  chief: Chief;
  reports: { poll(chief: Chief): Promise<{ processed: number; rejected: number }> };
  source: EvidenceSource;
}
export type DispatchedTask = { id: string; status: TaskStatus };
export interface PhaseResult {
  reports?: { processed: number; rejected: number };
  verified?: number;
  decisions?: Decision[];
  dispatched?: DispatchedTask[];
}

/** Runs one phase. `dispatch` is the only phase that sends Relay assignments. */
export async function runPhase(phase: Phase, ports: CyclePorts): Promise<PhaseResult> {
  const { chief } = ports;
  switch (phase) {
    case 'reports':
      return { reports: await ports.reports.poll(chief) };
    case 'verify': {
      // Retry incomplete verification independently of report redelivery.
      const pending = chief.ledger.tasks().filter(task => task.status === 'awaiting_verification');
      for (const task of pending) await chief.verify(task.id);
      return { verified: pending.length };
    }
    case 'scan':
      return { decisions: await chief.scan(ports.source) };
    case 'dispatch':
      return { dispatched: (await chief.dispatchReserved()).map(task => ({ id: task.id, status: task.status })) };
  }
}

/** One bounded cycle. Without `dispatch`, reserved work stays reserved and nothing is sent. */
export async function runCycle(ports: CyclePorts, options: { dispatch: boolean }): Promise<PhaseResult> {
  let result: PhaseResult = {};
  for (const phase of PHASES) {
    if (phase === 'dispatch' && !options.dispatch) break;
    result = { ...result, ...await runPhase(phase, ports) };
  }
  return result;
}
