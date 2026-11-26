/** Portfolio handoff. A job waiting for main is not an owner request. */
import { blockedObjectives, SETTLED_JOB_STATES, type ProjectSnapshot } from '../collectors/project-board.js';
import type { Objective } from '../collectors/objectives.js';
import { homeActivityAt, type HomePortfolio, type HomeProject } from '../collectors/home-portfolio.js';
import type { TodayFacts } from '../collectors/home-cards.js';
import type { MonitorRow } from './monitor.js';
import type { ObjectiveTarget } from './monitor-state.js';
import { homeCardRows, type ScheduleView } from './home-cards.js';
import { theme, truncateAnsi, visualLength as cells } from './colors.js';
import { cutSentence, fit, monitorText, pair, sentenceRows } from './monitor-text.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';
import { roleInk } from './work-job-row.js';
import { linkedTicketProgress as progress } from './progress-bar.js';
import { t } from './i18n.js';
import { ADVISOR_NOTICE_MS } from '../collectors/advisor-shadow.js';

export const OTHER_PROJECTS = 'home:other-projects';
export const otherProjectsHint = (expanded?: boolean) => expanded ? 'a fold' : 'a expand';

const nameCap = (width: number) => width < 50 ? 14 : width < 80 ? 18 : 24;
const liveMark = () => theme.board.active(mark('●', '*', '\uF111'));
const idleMark = () => theme.board.muted(mark('○', 'o', '\uF10C'));
const askMark = () => theme.board.attention(stateMark.asking());

