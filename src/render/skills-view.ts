/**
 * The Skills tab, display only: one row per shipped backup skill (its name and a one-line description in the panel's
 * language), under a header and a short line saying what the list is. No cursor, action or install state; the catalog is
 * read once by the caller and painted here, with no I/O.
 */
import type { BackupSkill } from '../collectors/backup-skills.js';
import type { MonitorRow } from './monitor.js';
import { language, t } from './i18n.js';
import { fit, flowLines, monitorText, squeeze } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { boardRow, section } from './workboard-rows.js';

/** Rows sit two cells in from the edge, as the Project hub's do under their section headers. */
const INDENT = 2;
const GAP = 2;
/** A description room under this is not a description: the rows then show names alone. */
const MIN_DESC = 8;
const PAD = ' '.repeat(INDENT);

/**
 * Names stand in one column as wide as the longest, but never over about a third of the panel (18 cells at least, the
 * second-longest name): the descriptions are what is read, and one long name must not take the room of twelve. A name
 * over the column is cut in the middle, as the end is what tells skills apart; at the default panel width that is the
 * one longest name.
 */
function layout(names: string[], width: number) {
  const column = Math.min(Math.max(0, ...names.map(visualLength)), Math.max(18, Math.floor(width * 0.37)));
  const room = width - INDENT - column - GAP;
  return { column, room: room >= MIN_DESC ? room : 0 };
}

/** `text` in `room` cells, ending in an ellipsis when cut: a Latin word is not split when a space is near enough, and a comma is not left before the dots. */
function cut(text: string, room: number): string {
  if (visualLength(text) <= room) return text;
  let head = truncateAnsi(text, room - 1, '');
  const mid = /[A-Za-z0-9]$/.test(head) && /^[A-Za-z0-9]/.test(text.slice(head.length)), space = head.lastIndexOf(' ');
  if (mid && space > head.length / 2) head = head.slice(0, space);
  return head.replace(/[\s,;:]+$/, '') + '…';
}

function skillRows(skills: BackupSkill[], width: number): MonitorRow[] {
  const key = language() === 'zh' ? 'zh' : 'en';
  const names = skills.map((s) => monitorText(s.name));
  const { column, room } = layout(names, width);
  return skills.map((skill, i) => {
    if (!room) return boardRow(fit(PAD + theme.board.identifier(squeeze(names[i], Math.max(1, width - INDENT))), width));
    const name = squeeze(names[i], column);
    const pad = ' '.repeat(column - visualLength(name) + GAP);
    return boardRow(
      fit(
        `${PAD}${theme.board.identifier(name)}${pad}${cut(monitorText(skill[key]), room)}`,
        width
      )
    );
  });
}

/**
 * `room` is the rows the panel has to show them: when the intro would push skills off a short panel it goes first, then
 * the blank row above the header. A panel too short for the skills themselves scrolls, as the other tabs do.
 */
export function skillsRows(skills: BackupSkill[] | null | undefined, width: number, room = Infinity): MonitorRow[] {
  const body: MonitorRow[] = skills
    ? skills.length
      ? skillRows(skills, width)
      : [boardRow(fit(PAD + theme.board.muted(t('No backup skills listed')), width))]
    : [boardRow(fit(PAD + theme.board.muted(t('Skills catalog unavailable')), width))];
  const head = section(t('Backup skills'), width, skills?.length ? String(skills.length) : '');
  const intro = flowLines(t('Matt Pocock skills kept as backups, not installed. Ask the main session to read one when you want it.'), Math.max(1, width - INDENT))
    .map((line) => boardRow(fit(PAD + theme.board.muted(line), width)));
  const full = [boardRow(''), head, ...intro, boardRow(''), ...body];
  if (full.length <= room) return full;
  const noIntro = [boardRow(''), head, ...body];
  return noIntro.length <= room ? noIntro : [head, ...body];
}
