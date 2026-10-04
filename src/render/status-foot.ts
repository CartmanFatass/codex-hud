/**
 * The status card at the foot of the panel, at the level the reader chose.
 * It is a closed box with rounded corners, which is what tells it apart from
 * the open agent cards above it.
 *
 * - `min`: its top edge alone, carrying the main session's state and clock,
 *   with a mark when something needs the person (a failure, an approval, a
 *   recap that says it needs them).
 * - `status`: the bar's fields, as the bar reads them.
 * - `full`: those, then an inner rule with the brief's state and its pause
 *   switch (while a brief is configured), then the main session's brief: the model's approval words, the
 *   labelled recap, the whole-picture sentence, a reply in another shape or
 *   a failure. Rich only: compact shows the brief above, so there `full` is
 *   `status`. With nothing to show it looks like `status`.
 *
 * The card takes at most about half the panel and always leaves the agents a
 * few rows; a brief taller than its room scrolls on its own, under the fixed
 * status rows, with a line saying what is out of view. Pure.
 */
import type { MonitorData, MonitorFrame, MonitorState } from './monitor.js';
import { fit, cardEdge, briefParts, writtenAge } from './monitor.js';
import { recapFields } from './cards.js';
import { colors, theme, truncateAnsi, visualLength, stripAnsi } from './colors.js';
import { t } from './i18n.js';

export type StatusLevel = 'min' | 'status' | 'full';
const LEVELS: readonly StatusLevel[] = ['min', 'status', 'full'];
/** Rows the agents view keeps however tall the card would like to be: its summary and a few more. */
const MIN_VIEW = 6;
/** Fewest rows of a cut brief worth an inner rule. */
const MIN_BRIEF = 2;

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

/** The main session's brief as lines `width` wide, its parts apart; paused, stepped back. */
function briefLines(input: MonitorData, width: number): string[] {
  const brief = input.brief;
  const parts: string[][] = [];
  // The approval words are a model feature of their own: shown with no brief configured too.
  const { approval, said } = briefParts(input, width, 0);
  if (approval.length) parts.push(approval);
  if (brief?.recap) parts.push(recapFields(brief.recap, width, true));
  if (said.length) parts.push(said);
  const lines = parts.flatMap((part, i) => [...(i ? [''] : []), ...part]);
  return brief?.paused ? lines.map(line => colors.dim(stripAnsi(line))) : lines;
}

