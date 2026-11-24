/** Portfolio handoff. A job waiting for main is not an owner request. */
import { blockedObjectives, ownerRequestKey, type ProjectSnapshot } from '../collectors/project-board.js';
import type { Objective } from '../collectors/objectives.js';
import type { HomePortfolio, HomeProject, HomeRequest } from '../collectors/home-portfolio.js';
import type { MonitorRow } from './monitor.js';
import { theme, truncateAnsi, visualLength as cells } from './colors.js';
import { cutSentence, fit, monitorText, pair, sentenceRows, tokenColumn } from './monitor-text.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';
import { roleInk } from './work-job-row.js';
import { barText, linkedTicketProgress as progress, TICKET_BAR_ORDER } from './progress-bar.js';
import { t } from './i18n.js';

const pad = (n: number) => ' '.repeat(Math.max(0, n));
const nameCap = (width: number) => width < 50 ? 14 : width < 80 ? 18 : 24;
const dots = (width: number) => theme.board.frame(mark('╌', '.').repeat(width));
const liveMark = () => theme.board.active(mark('●', '*', '\uF111'));
const idleMark = () => theme.board.muted(mark('○', 'o', '\uF10C'));
const pauseMark = () => theme.board.muted(mark('‖', '=', '\uF28B'));
const askMark = () => theme.board.attention(stateMark.asking());
function progressCells(data: ReturnType<typeof progress>, width: number, paused: boolean) {
  return !data ? pad(width) : data.total ? barText(data, width, TICKET_BAR_ORDER, paused) : dots(width);
}
const countText = (data: ReturnType<typeof progress>, width: number) => {
  if (!data?.total) return '';
  const count = `${data.counts.accepted}/${data.total}`;
  return width < 56 ? count : t('{count} tickets', { count });
};

function loadFacts(jobs: ProjectSnapshot['active']) {
  const ink = theme.board;
  const running: Record<string, number> = {}, queued: Record<string, number> = {};
  for (const { role, state } of jobs) {
    const key = Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other';
    const group = state === 'queued' ? queued : running;
    group[key] = (group[key] ?? 0) + 1;
  }
  const roles = Object.keys(ROLE_GLYPHS), queueMark = mark('◷', '~', '\uF017');
  return [roles.filter((r) => running[r]).map((r) => roleInk(r)(roleIcon(r) + running[r])),
    roles.filter((r) => queued[r]).map((r) => ink.muted(queueMark) + roleInk(r)(roleIcon(r) + queued[r]))].flat().join(' ');
}

function projectView({ root, name, unavailable, snapshot, resultDates }: HomeProject, now: number) {
  const ink = theme.board;
  const record = snapshot?.objectives, jobs = snapshot?.active ?? [], objectives = record?.objectives ?? [];
  const blocked = blockedObjectives(snapshot?.waiting ?? []), running = jobs.some(({ state }) => state !== 'queued');
  const open = objectives.filter(({ state }) => state !== 'done').sort((a, b) =>
    Number(blocked.has(b.id)) - Number(blocked.has(a.id)) || Number(a.state === 'paused') - Number(b.state === 'paused'));
  const recentAge = (id: string) => {
    const at = resultDates?.get(id);
    return at !== undefined && now - at <= 3 * 86_400_000 ? compactAge(at, now) : '';
  };
  const finished = objectives.filter(({ id, state }) => state === 'done' && recentAge(id));
  const stance = record?.stance === 'paused' || record?.stance === 'maintenance' ? ink.muted(` · ${t(record.stance)}`) : '';
  const priority = record?.priority === 'high' ? ink.attention(mark('↑', '^', '\uF062'))
    : record?.priority === 'low' ? ink.muted(mark('↓', 'v', '\uF063')) : '';
  const idle = snapshot?.idle && !running, idleWord = idle && !stance ? ink.muted(t('idle')) : '';
  const noNotes = snapshot && !record && !snapshot.statePath;
  const age = compactAge(noNotes ? snapshot.lastJobAt
    : Math.max(snapshot?.updatedAt ?? -Infinity, snapshot?.objectivesAt ?? -Infinity), now);
  return { root, name: monitorText(name), unavailable, stance, paused: record?.stance === 'paused', open, finished, blocked,
    features: new Map(snapshot?.tickets.map((f) => [f.slug, f])),
    mark: unavailable ? ink.danger(stateMark.failed()) : running ? liveMark() : idleMark(),
    nameInk: running && !unavailable ? ink.text : ink.muted,
    priority, idleWord, age: age && ink.muted(age), load: loadFacts(jobs),
    note: !record && snapshot?.summary, noNotes, recentAge };
}
type ProjectView = ReturnType<typeof projectView>;