export function unattendedRow(unattended: NonNullable<HomePortfolio['unattended']>, width: number): MonitorRow {
  const ink = theme.board;
  const { objectives, running, handbacks } = unattended;
  const prefix = t('Unattended · Runs: {running} · Hand-backs: {handbacks}', { running, handbacks });
  const compact = t('Unatt. {running} run / {handbacks} back', { running, handbacks });
  const ids = monitorText(objectives.join(', '));
  const left = cells(prefix) + Math.min(16, cells(ids)) + 3 <= width ? prefix : compact;
  return boardRow(fit(ink.active(left) + (cells(left) + 3 < width ? ` · ${ink.text(ids)}` : ''), width));
}

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
  const waiting = (snapshot?.waiting.length ?? 0) > 0;
  const blocked = blockedObjectives(snapshot?.waiting ?? []), running = jobs.some(({ state }) => state !== 'queued');
  const features = new Map(snapshot?.tickets.map((f) => [f.slug, f])), packages = new Set(jobs.map(({ package: slug }) => slug));
  const landings = new Map<string, number>();
  for (const { milestone, landed, at } of snapshot?.ledger ?? []) {
    if (landed && at !== undefined) landings.set(milestone, Math.max(landings.get(milestone) ?? -Infinity, at));
  }
  const recentAt = (id: string) => {
    const at = resultDates?.get(id);
    return at !== undefined && now - at <= 3 * 86_400_000 ? at : undefined;
  };
  const recentAge = (id: string) => {
    const at = recentAt(id);
    return at !== undefined ? compactAge(at, now) : '';
  };
  const finished = objectives
    .filter(({ id, state }) => state === 'done' && recentAge(id))
    .sort((a, b) => (recentAt(b.id) ?? -Infinity) - (recentAt(a.id) ?? -Infinity));
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
  const goals = [...open, ...finished];
  const currentGoal = goals[0];
  let resultObjective: Objective | undefined;
  if (currentGoal?.result && recentAge(currentGoal.id)) {
    resultObjective = currentGoal;
  } else {
    let bestAt = -Infinity;
    for (const candidate of [...goals.slice(1), ...resultOnly]) {
      const at = candidate.result ? recentAt(candidate.id) : undefined;
      if (at !== undefined && at > bestAt) { bestAt = at; resultObjective = candidate; }
    }
  }
  const stance = record?.stance === 'paused' || record?.stance === 'maintenance' ? ink.muted(` · ${t(record.stance)}`) : '';
  const priority = record?.priority === 'high' ? ink.attention(mark('↑', '^', '\uF062'))
    : record?.priority === 'low' ? ink.muted(mark('↓', 'v', '\uF063')) : '';
  const idle = snapshot?.idle && !running, idleWord = idle && !stance ? ink.muted(t('idle')) : '';
  const noNotes = snapshot && !record && !snapshot.statePath;
  const age = compactAge(homeActivityAt(snapshot), now);
  return { root, name: monitorText(name), unavailable, stance, goals, currentGoal, resultObjective, blocked,
    mark: unavailable ? ink.danger(stateMark.failed()) : waiting ? askMark() : running ? liveMark() : idleMark(),
    nameInk: (running || waiting) && !unavailable ? ink.text : ink.muted,
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

function goalRow(v: ProjectView, objective: Objective, extra: number, width: number): MonitorRow {
  const ink = theme.board;
  const done = objective.state === 'done', blocked = !done && v.blocked.has(objective.id), paused = objective.state === 'paused';
  const glyphInk = done ? ink.success : blocked ? ink.attention : paused ? ink.muted : ink.active;
  const idInk = blocked ? ink.attention : paused ? ink.muted : ink.text;
  const lead = `  ${glyphInk(mark('▸', '>'))} `;
  const count = extra > 0 ? ` (+${extra})` : '';
  const rawId = monitorText(objective.id);
  const rawTitle = monitorText(objective.title.replace(/\s+/g, ' ').trim());
  const idCap = width < 50 ? 14 : width < 80 ? 18 : 24;
  const maxId = rawTitle
    ? Math.max(1, Math.min(idCap, width - cells(lead) - cells(count) - 2 - Math.min(12, cells(rawTitle))))
    : Math.max(1, width - cells(lead) - cells(count));
  const id = truncateAnsi(rawId, Math.min(cells(rawId), maxId));
  const head = `${lead}${idInk(id)}${count ? ink.muted(count) : ''}`;
  const titleRoom = rawTitle ? Math.max(0, width - cells(head) - 2) : 0;
  const title = titleRoom > 0 ? `  ${ink.muted(cutSentence(rawTitle, titleRoom))}` : '';
  const target: ObjectiveTarget = { root: v.root, objective, blocked };
  return { text: fit(head + title, width), item: `home:objective:${v.root}:${objective.id}`, objectiveTarget: target };
}

function objectiveResultRow(v: ProjectView, objective: Objective, width: number): MonitorRow | undefined {
  const ink = theme.board, { id, result } = objective;
  const recentAge = v.recentAge(id);
  if (!recentAge || !result) return;
  const age = ink.muted(recentAge);
  const line = sentenceRows(monitorText(result), width - cells(age) - 1, 1, 2, ink.success(stateMark.done()))[0] ?? '';
  const target: ObjectiveTarget = { root: v.root, objective, blocked: objective.state !== 'done' && v.blocked.has(id) };
  return { text: fit(pair(line, age, width), width), item: `home:result:${v.root}:${id}`, objectiveTarget: target };
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

export function homeRows(portfolio: HomePortfolio | undefined, width: number, now: number, room: number, expanded: boolean | undefined,
  todayFacts: TodayFacts | undefined, schedule: ScheduleView, includeUnattended = true): MonitorRow[] {
  const ink = theme.board;
  if (!portfolio) return [boardRow(fit(t('Loading…'), width))];
  const { projects, unattended } = portfolio;
  const today = projects.filter((p) => p.activeToday), count = projects.length - today.length;
  const top: MonitorRow[] = [];
  if (includeUnattended && unattended) top.push(unattendedRow(unattended, width));
  top.push(section(t('Active today'), width, today.length ? String(today.length) : ''));
  const withCards = (rows: MonitorRow[]) => {
    const cards = homeCardRows(todayFacts, schedule, projects, width, now, room - rows.length);
    return [...rows, ...cards.rows];
  };
  if (!projects.length) return withCards([...top, boardRow(fit(ink.muted(t('No registered projects')), width))]);
  const foldGlyph = expanded ? mark('▾', 'v') : mark('▸', '>');
  const fold = count ? [{
    item: OTHER_PROJECTS,
    text: fit(pair(ink.text(`${foldGlyph} ${t(count === 1 ? '{count} other project' : '{count} other projects', { count })}`),
      ink.muted(t(otherProjectsHint(expanded))), width), width),
  }] : [];
  const visible = expanded ? [...today, ...projects.filter((p) => !p.activeToday)] : today;
  const views = visible.map((p) => projectView(p, now));
  const withFold = (groups: MonitorRow[][]) =>
    [...top, ...groups.slice(0, today.length).flat(), ...fold, ...groups.slice(today.length).flat()];
  const blocks = views.map((v) => {
    const header = projectHeader(v, width);
    const advisor = advisorRows(v, width);
    const goal = !v.unavailable && v.currentGoal ? goalRow(v, v.currentGoal, v.goals.length - 1, width) : undefined;
    const result = !v.unavailable && v.resultObjective ? objectiveResultRow(v, v.resultObjective, width) : undefined;
    const noteLines = v.unavailable ? [] : v.note ? sentenceRows(monitorText(v.note), width, 1, 2, mark('¶', '.', '\uF249'))
      : v.noNotes ? [`  ${t('no Objectives or handoff notes')}`] : [];
    const note = noteLines.map((line) => boardRow(fit(ink.muted(line), width)));
    return { header, advisor, goal, result, note };
  });
  const tier = (showGoal: boolean, showResult: boolean) => blocks.map(({ header, advisor, goal, result, note }) => [
    header,
    ...advisor,
    ...(showGoal ? note : []),
    ...(showGoal && goal ? [goal] : []),
    ...(showResult && result ? [result] : []),
  ]);
  const full = withFold(tier(true, true));
  if (full.length <= room) return withCards(full);
  const noResults = withFold(tier(true, false));
  if (noResults.length <= room) return noResults;
  // When even this exceeds the viewport, the visible projects and requests remain scrollable.
  return withFold(tier(false, false));
}
