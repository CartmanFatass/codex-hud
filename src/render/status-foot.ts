/**
 * The status card at the foot of the panel, at the level the reader chose,
 * drawn as omp draws its composer in band style: a band row on its own
 * background carrying coloured segments with no separators and the context
 * meter in its gap, the brief under it behind a left gutter, and a `╰─`
 * corner row closing it. The gutter and the corner are painted by the main
 * session's state (idle dim, working info, failed error, stale or needing
 * the person warning); the meters keep their own zone colours:
 *
 *   ▕ ✓ ★◕ 41s ──────────56%──────────────246K ~3m ▏
 *   │ ◎ 整理测试数据补全文档，并在版本冻结前合并本轮改动
 *   │ ▸ 本轮改动已合并并发布，无待办任务，等待新的需求
 *   │ ✓ 整理两个 CI 失败与下一步排查记录
 *   │   提交 release 说明并推送到 main 分支 +2
 *   ╰─ atlas-wsl · main * 7d ──────────99% ↺113h
 *
 * - `min`: the band row alone, the quota's reading at its right end, with a
 *   mark when something needs the person.
 * - `status`: the band and the corner row, and between them the alerts,
 *   when there are any.
 * - `full`: those, then the main session's brief between them: the model's
 *   approval words, the recap with its labels inline, the whole-picture
 *   sentence when there is no recap, a reply in another shape or a failure.
 *   Rich only: compact shows the brief above, so there `full` is `status`.
 *
 * The band's right end is data only, the brief's own state ("~3m"): the
 * switches and the hints are the control bar's, at the top of the panel. A
 * click on the band steps the level, as `r` does.
 *
 * The card takes at most a third of the panel and leaves the agents ten rows
 * when the panel is tall enough; a brief taller than its room keeps its most
 * wanted fields in view and scrolls the rest, with a line saying what is out
 * of view. Pure.
 */
import type { MonitorData, MonitorFrame, MonitorState } from './monitor.js';
import { fit, meterRow, writtenAge, iconic, squeeze, age, METER_MIN, type EdgeMeter } from './monitor.js';
import { briefFields, BRIEF_KEEP, type BriefField } from './cards.js';
import { tonePaint, type StatusCard, type StatusTone } from './status-block.js';
import { colors, theme, truncateAnsi, visualLength, stripAnsi } from './colors.js';
import { t } from './i18n.js';

export type StatusLevel = 'min' | 'status' | 'full';
const LEVELS: readonly StatusLevel[] = ['min', 'status', 'full'];
/** Rows the agents view keeps however tall the card would like to be, when the panel has them. */
const MIN_VIEW = 10;
/** Columns of bar the corner row's quota meter keeps while the place can still give way. */
const QUOTA_BAR = 12;
/** Columns of bar the band's context meter keeps while the identity can still give way. */
const BAND_BAR = 8;

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

/** A row's texts, each keyed so the narrow row can give it up. */
type Pieces = Array<[string, string]>;

/**
 * Fit a row with a meter in its gap: `lead`, the left texts, the meter, the
 * right texts, `trail`. The texts are tried whole, then with each droppable
 * piece gone in turn, least wanted first, keeping the meter's bar while any
 * dropping is left to do; `tail` and `bar` in `drops` are the meter's own,
 * and `label` the meter itself. At the last the left text is cut, beside
 * the meter's reading and the reset.
 */
function fitRow(width: number, lead: string, trail: string, left: Pieces, right: Pieces, meter: EdgeMeter | undefined, drops: string[],
  shorten: (text: string, room: number) => string = truncateAnsi, minBar = METER_MIN): string {
  const gone = new Set<string>();
  const attempt = (cut: boolean): string | null => {
    const join = (pieces: Pieces) => pieces.filter(([key, text]) => !gone.has(key) && text).map(([, text]) => text).join(' ');
    const rightText = join(right);
    const shown = !meter || gone.has('label') ? undefined : gone.has('tail') ? { ...meter, tail: undefined } : meter;
    let leftText = join(left);
    const after = (rightText ? ` ${rightText}` : '') + trail;
    if (cut) {
      // The last resort: the left text cut to what the meter's reading leaves it.
      const reading = shown ? visualLength(shown.label ?? `${shown.percent}%`) + visualLength(shown.mark ?? '') : 1;
      const room = width - visualLength(lead) - visualLength(after) - reading - 1;
      leftText = room > 1 ? shorten(leftText, room) : '';
    }
    const before = lead + (leftText ? `${leftText} ` : '');
    return meterRow(width, before, after, shown, !cut && !gone.has('bar') ? minBar : 0, !cut);
  };
  for (const key of ['', ...drops]) {
    if (key) gone.add(key);
    const found = attempt(false);
    if (found !== null) return found;
  }
  // Cut, the row keeps the meter's reading and the reset beside what is left of the left text.
  gone.delete('label'); gone.delete('reset');
  return attempt(true) ?? truncateAnsi(lead, width);
}

