import type { Run } from './types/execution.js';

export function isRunTerminal(run: { state: Run['state'] }): boolean {
  return run.state === 'ended' || run.state === 'failed' || run.state === 'cancelled';
}
