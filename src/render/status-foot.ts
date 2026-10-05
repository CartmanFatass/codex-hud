/**
 * The status card at the foot of the panel, at the level the reader chose.
 * It is a closed box with rounded corners, which is what tells it apart from
 * the open agent cards above it. Its frame is painted by the main session's
 * state (idle dim, working info, failed error, stale or needing the person
 * warning), and its edges are its meters, as omp's input box draws its
 * context meter in its border:
 *
 *   ╭─ ✓ ☀◆ 5d 56%━━━━━━━━━━━━━━──────────────246K ~3m b‖ , ? ─╮
 *   │ ◎ 整理测试数据补全文档                                      │
 *   │ ▸ 本轮改动已合并并发布                                      │
 *   │ ✓ 整理两个 CI 失败                                          │
 *   │ ✓ 提交 release 说明  +2                                     │
 *   ╰─ atlas-wsl · main * 7d 99%━━━━━━━━━━━━━━━━━━━━━━━━━ ↺114h ◷~30m+ ─╯
 *
 * - `min`: one line: the state, the context meter, the quota's reading,
 *   with a mark when something needs the person (a failure, an approval, a
 *   recap that says it needs them).
 * - `status`: the two edges, and between them the alerts, when there are any.
 * - `full`: those, then the main session's brief: the model's approval
 *   words, the recap with its labels inline, the whole-picture sentence
 *   when there is no recap, a reply in another shape or a failure. The
 *   brief's own state and its pause switch ride on the top edge. Rich only:
 *   compact shows the brief above, so there `full` is `status`.
 *
 * The card takes at most a third of the panel and leaves the agents ten rows
 * when the panel is tall enough; a brief taller than its room keeps its most
 * wanted fields in view and scrolls the rest, with a line saying what is out
 * of view. Pure.
 */
import type { MonitorData, MonitorFrame, MonitorState } from './monitor.js';
import { fit, edgeLine, writtenAge, iconic, squeeze, age, type EdgeMeter } from './monitor.js';
import { briefFields, BRIEF_KEEP, type BriefField } from './cards.js';
import { tonePaint, type StatusCard, type StatusTone } from './status-block.js';
import { colors, theme, truncateAnsi, visualLength, stripAnsi } from './colors.js';
import { t } from './i18n.js';

export type StatusLevel = 'min' | 'status' | 'full';
const LEVELS: readonly StatusLevel[] = ['min', 'status', 'full'];
/** Rows the agents view keeps however tall the card would like to be, when the panel has them. */
const MIN_VIEW = 10;

/** The level as drawn: absent is `full`, and compact has no `full` of its own. */
export function shownLevel(state: MonitorState): StatusLevel {
  const level = state.statusLevel ?? 'full';
  return level === 'full' && state.style !== 'rich' ? 'status' : level;
}

/** The next level `r` or a click on the card's top edge gives: min → status → full, compact skipping full. */
export function nextLevel(state: MonitorState): StatusLevel {
  const levels = state.style === 'rich' ? LEVELS : LEVELS.slice(0, 2);
  return levels[(levels.indexOf(shownLevel(state)) + 1) % levels.length];
}

/** Where the card sits, for the wheel: the whole card scrolls its brief. */
export interface FootInfo { y: number; height: number; brief: number; total: number; offset: number }

export interface FootPlan {
  rows: number;
  draw(frame: MonitorFrame, foot: number): void;
}

/** A text riding on an edge, with what a click on it does. */
interface Piece { text: string; kind?: 'settings' | 'brief' }

/**
 * Fit an edge: the pieces are tried whole, then with each droppable piece
 * gone in turn, least wanted first, keeping the meter's bar while any
 * dropping is left to do; then the bar gives way to its label; at the last
 * the left text is cut. `drops` names pieces by key, `tail` and `bar` being
 * the meter's.
 */
