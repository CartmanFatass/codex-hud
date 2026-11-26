/** Portfolio handoff. A job waiting for main is not an owner request. */
import { basename } from 'node:path';
import { RECENT_ADVICE_MS } from '../collectors/advisor-history.js';
import { blockedObjectives, ownerRequestKey, SETTLED_JOB_STATES, type ProjectSnapshot } from '../collectors/project-board.js';
import type { Objective } from '../collectors/objectives.js';
import { homeActivityAt, type HomePortfolio, type HomeProject, type HomeRequest } from '../collectors/home-portfolio.js';
import type { TodayFacts } from '../collectors/home-cards.js';
import type { MonitorRow } from './monitor.js';
import type { ObjectiveTarget } from './monitor-state.js';
import { homeCardRows, type ScheduleView } from './home-cards.js';
import { theme, truncateAnsi, visualLength as cells } from './colors.js';
import { cutSentence, fit, monitorText, pair, sentenceRows, tokenColumn } from './monitor-text.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';
import { roleInk } from './work-job-row.js';
import { barText, linkedTicketProgress as progress, TICKET_BAR_ORDER } from './progress-bar.js';
import { t } from './i18n.js';
import { ADVISOR_NOTICE_MS } from '../collectors/advisor-shadow.js';

export const OTHER_PROJECTS = 'home:other-projects';
export const otherProjectsHint = (expanded?: boolean) => expanded ? 'a fold' : 'a expand';

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

