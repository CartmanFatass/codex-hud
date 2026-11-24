import { SLICE_STATES, type SliceState, type ProjectSnapshot } from '../collectors/project-board.js';
import { theme } from './colors.js';
import { mark } from './workboard-rows.js';

export const sliceInk = (state: SliceState) => ({ working: theme.board.active, blocked: theme.board.attention,
  try: theme.board.identifier, accepted: theme.board.success, todo: theme.board.muted, dropped: theme.board.frame })[state];

/** Cumulative rounding keeps the stacked bar cell-exact. */
export function progressSegments(counts: ProjectSnapshot['counts'], width: number, order: readonly SliceState[] = SLICE_STATES) {
  const total = order.reduce((n, state) => n + counts[state], 0);
  let count = 0, edge = 0;
  return order.map((state) => {
    count += counts[state];
    const end = total ? Math.round(count / total * width) : 0;
    const segment = { state, width: end - edge };
    edge = end;
    return segment;
  });
}

// The shades (and their text equivalents) distinguish try from accepted and todo even without colour.
const BAR_GLYPH: Record<SliceState, [string, string]> = { working: ['█', '#'], blocked: ['█', '#'], try: ['▒', '='], accepted: ['█', '#'], todo: ['░', '.'], dropped: ['░', '.'] };
export const barText = (data: Pick<ProjectSnapshot, 'counts'>, width: number, order?: readonly SliceState[], dim = false) =>
  progressSegments(data.counts, width, order).filter(({ width }) => width > 0).map(({ state, width: cells }) =>
    (dim ? state === 'todo' ? theme.board.frame : theme.board.muted : sliceInk(state))(mark(...BAR_GLYPH[state]).repeat(cells))).join('');
