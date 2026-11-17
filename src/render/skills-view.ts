/**
 * The Skills tab, display only: each shipped backup skill's name and its whole one-line description in the panel's
 * language, under a header and a short line saying what the list is. Descriptions wrap, they are never cut, so the tab
 * reads at a 40-column panel. No cursor, action or install state; the catalog is read once by the caller and painted
 * here, with no I/O.
 *
 * Two layouts, one rule (the name is in the identifier ink, the description is plain text under or beside it, and a
 * skill ends where the next name begins):
 * - narrow: the name on its own row, the description under it, two cells further in. A description gets nearly the
 *   whole panel (36 cells at 40 columns) instead of the few cells left beside a name, and every skill is the same
 *   shape whatever its name or text. A name longer than the row wraps after a hyphen.
 * - wide: name and description side by side, the description wrapped in its own column with a hanging indent, as the
 *   Project hub's label rows are. Chosen when that column is at least `SIDE` cells: most descriptions then take one
 *   row, which saves the name row of each skill. Under that the side column wraps most of them to two rows, the tab
 *   comes out no shorter than the narrow layout and a word or two is left alone on a second row; the narrow layout
 *   then reads better, with a description a whole row wide.
 */
import type { BackupSkill } from '../collectors/backup-skills.js';
import type { MonitorRow } from './monitor.js';
import { language, t } from './i18n.js';
import { fit, flowLines, monitorText, wrapped } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { boardRow, section } from './workboard-rows.js';

/** Rows sit two cells in from the edge, as the Project hub's do under their section headers. */
const INDENT = 2;
/** A narrow layout's description sits this much further in than its name. */
const HANG = 2;
/** Between the name column and the descriptions of the wide layout. */
const GAP = 2;
/** The description column the wide layout needs: 70 cells holds 9 of the 12 shipped English descriptions on one row (and a 2-row one is no longer than the narrow layout's name row and text row). */
const SIDE = 70;
const PAD = ' '.repeat(INDENT);

/** A name in rows of at most `room`: broken after a hyphen where it can, in the middle of a word only when it must. */
function nameLines(name: string, room: number): string[] {
  if (visualLength(name) <= room) return [name];
  const lines: string[] = [];
  let line = '';
  for (const piece of name.match(/[^-]*-|[^-]+/g) ?? [name]) {
    if (line && visualLength(line + piece) > room) {
      lines.push(line);
      line = '';
    }
    if (visualLength(piece) > room) {
      const parts = wrapped(piece, room);
      lines.push(...parts.slice(0, -1));
      line = parts.at(-1) ?? '';
    } else line += piece;
  }
  if (line) lines.push(line);
  return lines;
}

function skillRows(skills: BackupSkill[], width: number): MonitorRow[] {
  const key = language() === 'zh' ? 'zh' : 'en';
  const names = skills.map((s) => monitorText(s.name));
  const column = Math.max(0, ...names.map(visualLength));
  const room = width - INDENT - column - GAP;
  const side = room >= SIDE;
  const row = (text: string) => boardRow(fit(text, width));
  return skills.flatMap((skill, i) => {
    const text = flowLines(monitorText(skill[key]), side ? room : Math.max(1, width - INDENT - HANG));
    if (side) {
      const name = theme.board.identifier(names[i]) + ' '.repeat(column - visualLength(names[i]) + GAP);
      return (text.length ? text : ['']).map((line, n) => row(PAD + (n ? ' '.repeat(column + GAP) : name) + line));
    }
    return [
      ...nameLines(names[i], Math.max(1, width - INDENT)).map((line) => row(PAD + theme.board.identifier(line))),
      ...text.map((line) => row(PAD + ' '.repeat(HANG) + line)),
    ];
  });
}

/**
 * `room` is the rows the panel has to show them. Where the whole tab does not fit but would without the intro, the intro
 * goes (then the blank row above the header); where it does not fit anyway the tab scrolls, as the other tabs do, and
 * keeps its intro, which a wrapped list at a narrow panel always needs.
 */
export function skillsRows(skills: BackupSkill[] | null | undefined, width: number, room = Infinity): MonitorRow[] {
  const muted = (text: string) => flowLines(text, Math.max(1, width - INDENT)).map((line) => boardRow(fit(PAD + theme.board.muted(line), width)));
  const body: MonitorRow[] = skills
    ? skills.length
      ? skillRows(skills, width)
      : muted(t('No backup skills listed'))
    : muted(t('Skills catalog unavailable'));
  const head = section(t('Backup skills'), width, skills?.length ? String(skills.length) : '');
  const intro = muted(t('Matt Pocock skills kept as backups, not installed. Ask the main session to read one when you want it.'));
  const full = [boardRow(''), head, ...intro, boardRow(''), ...body];
  if (full.length <= room) return full;
  const noIntro = [boardRow(''), head, ...body];
  if (noIntro.length <= room) return noIntro;
  const tight = [head, ...body];
  return tight.length <= room ? tight : full;
}
