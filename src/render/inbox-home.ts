/**
 * Inbox layout, Home (owner, 2026-11-17, PANEL-REDESIGN; docs/design/panel-v8, Option 1): one list ranked by need, the question,
 * a failure, a stalled job, a report ready, then what runs. A job is a title row and, while it runs or when it went wrong, one
 * sentence row; the package is the title's first word. Home's own rows only; Classic stays in home-view.ts.
 */
import { targetKey, type OwnerWorker, type WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { callTime } from '../collectors/workboard.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { boardRow, decisionRows, itemRow, minuteAge, mark, section } from './workboard-rows.js';
import {
  cardExpanded, failed, jobSentenceRows, quietDecisionSummary, renderWorkCard, requestLines, stemLines, workCardDetail,
  workCardName, workStateGlyph, workStateInk,
} from './work-card.js';
import { currentDecision, currentWorker, foldedWorker } from './work-visibility.js';
import { barText, currentRows, inline, landedAge, landedMark, landedNewest, ledgerText, sliceInk } from './project-view.js';
import { theme, truncateAnsi } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { t } from './i18n.js';

/** What gives way as Home runs short of rows, first to last; nothing that needs the owner is in it. */
interface Tier { gaps: boolean; heads: boolean; sentences: number; second: boolean; latest: boolean; block: boolean; native: boolean }
const TIERS: Tier[] = [
  { gaps: true, heads: true, sentences: Infinity, second: true, latest: true, block: true, native: true },
  { gaps: false, heads: true, sentences: Infinity, second: true, latest: true, block: true, native: true },
  { gaps: false, heads: false, sentences: Infinity, second: true, latest: true, block: true, native: true },
  { gaps: false, heads: false, sentences: 1, second: true, latest: true, block: true, native: true },
  { gaps: false, heads: false, sentences: 1, second: false, latest: true, block: true, native: true },
  { gaps: false, heads: false, sentences: 1, second: false, latest: false, block: true, native: true },
  { gaps: false, heads: false, sentences: 1, second: false, latest: false, block: false, native: true },
  { gaps: false, heads: false, sentences: 1, second: false, latest: false, block: false, native: false },
];
const OPTION = /^([A-Za-z]|[1-9][0-9]?)\s*[).:\-]\s+(.+)$/;
const optionKey = (s: string) => (OPTION.exec(s.trim())?.[1] ?? s.trim()).toLowerCase();
const rank = (w: OwnerWorker, now: number, stall?: number) => {
  const card = projectWorkCard(w, now, stall);
  return failed(card) ? 1 : card.state === 'stalled' ? 2 : card.state === 'awaiting-acceptance' ? 3 : card.state === 'in-progress' ? 4 : 5;
};

/** The question, whole and open (Enter), or its first lines and the options with the default marked. */
function slab(worker: OwnerWorker, label: string, state: MonitorState, width: number, now: number): MonitorRow[] {
  const card = projectWorkCard(worker, now, state.cardStallMinutes), r = worker.work?.requestInfo, quiet = quietDecisionSummary(worker.quietDecision);
  const target = { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id };
  const row = (text: string) => boardRow(theme.board.slab(text), target);
  const head = boardRow(theme.board.askTitle(pair(
    `? ${worker.labels?.category ? `[${t(worker.labels.category)}] ` : ''}${monitorText(worker.role ?? '')} · ${monitorText(label)}`,
    `${t('asking')} ${minuteAge(worker.humanEndedAt, now)}`, width)), target);
  if (state.boardExpanded?.has(targetKey(target)) && r)
    return [head, ...[...requestLines(card, true), quiet].filter(Boolean).flatMap((p) => stemLines(p, width, theme.board.attention)).map(row)];
  const bar = theme.board.attention(mark('┃', '|')), options = r?.options ?? [];
  const pick = (o: string) => (r?.suggested && optionKey(o) === optionKey(r.suggested) ? theme.board.attention(mark('●', '*')) : ' ');
  return [head, ...stemLines(r?.question ?? worker.ask ?? card.reason ?? '', width, theme.board.attention, 3).map(row),
    ...options.slice(0, 4).map((o) => row(fit(`${bar} ${pick(o)} ${theme.board.attention(monitorText(OPTION.exec(o) ? o.replace(OPTION, '$1  $2') : o))}`, width))),
    ...(options.length > 4 ? [row(fit(`${bar}   ${theme.board.muted(t('+{n} more', { n: options.length - 4 }))}`, width))] : []),
    ...(!options.length && r?.suggested ? stemLines(`${t('default')}: ${r.suggested}`, width, theme.board.attention, 1).map(row) : []),
    ...(quiet ? stemLines(quiet, width, theme.board.attention, 1).map(row) : [])];
}

