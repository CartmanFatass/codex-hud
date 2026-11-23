/**
 * The stage strip on a Home job row (`home-compact/03`): five fixed cells, read ▸ edit ▸ test ▸ report ▸ land, each passed (●),
 * current (◐), not reached (○) or unknown (a dim ○). It is read from what the card already knows: the report and the job's
 * settling, the checks receipt, the land flow and, when a collector provides it, `stage`, the kind of work a running job is in.
 * A cell the card cannot know stays unknown; nothing here is guessed.
 */
import type { OwnerWorker } from '../collectors/workboard-types.js';
import { theme } from './colors.js';
import { mark } from './workboard-rows.js';

export const STAGES = ['read', 'edit', 'test', 'report', 'land'] as const;
export type StageCell = 'passed' | 'current' | 'todo' | 'unknown';
/** The strip's width in cells. */
export const STRIP_CELLS = STAGES.length;
const KIND_INDEX = { read: 0, edit: 1, test: 2 } as const;

/** The five cells of a job: the first `passed` are passed and the next one is current when `current`. */
export function stageCells(w: OwnerWorker): readonly StageCell[] {
  const cells = (passed: number, current = false): StageCell[] => STAGES.map((_, i) => (i < passed ? 'passed' : i === passed && current ? 'current' : 'todo'));
  const land = w.flow?.kind === 'land' ? w.flow : undefined;
  if (land?.state === 'completed') return cells(STRIP_CELLS);
  if (land && land.state !== 'failed' && land.state !== 'cancelled') return cells(4, true);
  if (w.state === 'queued') return cells(0);
  const reported = w.files?.some((f) => f.kind === 'report');
  if (w.state === 'done' || (reported && w.settledAt === null)) {
    // A job whose checks have not all passed is still in test, whatever the report says.
    const checks = w.checks && !w.checks.stale && (w.checks.state === 'running' || w.checks.passed < w.checks.total);
    const out = cells(w.settledAt === null ? 3 : 4, w.settledAt === null);
    return checks ? out.map((cell, i) => (i === 2 ? 'current' : cell)) : out;
  }
  if (w.settledAt === null && w.state === 'working' && w.stage) return cells(KIND_INDEX[w.stage], true);
  return ['unknown', 'unknown', 'unknown', 'todo', 'todo'];
}

/** The strip as five painted cells (ASCII `+@o`): passed in the quiet ink, current in the active one, unknown dimmer than not reached. */
export function stageStrip(w: OwnerWorker): string {
  const { active, frame, muted } = theme.board;
  return stageCells(w).map((cell) =>
    cell === 'passed' ? muted(mark('●', '+')) : cell === 'current' ? active(mark('◐', '@')) : cell === 'todo' ? muted(mark('○', 'o')) : frame(mark('○', 'o'))).join('');
}
