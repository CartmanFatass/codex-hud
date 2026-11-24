// Home cards (Today, Schedule) composed from the panel's own helpers (dist/), so every row is cell-exact.
// Prototype only: nothing here is product code. The Today facts come from the shipped `collectJobStats`; the Schedule
// reader below is the proposed one (docs/design/home-cards/README.md section 4).
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
const dist = (p) => import(pathToFileURL(join(fileURLToPath(new URL('../../../../dist/', import.meta.url)), p)).href);
const [{ truncateAnsi, visualLength }, { fit, cutWords, monitorText }, { roleInk }, { ROLE_GLYPHS }, { collectJobStats, localDayStart }] = await Promise.all([
  dist('render/colors.js'), dist('render/monitor-text.js'), dist('render/work-job-row.js'), dist('render/model-glyphs.js'), dist('collectors/job-stats.js'),
]);
import { ink, G, NF, age as ageOf, vm } from '../../home-portfolio/gen/proposed.mjs';

const len = visualLength;
const D = 864e5;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - len(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - len(s))) + s;
const cutId = (s, n) => (len(s) <= n ? s : truncateAnsi(s, n));
const cutText = (s, n) => (n < 1 ? '' : len(s) <= n ? s : cutWords(s, n) || truncateAnsi(s, n));
const rule = (n) => ink.frame('─'.repeat(Math.max(0, n)));
const blank = (W) => ' '.repeat(W);
/** Section row, as the panel's `section()`: `Label ───── right`. */
const sec = (W, label, right = '') => {
  const tail = right ? len(right) : 0;
  return fit(`${label} ${rule(W - len(label) - tail - (tail ? 2 : 1))}${tail ? ' ' + right : ''}`, W);
};
/** Left and right on one row; the right is whole or absent. */
const lr = (W, left, right) => (right && len(left) + 1 + len(right) <= W ? left + ' '.repeat(W - len(left) - len(right)) + right : fit(left, W));

// Nerd marks as the panel draws them (workboard-rows.ts `stateMark`), plus the calendar family from the same font.
export const CAL = { far: 0xf133, today: 0xf073, overdue: 0xf06a, shield: 0xf132 };

const T = {
  zh: { today: '今天', schedule: '日程', landed: (n) => `${n} 个落地`, noLanding: '暂无落地', none: '暂无', done: '完成', failed: '失败', gates: '闸门',
    first: '一次过', retried: '重试', more: (n) => `另 ${n} 个`, moreItems: (n) => `另 ${n} 项`, items: (n) => `${n} 项`, quiet: '静默', overdueN: '逾期', todayN: '今天',
    next: '下一项', tab: ['首页', '项目', '控制'],
    count: { overdue: (a) => `逾期 ${a}`, today: '今天', tomorrow: '明天', days: (n) => `${n}天后`, weeks: (n) => `${n}周后`, months: (n) => `${n}月后`, next: '下月', this: '本月' },
    unit: { d: '天', w: '周' } },
  en: { today: 'Today', schedule: 'Schedule', landed: (n) => `${n} landed`, noLanding: 'none landed', none: 'nothing yet', done: 'done', failed: 'failed', gates: 'gates',
    first: 'first try', retried: 'retried', more: (n) => `${n} more`, moreItems: (n) => `${n} more`, items: (n) => `${n} item${n === 1 ? '' : 's'}`, quiet: 'quiet', overdueN: 'overdue', todayN: 'today',
    next: 'next', tab: ['Home', 'Project', 'Control'],
    count: { overdue: (a) => `${a} late`, today: 'today', tomorrow: 'tomorrow', days: (n) => `in ${n}d`, weeks: (n) => `in ${n}w`, months: (n) => `in ${n}mo`, next: 'next mo', this: 'this mo' },
    unit: { d: 'd', w: 'w' } },
};

