/**
 * Split Project: the hub and each page as a list over a preview of the cursor row. The hub lists Waiting for you and the pages
 * (Progress previews Now, To try and Latest, so the common question needs no Enter); Progress is one ledger list with the cursor
 * slice explained underneath; the Control plane lists roles with the cursor role's places below, where the place keys act.
 * Rows keep Classic's item ids where Classic acts on them (a page, a waiting item, a file, a place), so Enter, `o` and the place
 * keys are the ones Classic has.
 */
import type { LedgerSlice, SliceState, ProjectSnapshot } from '../collectors/project-board.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { PROJECT_PAGES, PAGE_WORD, HOME_BLOCK, asksYou, barText, briefRows, clampClean, clampLines, currentRows, hubNowRows, inFlight, inline, landedAge, landedMark, landedNewest,
  ledgerText, pageRows, pageSummary, progressSegments, projectFoldedSet, roleInk, sinceText, sliceInk, ticketRows, unlisted, unsliced, waitingRows, projectItem, trySelectionMark,
  type ProjectPage } from './project-view.js';
import { glyph, needsAttention, placeTarget, placeText, roleName } from './control-view.js';
import { splitItems, splitScope, splitSubValid, type SplitScene } from './split-frame.js';
import { boardRow, kvRows, mark, minuteAge, pack, section } from './workboard-rows.js';
import { jobSentenceRows, labelSummary, stemLines, workCardDetail } from './work-card.js';
import { fit, flowLines, monitorText, pair } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { basename } from 'node:path';

type Shown = { label: string; right?: string; rows: MonitorRow[]; act?: string };
interface Part { list: MonitorRow[]; start?: string; preview: (cursor?: string) => Shown; hints: string; focusHints?: string }
const muted = theme.board.muted, DAY = 864e5;
const bare = (rows: MonitorRow[]): MonitorRow[] => rows.map(({ item: _item, files: _files, ...row }) => row);
const plain = (text: string, width: number): MonitorRow => ({ text: fit(text, width) });
const indent = (text: string, width: number, max: number) => clampLines(text, width - 2, max).lines.map((l) => plain('  ' + l, width));
const tryTotals = (n: number) => (n ? t('{n} to try', { n }) : '');

function hubPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const projects = input.projects ?? [], many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const name: MonitorRow = { ...section(theme.board.title(monitorText(input.projectName ?? '') || t('Project')), width,
    [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
  ...(many ? { item: 'project:switch' } : {}) };
  const tries = data.waiting.filter((r) => /^try\b/i.test(r.value)).length, waitFacts = [data.waiting.length, tryTotals(tries)].filter(Boolean).join(' · ');
  const waiting: MonitorRow[] = data.waiting.length ? [{ item: 'project:fold:waiting', text: pair(`${theme.board.attention('?')} ${theme.board.title(t('Waiting for you'))}`, muted(waitFacts), width) }] : [];
  const cur = currentRows(data), tickets = data.tickets.flatMap((f) => f.tickets);
  const mark_ = (page: ProjectPage) => page === 'progress' && cur.counts.working ? theme.board.active(mark('◐', '@'))
    : (page === 'tickets' && tickets.some(asksYou)) || (page === 'control' && data.roles.some(needsAttention)) || (page === 'tree' && unlisted(data).length) ? theme.board.attention(page === 'tickets' ? '?' : '!')
    : muted(mark('○', 'o'));
  const pages = PROJECT_PAGES.filter((p) => p !== 'tickets' || data.tickets?.length).map((page): MonitorRow => {
    const facts = pageSummary(page, data, now), room = width - 2 - 14 - 1;
    while (facts.length > 1 && visualLength(facts.join(' · ')) > room) facts.pop();
    return { item: `project:page:${page}`, text: fit(`${mark_(page)} ${theme.board.title(fit(t(PAGE_WORD[page]), 14))}${facts.join(' · ') || mark('–', '-')}`, width) };
  });
  const preview = (cursor?: string): Shown => {
    if (cursor === 'project:fold:waiting') return { label: t('Waiting for you'), right: waitFacts, rows: data.waiting.flatMap((r, i) => waitingRows(r, i, width, now, Infinity)) };
    const page = /^project:page:(.+)$/.exec(cursor ?? '')?.[1] as ProjectPage | undefined;
    if (page && page !== 'progress') return { label: t(PAGE_WORD[page]), right: t('⏎ open page'), rows: bare(pageRows(page, data, state, width, now, board, input.modelEnabled, input.tryMarks).slice(1)) };
    const rows: MonitorRow[] = [...indent(data.summary, width, 2)];
    const total = cur.rows.length - cur.counts.dropped, cells = Math.max(6, Math.min(HOME_BLOCK, width - 10));
    if (progressSegments(cur.counts, cells).some((s) => s.width)) rows.push(plain(`  ${barText({ counts: cur.counts }, cells)} ${muted(`${cur.counts.accepted}/${total}`)}`, width));
    const landed = landedNewest(data), marks = input.tryMarks, queue = landed.filter(({ r }) => r.state === 'try');
    const todo = queue.filter(({ r }) => !marks?.get(r.id)), done = queue.filter(({ r }) => marks?.get(r.id));
    // A to-try slice is its row (the id and age, the text beside them when it fits) and the rest of its whole text wrapped under it; the preview scrolls.
    const tryRows = ({ r }: { r: LedgerSlice }, act: boolean): MonitorRow[] => {
      const item = `project:try:${r.id}`;
      const head = `  ${trySelectionMark(state, item)}${landedMark(r, marks?.get(r.id))} ${monitorText(r.id)}`, age = landedAge(r, now), body = monitorText(ledgerText(r));
      const fits = visualLength(head) + 2 + visualLength(body) + visualLength(age) + 1 <= width;
      const lines = fits || !body ? [inline(head, body, age, width)] : [pair(head, age, width), ...clampClean(body, width - 4, Infinity).lines.map((l) => fit('    ' + muted(l), width))];
      return lines.map((text) => ({ item, ...(data.statePath ? { files: [data.statePath] } : {}), ...(act ? { tryTarget: { milestone: r.milestone, slices: [r] } } : {}), text }));
    };
    if (queue.length) rows.push(boardRow(''), plain(muted(`${t('To try')}   ${t('y accept  n flag')}`), width), ...todo.flatMap((x) => tryRows(x, true)), ...done.flatMap((x) => tryRows(x, false)));
    if (inFlight(data).length || unsliced(data).length) rows.push(boardRow(''), plain(muted(t('Now')), width), ...hubNowRows(data, width, now, board));
    const accepted = landed.filter(({ r }) => r.state === 'accepted').slice(0, 3);
    if (accepted.length) rows.push(boardRow(''), plain(muted(t('Latest accepted')), width), ...accepted.map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now), width) })));
    return { label: t('Progress'), right: muted(t('⏎ open page')), rows, ...(todo.length ? { act: `project:try:${todo[0].r.id}` } : {}) };
  };
  return { list: [name, boardRow(''), ...waiting, ...pages], preview,
    start: pages.find((r) => r.item)?.item, hints: '↑↓ move  Space mark  y accept  n flag  ⏎ open  ←→ tab  [ ] project  ? help', focusHints: '↑↓ move  ⏎ open  esc back  ? help' };
}

