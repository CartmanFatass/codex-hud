/** Resident project strip under the tabs on Project and Execution. Pure: no I/O. */
import type { ProjectChoice, RowControl } from './monitor.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText } from './monitor-text.js';
import { boardCursor, mark, stateMark } from './workboard-rows.js';

export const PROJECT_STRIP_MORE = 'project:strip:more';

type MarkKind = 'ask' | 'live' | 'idle';

export interface ProjectStripRow {
  readonly hasMore: boolean;
  readonly controls: RowControl[];
  paint(moreSelected?: boolean): string;
}

function markKind(project: ProjectChoice): MarkKind {
  if ((project.overview?.waiting ?? 0) > 0) return 'ask';
  if ((project.overview?.running ?? 0) > 0) return 'live';
  return 'idle';
}

const askGlyph = () => stateMark.asking();
const liveGlyph = () => mark('●', '*', '\uF111');
const glyphOf = (kind: MarkKind) => (kind === 'ask' ? askGlyph() : kind === 'live' ? liveGlyph() : '');
const paintedGlyph = (kind: MarkKind) =>
  kind === 'ask' ? theme.board.attention(askGlyph()) : kind === 'live' ? theme.board.active(liveGlyph()) : '';

/**
 * One-row resident project strip in panel project order (own project first, never re-sorted):
 * - Marks: `?` open owner request, else `●` live work, else none (idle muted).
 * - Current project on the title surface; a trailing rule fills remaining width (>= 2 cells).
 * - Folding order when too wide: idle projects leave from the end into `+N`, then names shorten
 *   to 8 cells, only then marked projects fold and `+N` carries their strongest mark; current always stays.
 */
export function projectStripRow(
  projects: readonly ProjectChoice[],
  selectedProject: string | undefined,
  width: number,
): ProjectStripRow {
  const currentIdx = Math.max(0, projects.findIndex((p) => p.root === selectedProject));
  const items = projects.map((project, index) => ({
    root: project.root,
    rawName: monitorText(project.name) || monitorText(project.root),
    kind: markKind(project),
    current: index === currentIdx,
  }));

  const shown = items.map(() => true);
  let cap = Infinity;

  const foldedInfo = () => {
    let count = 0;
    let strongest: MarkKind = 'idle';
    for (let i = 0; i < items.length; i++) {
      if (shown[i]) continue;
      count++;
      const kind = items[i]!.kind;
      if (kind === 'ask') strongest = 'ask';
      else if (kind === 'live' && strongest === 'idle') strongest = 'live';
    }
    return { count, strongest };
  };

  const overflowWidth = () => {
    const { count, strongest } = foldedInfo();
    if (!count) return 0;
    const glyph = glyphOf(strongest);
    return 1 + visualLength(glyph) + String(count).length + 2; // ` [mark]+N `
  };

  const entryWidth = (index: number, nameCap: number) => {
    const item = items[index]!;
    const name = nameCap < Infinity ? truncateAnsi(item.rawName, nameCap) : item.rawName;
    const glyph = glyphOf(item.kind);
    const markCols = glyph ? visualLength(glyph) + 1 : 0;
    return 1 + markCols + visualLength(name) + 1;
  };

  const totalWidth = (nameCap: number) => {
    let sum = 0;
    for (let i = 0; i < items.length; i++) if (shown[i]) sum += entryWidth(i, nameCap);
    return sum + overflowWidth();
  };

  // Stage 1: idle non-current projects leave from the end into +N.
  for (let i = items.length - 1; i >= 0 && totalWidth(cap) > width; i--) {
    if (shown[i] && !items[i]!.current && items[i]!.kind === 'idle') shown[i] = false;
  }

  // Stage 2: shorten names to 8 cells.
  if (totalWidth(cap) > width) cap = 8;

  // Stage 3: marked non-current projects fold from the end; +N carries their strongest mark.
  for (let i = items.length - 1; i >= 0 && totalWidth(cap) > width; i--) {
    if (shown[i] && !items[i]!.current) shown[i] = false;
  }

  const folded = foldedInfo();
  const moreW = overflowWidth();

  // Extreme narrow fallback: shrink the sole remaining current name so +N can still fit.
  let currentCap = cap;
  if (totalWidth(cap) > width) {
    const cur = items[currentIdx]!;
    const markCols = cur.kind === 'idle' ? 0 : visualLength(glyphOf(cur.kind)) + 1;
    currentCap = Math.max(1, width - moreW - markCols - 2);
  }

  const controls: RowControl[] = [];
  const chips: string[] = [];
  let x = 0;
  for (let i = 0; i < items.length; i++) {
    if (!shown[i]) continue;
    const item = items[i]!;
    const limit = item.current ? currentCap : cap;
    const name = limit < Infinity ? truncateAnsi(item.rawName, limit) : item.rawName;
    const glyph = paintedGlyph(item.kind);
    const body = glyph ? `${glyph} ${name}` : item.current ? name : theme.board.muted(name);
    const chip = item.current ? theme.board.title(` ${body} `) : ` ${body} `;
    const span = visualLength(chip);
    const clipped = Math.max(0, Math.min(width, x + span) - x);
    if (clipped > 0) controls.push({ kind: 'project-strip-pick', item: item.root, x, width: clipped });
    chips.push(chip);
    x += span;
  }

  const moreX = x;
  const morePlain = folded.count > 0 ? ` ${paintedGlyph(folded.strongest)}${theme.board.muted(`+${folded.count}`)} ` : '';
  if (folded.count > 0) {
    const span = visualLength(morePlain);
    const clipped = Math.max(0, Math.min(width, moreX + span) - moreX);
    if (clipped > 0) controls.push({ kind: 'project-strip-more', item: PROJECT_STRIP_MORE, x: moreX, width: clipped });
    x += span;
  }

  const rest = width - x;
  const rule = rest >= 2 ? theme.board.frame(mark('─', '-').repeat(rest)) : '';
  const prefix = chips.join('');

  return {
    hasMore: folded.count > 0,
    controls,
    paint(moreSelected = false) {
      const more = morePlain ? (moreSelected ? boardCursor(morePlain) : morePlain) : '';
      return fit(prefix + more + rule, width);
    },
  };
}