// ---- Today ------------------------------------------------------------------------------------------------------------------
const roleKey = (role) => (Object.hasOwn(ROLE_GLYPHS, role ?? '') ? role : 'other');
const roleGlyph = (role) => G(ROLE_GLYPHS[roleKey(role)][2].codePointAt(0));
/** What got done today: the shipped job-stats reader over `$HUD_HOME`, joined to the registered projects' ticket titles. */
export function todayFacts(home, portfolio, now) {
  const since = localDayStart(now), stats = collectJobStats(home, since, now);
  const nameOf = (root) => portfolio.projects.find((p) => p.root === root)?.name ?? '';
  const titleOf = (job) => {
    const m = /^([a-z0-9-]+)\/(\d+)$/i.exec(job.ticket ?? ''), p = portfolio.projects.find((x) => x.root === job.project);
    return (m && p?.snapshot?.tickets.find((f) => f.slug === m[1])?.tickets.find((t) => t.number === m[2])?.title) || job.summary || job.ticket || '';
  };
  const landed = stats.landed.map(({ job, at }) => ({ project: nameOf(job.project), title: titleOf(job), ticket: job.ticket ?? '', at: Date.parse(at), retried: !!(job.land?.reruns || job.land?.repairs) }))
    .sort((a, b) => b.at - a.at);
  const count = (list) => list.reduce((o, j) => ((o[roleKey(j.role)] = (o[roleKey(j.role)] ?? 0) + 1), o), {});
  // A stop the owner asked for is not a failure (spec 2.1), so unlike `stats.failures` `stopped` is left out.
  const failedJobs = stats.cohort.filter((j) => j.state === 'failed' || (j.dispatch_exit_code ?? 0) > 0);
  const finishedJobs = stats.cohort.filter((j) => ['closed', 'done', 'idle_grace'].includes(j.state ?? '') && !failedJobs.includes(j));
  const first = landed.filter((l) => !l.retried).length;
  return { landed, finished: count(finishedJobs), failed: count(failedJobs), nFinished: finishedJobs.length, nFailed: failedJobs.length,
    gates: { first, retried: landed.length - first }, readOk: stats.coverage.skipped === 0 && !stats.coverage.limited };
}
const iconCounts = (counts, paint = (role) => roleInk(role)) =>
  Object.keys(ROLE_GLYPHS).filter((r) => counts[r]).map((r) => paint(r)(roleGlyph(r) + counts[r])).join(' ');

/** Rows of the Today card. level 0 full, 1 facts only, 2 one row, 3 never (the Schedule row stays alone). */
export function todayRows(W, lang, f, level, now) {
  const s = T[lang], rows = [], nothing = !f.landed.length && !f.nFinished && !f.nFailed;
  if (level >= 3) return rows;
  if (nothing) return [sec(W, s.today, ink.muted(s.none))];
  if (level === 2) {
    // One row: whole facts leave from the left (landings first), the failures stay.
    const parts = [f.landed.length && ink.muted(s.landed(f.landed.length)), f.nFinished && ink.muted(`${s.done} ${f.nFinished}`), f.nFailed && ink.danger(`${s.failed} ${f.nFailed}`)].filter(Boolean);
    const join = () => parts.join(ink.muted(' · '));
    while (parts.length > 1 && len(s.today) + 5 + len(join()) > W) parts.shift();
    return [sec(W, s.today, join())];
  }
  rows.push(sec(W, s.today, ink.muted(f.landed.length ? s.landed(f.landed.length) : s.noLanding)));
  if (level === 0 && f.landed.length) {
    // Name column 10 / 14 / 18 cells at 40 / 50 / 80 columns; 80 adds the ticket id (18) after the title.
    const nameCol = W < 50 ? 10 : W < 80 ? 14 : 18, ageCol = 4, idCol = W >= 80 ? 18 : 0, titleCol = W - 2 - nameCol - 1 - 1 - ageCol - (idCol ? idCol + 1 : 0);
    for (const l of f.landed.slice(0, 3)) {
      const id = idCol ? ' ' + ink.muted(pad(cutId(monitorText(l.ticket), idCol), idCol)) : '';
      rows.push(fit(`${ink.success(G(NF.done))} ${ink.text(pad(cutId(monitorText(l.project), nameCol), nameCol))} ${ink.muted(pad(cutText(monitorText(l.title), titleCol), titleCol))}${id} ${ink.muted(padL(ageOf(now - l.at, lang), ageCol))}`, W));
    }
    if (f.landed.length > 3) rows.push(fit('  ' + ink.muted(s.more(f.landed.length - 3)), W));
  }
  // Fact rows share one label column (the Details block's rule); a zero is absent.
  const col = Math.max(len(s.done), len(s.failed), len(s.gates)) + 1, room = W - 2 - col;
  const fact = (label, paint, value) => fit(`  ${paint(pad(label, col))}${value}`, W);
  if (f.nFinished) {
    let value = iconCounts(f.finished);
    if (len(value) > room) value = ink.text(String(f.nFinished)); // never cut an icon: fall back to the total
    rows.push(fact(s.done, ink.muted, value));
  }
  if (f.nFailed) {
    let value = iconCounts(f.failed, () => ink.danger);
    if (len(value) > room) value = ink.danger(String(f.nFailed));
    rows.push(fact(s.failed, ink.danger, value));
  }
  if (f.landed.length) {
    const parts = [f.gates.first && ink.text(`${s.first} ${f.gates.first}`), f.gates.retried && ink.text(`${s.retried} ${f.gates.retried}`)].filter(Boolean);
    rows.push(fact(s.gates, ink.muted, parts.join(ink.muted(' · '))));
  }
  return rows;
}

