import type { MachineWorkCounts } from '../collectors/work-summary-snapshot.js';

/** The machine-wide HUD load, not a count of owner requests or native subagents. */
export function formatMachineWork(work: MachineWorkCounts): string {
  return `HUD (OS): ${work.running} running, ${work.queued} queued`;
}