function fitEdge(width: number, lead: string, trail: string, rule: (s: string) => string,
  pieces: { left: Array<[string, Piece]>; right: Array<[string, Piece]> }, meter: EdgeMeter | undefined, drops: string[],
  shorten: (text: string, room: number) => string = truncateAnsi):
  { line: string; controls: Array<{ kind: 'settings' | 'brief'; x: number; width: number }> } {
  const gone = new Set<string>();
  const attempt = (cut: boolean) => {
    const left = pieces.left.filter(([key]) => !gone.has(key)).map(([, piece]) => piece.text).filter(Boolean);
    const right = pieces.right.filter(([key, piece]) => !gone.has(key) && piece.text);
    const rightText = right.map(([, piece]) => piece.text).join(' ');
    const shownMeter = !meter || gone.has('label') ? undefined : gone.has('tail') ? { ...meter, tail: undefined } : meter;
    let leftText = left.join(' ');
    if (cut) {
      // The last resort: the left text cut to what the rule leaves it.
      const room = width - visualLength(lead) - visualLength(trail) - (rightText ? visualLength(rightText) + 2 : 0) - 3
        - (shownMeter?.label ? visualLength(shownMeter.label) : 0);
      leftText = room > 1 ? shorten(leftText, room) : '';
    }
    const edge = edgeLine(width, lead, trail, leftText, rightText, shownMeter, !gone.has('bar'), rule, !cut);
    if (!edge) return null;
    const controls: Array<{ kind: 'settings' | 'brief'; x: number; width: number }> = [];
    let x = edge.rightX + 1;
    for (const [, piece] of right) {
      if (piece.kind) controls.push({ kind: piece.kind, x, width: visualLength(piece.text) });
      x += visualLength(piece.text) + 1;
    }
    return { line: edge.line, controls };
  };
  for (const key of ['', ...drops]) {
    if (key) gone.add(key);
    const found = attempt(false);
    if (found) return found;
  }
  return attempt(true) ?? { line: rule(lead + '─'.repeat(Math.max(0, width - visualLength(lead) - visualLength(trail))) + trail), controls: [] };
}

/**
 * The brief's own state, for the top edge: how old the recap is ("~" marks
 * the model's words), that one is being written, that the last call failed,
 * that it is paused. Words with glyphs off, icons with them on.
 */
function briefState(input: MonitorData, now: number): string {
  const brief = input.brief;
  if (!brief) return '';
  if (brief.paused) return theme.accent(iconic() ? '‖' : t('paused'));
  if (brief.running) return colors.dim(iconic() ? '~…' : t('writing…'));
  if (brief.error) return theme.warning(iconic() ? '✗' : t('failed'));
  if (!brief.recap) return '';
  return colors.dim(`~${iconic() ? age(new Date(brief.recap.at), now) : writtenAge(brief.recap.at, now)}`);
}

/**
 * The brief's fields as rows, cut to `room` by the keep order when they do
 * not fit: the most wanted that fit come first, in reading order, and the
 * rest follow them, in view by scrolling.
 */
function briefRows(fields: BriefField[], room: number): string[] {
  const all = fields.flatMap(field => field.lines);
  if (all.length <= room) return all;
  const keep = new Set<BriefField>();
  let used = 0;
  for (const id of BRIEF_KEEP) {
    for (const field of fields.filter(field => field.id === id)) {
      if (used + field.lines.length > room - 1 && keep.size) continue;
      keep.add(field); used += field.lines.length;
    }
  }
  return [...fields.filter(field => keep.has(field)), ...fields.filter(field => !keep.has(field))].flatMap(field => field.lines);
}

