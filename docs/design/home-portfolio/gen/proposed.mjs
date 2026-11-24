// Proposed Home and Project rows, composed from the panel's own helpers (dist/) so every row is cell-exact.
// Prototype only: nothing here is product code.
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dist = (p) => import(pathToFileURL(join(fileURLToPath(new URL('../../../../dist/', import.meta.url)), p)).href);
const [{ theme, visualLength, truncateAnsi, stripAnsi }, { fit, cutWords, flowLines, monitorText }, { roleInk }, { ROLE_GLYPHS }, { clampClean }] = await Promise.all([
  dist('render/colors.js'), dist('render/monitor-text.js'), dist('render/work-job-row.js'), dist('render/model-glyphs.js'), dist('render/project-view.js'),
]);
const ink = theme.board;
export const G = (cp) => String.fromCodePoint(cp);
// Nerd (Font Awesome) marks: the panel's own for states (workboard-rows.ts), the rest from the same family.
export const NF = { live: 0xf111, idle: 0xf10c, gone: 0xf057, pause: 0xf28b, ask: 0xf059, done: 0xf058, next: 0xf054, link: 0xf0c1,
  note: 0xf249, up: 0xf062, down: 0xf063, queue: 0xf017 };
const roleGlyph = (role) => G(parseInt(ROLE_GLYPHS[Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other'][2].codePointAt(0)));

const S = {
  zh: { waiting: '等你处理', needs: '需要你处理', projects: '项目', unit: '完成/工单', unitWord: '工单', objectives: '目标', details: '详情', jobs: '任务',
    blocked: '受阻', paused: '已暂停', maintenance: '维护中', active: '进行中', idle: '空闲', gone: '不可用', waits: '在等你', done: '完成', high: '高优先级', low: '低优先级',
    switch: (a, b) => `▾ 项目 ${a}/${b}`, more: (n) => `另 ${n} 个`, progress: '进度', tickets: '工单', tree: '工作区', docs: '文档',
    features: (n) => `${n} 个功能`, ticketsDone: (a, b) => `${a}/${b} 已完成`, inFlight: (n) => `${n} 进行中`, todo: (n) => `${n} 待办`,
    review: (a) => `复审 ${a}前`, updated: (a) => `${a}前更新`, noObj: '没有进行中的目标', ago: '' },
  en: { waiting: 'Waiting', needs: 'Needs you', projects: 'Projects', unit: 'done/tickets', unitWord: 'tickets', objectives: 'Objectives', details: 'Details', jobs: 'Jobs',
    blocked: 'blocked', paused: 'paused', maintenance: 'maintenance', active: 'active', idle: 'idle', gone: 'unavailable', waits: 'work waits', done: 'done', high: 'high priority', low: 'low priority',
    switch: (a, b) => `▾ project ${a}/${b}`, more: (n) => `${n} more`, progress: 'Progress', tickets: 'Tickets', tree: 'Working tree', docs: 'Docs',
    features: (n) => `${n} feature${n === 1 ? '' : 's'}`, ticketsDone: (a, b) => `${a}/${b} done`, inFlight: (n) => `${n} working`, todo: (n) => `${n} to do`,
    review: (a) => `review ${a} ago`, updated: (a) => `updated ${a} ago`, noObj: 'no active Objective', ago: ' ago' },
};
/** Compact age: m h d w, one unit, rounded down. zh uses the panel's own 分 and adds 时 天 周. */
export function age(ms, lang) {
  const u = lang === 'zh' ? ['分', '时', '天', '周'] : ['m', 'h', 'd', 'w'], m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${Math.max(1, m)}${u[0]}`;
  if (m < 1440) return `${Math.floor(m / 60)}${u[1]}`;
  if (m < 14 * 1440) return `${Math.floor(m / 1440)}${u[2]}`;
  return `${Math.floor(m / 10080)}${u[3]}`;
}
const len = visualLength;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - len(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - len(s))) + s;
/** A token (name, id, slug) cut by cell with an ellipsis. */
const cutId = (s, n) => (len(s) <= n ? s : truncateAnsi(s, n));
/** Prose cut at a word (CJK: any character); falls back to a cell cut when not even one word fits. */
const cutText = (s, n) => (n < 1 ? '' : len(s) <= n ? s : cutWords(s, n) || truncateAnsi(s, n));
const cutPathLeft = (s, n) => { if (len(s) <= n) return s; const parts = s.split('/'); let out = parts.pop(); while (parts.length && len('…/' + parts.at(-1) + '/' + out) <= n) out = parts.pop() + '/' + out; return len(out) < n ? '…/' + out : '…' + [...out].slice(-(n - 1)).join(''); };
const frameRule = (n) => ink.frame('─'.repeat(Math.max(0, n)));

/** Section row: `Label ─────── right`, as the panel's `section()`. */
function sec(W, label, right = '') {
  const tail = right ? len(right) : 0, rule = W - len(label) - tail - (tail ? 2 : 1);
  return fit(`${label} ${frameRule(rule)}${tail ? ' ' + ink.muted(right) : ''}`, W);
}
/** Left and right on one row; the right is whole or absent. */
const lr = (W, left, right) => (right && len(left) + 1 + len(right) <= W ? left + ' '.repeat(W - len(left) - len(right)) + right : fit(left, W));

// ---- bars ---------------------------------------------------------------------------------------------------------------
const BARS = [['done', '█', ink.success], ['try', '▒', ink.identifier], ['working', '█', ink.active], ['blocked', '█', ink.attention], ['todo', '░', ink.muted]];
/** The panel's cumulative-rounding stacked bar: done, to try, working, blocked, then the rest. `dim` greys a paused Objective. */
export function bar(c, n, dim = false) {
  const total = BARS.reduce((s, [k]) => s + (c[k] || 0), 0);
  if (!total || n < 1) return ink.frame('╌'.repeat(Math.max(0, n)));
  let sum = 0, edge = 0, out = '';
  for (const [k, ch, paint] of BARS) {
    sum += c[k] || 0;
    const end = Math.round((sum / total) * n);
    if (end > edge) out += (dim ? (k === 'todo' ? ink.frame : ink.muted) : paint)(ch.repeat(end - edge));
    edge = end;
  }
  return out;
}
const dots = (n) => ink.frame('╌'.repeat(Math.max(0, n)));

// ---- view model from the real snapshot ------------------------------------------------------------------------------------
export function ticketCounts(snap, features) {
  const c = { done: 0, try: 0, working: 0, blocked: 0, todo: 0 };
  let known = features.length > 0;
  for (const slug of features) {
    const f = snap.tickets.find((x) => x.slug === slug);
    if (!f) { known = false; continue; }
    for (const t of f.tickets) if (t.state !== 'dropped') c[t.state === 'done' ? 'done' : t.state === 'try' ? 'try' : t.state === 'working' ? 'working' : t.state === 'blocked' ? 'blocked' : 'todo']++;
  }
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { ...c, total, bar: known && total > 0 };
}
export function vm(project, now, lang) {
  const snap = project.snapshot, obj = snap?.objectives;
  const blockedIds = new Set((snap?.waiting ?? []).flatMap((w) => (w.objective && w.waitedOn ? [w.objective] : [])));
  const running = {}; let queued = 0;
  for (const j of snap?.active ?? []) { if (j.state === 'queued') queued++; else running[j.role] = (running[j.role] ?? 0) + 1; }
  const at = Math.max(snap?.updatedAt ?? -Infinity, snap?.objectivesAt ?? -Infinity);
  const live = Object.values(running).reduce((a, b) => a + b, 0) + queued > 0;
  const objectives = (obj?.objectives ?? []).map((o) => ({ ...o, blocked: blockedIds.has(o.id), counts: ticketCounts(snap, o.features) }));
  const [latest] = [...(project.resultDates ?? [])].sort((a, b) => b[1] - a[1]);
  const recent = latest && now - latest[1] <= 3 * 864e5
    ? { id: latest[0], at: latest[1], text: objectives.find((o) => o.id === latest[0]).result } : undefined;
  return { name: project.name, root: project.root, unavailable: !!project.unavailable, snap, stance: obj?.stance ?? 'unknown', priority: obj?.priority ?? 'normal',
    running, queued, live, idle: !project.unavailable && !live, ageMs: Number.isFinite(at) ? now - at : undefined, objectives, hasRecord: !!obj, recent, note: snap?.summary };
}
const stateRank = { active: 1, paused: 2, done: 3 };
const shown = (v) => v.objectives.filter((o) => o.state !== 'done').sort((a, b) => Number(b.blocked) - Number(a.blocked) || stateRank[a.state] - stateRank[b.state]);

// ---- shared parts ---------------------------------------------------------------------------------------------------------
const loadText = (v) => [...Object.keys(ROLE_GLYPHS).filter((r) => v.running[r]).map((r) => roleInk(r)(roleGlyph(r) + v.running[r])),
  ...(v.queued ? [ink.muted(G(NF.queue) + v.queued)] : [])].join(' ');
/** The state mark of an Objective row. */
const objMark = (o) => (o.blocked ? ink.attention(G(NF.ask)) : o.state === 'paused' ? ink.muted(G(NF.pause)) : o.state === 'done' ? ink.success(G(NF.done)) : ink.active(G(NF.live)));
const objIdInk = (o) => (o.blocked ? ink.attention : o.state === 'paused' ? ink.muted : ink.text);
const stanceWord = (v, s) => (v.stance === 'paused' ? s.paused : v.stance === 'maintenance' ? s.maintenance : '');
/** Strip the collector's `date id · … · Objective title (work waits)` wrapper off a request's sentence. */
export function requestSentence(w, objectives) {
  const title = objectives.find((o) => o.id === w.objective)?.title;
  let s = w.value.replace(/^\d{4}-\d\d-\d\d\s+\S+\s+·\s+/, '').replace(/\s*\(work waits\)\s*$/i, '');
  if (title && s.endsWith(' · ' + title)) s = s.slice(0, -(' · ' + title).length);
  return s;
}

// ---- Home -----------------------------------------------------------------------------------------------------------------
export function homeGeometry(W, lang) {
  const s = S[lang];
  const idCol = W < 50 ? 11 : 14, wide = W >= 80, unitEach = W >= 56, flagWord = W >= 50;
  const flagCol = flagWord ? Math.max(len(s.blocked), len(s.paused)) : 0;
  const cntCol = unitEach ? 5 + 1 + len(s.unitWord) : 5;
  const left = 2 + 1 + 1 + idCol + 1;           // indent, mark, space, id, space
  const right = 1 + cntCol + (flagCol ? 1 + flagCol : 0);
  const rest = W - left - right;                 // bar plus title column
  const titleCol = wide ? rest - 16 - 1 : 0;     // 80 columns: the title gets what the bar does not need
  const barCol = wide ? 16 : rest;
  return { idCol, wide, unitEach, flagCol, cntCol, barCol, titleCol, nameCap: W < 50 ? 14 : W < 80 ? 18 : 24, s };
}

function objRow(W, g, o, lang, titleOn) {
  const s = g.s, c = o.counts;
  const idText = objIdInk(o)(pad(cutId(o.id, g.idCol), g.idCol));
  const title = g.titleCol >= 14 ? ink.muted(pad(cutText(monitorText(o.title), g.titleCol), g.titleCol)) + ' ' : '';
  const dim = o.state === 'paused';
  const graphic = c.bar ? bar(c, g.barCol, dim) : dots(g.barCol);
  const count = c.bar ? `${c.done}/${c.total}` : '';
  const unit = g.unitEach && c.bar ? ' ' + s.unitWord : '';
  const cnt = c.bar ? (dim ? ink.muted : ink.text)(padL(count, 5)) + ink.muted(unit ? pad(unit, 1 + len(s.unitWord)) : '') : ' '.repeat(g.cntCol);
  const flag = g.flagCol ? ' ' + pad(o.blocked ? ink.attention(s.blocked) : dim ? ink.muted(s.paused) : '', g.flagCol) : '';
  return `  ${objMark(o)} ${idText} ${title}${graphic} ${cnt}${flag}`;
}

/** Home middle rows (tab row and footer come from the real frame). `tier`: 'full' | 'one-row'. */
export function homeRows(portfolio, now, W, lang, { tier = 'full', blank = true } = {}) {
  const s = S[lang], g = homeGeometry(W, lang), rows = [];
  const vms = portfolio.projects.map((p) => vm(p, now, lang)), oneRows = [];
  // 1. Requests first, only when there are any.
  if (portfolio.requests.length) {
    rows.push(sec(W, s.waiting, String(portfolio.requests.length)));
    for (const { project, item } of portfolio.requests) {
      const v = vms.find((x) => x.root === project.root), sentence = requestSentence(item, v.objectives);
      const flagText = item.waitedOn ? s.waits : '', ageText = item.at !== undefined ? age(now - item.at, lang) : '';
      const idText = item.objective ?? '', fixed = 2 + (idText ? 3 : 0);
      // The age leaves before the flag (rule 6) when even a name and id of 8 cells each would not fit beside both.
      const keepAge = fixed + Math.min(len(v.name), 8) + Math.min(len(idText), 8) + len([flagText, ageText].filter(Boolean).join(' ')) + 1 <= W;
      const right = [flagText && ink.attention(flagText), keepAge && ageText && ink.muted(ageText)].filter(Boolean).join(' ');
      const room = W - (right ? len(right) + 1 : 0);
      let name = v.name, id = idText;
      while (fixed + len(name) + len(id) > room && (len(name) > 8 || len(id) > 8)) { if (len(name) >= len(id) && len(name) > 8) name = cutId(name, len(name) - 1); else id = cutId(id, len(id) - 1); }
      const head = `${ink.attention(G(NF.ask))} ${ink.text(name)}${id ? ' ' + ink.muted('›') + ' ' + ink.text(id) : ''}`;
      rows.push(lr(W, head, right));
      for (const line of clampClean(sentence, W - 2, 2).lines) rows.push(fit('  ' + ink.text(line), W));
    }
  }
  rows.push(sec(W, s.projects, s.unit));
  const sep = () => { if (blank && tier === 'full') rows.push(fit('', W)); };
  vms.forEach((v, idx) => {
    if (idx) sep();
    const mark = v.unavailable ? ink.danger(G(NF.gone)) : v.live ? ink.active(G(NF.live)) : ink.muted(G(NF.idle));
    const nameInk = v.unavailable || !v.live ? ink.muted : ink.text;
    const stance = stanceWord(v, s);
    const prio = v.priority === 'high' ? ink.attention(G(NF.up)) : v.priority === 'low' ? ink.muted(G(NF.down)) : '';
    const idleWord = v.idle && !stance ? ink.muted(s.idle) : '';
    const ageT = v.ageMs !== undefined ? ink.muted(age(v.ageMs, lang)) : '';
    const facts = v.unavailable ? [ink.danger(s.gone)] : [prio, idleWord, loadText(v), ageT].filter(Boolean);
    const one = tier === 'one-row';
    // One-row tier: roll-up bar of the project's open Objectives' tickets.
    const open = shown(v), roll = open.reduce((a, o) => (o.counts.bar ? Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + o.counts[k]])) : a), { done: 0, try: 0, working: 0, blocked: 0, todo: 0 });
    const rollTotal = Object.values(roll).reduce((a, b) => a + b, 0);
    const tail = (list) => list.join(' ');
    let list = [...facts];
    const nameText = (n) => nameInk(cutId(v.name, n)) + (stance ? ink.muted(' · ' + stance) : '');
    if (!one) {
      // Drop whole facts from the front (priority arrow, idle word, age) before the load; never cut one.
      while (list.length && len(`${mark} ${nameText(Math.min(v.name.length, g.nameCap))}`) + 2 + len(tail(list)) + 1 > W) list.shift();
      const nm = Math.min(len(v.name), g.nameCap), l = `${mark} ${nameText(nm)}`;
      const r = tail(list), rule = W - len(l) - len(r) - (r ? 2 : 1);
      rows.push(fit(`${l} ${frameRule(rule)}${r ? ' ' + r : ''}`, W));
      if (v.unavailable) return;
      const objs = open;
      if (v.hasRecord) {
        const top = tier === 'full' ? objs.slice(0, 2) : objs.slice(0, 1);
        for (const o of top) {
          rows.push(objRow(W, g, o, lang));
          if (v.recent && v.recent.id === o.id) {
            const a = ink.muted(age(now - v.recent.at, lang)), room = W - 4 - 2 - len(a) - 1;
            rows.push(lr(W, `    ${ink.success(G(NF.done))} ${ink.text(cutText(monitorText(v.recent.text), room))}`, a));
          }
        }
        if (objs.length > top.length) rows.push(fit('  ' + ink.muted(s.more(objs.length - top.length)), W));
        if (!objs.length && v.stance === 'active') rows.push(fit('  ' + ink.muted(s.noObj), W));
      } else if (v.note) rows.push(fit(`  ${ink.muted(G(NF.note))} ${ink.muted(cutText(monitorText(v.note), W - 4))}`, W));
    } else {
      // One row: mark, name, roll-up bar and count, then the facts that fit; the columns line up across projects.
      const cnt = rollTotal ? `${roll.done}/${rollTotal}` : '';
      const dim = v.stance === 'paused' || (open.length > 0 && open.every((o) => o.state === 'paused'));
      const nameW = Math.min(g.nameCap - 3, 11), right = v.unavailable ? [ink.danger(s.gone)] : [loadText(v), ageT].filter(Boolean);
      oneRows.push({ v, mark, nameInk, nameW, cnt, roll, rollTotal, dim, right });
    }
  });
  if (oneRows.length) {
    const rightCol = Math.max(...oneRows.map((r) => len(r.right.join(' ')))), nameW = Math.max(...oneRows.map((r) => r.nameW));
    const barN = Math.max(4, W - 2 - nameW - 1 - 1 - 5 - (rightCol ? 1 + rightCol : 0));
    for (const r of oneRows) {
      const v = r.v, graphic = v.unavailable ? ' '.repeat(barN) : r.rollTotal ? bar(r.roll, barN, r.dim) : v.hasRecord || stanceWord(v, s) ? dots(barN) : ' '.repeat(barN);
      rows.push(fit(`${r.mark} ${r.nameInk(pad(cutId(v.name, nameW), nameW))} ${graphic} ${r.cnt ? ink.text(padL(r.cnt, 5)) : '     '}${rightCol ? ' ' + padL(r.right.join(' '), rightCol) : ''}`, W));
    }
  }
  return rows;
}

// ---- Project --------------------------------------------------------------------------------------------------------------
/** Text clamped to `max` rows where the first row has `room1` cells and the others `room`; the last ends in `…` when cut. */
function clamp2(text, room1, room, max) {
  const first = flowLines(text, Math.max(1, room1))[0] ?? '';
  const rest = text.slice(first.length).trimStart();
  if (!rest) return [first];
  const more = clampClean(rest, room, max - 1);
  return [first, ...more.lines];
}
export function projectRows(ctx, now, W, lang) {
  const s = S[lang], portfolio = ctx.portfolio, hp = portfolio.projects.find((p) => p.root === ctx.own);
  const v = vm(hp, now, lang), snap = ctx.project, rows = [fit('', W)];
  const total = portfolio.projects.length, at = portfolio.projects.findIndex((p) => p.root === ctx.own) + 1;
  rows.push(sec(W, ink.text(v.name), s.switch(at, total)));
  const stance = v.stance === 'unknown' ? '' : s[v.stance];
  const prio = v.priority === 'normal' ? '' : s[v.priority];
  const ageT = v.ageMs !== undefined ? s.updated(age(v.ageMs, lang)) : '';
  const idParts = [stance, prio, ageT].filter(Boolean);
  while (idParts.length > 1 && 2 + len(idParts.join(' · ')) > W) idParts.pop(); // whole facts leave from the end
  rows.push(fit('  ' + ink.muted(idParts.join(' · ')), W));
  // Requests.
  rows.push(sec(W, s.needs, String(snap.waiting.length)));
  if (!snap.waiting.length) rows.push(fit('  ' + ink.muted('—'), W));
  for (const w of snap.waiting) {
    const sentence = requestSentence(w, v.objectives);
    const right = [w.waitedOn && ink.attention(s.waits), w.at !== undefined && ink.muted(age(now - w.at, lang))].filter(Boolean).join(' ');
    rows.push(lr(W, `${ink.attention(G(NF.ask))} ${ink.text(cutId(w.objective ?? '', Math.min(16, W - len(right) - 4)))}`, right));
    for (const line of clampClean(sentence, W - 2, 4).lines) rows.push(fit('  ' + ink.text(line), W));
  }
  // Objectives.
  const objs = v.objectives, open = objs.filter((o) => o.state !== 'done').sort((a, b) => Number(b.blocked) - Number(a.blocked) || stateRank[a.state] - stateRank[b.state]);
  rows.push(sec(W, s.objectives, String(objs.length)));
  const featCol = Math.min(16, Math.max(...open.flatMap((o) => o.features.map((f) => len(f))), 8));
  const jobsOf = new Set();
  for (const [oi, o] of open.entries()) {
    if (oi) rows.push(fit('', W));
    const c = o.counts, stateInk = o.blocked ? ink.attention : o.state === 'paused' ? ink.muted : ink.text;
    const flag = o.blocked ? ink.attention(s.blocked) : o.state === 'paused' ? ink.muted(s.paused) : '';
    const cnt = c.bar ? ink.text(`${c.done}/${c.total}`) + ink.muted(' ' + s.unitWord) : '';
    const right = [cnt, flag].filter(Boolean).join(' ');
    rows.push(lr(W, `  ${objMark(o)} ${stateInk(cutId(o.id, Math.max(8, W - 4 - len(right) - 2)))}`, right));
    for (const line of clampClean(monitorText(o.title), W - 4, 3).lines) rows.push(fit('    ' + ink.text(line), W));
    if (o.next) {
      const lines = clampClean(monitorText(o.next), W - 6, 3).lines;
      lines.forEach((line, i) => rows.push(fit(`    ${i ? ' ' : ink.active(G(NF.next))} ${ink.text(line)}`, W)));
    }
    for (const slug of o.features) {
      const f = snap.tickets.find((x) => x.slug === slug);
      if (!f) { rows.push(fit(`    ${ink.muted(pad(cutId(slug, featCol), featCol))} ${ink.muted('—')}`, W)); continue; }
      const fc = ticketCounts(snap, [slug]), n = `${fc.done}/${fc.total}`;
      const barN = Math.max(6, Math.min(24, W - 4 - featCol - 1 - 1 - 5));
      rows.push(fit(`    ${ink.text(pad(cutId(slug, featCol), featCol))} ${bar(fc, barN, o.state === 'paused')} ${ink.text(padL(n, 5))}`, W));
      for (const j of snap.active.filter((a) => (a.title ?? '').startsWith(slug + '/'))) {
        jobsOf.add(j.jobId);
        const num = j.title.slice(slug.length + 1), t = f.tickets.find((x) => x.number === num);
        const a = ink.muted(age(now - (j.at ?? now), lang)), room = W - 6 - 2 - len(num) - 1 - len(a) - 1;
        rows.push(lr(W, `      ${roleInk(j.role)(roleGlyph(j.role))} ${ink.text(num)} ${ink.muted(cutText(t?.title ?? '', Math.max(0, room)))}`, a));
      }
    }
    const rec = v.recent?.id === o.id ? v.recent : undefined, text = rec?.text ?? o.result;
    if (text) {
      const a = rec ? ink.muted(age(now - rec.at, lang)) : '';
      const lines = clamp2(monitorText(text), W - 6 - (a ? len(a) + 2 : 0), W - 6, 2);
      lines.forEach((line, i) => rows.push(i === 0 && a ? lr(W, `    ${ink.success(G(NF.done))} ${ink.text(line)}`, a) : fit(`    ${i ? ' ' : ink.success(G(NF.done))} ${ink.text(line)}`, W)));
    }
    const ev = o.evidence.slice(0, 3);
    for (const e of ev) rows.push(fit(`    ${ink.muted(G(NF.link))} ${ink.muted(/^[0-9a-f]{7,40}$/i.test(e) ? e : cutPathLeft(e, W - 6))}`, W));
    if (o.evidence.length > 3) rows.push(fit('      ' + ink.muted(s.more(o.evidence.length - 3)), W));
  }
  for (const o of objs.filter((o) => o.state === 'done'))
    rows.push(lr(W, `  ${ink.success(G(NF.done))} ${ink.muted(cutId(o.id, 12))} ${ink.muted(cutText(monitorText(o.title), W - 4 - Math.min(12, len(o.id)) - 1))}`, ''));
  // Jobs no Objective claims.
  const free = snap.active.filter((a) => !jobsOf.has(a.jobId));
  if (free.length) {
    rows.push(sec(W, s.jobs, String(free.length)));
    for (const j of free) rows.push(lr(W, `  ${roleInk(j.role)(roleGlyph(j.role))} ${ink.text(cutId(j.title ?? '', W - 12))}`, ink.muted(age(now - (j.at ?? now), lang))));
  }
  // Details: each row names what it counts.
  const d = [];
  const tt = snap.ticketTotals;
  if (tt?.totalTickets) d.push([s.tickets, `${s.ticketsDone(tt.doneTickets, tt.totalTickets)} · ${s.features(tt.totalFeatures)}`]);
  const c = snap.counts, rest = c.accepted + c.working + c.todo + c.try + c.blocked;
  if (rest) d.push([s.progress, [snap.ladder.current, c.working && s.inFlight(c.working), c.todo && s.todo(c.todo)].filter(Boolean).join(' · ')]);
  if (snap.git) d.push([s.tree, `${snap.git.branch} · ${snap.git.changed}`]);
  const spec = snap.docs.find((x) => x.label === 'spec'), review = snap.docs.find((x) => x.label === 'review');
  if (spec || review) d.push([s.docs, [spec && `spec ${spec.value}`, review?.at && s.review(age(now - review.at, lang))].filter(Boolean).join(' · ')]);
  rows.push(fit('', W), sec(W, s.details));
  const col = Math.max(...d.map(([l]) => len(l))) + 1;
  for (const [l, r] of d) rows.push(fit(`${ink.muted(pad(l, col))}${ink.text(r)}`, W));
  return rows;
}
export { S, ink, len as cells, stripAnsi };