const SLICE_MARK: Partial<Record<SliceState, () => string>> = { working: () => sliceInk('working')(mark('◐', '@')), blocked: () => sliceInk('blocked')(mark('◆', '!')), todo: () => muted(mark('○', '-')) };
function progressPart(input: MonitorData, data: ProjectSnapshot, state: MonitorState, board: WorkboardSnapshot, width: number, now: number): Part {
  const cur = currentRows(data), marks = input.tryMarks, path = data.statePath, files = path ? { files: [path] } : {};
  const list: MonitorRow[] = [];
  const total = cur.rows.length - cur.counts.dropped, label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = `${cur.counts.accepted}/${total}`;
  if (cur.rows.length) list.push(plain(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2)))} ${muted(frac)}`, width), boardRow(''));
  else if (!path) list.push(plain('  ' + muted(t('no STATE.md')), width));
  const ids = cur.rows.map((r) => visualLength(monitorText(r.id))), col = Math.max(8, Math.min(14, Math.max(0, ...ids)));
  const info = (r: LedgerSlice) => data.slices.find((s) => s.label === r.id), workerOf = (r: LedgerSlice) => board.workers.find((w) => w.evidence[0]?.sourceId === info(r)?.jobId);
  for (const st of ['working', 'blocked', 'try', 'todo'] as const) for (const r of cur.rows.filter((x) => x.state === st)) {
    const s = info(r), role = workerOf(r)?.role ?? s?.role ?? '';
    const right = s?.drift ? theme.board.attention(t(s.drift)) : st === 'working' && s?.jobId ? `${role ? roleInk(role)(monitorText(role)) + ' ' : ''}${muted(minuteAge(s.at ?? null, now))}` : st === 'try' ? muted(sinceText(r.at, now)) : '';
    const item = `project:slice:${r.id}`;
    list.push({ item, ...files, ...(st === 'try' ? { tryTarget: { milestone: r.milestone, slices: [r] } } : {}),
      text: pair(`${trySelectionMark(state, item)}${st === 'try' ? landedMark(r, marks?.get(r.id)) : SLICE_MARK[st]!()} ${fit(monitorText(r.id), col)} ${muted(t(st === 'try' ? 'to try' : st))}`, right, width) });
  }
  for (const job of unsliced(data)) list.push({ item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}),
    text: pair(`${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))} ${muted(monitorText(job.title ?? job.package ?? ''))}`, job.asking ? theme.board.attention(`${t('asking')} ?`) : muted(minuteAge(job.at ?? null, now)), width) });
  const landed = landedNewest(data), recent = landed.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY);
  const block = (item: string, left: string, right: string): MonitorRow => ({ item, ...files, text: pair(left, muted(right), width) });
  if (cur.counts.accepted) list.push(block('split:accepted', `${sliceInk('accepted')(mark('✓', '+'))} ${muted(t('{n} accepted', { n: cur.counts.accepted }))}  ${muted(mark('▸', '>'))}`, ''));
  if (data.next.length) list.push(block('split:next', `${muted(mark('→', '>'))} ${t('Next')}`, String(data.next.length)));
  if (landed.length) list.push(block('split:history', `${muted(mark('▸', '>'))} ${t('History')}`, `${t('{n} landed in 7 days', { n: recent.length })} · ${landed.length - recent.length} ${t('older')}`));
  const preview = (cursor?: string): Shown => {
    const id = /^project:slice:(.+)$/.exec(cursor ?? '')?.[1], r = cur.rows.find((x) => x.id === id);
    if (r) {
      // The slice's whole text, with its model brief and steps (a to-try slice, model on) above it.
      const s = info(r), worker = workerOf(r), rows = [...briefRows(r.brief, width).map((l) => plain(l, width)), ...indent(ledgerText(r) || r.text, width, Infinity)];
      if (worker && s) {
        rows.push(plain(`  ${muted(t('now:'))} ${roleInk(worker.role ?? '')(monitorText(worker.role ?? ''))} ${muted(worker.homeNeedsHuman ? `${t('asking')} ?` : minuteAge(s.at ?? null, now))}`, width));
        rows.push(...(input.modelEnabled && worker.modelSentence ? jobSentenceRows(worker.modelSentence, width, theme.board.muted, true).map((l) => plain(l, width))
          : stemLines(workCardDetail(projectWorkCard(worker, now)), width, theme.board.muted, 3).map((l) => plain(l, width))));
        const labels = labelSummary(worker.labels);
        if (labels) rows.push(plain('  ' + labels, width));
      } else rows.push(plain('  ' + muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at) : ''].filter(Boolean).join(' · ')), width));
      return { label: monitorText(r.id), right: `${t(r.state === 'try' ? 'to try' : r.state)}${NO_MILESTONE.test(r.milestone) ? '' : ' · ' + monitorText(r.milestone)}`, rows };
    }
    if (cursor === 'split:accepted') return { label: t('accepted'), right: String(cur.counts.accepted), rows: landed.filter(({ r }) => r.state === 'accepted' && cur.rows.includes(r))
      .map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now, false), width) })) };
    if (cursor === 'split:next') return { label: t('Next'), right: String(data.next.length), rows: data.next.flatMap((n) => clampLines(n.value, width - 4, 2).lines.map((l, k) => plain(`${k ? '    ' : `  ${mark('→', '>')} `}${l}`, width))) };
    if (cursor === 'split:history') {
      const old = landed.filter((x) => !recent.includes(x)), by = new Map<string, number>();
      for (const { r } of old) by.set(r.milestone, (by.get(r.milestone) ?? 0) + 1);
      return { label: t('History'), right: t('newest first'), rows: [...recent.map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now, false), width) })),
        ...[...by].map(([m, n]) => plain(`  ${muted(mark('▸', '>'))} ${NO_MILESTONE.test(m) ? t('other') : monitorText(m)}  ${sliceInk('accepted')(`${mark('✓', '+')} ${n}`)}`, width))] };
    }
    const job = unsliced(data).find((j) => `project:job:${j.jobId}` === cursor);
    return { label: monitorText(job?.role ?? ''), rows: job ? indent(job.title ?? job.package ?? '', width, 3) : [] };
  };
  const hints = '↑↓ move  Space mark  y accept  n flag  ⏎ open file  PgUp PgDn scroll  esc back  ? help';
  return { list, preview, start: list.find((r) => r.item)?.item, hints };
}
const NO_MILESTONE = /^[—–-]*$/;
const dateText = (at: number) => new Date(at).toISOString().slice(5, 10);

function controlPart(data: ProjectSnapshot, width: number, now: number): Part {
  const col = Math.max(8, Math.min(16, Math.max(0, ...data.roles.map((r) => visualLength(roleName(r)))))), mins = (until: number) => t('{n}m', { n: Math.max(1, Math.ceil((until - now) / 60000)) });
  const roleRows = (role: (typeof data.roles)[number], attention: boolean): MonitorRow[] => {
    const item = `project:role:${role.role}`, dead = role.places.find((p) => p.state === 'exhausted'), next = role.places.find((p) => p.state === 'active');
    const mid = dead ? theme.board.attention(`${dead.label} ${t('exhausted')}${dead.until === undefined ? '' : ' ' + mins(dead.until)}`) : next ? muted(placeText(next, width - col - 5, ' ')) : muted(t('not installed'));
    const rows: MonitorRow[] = [{ item, text: fit(`${glyph(!attention ? 'active' : dead ? 'exhausted' : 'missing')} ${fit(roleName(role), col)} ${mid}`, width) }];
    if (attention && dead && next) rows.push({ item, text: fit(`  ${muted(`${t('next job')} ${mark('→', '>')}`)} ${glyph('active')} ${placeText(next, width - 20, ' ')}`, width) });
    return rows;
  };
  const sick = data.roles.filter(needsAttention), healthy = data.roles.filter((r) => !needsAttention(r)), invalid = data.control.filter((r) => r.label === 'invalid');
  const files = data.control.filter((r) => r.label !== 'invalid'), have = data.keys.filter((k) => k[1]).length;
  const ok = (yes: boolean) => (yes ? theme.board.success(mark('✓', '+')) : muted(mark('−', '-')));
  const list: MonitorRow[] = [];
  if (sick.length + invalid.length) list.push(section(t('Needs attention'), width, theme.board.attention(String(sick.length + invalid.length))), ...sick.flatMap((r) => roleRows(r, true)),
    ...invalid.map((r, i): MonitorRow => ({ item: `project:file:${r.path}:invalid:${i}`, files: r.path ? [r.path] : [], text: pair(`${theme.board.attention('!')} ${monitorText(basename(r.path ?? r.value))}`, muted(monitorText(r.value)), width) })), boardRow(''));
  if (healthy.length) list.push(section(t('Roles'), width, String(healthy.length)), ...healthy.flatMap((r) => roleRows(r, false)), boardRow(''));
  if (data.harnesses.length) list.push({ item: 'split:harnesses', text: pair(`${muted(mark('▸', '>'))} ${t('Harnesses')}`, muted(data.harnesses.map((h) => `${h.name} ${ok(h.ok)}`).join(' ')), width) });
  list.push({ item: 'split:files', text: pair(`${muted(mark('▸', '>'))} ${t('Files')}`, muted([data.keys.length && `${t('keys')} ${have}/${data.keys.length}`, `${t('browser')} ${mark(data.browser ? '✓' : '−', data.browser ? '+' : '-')}`].filter(Boolean).join(' · ')), width) });
  const preview = (cursor?: string): Shown => {
    const role = data.roles.find((r) => `project:role:${r.role}` === cursor);
    if (cursor === 'split:harnesses') return { label: t('Harnesses'), rows: pack(data.harnesses.map((h) => `${monitorText(h.name)} ${ok(h.ok)}`), width).map((l) => plain(l, width)) };
    if (cursor === 'split:files') return { label: t('Files'), right: String(files.length + data.agents.length), rows: [...files.map((r, i) => projectItem(r.label === 'convention' ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i, '', width, now)),
      ...data.agents.map((r, i) => projectItem(r, i, '', width, now)), ...kvRows('keys', data.keys.map(([n, p]) => `${n} ${mark(p ? '✓' : '−', p ? '+' : '-')}`).join('  '), width)] };
    if (!role) return { label: '', rows: [] };
    const place = (i: number): MonitorRow => {
      const p = role.places[i], tag = p.state === 'exhausted' ? theme.board.attention(`${t('exhausted')}${p.until === undefined ? '' : ' ' + mins(p.until)}`) : p.state === 'missing' ? muted(t('not installed'))
        : p.state === 'active' && role.places.findIndex((x) => x.state === 'active') === i ? theme.board.active(t('next job')) : '';
      return { ...placeTarget(role, i, data), text: pair(`  ${glyph(p.state)} ${(p.state === 'active' ? (s: string) => s : muted)(placeText(p, width - 6 - visualLength(tag), '  '))}`, tag, width) };
    };
    return { label: monitorText(role.role), right: [t('{n} places', { n: role.places.length }), role.preset === undefined ? '' : `${t('preset')}: ${monitorText(role.preset ?? t('custom'))}`].filter(Boolean).join(' · '),
      rows: [...role.places.map((_, i) => place(i)), boardRow(''), ...kvRows('source file', `${t(role.source)} · ${basename(role.path)}`, width, undefined, 11)] };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: '↑↓ move  ⏎ places  c C preset  PgUp PgDn scroll  esc back  ? help',
    focusHints: '↑↓ place  p harness  m model  e thinking  + - fallback  K J move  x clear  esc back  ? help' };
}

/** Tickets: a ticket a row under its lane (as Classic), the cursor ticket's checklist and latest comment below; Enter opens its file. */
function ticketsPart(data: ProjectSnapshot, state: MonitorState, width: number, now: number): Part {
  const folded = projectFoldedSet(state), seen = new Set<string>(), prefix = 'project:fold:ticket:';
  const list = [...ticketRows(data, folded, width, now).filter((r) => !r.item || (!seen.has(r.item) && seen.add(r.item)))
    .map((r) => (r.item?.startsWith(prefix) ? { ...r, item: `project:tk:${r.item.slice(prefix.length)}` } : r))];
  const preview = (cursor?: string): Shown => {
    const key = /^project:tk:(.+)$/.exec(cursor ?? '')?.[1];
    const ticket = data.tickets.flatMap((f) => f.tickets.map((x) => ({ x, key: `${f.slug}:${basename(x.path)}` }))).find((o) => o.key === key)?.x;
    if (!key || !ticket) return { label: '', rows: [] };
    const rows = ticketRows(data, new Set([...folded, `ticket:${key}`]), width, now).filter((r) => r.item === prefix + key).slice(1);
    return { label: monitorText(`${ticket.number} ${ticket.title}`), right: monitorText(ticket.status), rows: bare(rows) };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: '↑↓ move  ⏎ open file  PgUp PgDn scroll  esc back  ? help' };
}

/** Working tree and Docs: each fact a row, its whole text, path and age underneath. */
function factsPart(page: 'tree' | 'docs', data: ProjectSnapshot, width: number, now: number): Part {
  const git = data.git, facts = page === 'docs' ? data.docs : [
    ...(git ? [{ label: 'branch', value: [git.branch, t('{n} changed', { n: git.changed }), git.ahead === null ? '' : `${git.ahead} ${t('ahead')}`, git.behind ? `${git.behind} ${t('behind')}` : ''].filter(Boolean).join(' · ') }] : []),
    ...data.editing, ...(data.last ? [{ label: 'last', value: data.last.text, at: data.last.at }] : []),
    ...unlisted(data).map((r) => ({ label: '!', value: `${r.label} · ${t('not in ledger')}` }))];
  const list = [...facts.map((r, i) => ({ ...projectItem(r, i, '', width, now), item: `project:row:${i}` }))];
  const preview = (cursor?: string): Shown => {
    const r = facts[Number(/^project:row:(\d+)$/.exec(cursor ?? '')?.[1])];
    return !r ? { label: '', rows: [] } : { label: r.label === '!' ? t('Unlisted worktrees') : t(r.label), right: 'at' in r && r.at !== undefined ? minuteAge(r.at, now) : '',
      rows: [...flowLines(monitorText(r.value), width - 2).map((l) => plain('  ' + l, width)), ...('path' in r && r.path ? [plain('  ' + muted(basename(r.path)), width)] : [])] };
  };
  return { list, preview, start: list.find((r) => r.item)?.item, hints: '↑↓ move  ⏎ open file  PgUp PgDn scroll  esc back  ? help' };
}

/** The scene of a Project page the layout draws; `undefined` for the pages Classic keeps (one waiting item's text, the Projects list). */
export function projectScene(input: MonitorData, state: MonitorState, board: WorkboardSnapshot, page: ProjectPage | undefined, width: number, now: number): SplitScene | undefined {
  const data = input.project;
  if (!data || page === 'waiting') return undefined;
  const part = !page ? hubPart(input, data, state, board, width, now) : page === 'progress' ? progressPart(input, data, state, board, width, now)
    : page === 'control' ? controlPart(data, width, now) : page === 'tickets' ? ticketsPart(data, state, width, now) : factsPart(page, data, width, now);
  const items = splitItems(part.list), wait = (at?: string) => (at?.startsWith('project:wait:') ? 'project:fold:waiting' : at);
  let focus = state.splitFocus === 'preview', cursor = wait(focus ? state.splitList : state.projectCursor);
  cursor = cursor && items.includes(cursor) ? cursor : part.start;
  let shown = part.preview(cursor);
  // Classic moved the cursor: to another row of this preview (a place added or moved), or off it (a page opened, a project switched).
  if (focus && state.projectCursor !== state.splitSub) {
    if (splitItems(shown.rows).includes(state.projectCursor ?? '')) state.splitSub = state.projectCursor;
    else { focus = false; cursor = wait(state.projectCursor); cursor = cursor && items.includes(cursor) ? cursor : part.start; shown = part.preview(cursor); }
  }
  const scope = `project|${page ?? 'hub'}|${state.projectRoot ?? ''}|${cursor}`;
  splitScope(state, scope);
  const sub = focus ? splitSubValid(state, shown.rows) : undefined;
  if (!page && state.splitFocus && !sub) state.trySelection = undefined;
  state.splitFocus = sub ? 'preview' : undefined;
  state.splitList = cursor;
  state.projectCursor = sub ?? cursor;
  const hints = !sub ? part.hints : shown.act ? '↑↓ move  Space mark  y accept  n flag  esc back  ? help' : part.focusHints ?? part.hints;
  return { list: part.list, cursor, rule: { label: shown.label, right: shown.right }, preview: shown.rows, sub, act: sub ? undefined : shown.act, scope, hints };
}
