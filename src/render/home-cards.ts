import type { TodayFacts } from '../collectors/home-cards.js';
import { homeActivityAt, type HomeProject } from '../collectors/home-portfolio.js';
import { localDayStart } from '../collectors/job-stats.js';
import { DAY_MS, scheduleTiming, type ScheduleItem } from '../collectors/schedule.js';
import { theme, visualLength as cells } from './colors.js';
import { t } from './i18n.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';
import type { MonitorRow } from './monitor.js';
import { cutSentence, fit, monitorText, tokenColumn } from './monitor-text.js';
import { roleInk } from './work-job-row.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';

const calendar = () => mark('◉', '@', '\uF073');
const joinFacts = (facts: string[]) => facts.filter(Boolean).join(theme.board.muted(' · '));
const paddedLeft = (text: string, width: number) => ' '.repeat(Math.max(0, width - cells(text))) + text;
const line = (text: string, width: number) => boardRow(fit(text, width));

function sectionFacts(label: string, width: number, ...facts: string[]) {
  const kept = facts.filter(Boolean);
  while (kept.length && cells(label) + 3 + cells(joinFacts(kept)) > width) kept.shift();
  return section(label, width, joinFacts(kept));
}

function roleCounts(counts: ReadonlyMap<string, number>, failed: boolean) {
  const grouped = new Map<string, number>();
  for (const [role, n] of counts) {
    const key = Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other';
    grouped.set(key, (grouped.get(key) ?? 0) + n);
  }
  return Object.keys(ROLE_GLYPHS).flatMap(role => {
    const n = grouped.get(role);
    return n ? [(failed ? theme.board.danger : roleInk(role))(roleIcon(role) + n)] : [];
  }).join(' ');
}
const total = (counts: ReadonlyMap<string, number>) => [...counts.values()].reduce((sum, n) => sum + n, 0);

function todayRows(data: TodayFacts | undefined, width: number, now: number, level: number): MonitorRow[] {
  if (!data || level >= 3 || data.since !== localDayStart(now)) return [];
  const ink = theme.board, label = t('Today'), { landed, newest, finished, failed, first, retried, limited } = data;
  const nDone = total(finished), nFailed = total(failed), bound = limited ? t('bounded scan') : '';
  if (!landed && !nDone && !nFailed) return [sectionFacts(label, width, t('nothing yet'), bound)];
  const lands = landed ? t('{n} landed', { n: landed }) : '';
  if (level === 2) return [sectionFacts(label, width, lands, nDone ? t('done {n}', { n: nDone }) : '',
    nFailed ? ink.danger(t('failed {n}', { n: nFailed })) : '', bound)];
  const rows = [sectionFacts(label, width, lands || t('none landed'), bound)];
  if (level === 0) {
    const nameCol = Math.min(width < 50 ? 10 : width < 80 ? 14 : 18, Math.max(0, width - 8)), ticketCol = width >= 80 ? 18 : 0;
    for (const { id, root, name, ticket, title, at } of newest) {
      const age = compactAge(at, now), titleCol = Math.max(0, width - 4 - nameCol - Math.max(4, cells(age)) - (ticketCol ? ticketCol + 1 : 0));
      const ticketText = ticketCol ? ' ' + ink.muted(tokenColumn(monitorText(ticket ?? ''), ticketCol)) : '';
      rows.push({ ...line(`${ink.success(stateMark.done())} ${ink.text(tokenColumn(monitorText(name), nameCol))} ` +
        `${ink.muted(fit(cutSentence(monitorText(title ?? ''), titleCol), titleCol))}${ticketText} ${ink.muted(paddedLeft(age, 4))}`, width),
        item: `home:card:today:${id}`, homeTarget: { root } });
    }
    if (landed > newest.length) rows.push(line('  ' + ink.muted(t('{remaining} more', { remaining: landed - newest.length })), width));
  }
  const col = Math.max(...[t('done'), t('failed'), t('gates')].map(cells)) + 1, room = width - 2 - col;
  const fact = (key: string, paint: (s: string) => string, value: string) => line(`  ${paint(fit(t(key), col))}${value}`, width);
  const roles = (counts: ReadonlyMap<string, number>, n: number, failed: boolean) => {
    const value = roleCounts(counts, failed);
    return cells(value) <= room ? value : (failed ? ink.danger : ink.text)(String(n));
  };
  if (nDone) rows.push(fact('done', ink.muted, roles(finished, nDone, false)));
  if (nFailed) rows.push(fact('failed', ink.danger, roles(failed, nFailed, true)));
  const gates = [first ? t('first try {n}', { n: first }) : '', retried ? t('retried {n}', { n: retried }) : ''].filter(Boolean);
  while (gates.length && cells(joinFacts(gates)) > room) gates.shift();
  if (gates.length) rows.push(fact('gates', ink.muted, joinFacts(gates)));
  return rows;
}

