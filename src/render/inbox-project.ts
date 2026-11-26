/** Pure Project overview and project switcher. Owner requests live in the pinned request area. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { PAGE_WORD, objectiveRows, pageSummary, projectOrder, sinceText } from './project-view.js';
import { boardRow, compactAge, mark, section } from './workboard-rows.js';
import { cutWords, fit, monitorText, pair, sentenceRows } from './monitor-text.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

const muted = (text: string) => theme.board.muted(text);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const cutText = (b: string, room: number) => room < 1 ? '' : visualLength(b) <= room ? b : cutWords(b, room);
const cutId = (text: string, room: number) => {
  const body = monitorText(text);
  return cutText(body, room) || truncateAnsi(body, room);
};

function detailRows(data: ProjectSnapshot, width: number, now: number): MonitorRow[] {
  const totals = data.ticketTotals, col = width < 56 ? 9 : 10;
  const coverage = totals?.partial ? t(totals.totalFeatures === 1 ? '{n} feature sampled' : '{n} features sampled', { n: totals.totalFeatures }) : '';
  const rows = [plain('', width), section(t('Details'), width, coverage)];
  for (const page of ['tickets', 'progress', 'tree', 'docs'] as const) {
    if ((page === 'tickets' && !(totals?.totalFeatures || totals?.partial || data.tickets.length)) || (page === 'tree' && !data.git)) continue;
    const label = page === 'tree' ? 'Worktree' : PAGE_WORD[page], room = width - col - 1;
    const summary = pageSummary(page, data, now);
    // The Git branch is a token; let it give way to the whole change count.
    if (page === 'tree' && data.git?.branch) summary[0] = truncateAnsi(summary[0], Math.max(0, room - visualLength(summary[1]) - 3));
    const facts = summary.filter((fact) => fact && visualLength(fact) <= room);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > room) facts.pop();
    rows.push({ ...plain(`${muted(fit(t(label), col))} ${facts.join(' · ') || muted(mark('—', '-'))}`, width), item: `project:page:${page}` });
  }
  return rows;
}

function stateNotes(data: ProjectSnapshot, width: number): MonitorRow[] {
  const next = data.next.map((r) => r.value).join(' · '), path = data.statePath;
  return ([['Now', data.summary], ['Next', next]] as const).flatMap(([label, body]) => body ? [section(t(label), width),
    ...sentenceRows(monitorText(body), width, 2, 2).map((line) => ({ ...plain(muted(line), width),
      ...(path && { item: `project:file:${path}:${label.toLowerCase()}`, files: [path] }) }))] : []);
}

/** Project landing: declared Objectives or STATE notes, then diagnostic links. */
export function projectOverviewRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
): MonitorRow[] {
  const many = projects.length > 1;
  const record = data.objectives, stance = record && record.stance !== 'unknown' ? t(record.stance) : '';
  const priority = record && record.priority !== 'normal' ? t('{priority} priority', { priority: t(record.priority) }) : '';
  const age = compactAge(Math.max(data.updatedAt ?? -Infinity, data.objectivesAt ?? -Infinity), now);
  const ageText = age && t(width < 50 ? '{age} ago' : 'updated {age} ago', { age });
  const identity = [priority, ageText, stance].filter(Boolean);
  while (visualLength(identity.join(' · ')) + 2 > width && identity.length) identity.shift();
  if (stance && identity.includes(stance)) identity.unshift(identity.pop()!);
  const title = truncateAnsi(monitorText(name), width < 50 ? 14 : width < 80 ? 18 : 24) || t('Project');
  // With multiple projects, the resident project strip under the tabs replaces the folded picker header.
  return [...(many ? [] : [plain('', width), section(theme.board.title(title), width)]),
    ...(identity.length ? [plain(`  ${muted(identity.join(' · '))}`, width)] : []),
    ...(!record ? stateNotes(data, width) : []), ...objectiveRows(data, width, now, state.project.folded.has('unlinked:more')),
    ...detailRows(data, width, now)];
}

/** Projects list: grouped into Needs you, Running and Quiet (a quiet project is one row). */
export function projectListRows(projects: ProjectChoice[], width: number, now: number): MonitorRow[] {
  const ordered = projectOrder(projects), needs = ordered.filter((p) => (p.overview?.waiting ?? 0) > 0);
  const running = ordered.filter((p) => !needs.includes(p) && (p.overview?.running ?? 0) > 0), quiet = ordered.filter((p) => !needs.includes(p) && !running.includes(p));
  const rows: MonitorRow[] = [boardRow('')], gap = () => { if (rows.length > 1) rows.push(boardRow('')); };
  const headRow = (p: ProjectChoice, right: string): MonitorRow => {
    const ms = p.overview?.milestone ? monitorText(p.overview.milestone) : '', max = Math.max(1, width - (right ? visualLength(right) + 1 : 0)), title = cutId(p.name, max);
    return { item: `project:list:${p.root}`, text: pair(theme.board.title(title) + (ms && visualLength(title) + 2 + visualLength(ms) <= max ? '  ' + muted(ms) : ''), right, width) };
  };
  if (needs.length) {
    rows.push(section(t('Needs you'), width, String(needs.length)));
    for (const p of needs) {
      const o = p.overview!, item = `project:list:${p.root}`, age = muted(sinceText(o.at, now));
      rows.push(headRow(p, theme.board.attention(t('{n} waiting', { n: o.waiting }))));
      const status = o.running ? theme.board.active(t('{n} running', { n: o.running })) : o.open ? muted(t('{n} open', { n: o.open })) : '';
      rows.push({ item, text: pair(status ? '  ' + status : '', age, width) });
    }
  }
  if (running.length) {
    gap();
    rows.push(section(t('Running'), width, String(running.length)));
    for (const p of running) {
      const o = p.overview!, item = `project:list:${p.root}`;
      rows.push(headRow(p, theme.board.active(`${mark('◉', '@')} ${o.running}`)), { item, text: pair('  ' + theme.board.active(t('{n} running', { n: o.running })), muted(sinceText(o.at, now)), width) });
    }
  }
  if (quiet.length) {
    gap();
    rows.push(section(t('Quiet'), width, String(quiet.length)));
    for (const p of quiet) {
      const o = p.overview, age = muted(sinceText(o?.at, now)), tag = !o ? muted(mark('…', '~')) : !o.hasState ? muted(t('no STATE.md')) : o.milestone ? muted(monitorText(o.milestone)) : '';
      const room = Math.max(1, width - 2 - (age ? visualLength(age) + 1 : 0) - (tag ? visualLength(tag) + 2 : 0));
      rows.push({ item: `project:list:${p.root}`, text: pair(`  ${theme.board.title(cutId(p.name, room))}${tag ? '  ' + tag : ''}`, age, width) });
    }
  }
  return rows;
}