export function planFoot(input: MonitorData, state: MonitorState, width: number, height: number, now: number, notices: number): FootPlan {
  const level = shownLevel(state);
  const hints = t(', ?');
  // Under 24 columns the frame would cost more than it holds: no card.
  const hint: FootPlan = { rows: height > 1 ? 1 : 0, draw(frame, foot) {
    if (height <= 1) return;
    frame.lines[foot] = colors.dim(truncateAnsi(t(width < 24 ? ', Settings  ?' : ', Settings  ? keys  1–5'), width));
    frame.controls.push({ kind: 'settings', x: 0, y: foot, width: Math.min(width, 12) });
  } };
  if (width < 24) return hint;
  const session = input.session?.(now) ?? null;
  const card = input.status?.(now) ?? null;
  const brief = input.brief;
  const needs = Boolean(brief?.recap?.needs);
  if (!card && !session) return hint;

  const place = (frame: MonitorFrame, y: number, edge: ReturnType<typeof fitEdge>, level: boolean) => {
    frame.lines[y] = edge.line;
    // The hint opens settings and the switch holds the brief; the rest of the top edge changes the level.
    for (const control of edge.controls) frame.controls.push({ ...control, y });
    if (level) frame.controls.push({ kind: 'level', x: 0, y, width });
  };
  // The parts every top edge carries, each keyed for the drop order.
  const meter = card?.context;
  const identity: Array<[string, Piece]> = [['rate', { text: card?.rate ?? '' }], ['tasks', { text: card?.tasks ?? '' }],
    ['model', { text: card?.model ?? '' }], ['age', { text: card?.age ?? '' }]];

  const cap = Math.min(Math.floor(height / 3), height - 1 - notices - MIN_VIEW);
  if (level === 'min' || !card || cap < 2) {
    if (!session && !card) return hint;
    if (height <= 1) return { rows: 0, draw() {} };
    // One line: the state, the context meter, the quota's reading, the hints.
    const mark = session?.attention ? '' : session?.failed ? theme.error('! ') : needs ? theme.warning('! ') : '';
    const tone: StatusTone = session?.attention || needs || session?.failed ? 'needs' : card?.tone ?? 'idle';
    const stateText = session ? `${mark}${session.text}` : card?.state ?? '';
    return { rows: 1, draw(frame, foot) {
      const edge = fitEdge(width, '╶─', '─╴', tonePaint(tone), {
        left: [['state', { text: stateText }], ['model', { text: card?.model ?? '' }], ['age', { text: card?.age ?? '' }]],
        right: [['quota', { text: card?.quota?.text ?? '' }], ['hints', { text: hints, kind: 'settings' }]],
      }, meter, ['hints', 'age', 'model', 'tail', 'bar', 'quota', 'label']);
      place(frame, foot, edge, true);
      frame.statusCard = { y: foot, height: 1, brief: 0, total: 0, offset: 0 };
    } };
  }

  const inner = width - 4;
  const tone: StatusTone = card.tone === 'error' ? 'error' : needs || session?.attention ? 'needs' : card.tone;
  const rule = tonePaint(tone);
  const alerts = card.alerts.slice(0, Math.max(0, cap - 2));
  const fields = level === 'full' ? briefFields(input, inner) : [];
  const lines0 = briefRows(fields, Math.max(0, cap - 2 - alerts.length));
  // Paused, the brief stays for reference but steps back.
  const lines = brief?.paused ? lines0.map(line => colors.dim(stripAnsi(line))) : lines0;
  const room = cap - 2 - alerts.length;
  // Cut, the brief needs room for a line of it beside the line saying so.
  const section = lines.length > 0 && room >= 1 && (lines.length <= room || room >= 2);
  const overflow = section && lines.length > room;
  const shown = !section ? 0 : overflow ? room - 1 : lines.length;
  const offset = overflow ? Math.max(0, Math.min(state.statusScroll ?? 0, lines.length - shown)) : 0;
  state.statusScroll = offset;
  const rows = 2 + alerts.length + shown + (overflow ? 1 : 0);
  // The brief's state and its switch, only at full with a brief configured.
  const said = level === 'full' ? briefState(input, now) : '';
  const pause = level === 'full' && brief ? (iconic() ? `b${brief.paused ? '▸' : '‖'}` : t(brief.paused ? 'b resume' : 'b pause')) : '';
  return { rows, draw(frame, foot) {
    const top = fitEdge(width, '╭─', '─╮', rule, {
      left: [['state', { text: card.state }], ...identity],
      right: [['brief', { text: said }], ['pause', { text: pause ? (brief?.paused ? theme.accent(pause) : colors.dim(pause)) : '', kind: 'brief' }],
        ['hints', { text: colors.dim(hints), kind: 'settings' }]],
    }, meter, ['hints', 'rate', 'tasks', 'age', 'model', 'brief', 'tail', 'bar', 'label', 'pause']);
    place(frame, foot, top, true);
    let y = foot + 1;
    const row = (text: string) => { frame.lines[y++] = rule('│ ') + fit(text, inner) + rule(' │'); };
    for (const alert of alerts) row(alert);
    for (const line of lines.slice(offset, offset + shown)) row(line);
    if (overflow) {
      const below = lines.length - offset - shown;
      row(colors.dim(below ? (offset ? t('↑ {a}  ↓ {n} more lines', { a: offset, n: below }) : t('↓ {n} more lines', { n: below })) : t('↑ {n} more lines', { n: offset })));
    }
    const quota = card.quota;
    const bottom = fitEdge(width, '╰─', '─╯', rule, {
      left: [['place', { text: card.place }]],
      right: [['others', { text: card.others }], ['forecast', { text: card.forecast }], ['reset', { text: card.reset }], ['cache', { text: card.cache }]],
    }, quota, ['others', 'cache', 'bar', 'forecast', 'reset', 'label'], squeezePlace);
    frame.lines[y] = bottom.line;
    frame.statusCard = { y: foot, height: rows, brief: shown, total: lines.length, offset };
  } };
}

/** The place cut in the middle, its colours given up: the ends say which project and branch. */
function squeezePlace(place: string, width: number): string {
  return colors.dim(squeeze(stripAnsi(place), width));
}