export function scheduleView(items: readonly ScheduleItem[] | undefined, now: number) {
  const sorted = (items ?? []).map(item => ({ item, ...scheduleTiming(item.date, now) }))
    .sort((a, b) => a.days_until_due - b.days_until_due);
  const overdue = sorted.filter(row => row.stage === 'overdue').length;
  const today = sorted.filter(row => row.stage === 'today').length;
  return { sorted, overdue, today };
}
export type ScheduleView = ReturnType<typeof scheduleView>;

export function scheduleBadge({ overdue, today }: ScheduleView) {
  return overdue || today ? ' ' + (overdue ? theme.board.attention : theme.board.active)(calendar() + (overdue + today)) : '';
}

function countdown({ item, stage, days_until_due: days }: ScheduleView['sorted'][number], now: number) {
  if (stage === 'overdue') {
    const age = days <= -14 ? t('{n}w', { n: Math.floor(-days / 7) }) : t('{n}d', { n: -days });
    return t('{age} late', { age });
  }
  if (stage === 'today') return t('Today').toLowerCase();
  if (item.date.length === 7) {
    const date = new Date(now);
    const months = (Number(item.date.slice(0, 4)) - date.getFullYear()) * 12 + Number(item.date.slice(5)) - 1 - date.getMonth();
    return months === 0 ? t('this mo') : months === 1 ? t('next mo') : t('in {n}mo', { n: months });
  }
  if (days === 1) return t('tomorrow');
  return days < 14 ? t('in {n}d', { n: days }) : days < 70 ? t('in {n}w', { n: Math.floor(days / 7) })
    : t('in {n}mo', { n: Math.floor(days / 30) });
}

function quietProjects(projects: readonly HomeProject[], now: number) {
  return projects.flatMap(({ name, snapshot, unavailable }) => {
    const at = homeActivityAt(snapshot), stance = snapshot?.objectives?.stance;
    return !unavailable && stance !== 'paused' && stance !== 'maintenance' && snapshot?.idle &&
      at !== undefined && now - at > 14 * DAY_MS ? [{ name, at }] : [];
  }).sort((a, b) => a.at - b.at);
}

