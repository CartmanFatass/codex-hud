/**
 * Inbox layout, Project (owner, 2026-11-17, PANEL-REDESIGN; docs/design/panel-v8, Option 1): the hub opens on what the owner owes
 * and acts on it in place (`y` accepts, `n` flags a slice to try), then what is in flight, the latest accepted slices and the
 * pages with a mark each. Progress puts To try above Now. The other pages are Classic's (project-view.ts).
 */
import type { LedgerSlice, ProjectSnapshot } from '../collectors/project-board.js';
import type { TryAction } from '../collectors/try-records.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorRow, MonitorState, ProjectChoice } from './monitor.js';
import { boardRow, minuteAge, mark, pack, section } from './workboard-rows.js';
import { jobSentenceLine, labelSummary, workCardDetail } from './work-card.js';
import {
  DAY, HOME_BLOCK, NO_MILESTONE, PAGE_WORD, PROJECT_PAGES, asksYou, barText, clampLines, currentRows, dateText, foldRow, inFlight,
  inline, landedMark, landedNewest, ledgerText, milestoneOrder, pageSummary, projectFoldedSet, roleInk, sinceText,
  sliceInk, stacked, unsliced, waitingRows,
} from './project-view.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { SLICE_STATES } from '../collectors/project-board.js';
import { t } from './i18n.js';

/** A slice to try as a row `y` and `n` act on: its mark (what the owner just said, until STATE agrees), id, text and age. */
function tryRow(r: LedgerSlice, action: TryAction | undefined, data: ProjectSnapshot, width: number, now: number, text = true): MonitorRow[] {
  const word = action ? [action === 'accept' ? theme.board.success(t('accepted')) : theme.board.attention(t('flagged'))] : [];
  const right = [...word, theme.board.muted(sinceText(r.at, now))].join(' ');
  const head = `${landedMark(r, action)} ${monitorText(r.id)}`;
  const lines = text ? stacked(head, ledgerText(r), right, width, 2, 2) : [inline(head, ledgerText(r), right, width)];
  return lines.map((line) => ({ text: fit(line, width), item: `project:try:${r.id}`, tryTarget: { milestone: r.milestone, slices: [r] },
    ...(data.statePath ? { files: [data.statePath] } : {}) }));
}
const toTry = (data: ProjectSnapshot) => landedNewest(data).filter(({ r }) => r.state === 'try').map(({ r }) => r);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The hub's Waiting block: the ledger's slices to try, then STATE's items; a `Try …` item that names a slice shows as the slice only. */
function waitingBlock(data: ProjectSnapshot, folded: ReadonlySet<string>, width: number, now: number, wrap: number, marks?: ReadonlyMap<string, TryAction>): MonitorRow[] {
  const slices = toTry(data);
  const items = data.waiting.map((r, i) => ({ r, i })).filter(({ r }) => !(/^try\b/i.test(r.value) && slices.some((s) => new RegExp(`(^|[^\\w-])${escape(s.id)}($|[^\\w-])`, 'i').test(r.value))));
  const owed = slices.length + items.length, fresh = slices.filter((s) => !marks?.has(s.id)).length;
  if (!owed) return [];
  const rows = [foldRow(folded, 'waiting', 'Waiting for you', width, [owed, fresh && t('{n} to try', { n: fresh })].filter(Boolean).join(' · '))];
  if (!folded.has('waiting')) {
    for (const s of slices) rows.push(...tryRow(s, marks?.get(s.id), data, width, now, false));
    for (const { r, i } of items) { const item = waitingRows(r, i, width, now, wrap > 0); if (item.length > 1) wrap--; rows.push(...item); }
  }
  return [...rows, boardRow('')];
}

const PAGE_MARK: Record<string, (data: ProjectSnapshot) => string> = {
  progress: (d) => (currentRows(d).counts.working ? theme.board.active(mark('◐', '@')) : theme.board.muted(mark('○', '-'))),
  tickets: (d) => (d.tickets.some((f) => f.tickets.some(asksYou)) ? theme.board.attention('?') : theme.board.muted(mark('○', '-'))),
  tree: (d) => (d.slices.some((r) => r.drift === 'not in ledger') ? theme.board.attention('!') : theme.board.muted(mark('○', '-'))),
  docs: () => theme.board.muted(mark('○', '-')),
  control: (d) => (d.roles.some((r) => r.places.some((p) => p.state === 'exhausted')) ? theme.board.attention('!') : theme.board.muted(mark('○', '-'))),
};