export function planFoot(input: MonitorData, state: MonitorState, width: number, height: number, now: number, notices: number): FootPlan {
  const level = shownLevel(state);
  const hints = [` ${t(', Settings  ? keys')} `, ` ${t(', ?')} `];
  const title = colors.dim(` ${t('Status')} `);
  // Under 24 columns the frame would cost more than it holds: no card.
  const hint: FootPlan = { rows: height > 1 ? 1 : 0, draw(frame, foot) {
    if (height <= 1) return;
    frame.lines[foot] = colors.dim(truncateAnsi(t(width < 24 ? ', Settings  ?' : ', Settings  ? keys  1–5'), width));
    frame.controls.push({ kind: 'settings', x: 0, y: foot, width: Math.min(width, 12) });
  } };
  if (width < 24) return hint;
  const session = input.session?.(now) ?? null;
  const topEdge = (frame: MonitorFrame, foot: number, left: string, rights = hints, squeeze = false) => {
    const top = cardEdge('╭', '╮', width, left, title, rights, squeeze);
    frame.lines[foot] = top.line;
    // The hint opens settings; the rest of the edge changes the level.
    if (top.right) frame.controls.push({ kind: 'settings', x: top.right.x + 1, y: foot, width: visualLength(top.right.text) - 2 });
    frame.controls.push({ kind: 'level', x: 0, y: foot, width });
  };

  if (level === 'min') {
    if (!session && !input.status) return hint;
    const needs = Boolean(input.brief?.recap?.needs);
    const mark = session?.attention ? '' : session?.failed ? theme.error('! ') : needs ? theme.warning('! ') : '';
    // The state never gives way to the hints: they go first, then the
    // card's name, then the state's glyph; at the last it is cut.
    const lefts = session ? [`${title}${mark}${session.text} `, ` ${mark}${session.text} `,
      ...(session.short ? [` ${session.attention ? theme.warning('! ') : mark}${session.short} `] : [])] : [title];
    return { rows: 1, draw(frame, foot) {
      const room = width - 4;
      const fits = lefts.find(left => visualLength(left) <= room - 1) ?? lefts.at(-1)!;
      const hinted = lefts[0] === fits && hints.find(hint => visualLength(fits) + visualLength(hint) <= room - 1);
      topEdge(frame, foot, fits, hinted ? [hinted] : [], true);
      frame.statusCard = { y: foot, height: 1, brief: 0, total: 0, offset: 0 };
    } };
  }

  // The card is its rows plus a top and bottom edge; a shorter panel gets fewer rows.
  const cardRows = height >= 24 ? 5 : height >= 18 ? 4 : height >= 13 ? 2 : 0;
  const card = cardRows && input.status ? input.status(width - 4, cardRows) : null;
  const status = card?.rows.slice(0, cardRows) ?? [];
  if (!card || !status.length) return hint;
  const inner = width - 4;
  const brief = input.brief;
  const lines = level === 'full' ? briefLines(input, inner) : [];
  // The brief's own state rides on the inner rule, with its switch.
  const said = !brief ? '' : brief.paused ? t('paused') : brief.running ? t('writing…') : brief.error ? t('failed')
    : brief.recap ? `${t('Recap')} ${writtenAge(brief.recap.at, now)}` : '';
  const wanted = level === 'full' && (lines.length || said);
  const cap = Math.min(Math.floor(height / 2), height - 1 - notices - MIN_VIEW);
  const room = cap - status.length - 3;
  // Cut, the brief needs room for a few of its lines beside the line saying so.
  const section = wanted && room >= 0 && (lines.length <= room || room - 1 >= MIN_BRIEF);
  const overflow = section && lines.length > room;
  const shown = !section ? 0 : overflow ? room - 1 : lines.length;
  const offset = overflow ? Math.max(0, Math.min(state.statusScroll ?? 0, lines.length - shown)) : 0;
  state.statusScroll = offset;
  const rows = status.length + 2 + (section ? 1 + shown + (overflow ? 1 : 0) : 0);
  return { rows, draw(frame, foot) {
    topEdge(frame, foot, card.top ? `${title}${card.top} ` : title);
    let y = foot + 1;
    const row = (text: string) => { frame.lines[y++] = colors.dim('│ ') + fit(text, inner) + colors.dim(' │'); };
    for (const line of status) row(line);
    if (section) {
      // The switch only while a brief is configured: with none there is nothing to hold.
      const pause = brief ? [` ${t(brief.paused ? 'b resume' : 'b pause')} `] : [];
      const paint = brief?.error && !brief.paused && !brief.running ? theme.warning : colors.dim;
      // Short of room, the age alone says which recap it is; the switch stays.
      const label = said && pause.length && visualLength(` ${said} `) + visualLength(pause[0]) > width - 5 && !brief?.paused && !brief?.running && !brief?.error && brief?.recap
        ? writtenAge(brief.recap.at, now) : said;
      const rule = cardEdge('├', '┤', width, label ? ` ${paint(label)} ` : '', '', pause, true);
      frame.lines[y] = rule.line;
      if (rule.right) frame.controls.push({ kind: 'brief', x: rule.right.x, y, width: visualLength(rule.right.text) });
      y++;
      for (const line of lines.slice(offset, offset + shown)) row(line);
      if (overflow) {
        const below = lines.length - offset - shown;
        row(colors.dim(below ? (offset ? t('↑ {a}  ↓ {n} more lines', { a: offset, n: below }) : t('↓ {n} more lines', { n: below })) : t('↑ {n} more lines', { n: offset })));
      }
    }
    frame.lines[y] = cardEdge('╰', '╯', width, card.bottom ? ` ${card.bottom} ` : '', '', card.bottomRight ? [` ${card.bottomRight} `] : [], true).line;
    frame.statusCard = { y: foot, height: rows, brief: shown, total: lines.length, offset };
  } };
}