/** Drop whole facts from least to most important; callers reserve the minimum token space first. */
function keepFacts(room: number, ...facts: string[]) {
  const kept = facts.filter(Boolean);
  while (kept.length && cells(kept.join(' ')) > room) kept.shift();
  return kept;
}
function headerFacts(v: ProjectView, room: number) {
  const kept = keepFacts(room, v.priority, v.idleWord, v.age, v.load);
  // Display load before the age even though age is dropped first.
  if (v.load && v.age && kept.includes(v.age)) kept.splice(kept.length - 2, 2, v.load, v.age);
  return kept.join(' ');
}
const projectTarget = ({ root }: ProjectView) => ({ item: `home:project:${root}`, homeTarget: { root } });

function projectHeader(v: ProjectView, width: number): MonitorRow {
  const ink = theme.board;
  const stance = !v.unavailable && width >= 2 + Math.min(8, cells(v.name)) + cells(v.stance) ? v.stance : '';
  const room = width - 2 - cells(stance) - 1 - Math.min(8, cells(v.name));
  const right = v.unavailable ? keepFacts(room, ink.danger(t('unavailable'))).join(' ') : headerFacts(v, room);
  const nameWidth = Math.max(0, Math.min(nameCap(width), width - 2 - cells(stance) - (right ? cells(right) + 1 : 0)));
  const left = `${v.mark} ${v.nameInk(truncateAnsi(v.name, nameWidth))}${stance}`;
  const rule = width - cells(left) - (right ? cells(right) + 2 : 1);
  const body = rule > 0 ? `${left} ${ink.frame(mark('─', '-').repeat(rule))}` : left;
  return { ...boardRow(fit(pair(body, right, width), width)), ...projectTarget(v) };
}

function requestRows({ project, index, item }: HomeRequest, width: number, now: number): MonitorRow[] {
  const ink = theme.board;
  const name = monitorText(project.name), id = monitorText(item.objective ?? ''), lead = `${askMark()} `;
  const divider = id ? ` ${ink.muted(mark('›', '>'))} ` : '';
  const fixed = cells(lead + divider), minName = Math.min(cells(name), 8), minId = Math.min(cells(id), 8);
  const age = compactAge(item.at, now), flag = item.waitedOn ? ink.attention(t('work waits')) : '';
  const right = keepFacts(width - fixed - minName - minId - 1, age && ink.muted(age), flag).reverse().join(' ');
  const room = Math.max(0, width - fixed - (right ? cells(right) + 1 : 0));
  let nameWidth = Math.min(cells(name), nameCap(width)), idWidth = Math.min(cells(id), width < 50 ? 11 : 14);
  while (nameWidth + idWidth > room && (nameWidth > minName || idWidth > minId)) {
    if (nameWidth > minName && (nameWidth >= idWidth || idWidth <= minId)) nameWidth--;
    else idWidth--;
  }
  const head = `${lead}${ink.text(truncateAnsi(name, nameWidth))}${divider}${ink.text(truncateAnsi(id, idWidth))}`;
  const prose = monitorText((item.sentence ?? item.value).replace(/\s+/g, ' ').trim());
  const itemId = `home:wait:${project.root}:${item.request ?? index}`;
  const homeTarget = { root: project.root, index, request: ownerRequestKey(item) };
  return [pair(head, right, width), ...sentenceRows(prose, width, 2, 2).map(ink.text)]
    .map((text) => ({ text: fit(text, width), item: itemId, homeTarget }));
}

function objectiveRows(v: ProjectView, objective: Objective, width: number) {
  const ink = theme.board;
  const done = objective.state === 'done', blocked = !done && v.blocked.has(objective.id), paused = objective.state === 'paused';
  const state = done ? ink.success(stateMark.done()) : blocked ? askMark() : paused ? pauseMark() : liveMark();
  const textInk = blocked ? ink.attention : paused ? ink.muted : ink.text;
  const data = progress(v.features, objective.features), count = countText(data, width);
  const lead = `  ${state} `, flagCol = width < 50 ? 0 : Math.max(cells(t('blocked')), cells(t('paused')));
  const flag = flagCol ? ' ' + fit(blocked ? ink.attention(t('blocked')) : paused ? ink.muted(t('paused')) : '', flagCol) : '';
  const countCol = Math.max(cells(count), width < 56 ? 5 : cells(t('{count} tickets', { count: '00/00' })));
  const idCol = Math.min(width < 50 ? 11 : 14, Math.max(1, width - cells(lead) - cells(flag) - countCol - 3));
  const graphicRoom = Math.max(0, width - cells(lead) - idCol - 2 - countCol - cells(flag));
  const titleCol = width >= 80 ? graphicRoom - 17 : 0;
  const title = titleCol > 0 ? ink.muted(fit(cutSentence(monitorText(objective.title), titleCol), titleCol)) + ' ' : '';
  const barWidth = graphicRoom - cells(title);
  const graphic = done ? ink.success(mark('█', '#').repeat(barWidth)) : progressCells(data, barWidth, paused);
  const target = { root: v.root, objective, blocked };
  const row = { text: fit(`${lead}${textInk(tokenColumn(monitorText(objective.id), idCol))} ${title}${graphic} ${pad(countCol - cells(count))}${(paused ? ink.muted : ink.text)(count)}${flag}`, width),
    item: `home:objective:${v.root}:${objective.id}`, objectiveTarget: target };
  const recentAge = v.recentAge(objective.id);
  if (!recentAge || !objective.result) return { row };
  const age = ink.muted(recentAge);
  const line = sentenceRows(monitorText(objective.result), width - cells(age) - 1, 1, 4, ink.success(stateMark.done()))[0] ?? '';
  return { row, result: { text: fit(pair(line, age, width), width), item: `home:result:${v.root}:${objective.id}`, objectiveTarget: target } };
}