function scheduleRows({ sorted, overdue, today }: ScheduleView, projects: readonly HomeProject[], width: number, now: number, level: number): MonitorRow[] {
  const ink = theme.board, label = t('Schedule'), n = sorted.length, due = overdue + today;
  if (level === 3 && !due) return [];
  if (level >= 2 && due) return [sectionFacts(label, width, overdue ? ink.attention(t('overdue {n}', { n: overdue })) : '',
    today ? ink.active(t('today {n}', { n: today })) : '')];
  const quiet = quietProjects(projects, now);
  if (!n && !quiet.length) return [];
  const count = n ? t(n === 1 ? '{n} item' : '{n} items', { n }) : '';
  if (level === 2) return [sectionFacts(label, width, ...(n ? [count, t('next {when}', { when: countdown(sorted[0], now) })]
    : [t('quiet projects: {n}', { n: quiet.length })]))];
  const rows = [sectionFacts(label, width, count)];
  // Due items all stay, with at least one later item when there is one.
  const shown = sorted.slice(0, Math.max(due + 1, level === 0 ? 4 : 3));
  const names = new Map(projects.map(p => [p.root, p.name])), nameCol = width >= 80 ? 14 : 0;
  const times = shown.map(row => countdown(row, now));
  const timeCol = Math.max(0, ...times.map(cells)), showTime = timeCol <= width - 10 - (nameCol ? nameCol + 1 : 0);
  const textCol = width - 8 - (nameCol ? nameCol + 1 : 0) - (showTime ? timeCol + 1 : 0);
  for (const [i, { item, stage, due }] of shown.entries()) {
    const paint = stage === 'far' ? ink.muted : ink.text;
    const whenInk = stage === 'overdue' ? ink.attention : stage === 'today' ? ink.active : paint;
    const glyph = stage === 'overdue' ? mark('!', '!', '\uF06A') : stage === 'today' ? calendar() : mark('◷', '~', '\uF133');
    const date = item.date.slice(5) + (item.date.length === 7 ? '-??' : '');
    const name = item.project ? monitorText(names.get(item.project) ?? '') : '';
    const target = { item: `home:card:schedule:${item.id}`, ...(name && item.project ? { homeTarget: { root: item.project } } : {}) };
    const project = nameCol ? ' ' + ink.muted(tokenColumn(name, nameCol)) : '';
    const when = showTime ? ' ' + whenInk(paddedLeft(times[i], timeCol)) : '';
    rows.push({ ...line(`${whenInk(glyph)} ${(stage === 'overdue' ? ink.attention : paint)(date)} ` +
      `${paint(fit(cutSentence(monitorText(item.text), textCol), textCol))}${project}${when}`, width), ...target });
    if (level === 0 && !nameCol && due && name) {
      const objective = item.objective ? ` ${mark('›', '>')} ${tokenColumn(monitorText(item.objective), width < 50 ? 11 : 14).trimEnd()}` : '';
      rows.push({ ...line('  ' + ink.muted(tokenColumn(name, 14).trimEnd() + objective), width), ...target });
    }
  }
  if (level === 0 && shown.length < n) rows.push(line('  ' + ink.muted(t('{n} more items', { n: n - shown.length })), width));
  if (level === 0 && quiet.length) {
    const facts = quiet.map(({ name, at }) => `${tokenColumn(monitorText(name), 14).trimEnd()} ${compactAge(at, now)}`);
    const glyph = mark('○', 'o', '\uF10C');
    for (let keep = Math.min(facts.length, width); keep >= 0; keep--) {
      const rest = keep < facts.length ? t('{remaining} more', { remaining: facts.length - keep }) : '';
      const text = `${glyph} ${t('quiet {projects}', { projects: joinFacts([...facts.slice(0, keep), rest]) })}`;
      if (cells(text) <= width) { rows.push(line(ink.muted(text), width)); break; }
    }
  }
  return rows;
}

/** Cards never borrow a row from the full-tier portfolio. */
export function homeCardRows(today: TodayFacts | undefined, schedule: ScheduleView, projects: readonly HomeProject[], width: number, now: number, spare: number) {
  if (spare <= 0) return { rows: [], full: false };
  const blank = line('', width);
  for (let level = 0; level <= 3; level++) {
    const a = todayRows(today, width, now, level), b = scheduleRows(schedule, projects, width, now, level);
    if (!a.length && !b.length) return { rows: [], full: level === 0 };
    const rows = [...(level < 3 ? [blank] : []), ...a, ...(a.length && b.length && level < 2 ? [blank] : []), ...b];
    if (rows.length <= spare) return { rows, full: level === 0 };
  }
  return { rows: [], full: false };
}