// ---- Schedule ---------------------------------------------------------------------------------------------------------------
/** The proposed reader: `$HUD_HOME/schedule.json`, open items only (`done_at` unset), resolved to a registered project's name. */
export function readSchedule(path, portfolio) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return undefined; } // unreadable is unknown, not empty
  return (doc.items ?? []).filter((i) => !i.done_at).map((i) => ({ ...i, projectName: portfolio.projects.find((p) => p.root === i.project)?.name ?? '' }));
}
/** Calendar-day arithmetic in local time. A month-only date (`2026-12`) is due on that month's last day and shows as `12-??`. */
export function dueInfo(item, now) {
  const d = new Date(now), today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const [y, m, day] = item.date.split('-').map(Number), monthOnly = day === undefined;
  const due = monthOnly ? Date.UTC(y, m, 0) : Date.UTC(y, m - 1, day), days = Math.round((due - today) / D);
  const monthsAway = (y - d.getFullYear()) * 12 + (m - 1 - d.getMonth());
  const stage = days < 0 ? 'overdue' : monthOnly ? (monthsAway <= 0 ? 'soon' : 'far') : days === 0 ? 'today' : days <= 7 ? 'soon' : 'far';
  return { days, due, monthOnly, monthsAway, stage, label: monthOnly ? `${String(m).padStart(2, '0')}-??` : item.date.slice(5) };
}
function countdown(info, lang) {
  const c = T[lang].count, u = T[lang].unit;
  if (info.stage === 'overdue') {
    const n = -info.days;
    return c.overdue(n >= 14 ? `${Math.floor(n / 7)}${u.w}` : `${n}${u.d}`);
  }
  if (info.monthOnly) return info.monthsAway <= 0 ? c.this : info.monthsAway === 1 ? c.next : c.months(info.monthsAway);
  if (info.days === 0) return c.today;
  if (info.days === 1) return c.tomorrow;
  return info.days < 14 ? c.days(info.days) : info.days < 70 ? c.weeks(Math.floor(info.days / 7)) : c.months(Math.floor(info.days / 30));
}
const STAGE = {
  overdue: { mark: () => ink.attention(G(CAL.overdue)), row: ink.text, date: ink.attention, when: ink.attention },
  today: { mark: () => ink.active(G(CAL.today)), row: ink.text, date: ink.text, when: ink.active },
  soon: { mark: () => ink.text(G(CAL.far)), row: ink.text, date: ink.text, when: ink.text },
  far: { mark: () => ink.muted(G(CAL.far)), row: ink.muted, date: ink.muted, when: ink.muted },
};
/** Sorted for the card: overdue (oldest first), then by due date. */
export function sortSchedule(items, now) {
  return items.map((item) => ({ item, info: dueInfo(item, now) })).sort((a, b) => a.info.due - b.info.due || a.item.id.localeCompare(b.item.id));
}
export const dueCount = (sorted) => ({ overdue: sorted.filter((x) => x.info.stage === 'overdue').length, today: sorted.filter((x) => x.info.stage === 'today').length });
/** Projects with no activity for more than two weeks that the owner did not park: stance active or not recorded. */
export function quietProjects(portfolio, now, lang) {
  return portfolio.projects.map((p) => vm(p, now, lang))
    .filter((v) => !v.unavailable && !v.live && v.ageMs !== undefined && v.ageMs > 14 * D && ['active', 'unknown'].includes(v.stance))
    .sort((a, b) => b.ageMs - a.ageMs);
}