/** One job: its title row (the package first, dim `PKG ›` when the title does not start with it), and one sentence row if it runs or went wrong. */
function jobRows(w: OwnerWorker, label: string, state: MonitorState, width: number, now: number, tier: Tier, keep: boolean, indent = ''): MonitorRow[] {
  const card = projectWorkCard(w, now, state.cardStallMinutes), key = targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id });
  const room = Math.max(1, width - indent.length), ink = workStateInk(card), bad = failed(card);
  if (cardExpanded(state, key)) return renderWorkCard(card, state, room, card.reason ? t(card.reason) : '').map((text) => ({ text: indent + text, item: key, key }));
  const prefix = !label || card.title.toUpperCase().startsWith(label.toUpperCase()) ? '' : `${monitorText(label)} › `;
  const name = workCardName({ ...card, title: prefix + card.title }, state, room);
  const text = prefix && name.text.startsWith(prefix) ? theme.board.muted(prefix) + name.text.slice(prefix.length) : name.text;
  const title = pair(`${ink(workStateGlyph(card))} ${name.role}  ${text}`, card.state === 'in-progress' ? theme.board.muted(name.right) : ink(name.right), room);
  const rows = [indent + (bad ? theme.board.title(title) : title)];
  const live = w.settledAt === null || card.state === 'awaiting-acceptance' || bad;
  if (live && (bad || !foldedWorker(w, now, state)) && (bad || keep || tier.sentences > 1)) {
    const detail = workCardDetail(card, card.reason ? t(card.reason) : '');
    const lines = w.modelSentence?.trim() ? jobSentenceRows(w.modelSentence, room, ink, true) : detail ? stemLines(detail, room, ink, 2) : [];
    rows.push(...lines.slice(0, bad && tier.second ? 2 : 1).map((l) => indent + (bad ? theme.board.failedBody : theme.board.body)(l)));
  }
  return rows.map((text) => ({ text, item: key, key }));
}

const PROGRESS = 'home-progress:progress';
/** Header, one summary row, the bar and one counts row; or, short of rows, the bar alone with the counts after it. */
function progressRows(data: ProjectSnapshot | undefined, width: number, tier: Tier): MonitorRow[] {
  if (!data) return [];
  const cur = currentRows(data), counts = cur.counts, total = cur.rows.length - counts.dropped, row = (text: string): MonitorRow => ({ text: fit(text, width), item: PROGRESS });
  if (!total && !data.summary) return [];
  const milestone = data.ladder.current && !cur.whole ? monitorText(data.ladder.current) : '';
  const done = `${counts.accepted}/${total}`, cells = Math.max(6, Math.min(36, width - 2));
  if (!tier.block)
    return [row(pair(`  ${barText({ counts }, Math.max(6, Math.min(18, width - 24)))}`, theme.board.muted([milestone, done, counts.try && t('{n} to try', { n: counts.try })].filter(Boolean).join(' · ')), width))];
  const glyph = { accepted: mark('✓', '+'), try: mark('◇', 'o'), working: mark('◐', '@'), blocked: mark('◆', '!'), todo: mark('○', '-') } as const;
  const legend = (Object.keys(glyph) as (keyof typeof glyph)[]).filter((s) => counts[s]).map((s) => sliceInk(s)(`${glyph[s]} ${counts[s]}`)).join('  ');
  const first = data.summary ? truncateAnsi(monitorText(data.summary).replace(/\s+/g, ' '), width - 2) : '';
  return [{ ...section(t('Progress'), width, milestone ? `${t('Milestone')} ${milestone}` : ''), item: PROGRESS },
    ...(first ? [row(`  ${theme.board.text(first)}`)] : []), row(`  ${barText({ counts }, cells)}`),
    row(pair(`  ${legend}`, theme.board.muted(`${done} ${t('accepted')}`), width))];
}