function compactProjects(projects: ProjectView[], width: number): MonitorRow[] {
  const nameCol = Math.min(11, nameCap(width), Math.max(1, width - 10));
  const rollups = projects.map((v) => !v.unavailable ? progress(v.features, v.open.flatMap((o) => o.features)) : undefined);
  const countCol = Math.max(5, ...rollups.map((r) => cells(countText(r, width))));
  const rightRoom = width - 2 - nameCol - 3 - countCol - 4;
  const rights = projects.map((v) => v.unavailable ? '' : headerFacts(v, rightRoom));
  const rightCol = Math.max(0, ...rights.map(cells)), barCol = Math.max(0, width - 2 - nameCol - 2 - countCol - (rightCol ? rightCol + 1 : 0));
  return projects.map((v, index) => {
    if (v.unavailable) return projectHeader(v, width);
    const data = rollups[index], count = countText(data, width), right = rights[index];
    const paused = v.paused || v.open.every((o) => o.state === 'paused');
    const graphic = v.open.length ? progressCells(data, barCol, paused) : pad(barCol);
    const left = `${v.mark} ${v.nameInk(tokenColumn(v.name, nameCol))} ${graphic} ${pad(countCol - cells(count))}${paused && count ? theme.board.muted(count) : count}`;
    return { text: fit(pair(left, right, width), width), ...projectTarget(v) };
  });
}

export function homeRows(portfolio: HomePortfolio | undefined, width: number, now: number, room: number): MonitorRow[] {
  const ink = theme.board;
  if (!portfolio) return [boardRow(fit(t('Loading…'), width))];
  const { requests, projects } = portfolio;
  const top = requests.length ? [section(t('Waiting'), width, String(requests.length)), ...requests.flatMap((r) => requestRows(r, width, now))] : [];
  top.push(section(t('Projects'), width, width < 56 ? t('done/tickets') : ''));
  if (!projects.length) return [...top, boardRow(fit(ink.muted(t('No registered projects')), width))];
  const views = projects.map((p) => projectView(p, now));
  const blocks = views.map((v) => {
    const header = projectHeader(v, width);
    const previews = v.unavailable ? [] : [...v.open, ...v.finished].slice(0, 2).map((o) => objectiveRows(v, o, width));
    const noteLines = v.unavailable ? [] : v.note ? sentenceRows(monitorText(v.note), width, 1, 2, mark('¶', '.', '\uF249'))
      : v.noNotes ? [`  ${t('no Objectives or handoff notes')}`] : [];
    const note = noteLines.map((line) => boardRow(fit(ink.muted(line), width)));
    return { v, header, previews, note };
  });
  const tier = (limit: number, results: boolean, gaps = false) => blocks.flatMap(({ v, header, previews, note }, i) => {
    const rows = [header, ...note, ...previews.slice(0, limit).flatMap(({ row, result }) => results && result ? [row, result] : [row])];
    const more = v.open.length + v.finished.length - Math.min(limit, previews.length);
    if (!v.unavailable && more > 0) rows.push({ text: fit(`  ${ink.muted(t('{remaining} more', { remaining: more }))}`, width),
      item: `home:more:${v.root}`, homeTarget: { root: v.root } });
    return gaps && i ? [boardRow(fit('', width)), ...rows] : rows;
  });
  for (const [limit, results, gaps] of [[2, true, true], [2, true], [2, false], [1, false]] as const) {
    const rows = tier(limit, results, gaps);
    if (top.length + rows.length <= room) return [...top, ...rows];
  }
  // When even this exceeds the viewport, all membership and requests remain scrollable.
  return [...top, ...compactProjects(views, width)];
}