/** The hub: the project's name, what the owner owes, what is in flight, the latest accepted, then the pages. */
export function inboxHubRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, name: string, projects: ProjectChoice[],
  board?: WorkboardSnapshot, room?: number, marks?: ReadonlyMap<string, TryAction>
): MonitorRow[] {
  const folded = projectFoldedSet(state), many = projects.length > 1, at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const top: MonitorRow[] = [boardRow(''), {
    ...section(theme.board.title(monitorText(name) || t('Project')), width,
      [data.ladder.current && theme.board.active(monitorText(data.ladder.current)), many && `${mark('▾', 'v')} ${t('project')} ${at + 1}/${projects.length}`].filter(Boolean).join(' ')),
    ...(many ? { item: 'project:switch' } : {}),
  }];
  const flight: MonitorRow[] = [...inFlight(data).map((r): MonitorRow => {
    const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId), role = worker?.role ?? r.role ?? '';
    const reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) }) : r.drift ? t(r.drift) : '';
    const blocked = r.ledgerState === 'blocked', lead = r.drift ? theme.board.attention('!') : blocked ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
    const who = reason ? theme.board.attention(reason) : r.jobId
      ? [role && roleInk(role)(monitorText(role)), (worker?.homeNeedsHuman ?? r.asking) ? theme.board.attention(`${t('asking')} ?`) : theme.board.muted(minuteAge(r.at ?? null, now))].filter(Boolean).join(' ')
      : sliceInk(blocked ? 'blocked' : 'working')(t(r.ledgerState ?? 'working'));
    return { text: inline(`${lead} ${monitorText(r.label)}`, r.value, who, width) };
  }), ...unsliced(data).map((job): MonitorRow => ({
    text: pair(`${sliceInk('working')(mark('◉', '@'))} ${roleInk(job.role)(monitorText(job.role || job.jobId.slice(-6)))}${job.title ? '  ' + theme.board.muted(monitorText(job.title)) : ''}`,
      job.asking ? theme.board.attention(`${t('asking')} ?`) : theme.board.muted(minuteAge(job.at ?? null, now)), width),
  }))];
  const accepted = landedNewest(data).filter(({ r }) => r.state === 'accepted').slice(0, width < 56 ? 3 : 5)
    .map(({ r }): MonitorRow => ({ text: inline(`${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), theme.board.muted(sinceText(r.at, now)), width) }));
  const column = Math.max(...PROJECT_PAGES.map((p) => visualLength(t(PAGE_WORD[p])))) + 1, space = Math.max(1, width - column - 2);
  const pages = PROJECT_PAGES.flatMap((page): MonitorRow[] => {
    if (page === 'tickets' && !data.tickets?.length) return [];
    const counts = currentRows(data).counts, total = SLICE_STATES.filter((s) => s !== 'dropped').reduce((n, s) => n + counts[s], 0);
    const asks = page === 'tickets' ? data.tickets.flatMap((f) => f.tickets).filter(asksYou).length : 0;
    const facts = page === 'progress' ? [total ? `${barText({ counts }, Math.min(14, Math.max(4, space - 6)))} ${theme.board.muted(`${counts.accepted}/${total}`)}` : '']
      : page === 'tickets' ? [...pageSummary(page, data, now).slice(0, 1), asks && theme.board.attention(t('{n} asks you', { n: asks }))].filter(Boolean) as string[]
      : pageSummary(page, data, now);
    while (facts.length > 1 && visualLength(facts.join(' · ')) > space) facts.pop();
    return [{ text: fit(`${PAGE_MARK[page](data)} ${theme.board.title(fit(t(PAGE_WORD[page]), column))}${facts.join(' · ') || mark('–', '-')}`, width), item: `project:page:${page}` }];
  });
  const build = (n: number, heads: boolean, gaps: boolean, wrap = 0) => [
    ...top, ...(gaps ? [boardRow('')] : []), ...waitingBlock(data, folded, width, now, wrap, marks),
    section(t('In flight'), width, flight.length ? String(flight.length) : ''), ...(flight.length ? flight : [boardRow(theme.board.muted(t('Nothing in progress')))]), boardRow(''),
    ...(n ? [section(t('Latest accepted'), width, t('newest first')), ...accepted.slice(0, n), boardRow('')] : []),
    ...(heads ? [section(t('Pages'), width)] : []), ...pages,
  ].filter((r) => gaps || r.text !== '' || r.item);
  // Latest gives way first, then the headers and the blank rows; the owed rows, in flight and the pages stay.
  const tiers: [number, boolean, boolean][] = [...accepted.map((_, i): [number, boolean, boolean] => [accepted.length - i, true, true]), [0, true, true], [0, false, true], [0, false, false]];
  for (const [k, [n, heads, gaps]] of tiers.entries()) {
    const rows = build(n, heads, gaps);
    if (room === undefined || rows.length <= room) return k ? rows : build(n, heads, gaps, room === undefined ? Infinity : room - rows.length);
  }
  return build(0, false, false);
}

/** Progress: where the milestone is, what is to try, what is in flight, what is next, what was accepted. */
export function inboxProgressRows(
  data: ProjectSnapshot, state: MonitorState, width: number, now: number, board?: WorkboardSnapshot, modelEnabled = false, marks?: ReadonlyMap<string, TryAction>
): MonitorRow[] {
  const rows: MonitorRow[] = [boardRow('')], folded = projectFoldedSet(state);
  const file = (text: string, key: string, path = data.statePath) => rows.push({ text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}) });
  const head = (label: string, right: string | number) => rows.push(boardRow(''), section(t(label), width, String(right)));
  if (!data.statePath) rows.push(boardRow('  ' + theme.board.muted(t('no STATE.md'))));
  if (data.summary) for (const line of clampLines(data.summary, width - 2, 2).lines) file('  ' + line, 'summary');
  const cur = currentRows(data), total = cur.rows.length - cur.counts.dropped;
  if (cur.rows.length) {
    const label = cur.whole || !data.ladder.current ? '' : ` ${monitorText(data.ladder.current)} `, frac = `${cur.counts.accepted}/${total}`;
    const cells = Math.max(6, Math.min(24, width - 3 - visualLength(label) - visualLength(frac) - 2));
    file(`  ${label ? theme.board.title(label) + ' ' : ''}${barText({ counts: cur.counts }, cells)} ${theme.board.muted(frac)}`, 'bar');
    for (const line of pack(SLICE_STATES.filter((s) => s !== 'accepted' && cur.counts[s]).map((s) => sliceInk(s)(`${cur.counts[s]} ${t(s === 'try' ? 'to try' : s)}`)), width)) file(line, 'counts');
    const order = milestoneOrder(data), before = order.slice(0, Math.max(0, order.indexOf(data.ladder.current ?? ''))), earlier = data.ledger.filter((r) => r.state === 'accepted' && before.includes(r.milestone));
    const places = new Set(earlier.map((r) => r.milestone)).size;
    if (!cur.whole && earlier.length) file(`  ${sliceInk('accepted')(mark('✓', '+'))} ${theme.board.muted(t(places === 1 ? '{n} accepted in {m} earlier milestone' : '{n} accepted in {m} earlier milestones', { n: earlier.length, m: places }))}`, 'earlier');
  }
  const tries = toTry(data);
  if (tries.length) { head('To try', tries.length); for (const r of tries) rows.push(...tryRow(r, marks?.get(r.id), data, width, now)); }
  const jobs = unsliced(data), slices = inFlight(data);
  if (slices.length + jobs.length) head('Now', slices.length + jobs.length);
  for (const [i, r] of slices.entries()) {
    const path = r.path ?? data.statePath, reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) }) : r.drift ? t(r.drift) : '';
    const glyph = r.drift ? theme.board.attention('!') : r.ledgerState === 'blocked' ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
    for (const line of stacked(`  ${glyph} ${monitorText(r.label)}`, r.value, reason ? theme.board.attention(reason) : '', width, 4)) file(line, `slice:${i}`, path);
    if (!r.jobId) continue;
    const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId), asking = worker?.homeNeedsHuman ?? r.asking;
    const right = [monitorText(worker?.role ?? r.role ?? ''), asking ? `${t('asking')} ?` : minuteAge(r.at ?? null, now)].filter(Boolean).join(' ');
    const prefix = `    ${t('now:')} `, roomLeft = Math.max(1, width - visualLength(prefix) - visualLength(right) - 1);
    const sentence = worker ? modelEnabled && worker.modelSentence ? jobSentenceLine(worker.modelSentence, roomLeft + 3, (s) => s).slice(2).trimEnd()
      : monitorText(workCardDetail(projectWorkCard(worker, now))) : '';
    file(pair(prefix + sentence, right, width), `slice:${i}:now`, path);
    const labels = labelSummary(worker?.labels);
    if (labels) file('    ' + labels, `slice:${i}:labels`, path);
  }
  for (const job of jobs) {
    const right = [job.asking ? `${t('asking')} ?` : minuteAge(job.at ?? null, now)].filter(Boolean).join(' ');
    for (const line of stacked(`  ${sliceInk('working')(mark('◉', '@'))} ${monitorText(job.role || job.jobId.slice(-6))}`, job.title ?? job.package ?? '', theme.board.muted(right), width, 4))
      rows.push({ text: fit(line, width), item: `project:job:${job.jobId}`, ...(job.path ? { files: [job.path] } : {}) });
  }
  if (data.next.length) head('Next', data.next.length);
  const all = folded.has('next'), more = data.next.length - 2;
  (all ? data.next : data.next.slice(0, 2)).forEach((r, i) => {
    const id = `next:${i}`, clip = clampLines(r.value, width - 4, 2);
    for (const [k, line] of (folded.has(id) ? clampLines(r.value, width - 4, Infinity) : clip).lines.entries()) rows.push({
      text: fit(`${k ? '    ' : `  ${mark('→', '>')} `}${line}`, width),
      ...(clip.more ? { item: `project:fold:${id}` } : r.path ? { item: `project:file:${r.path}:${id}` } : {}), ...(r.path ? { files: [r.path] } : {}),
    });
  });
  if (more > 0) rows.push({ text: fit(`  ${theme.board.muted(`${all ? mark('▾', 'v') : mark('▸', '>')} ${all ? t('fewer') : t('{n} more', { n: more })}`)}`, width), item: 'project:fold:next' });
  // History is what was accepted: the last seven days in full, older work one row a milestone (Enter opens it into its slices).
  const done = landedNewest(data).filter(({ r }) => r.state === 'accepted'), recent = done.filter(({ r }) => r.at !== undefined && now - r.at <= 7 * DAY), older = done.filter((x) => !recent.includes(x));
  if (done.length) head('History', t('newest first'));
  const entry = (r: LedgerSlice, indent: number, right: string) => {
    const id = `hist:${r.id}`, lines = stacked(`${' '.repeat(indent)}${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), right, width, indent + 4, 2);
    if (folded.has(id)) lines.splice(1, 0, ' '.repeat(indent + 4) + theme.board.muted([NO_MILESTONE.test(r.milestone) ? '' : monitorText(r.milestone), r.commit?.slice(0, 7), r.at !== undefined ? dateText(r.at, now) : ''].filter(Boolean).join(' · ')));
    for (const line of lines) rows.push({ text: fit(line, width), item: `project:fold:${id}`, ...(data.statePath ? { files: [data.statePath] } : {}) });
  };
  recent.forEach(({ r }) => entry(r, 0, theme.board.muted(sinceText(r.at, now))));
  const order = milestoneOrder(data), buckets = new Map<string, LedgerSlice[]>();
  for (const { r } of older) { const m = NO_MILESTONE.test(r.milestone) ? '' : r.milestone; buckets.set(m, [...(buckets.get(m) ?? []), r]); }
  const name = (m: string) => (m ? monitorText(m) : t('other')), column = Math.min(10, Math.max(...[...buckets.keys()].map((m) => visualLength(name(m))), 0));
  for (const [milestone, items] of [...buckets].sort((a, b) => order.indexOf(b[0]) - order.indexOf(a[0]))) {
    const id = `hist:m:${milestone}`, open = folded.has(id);
    const days = items.flatMap((r) => (r.at === undefined ? [] : [Math.floor((now - r.at) / DAY)])), lo = Math.min(...days), hi = Math.max(...days);
    const span = !days.length ? '' : lo === hi ? t('{n}d', { n: lo }) : `${lo}–${t('{n}d', { n: hi })}`;
    const lead = `${open ? mark('▾', 'v') : mark('▸', '>')} ${theme.board.muted(fit(name(milestone), column))} `;
    rows.push({ text: pair(`${lead}${sliceInk('accepted')(`${mark('✓', '+')} ${items.length} ${t('accepted')}`)}`, theme.board.muted(span), width), item: `project:fold:${id}` });
    if (open) items.forEach((r) => entry(r, 2, theme.board.muted(sinceText(r.at, now))));
  }
  if (rows.length === 1) rows.push(boardRow('  ' + theme.board.muted(t('none'))));
  return rows;
}