/**
 * Home's rows in the Inbox layout. `room` is what the panel has below its tab row; the layout gives way tier by tier until the
 * rows fit it (or all that may go has gone, and the panel scrolls). The question, the waiting count, a failure and every
 * running job are in every tier.
 */
export function inboxHomeRows(board: WorkboardSnapshot, state: MonitorState, width: number, now: number, input: MonitorData | undefined, room: number): MonitorRow[] {
  state.boardNewest = undefined;
  const data = input?.project, source = input?.workboard ?? board;
  const asking = board.workers.filter((w) => w.homeNeedsHuman)
    .sort((a, b) => Number(b.labels?.category === 'owner authorisation') - Number(a.labels?.category === 'owner authorisation'));
  const laneOf = (w: OwnerWorker) => board.lanes.find((l) => l.id === w.laneId);
  const mine = board.lanes.filter((l) => l.identity.kind !== 'native').flatMap((l) => l.workers.filter((w) => !w.homeNeedsHuman));
  const startedAt = (w: OwnerWorker) => w.startedAt ?? 0, settled = (w: OwnerWorker) => w.settledAt ?? 0;
  const jobs = mine.map((w) => ({ w, rank: rank(w, now, state.cardStallMinutes) })).sort((a, b) => a.rank - b.rank
    || (a.w.homeRank !== undefined && b.w.homeRank !== undefined ? b.w.homeRank - a.w.homeRank : 0)
    || (a.rank === 4 ? startedAt(a.w) - startedAt(b.w) : settled(b.w) - settled(a.w))).map((x) => x.w);
  const natives = board.lanes.filter((l) => l.identity.kind === 'native').flatMap((l) => l.workers.filter((w) => !w.homeNeedsHuman));
  const running = jobs.filter((w) => w.settledAt === null), longest = running[0]?.id ?? jobs[0]?.id;
  const waiting = data?.waiting ?? [], tries = waiting.filter((r) => /^try\b/i.test(r.value)).length;
  const busy = board.workers.some((w) => w.settledAt === null);
  const decisions = [...board.decisions].sort((a, b) => Number(b.departure) - Number(a.departure) || (callTime(b) ?? 0) - (callTime(a) ?? 0));
  const worth = decisions.filter((d) => d.departure).length, quiet = decisions.filter((d) => !d.departure);
  const hidden = input?.workboard ? input.workboard.workers.filter((w) => !currentWorker(w, now, state)).length
    + input.workboard.decisions.filter((d) => !currentDecision(d, now)).length : 0;
  const counts = (...parts: (string | false)[]) => parts.filter(Boolean).join(' · ');
  const build = (tier: Tier): MonitorRow[] => {
    const rows: MonitorRow[] = [], gap = () => { if (tier.gaps && rows.length) rows.push(boardRow('')); };
    const head = (label: string, right: string, extra: Partial<MonitorRow> = {}, on = tier.heads) => { if (on) rows.push({ ...section(label, width, right), ...extra }); };
    rows.push(...(tier.gaps ? [boardRow('')] : []));
    for (const w of asking) { rows.push(...slab(w, laneOf(w)?.label ?? '', state, width, now)); gap(); }
    if (waiting.length) {
      const text = counts(t('{n} waiting for you', { n: waiting.length }), tries > 0 && t('{n} to try', { n: tries }));
      if (busy) rows.push({ text: pair(`${theme.board.attention('?')} ${theme.board.attention(text)}`, theme.board.muted(mark('▸', '>')), width), item: 'home-progress:waiting' });
      else {
        head(t('Waiting for you'), counts(String(waiting.length), tries > 0 && t('{n} to try', { n: tries })), { item: 'home-progress:waiting' });
        waiting.slice(0, 6).forEach((r, i) => rows.push({ ...itemRow(theme.board.attention('?'), monitorText(r.value), '', width), item: `home-progress:wait:${i}` }));
        if (waiting.length > 6) rows.push({ text: fit('  ' + theme.board.muted(t('+{n} more', { n: waiting.length - 6 })), width), item: 'home-progress:waiting' });
      }
      gap();
    }
    if (jobs.length) {
      const bad = jobs.filter((w) => failed(projectWorkCard(w, now, state.cardStallMinutes))).length;
      head(t('Jobs'), counts(running.length > 0 && t('{n} running', { n: running.length }), bad > 0 && t('{n} failed', { n: bad }), !running.length && !bad && t('nothing running')));
      for (const w of jobs) rows.push(...jobRows(w, laneOf(w)?.label ?? '', state, width, now, tier, w.id === longest));
      gap();
    }
    if (natives.length) {
      const live = natives.filter((w) => w.settledAt === null).length;
      head(t('this session'), counts(live > 0 && t('{n} running', { n: live }), natives.length - live > 0 && t('{n} done', { n: natives.length - live })), {}, tier.native);
      for (const w of natives) rows.push(...jobRows(w, '', state, width, now, tier, false, w.nativeDepth === 2 || w.parentJobId ? '  ' : ''));
      gap();
    }
    if (decisions.length) {
      const open = state.boardExpanded?.has('fold:decisions') === true, summary = counts(t('{n} as proposed', { n: quiet.length }));
      const list = (open ? decisions : decisions.filter((d) => d.departure)).flatMap((d) => {
        const lane = source.lanes.find((l) => l.id === d.laneId);
        return lane ? decisionRows(d, lane, state, width, now) : [];
      });
      if (!tier.block && !open)
        rows.push({ text: pair(`${theme.board.attention(mark('◆', '*'))} ${theme.board.attention(counts(t('{n} decided for you', { n: decisions.length }), worth > 0 && `${worth} ${t('worth a look')}`))}`, theme.board.muted(mark('▸', '>')), width), item: 'fold:decisions' });
      else {
        head(t('Decided for you'), counts(String(decisions.length), worth > 0 && `${worth} ${t('worth a look')}`));
        rows.push(...list);
        if (quiet.length) rows.push({ text: fit(`  ${theme.board.muted(`${mark(open ? '▾' : '▸', open ? 'v' : '>')} ${summary}`)}`, width), item: 'fold:decisions' });
      }
      gap();
    }
    if (hidden) { rows.push(boardRow(theme.board.muted(t(state.tree.showAll ? '{n} older shown · a hide' : '+{n} older · a', { n: hidden })))); gap(); }
    if (!busy && tier.latest && data) {
      const landed = landedNewest(data).slice(0, width < 56 ? 3 : 5);
      if (landed.length) {
        head(t('Latest'), t('newest first'), { item: 'home-progress:latest' });
        rows.push(...landed.map(({ r }): MonitorRow => ({ text: inline(`  ${landedMark(r)} ${monitorText(r.id)}`, ledgerText(r), landedAge(r, now), width), item: 'home-progress:latest' })));
        gap();
      }
    }
    rows.push(...progressRows(data, width, tier));
    while (rows.length && !rows.at(-1)!.text.trim() && !rows.at(-1)!.item) rows.pop();
    return rows;
  };
  const rows = build(TIERS.find((tier) => build(tier).length <= room) ?? TIERS.at(-1)!);
  // With no job selected (or the selected one gone) the cursor starts on the top of the list, not on the first package's job.
  const top = asking[0] ?? jobs[0] ?? natives[0];
  if (top && !(state.homeTarget && rows.some((r) => r.item === targetKey(state.homeTarget!))))
    state.homeTarget = { kind: 'worker', laneId: top.laneId, workerId: top.id };
  return rows;
}