/**
 * The brief's own state, for the band's right end: how old the recap is
 * ("~" marks the model's words), that one is being written, that the last
 * call failed, that it is paused. Words with glyphs off, icons with them on.
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
  // Under 24 columns the card would cost more than it holds, and with nothing
  // to say it is not drawn: the foot is the panel's. The keys are the bar's.
  const hint: FootPlan = { rows: 0, draw() {} };
  if (width < 24) return hint;
  const session = input.session?.(now) ?? null;
  const card = input.status?.(now) ?? null;
  const brief = input.brief;
  const needs = Boolean(brief?.recap?.needs);
  if (!card && !session) return hint;

  // A click anywhere on the band steps the level.
  const band = (frame: MonitorFrame, y: number, line: string) => {
    frame.lines[y] = theme.band(line);
    frame.controls.push({ kind: 'level', x: 0, y, width });
  };
  const meter = card?.context;
  // The brief's state, wherever a brief is configured: data, not a switch.
  const said = briefState(input, now);
  const tone: StatusTone = card?.tone === 'error' ? 'error' : needs || session?.attention || session?.failed ? 'needs' : card?.tone ?? 'idle';
  // The state's glyph says it in copied text and without colour: needing the
  // person is "!", which leads a working state and stands in for an idle one.
  // A failure alone is marked in the error colour, as the alert row paints it.
  const flagged = tone === 'needs' && card?.tone !== 'error';
  const flag = (session?.failed && !needs && !session.attention ? theme.error : theme.warning)('!');
  const busy = card?.busy ?? card?.tone === 'working';
  const stateText = !card ? session?.text ?? '' : flagged ? (busy ? `${flag} ${card.state}` : flag) : card.state;
  const left = (state: string): Pieces => [['state', state], ['rate', card?.rate ?? ''], ['tasks', card?.tasks ?? ''],
    ['model', card?.model ?? ''], ['age', card?.age ?? '']];

  const cap = Math.min(Math.floor(height / 3), height - 1 - notices - MIN_VIEW);
  if (level === 'min' || !card || cap < 2) {
    if (height <= 1) return { rows: 0, draw() {} };
    // One line: the band, and the quota's reading where the corner row would have had it.
    // An approval waited on says what it waits on, as the alerts row would have.
    const shown = session?.attention ? session.text : stateText;
    return { rows: 1, draw(frame, foot) {
      band(frame, foot, fitRow(width, ' ', ' ', left(shown), [['brief', said], ['quota', card?.quota?.text ?? '']], meter,
        ['rate', 'tasks', 'age', 'tail', 'model', 'brief', 'bar', 'quota', 'label'], truncateAnsi, BAND_BAR));
      frame.statusCard = { y: foot, height: 1, brief: 0, total: 0, offset: 0 };
    } };
  }

  const inner = width - 2;
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
  return { rows, draw(frame, foot) {
    band(frame, foot, fitRow(width, ' ', ' ', left(stateText), [['brief', said]], meter,
      ['rate', 'tasks', 'age', 'tail', 'model', 'brief', 'bar', 'label'], truncateAnsi, BAND_BAR));
    let y = foot + 1;
    // A gutter on the left only: the text gets the column a right border would take.
    const row = (text: string) => { frame.lines[y++] = rule('│ ') + fit(text, inner); };
    for (const alert of alerts) row(alert);
    for (const line of lines.slice(offset, offset + shown)) row(line);
    if (overflow) {
      const below = lines.length - offset - shown;
      row(colors.dim(below ? (offset ? t('↑ {a}  ↓ {n} more lines', { a: offset, n: below }) : t('↓ {n} more lines', { n: below })) : t('↑ {n} more lines', { n: offset })));
    }
    const quota = card.quota;
    // Narrow, the branch goes first, then the window's name, then the repository.
    frame.lines[y] = fitRow(width, `${rule('╰─')} `, '',
      [['project', card.project || card.place], ['repo', card.repo ?? ''], ['branch', card.branch ?? ''], ['window', quota?.window ?? '']],
      [['others', card.others], ['spent', quota?.spent ?? ''], ['forecast', card.forecast], ['reset', card.reset], ['cache', card.cache]],
      quota ? { percent: quota.percent } : undefined, ['others', 'branch', 'window', 'repo', 'forecast', 'bar', 'reset', 'label'], squeezePlace,
      // A quota meter shorter than this reads as a tick mark, not a meter: the place gives way first.
      QUOTA_BAR);
    frame.statusCard = { y: foot, height: rows, brief: shown, total: lines.length, offset };
  } };
}

/** The place cut in the middle, its colours given up: the ends say which project and branch. */
function squeezePlace(place: string, width: number): string {
  return colors.dim(squeeze(stripAnsi(place), width));
}