function projectView({ root, name, unavailable, snapshot, resultDates, workingRuns, advisor, advisorRules }: HomeProject, now: number) {
  const ink = theme.board;
  const record = snapshot?.objectives, jobs = snapshot?.active ?? [], objectives = record?.objectives ?? [];
  const blocked = blockedObjectives(snapshot?.waiting ?? []), running = jobs.some(({ state }) => state !== 'queued');
  const features = new Map(snapshot?.tickets.map((f) => [f.slug, f])), packages = new Set(jobs.map(({ package: slug }) => slug));
  const landings = new Map<string, number>();
  for (const { milestone, landed, at } of snapshot?.ledger ?? []) {
    if (landed && at !== undefined) landings.set(milestone, Math.max(landings.get(milestone) ?? -Infinity, at));
  }
  const recentAge = (id: string) => {
    const at = resultDates?.get(id);
    return at !== undefined && now - at <= 3 * 86_400_000 ? compactAge(at, now) : '';
  };
  const finished = objectives.filter(({ id, state }) => state === 'done' && recentAge(id));
  const resultOnly: Objective[] = [];
  const open = objectives.flatMap((objective) => {
    const { id, state, features: links, result } = objective;
    if (state === 'done') return [];
    const data = progress(features, links);
    // Ticketless objectives and ones with incomplete ticket evidence aren't known to be finished.
    if (links.length && data && data.counts.accepted === data.total) {
      if (result && recentAge(id)) resultOnly.push(objective);
      return [];
    }
    const live = workingRuns?.objectives.has(id) || links.some((slug) =>
      workingRuns?.features.has(slug) || packages.has(slug) || features.get(slug)?.tickets.some(({ job }) =>
        job && !SETTLED_JOB_STATES.has(job.state)));
    const rank = blocked.has(id) ? 0 : state === 'paused' ? 3 : live ? 1 : 2;
    const at = links.reduce((latest, slug) => Math.max(latest, features.get(slug)?.at ?? -Infinity, landings.get(slug) ?? -Infinity),
      resultDates?.get(id) ?? -Infinity);
    return [{ objective, rank, at }];
  }).sort((a, b) => a.rank - b.rank || (a.rank === 2 && a.at !== b.at ? b.at - a.at : 0)).map(({ objective }) => objective);
  const stance = record?.stance === 'paused' || record?.stance === 'maintenance' ? ink.muted(` · ${t(record.stance)}`) : '';
  const priority = record?.priority === 'high' ? ink.attention(mark('↑', '^', '\uF062'))
    : record?.priority === 'low' ? ink.muted(mark('↓', 'v', '\uF063')) : '';
  const idle = snapshot?.idle && !running, idleWord = idle && !stance ? ink.muted(t('idle')) : '';
  const noNotes = snapshot && !record && !snapshot.statePath;
  const age = compactAge(homeActivityAt(snapshot), now);
  return { root, name: monitorText(name), unavailable, stance, paused: record?.stance === 'paused', open, finished, resultOnly, blocked,
    features, unlinked: snapshot?.unlinked ?? [],
    mark: unavailable ? ink.danger(stateMark.failed()) : running ? liveMark() : idleMark(),
    nameInk: running && !unavailable ? ink.text : ink.muted,
    priority, idleWord, age: age && ink.muted(age), load: loadFacts(jobs),
    note: !record && snapshot?.summary, noNotes, recentAge, advisor,
    rules: advisorRules && now >= advisorRules.at && now - advisorRules.at < ADVISOR_NOTICE_MS ? advisorRules.rules : [] };
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

function requestRows({ project, index, item, files }: HomeRequest, width: number, now: number): MonitorRow[] {
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
  const target = files ? { files } : { homeTarget: { root: project.root, index, request: ownerRequestKey(item) } };
  return [pair(head, right, width), ...sentenceRows(prose, width, 2, 2).map(ink.text)]
    .map((text) => ({ text: fit(text, width), item: itemId, ...target }));
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
  return { row, result: objectiveResultRow(v, target, width) };
}

function objectiveResultRow(v: ProjectView, target: ObjectiveTarget, width: number) {
  const ink = theme.board, { id, result } = target.objective;
  const recentAge = v.recentAge(id);
  if (!recentAge || !result) return;
  const age = ink.muted(recentAge);
  const line = sentenceRows(monitorText(result), width - cells(age) - 1, 1, 4, ink.success(stateMark.done()))[0] ?? '';
  return { text: fit(pair(line, age, width), width), item: `home:result:${v.root}:${id}`, objectiveTarget: target };
}

/** Work no Objective lists, on one row: live features first, whole `slug done/total` facts, the rest counted. */
function unlinkedRow(v: ProjectView, width: number): MonitorRow | undefined {
  if (!v.unlinked.length) return undefined;
  const ink = theme.board, lead = `  ${ink.muted(`${mark('◌', '-', '\uF127')} ${t('Unlinked')}:`)} `;
  const facts = v.unlinked.map(({ slug }) => {
    const data = progress(v.features, [slug]);
    return { slug: monitorText(slug), count: data ? `${data.counts.accepted}/${data.total}` : '' };
  });
  const part = (name: string, count: string) => ink.text(name) + (count ? ` ${ink.muted(count)}` : '');
  const rest = (shown: number) => shown < facts.length ? ` ${ink.muted(`+${facts.length - shown}`)}` : '';
  const room = width - cells(lead);
  let body = '', shown = 0;
  for (const { slug, count } of facts) {
    const next = (body ? body + ink.muted(' · ') : '') + part(slug, count);
    if (cells(next + rest(shown + 1)) > room) break;
    body = next;
    shown++;
  }
  if (!shown) { // Even one fact is too long: cut its slug, never its count or the number left over.
    const [{ slug, count }] = facts;
    shown = 1;
    body = part(truncateAnsi(slug, Math.max(1, room - cells(rest(shown)) - (count ? cells(count) + 1 : 0))), count);
  }
  return { text: fit(lead + body + rest(shown), width), item: `home:unlinked:${v.root}`, homeTarget: { root: v.root } };
}

function advisorRow(v: ProjectView, width: number): MonitorRow | undefined {
  if (!v.advisor) return undefined;
  const ink = theme.board;
  const lead = `  ${ink.active(mark('✦', '*', '\uF0EB'))} `;
  const name = monitorText(v.advisor.skill);
  const skillPath = monitorText(v.advisor.path);
  const room = Math.max(0, width - cells(lead));
  const namePart = truncateAnsi(name, Math.min(cells(name), room));
  const sep = ' — ';
  const pathRoom = Math.max(0, room - cells(namePart) - cells(sep));
  const text = pathRoom > 0
    ? `${lead}${ink.text(namePart)}${ink.muted(sep + truncateAnsi(skillPath, pathRoom))}`
    : `${lead}${ink.text(namePart)}`;
  return {
    text: fit(text, width),
    item: `home:advisor:${v.root}`,
    advisorCopy: {
      root: v.root,
      session: v.advisor.session,
      skill: v.advisor.skill,
      path: v.advisor.path,
    },
  };
}

function advisorRows(v: ProjectView, width: number): MonitorRow[] {
  const skill = advisorRow(v, width);
  const ink = theme.board;
  return [
    ...(skill ? [skill] : []),
    ...v.rules.map(({ id, sentence }) => {
      const rule = t('Rule {id}: {sentence}', { id: monitorText(id), sentence: monitorText(sentence) });
      return boardRow(fit(`  ${ink.active(mark('✦', '*', '\uF0EB'))} ${ink.text(rule)}`, width));
    }),
  ];
}

function recentAdviceRows({ recentAdvice, projects }: HomePortfolio, width: number, now: number, room: number): MonitorRow[] {
  const events = recentAdvice?.filter(({ at }) => at <= now && now - at <= RECENT_ADVICE_MS);
  if (!events?.length || events.length + 1 > room) return [];
  const ink = theme.board;
  return [section(t('Recent advice'), width), ...events.map((event) => {
    const { project, session, at } = event;
    const name = project ? monitorText(projects.find(({ root }) => root === project)?.name ?? (basename(project) || project))
      : t('unknown project');
    const age = compactAge(at, now);
    const detail = event.kind === 'advice' ? t('skill: {name}', { name: monitorText(event.skill) })
      : t('rules: {ids}', { ids: monitorText(event.rules.join(' ')) });
    const detailRoom = Math.min(cells(detail), Math.max(14, Math.floor(width / 2)));
    const nameWidth = Math.max(1, width - cells(age) - 2 - detailRoom);
    const row = boardRow(fit(`${ink.muted(age)} ${ink.muted(truncateAnsi(name, nameWidth))} ${ink.text(detail)}`, width));
    if (event.kind !== 'advice' || !event.path) return row;
    return { ...row, item: `home:recent-advice:${JSON.stringify([at, session, project, event.skill])}`,
      advisorCopy: { root: project ?? '', session, skill: event.skill, path: event.path } };
  })];
}

function compactProjects(projects: ProjectView[], width: number): MonitorRow[][] {
  const nameCol = Math.min(11, nameCap(width), Math.max(1, width - 10));
  const rollups = projects.map((v) => !v.unavailable ? progress(v.features, v.open.flatMap((o) => o.features)) : undefined);
  const countCol = Math.max(5, ...rollups.map((r) => cells(countText(r, width))));
  const rightRoom = width - 2 - nameCol - 3 - countCol - 4;
  const rights = projects.map((v) => v.unavailable ? '' : headerFacts(v, rightRoom));
  const rightCol = Math.max(0, ...rights.map(cells)), barCol = Math.max(0, width - 2 - nameCol - 2 - countCol - (rightCol ? rightCol + 1 : 0));
  return projects.map((v, index) => {
    const adv = advisorRows(v, width);
    if (v.unavailable) return [projectHeader(v, width), ...adv];
    const data = rollups[index], count = countText(data, width), right = rights[index];
    const paused = v.paused || v.open.every((o) => o.state === 'paused');
    const graphic = v.open.length ? progressCells(data, barCol, paused) : pad(barCol);
    const left = `${v.mark} ${v.nameInk(tokenColumn(v.name, nameCol))} ${graphic} ${pad(countCol - cells(count))}${paused && count ? theme.board.muted(count) : count}`;
    const row = { text: fit(pair(left, right, width), width), ...projectTarget(v) };
    return [row, ...adv];
  });
}

export function homeRows(portfolio: HomePortfolio | undefined, width: number, now: number, room: number, expanded: boolean | undefined,
  todayFacts: TodayFacts | undefined, schedule: ScheduleView): MonitorRow[] {
  const ink = theme.board;
  if (!portfolio) return [boardRow(fit(t('Loading…'), width))];
  const { requests, projects, unattended } = portfolio;
  const top: MonitorRow[] = [];
  if (unattended) {
    const { objectives, running, handbacks } = unattended;
    const prefix = t('Unattended · Runs: {running} · Hand-backs: {handbacks}', { running, handbacks });
    const compact = t('Unatt. {running} run / {handbacks} back', { running, handbacks });
    const ids = monitorText(objectives.join(', '));
    const left = cells(prefix) + Math.min(16, cells(ids)) + 3 <= width ? prefix : compact;
    top.push(boardRow(fit(ink.active(left) + (cells(left) + 3 < width ? ` · ${ink.text(ids)}` : ''), width)));
  }
  if (requests.length) top.push(section(t('Waiting'), width, String(requests.length)), ...requests.flatMap((r) => requestRows(r, width, now)));
  top.push(section(t('Projects'), width, width < 56 ? t('done/tickets') : ''));
  const withCards = (rows: MonitorRow[]) => {
    const cards = homeCardRows(todayFacts, schedule, projects, width, now, room - rows.length);
    // Recent advice only uses spare height when the other Home blocks are still at full size.
    const advice = cards.full ? recentAdviceRows(portfolio, width, now, room - rows.length - cards.rows.length) : [];
    return [...rows, ...advice, ...cards.rows];
  };
  if (!projects.length) return withCards([...top, boardRow(fit(ink.muted(t('No registered projects')), width))]);
  const today = projects.filter((p) => p.activeToday), count = projects.length - today.length;
  const fold = count ? [{
    item: OTHER_PROJECTS,
    text: fit(pair(ink.text(t(count === 1 ? '{count} other project' : '{count} other projects', { count })),
      ink.muted(t(otherProjectsHint(expanded))), width), width),
  }] : [];
  const visible = expanded ? [...today, ...projects.filter((p) => !p.activeToday)] : today;
  const views = visible.map((p) => projectView(p, now));
  const withFold = (groups: MonitorRow[][]) =>
    [...top, ...groups.slice(0, today.length).flat(), ...fold, ...groups.slice(today.length).flat()];
  const blocks = views.map((v) => {
    const header = projectHeader(v, width);
    const advisor = advisorRows(v, width);
    const previews = v.unavailable ? [] : [...v.open, ...v.finished].slice(0, 2).map((o) => objectiveRows(v, o, width));
    const resultOnly = v.unavailable ? [] : v.resultOnly.slice(0, 2 - previews.length).flatMap((objective) => {
      const result = objectiveResultRow(v, { root: v.root, objective, blocked: v.blocked.has(objective.id) }, width);
      return result ? [result] : [];
    });
    const noteLines = v.unavailable ? [] : v.note ? sentenceRows(monitorText(v.note), width, 1, 2, mark('¶', '.', '\uF249'))
      : v.noNotes ? [`  ${t('no Objectives or handoff notes')}`] : [];
    const note = noteLines.map((line) => boardRow(fit(ink.muted(line), width)));
    return { v, header, advisor, previews, resultOnly, note, unlinked: unlinkedRow(v, width) };
  });
  const tier = (limit: number, results: boolean, gaps = false, loose = false) => blocks.map(({ v, header, advisor, previews, resultOnly, note, unlinked }, i) => {
    const rows = [header, ...advisor, ...note, ...previews.slice(0, limit).flatMap(({ row, result }) => results && result ? [row, result] : [row])];
    if (results) rows.push(...resultOnly);
    const more = v.open.length + v.finished.length - Math.min(limit, previews.length);
    if (!v.unavailable && more > 0) rows.push({ text: fit(`  ${ink.muted(t('{remaining} more', { remaining: more }))}`, width),
      item: `home:more:${v.root}`, homeTarget: { root: v.root } });
    if (loose && unlinked) rows.push(unlinked);
    return gaps && i && i !== today.length ? [boardRow(fit('', width)), ...rows] : rows;
  });
  // Separators, then results, then the unlinked row fold before any Objective row does.
  for (const [limit, results, gaps, loose] of [[2, true, true, true], [2, true, false, true], [2, false, false, true], [2, false], [1, false]] as const) {
    const rows = withFold(tier(limit, results, gaps, loose));
    if (rows.length <= room) return gaps ? withCards(rows) : rows;
  }
  // When even this exceeds the viewport, the visible projects and requests remain scrollable.
  return withFold(compactProjects(views, width));
}