/** Rows of the Schedule card. level 0 full, 1 compact, 2 one summary row, 3 only when something is due. */
export function scheduleRows(W, lang, sorted, quiet, level, now) {
  const s = T[lang], n = sorted.length, due = dueCount(sorted), anyDue = due.overdue + due.today > 0;
  if (!n && !quiet.length) return [];
  if (level >= 2) {
    if (level === 3 && !anyDue) return [];
    const first = sorted[0];
    let right;
    if (anyDue) right = [due.overdue && ink.attention(`${s.overdueN} ${due.overdue}`), due.today && ink.active(`${s.todayN} ${due.today}`)].filter(Boolean).join(ink.muted(' · '));
    else if (first) right = ink.muted(`${s.items(n)} · ${s.next} ${countdown(first.info, lang)}`);
    else right = ink.muted(`${s.quiet} ${quiet.length}`);
    return [sec(W, s.schedule, right)];
  }
  const rows = [sec(W, s.schedule, n ? ink.muted(s.items(n)) : '')];
  // Which items show: every due one, then the next ones, four rows at most (compact: three).
  const cap = level === 0 ? 4 : 3, isDue = (x) => ['overdue', 'today'].includes(x.info.stage);
  const dueItems = sorted.filter(isDue), rest = sorted.filter((x) => !isDue(x));
  const shown = [...dueItems, ...rest.slice(0, rest.length ? Math.max(1, cap - dueItems.length) : 0)].sort((a, b) => a.info.due - b.info.due || a.item.id.localeCompare(b.item.id));
  const hidden = n - shown.length;
  const projCol = W >= 80 ? 14 : 0; // the project name is a right-hand fact from 80 columns; below, a due item gets a context row
  const cdCol = Math.max(0, ...shown.map((x) => len(countdown(x.info, lang))));
  const textCol = W - 2 - 5 - 1 - 1 - (projCol ? projCol + 1 : 0) - cdCol;
  for (const { item, info } of shown) {
    const st = STAGE[info.stage], cd = countdown(info, lang);
    const proj = projCol ? ' ' + ink.muted(pad(item.projectName ? cutId(monitorText(item.projectName), projCol) : '', projCol)) : '';
    rows.push(fit(`${st.mark()} ${st.date(info.label)} ${st.row(pad(cutText(monitorText(item.text), textCol), textCol))}${proj} ${st.when(padL(cd, cdCol))}`, W));
    // A due item whose project the row cannot name gets one muted context row: where to look, never a request.
    if (level === 0 && !projCol && ['overdue', 'today'].includes(info.stage) && item.projectName)
      rows.push(fit('  ' + ink.muted(cutId(monitorText(item.projectName), 14) + (item.objective ? ` › ${cutId(item.objective, 11)}` : '')), W));
  }
  if (level === 0 && hidden > 0) rows.push(fit('  ' + ink.muted(s.moreItems(hidden)), W));
  if (level === 0 && quiet.length) {
    const mark = ink.muted(G(NF.idle)), facts = quiet.map((v) => `${cutId(monitorText(v.name), 14)} ${ageOf(v.ageMs, lang)}`);
    let kept = facts.length;
    while (kept > 1 && 2 + len(s.quiet) + 1 + len(facts.slice(0, kept).join(' · ')) + (kept < facts.length ? 3 + len(s.more(facts.length - kept)) : 0) > W) kept--;
    const tail = kept < facts.length ? ` · ${s.more(facts.length - kept)}` : '';
    rows.push(fit(`${mark} ${ink.muted(s.quiet + ' ' + facts.slice(0, kept).join(' · ') + tail)}`, W));
  }
  return rows;
}

// ---- the cards area and the tab row ------------------------------------------------------------------------------------------
/** The cards at one fold level, with their separating blank rows. [] when nothing is shown. */
export function cardRows(ctx, W, lang, now, level) {
  const today = todayRows(W, lang, ctx.today, level, now);
  const sched = scheduleRows(W, lang, ctx.sorted, ctx.quiet, level, now);
  const out = [];
  if (today.length) out.push(...today);
  if (sched.length) { if (today.length && level < 2) out.push(blank(W)); out.push(...sched); }
  // The due-only row sits directly under the project list: with one spare row there is no room for a separator.
  return out.length ? (level >= 3 ? out : [blank(W), ...out]) : [];
}
/** The largest level (fewest folds) whose rows fit in `spare` rows; 4 means the cards are gone. */
export function foldLevel(ctx, W, lang, now, spare) {
  for (let level = 0; level <= 3; level++) if (cardRows(ctx, W, lang, now, level).length <= spare) return level;
  return 4;
}
/** Tab row as `work-view.ts` draws it, with the optional due-schedule badge after the Home tab's `?N`. */
export function tabRow(W, lang, requests, sorted, { badge = true } = {}) {
  const [home, project, control] = T[lang].tab, due = dueCount(sorted), n = due.overdue + due.today;
  const q = (k) => (k ? ' ' + ink.attention(`?${k}`) : '');
  const cal = badge && n ? ' ' + (due.overdue ? ink.attention : ink.active)(G(CAL.today) + n) : '';
  const labels = [` ${home}${q(requests)}${cal} `, ` ${project}${q(requests)} `, ` ${control} `];
  return fit(labels.map((l, i) => (i === 0 ? ink.title : ink.muted)(l)).join(''), W);
}
