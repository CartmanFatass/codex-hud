/** Cached workflow facts rendered as vertical waves or compact fixed-flow chains. */
import type { ExecutionRun, ExecutionRunJobTarget, LandProgress, WorkflowNode } from '../collectors/execution-runs.js';
import { theme, visualLength } from './colors.js';
import { runElapsed, runStateView, stepStateView, ticketStageView } from './execution-run-detail.js';
import { t } from './i18n.js';
import { roleIcon } from './model-glyphs.js';
import type { MonitorRow } from './monitor.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { stemLines } from './work-job-detail.js';
import { boardRow, compactAge, mark, stateMark } from './workboard-rows.js';

const muted = (text: string) => theme.board.muted(text);
const arrow = () => muted(mark(' ─▶ ', ' -> '));
const down = () => muted(mark('▼', 'v'));
const cursorMark = (on: boolean) => on ? `${theme.board.active(mark('▸', '>'))} ` : '  ';
export const runItem = (flow: string) => `project:exec-run:${flow}`;

export function workflowLabel(run: ExecutionRun): string {
  const word = { queue: 'Queue', batch: 'Batch', council: 'Council', prewalk: 'Scouting', land: 'Land', graph: 'Graph' }[run.kind];
  return `${t(word)} ${monitorText(run.label)}`;
}

function landFact(progress: LandProgress, now: number): string {
  if (progress.kind === 'lease') return [mark('◷', '~'), t('Lease wait'), compactAge(progress.since, now)].filter(Boolean).join(' ');
  const index = progress.index === undefined ? '' : ` ${progress.index}${progress.total === undefined ? '' : `/${progress.total}`}`;
  return progress.kind === 'repair' ? `${mark('↻', '~')} ${t('Repair')}${index}` : `${t('Gate')}${index}`;
}

function claim(run: ExecutionRun, key: string, job: string | undefined, target: ExecutionRunJobTarget | undefined, seen: Set<string>): Pick<MonitorRow, 'item' | 'execJob'> {
  if (!job || seen.has(job)) return {};
  seen.add(job);
  return target ? { item: `${runItem(run.flow)}:${key}`, execJob: target } : {};
}

function blockedRows<T>(waves: readonly (readonly T[])[], format: (node: T) => string, width: number): MonitorRow[] {
  const prefix = `    ${down()} `, rows: MonitorRow[] = [];
  let line = '';
  for (const wave of waves) {
    let part = '';
    for (const node of wave) {
      const atom = format(node), candidate = part ? `${part}${muted(' · ')}${atom}` : atom;
      if (part && visualLength(prefix + candidate) > width) {
        if (line) { rows.push(boardRow(fit(prefix + line, width))); line = ''; }
        rows.push(boardRow(fit(prefix + part, width)));
        part = atom;
      } else part = candidate;
    }
    const candidate = line ? line + arrow() + part : part;
    if (line && visualLength(prefix + candidate) > width) {
      rows.push(boardRow(fit(prefix + line, width)));
      line = part;
    } else line = candidate;
  }
  if (line) rows.push(boardRow(fit(prefix + line, width)));
  return rows;
}

const future = (key: string, blockers?: readonly string[]) => {
  const refs = blockers?.length ? `(${mark('←', '<-')}${monitorText(blockers.join(','))})` : '';
  return muted(`${stateMark.queued()} ${monitorText(key)}${refs}`);
};

const ticketKey = (key: string) => key.split('/').at(-1)!;

function collapsed(word: string, keys: readonly string[], width: number): MonitorRow[] {
  if (!keys.length) return [];
  const lead = `    ${theme.board.success(stateMark.done())} ${t(word)} ${keys.length}: `;
  const list = keys.map((key) => monitorText(key));
  // Keep the count and as many whole IDs as fit, even for a very long settled prefix.
  let line = lead;
  for (const [i, id] of list.entries()) {
    const next = line + (i ? ', ' : '') + id;
    if (visualLength(next) + (i < list.length - 1 ? 2 : 0) > width) { line += mark(' …', ' +'); break; }
    line = next;
  }
  return [boardRow(fit(line, width))];
}

function nodeText(node: WorkflowNode, now: number): string {
  const state = stepStateView(node.state);
  const icon = node.role ? `${roleIcon(node.role)} ` : '';
  const label = node.label !== undefined ? monitorText(node.label) : '';
  const word = node.progress ? landFact(node.progress, now) : node.word ? t(node.word) : '';
  const repair = node.word === 'Repair';
  const shown = !word || !label ? word || label || monitorText(node.key)
    : node.word === 'Pool' || node.word === 'Pilot' ? `${word} ${label}`
      : node.word === 'Scout' ? t('{kind} prewalk scout', { kind: label }) : `${word}(${repair ? icon : ''}${label})`;
  return `${state.ink(state.glyph)} ${repair ? '' : icon}${shown}`;
}

/** A fixed chain stays compact where possible. If two live nodes have Inspectors,
 * put them on separate rows: a terminal row has only one Enter target. */
function chainRows(run: ExecutionRun, waves: readonly (readonly WorkflowNode[])[], first: string, selected: string | undefined,
  seen: Set<string>, width: number, now: number, facts = ''): MonitorRow[] {
  const rows: MonitorRow[] = [];
  let line = '', at: Pick<MonitorRow, 'item' | 'execJob'> = {};
  const flush = () => {
    if (!line) return;
    rows.push({ ...at, text: fit(`${cursorMark(selected !== undefined && selected === at.item)}  ${line}`, width) });
    line = ''; at = {};
  };
  for (const [i, group] of waves.filter((g) => g.length).entries()) for (const [j, node] of group.entries()) {
    const clickable = node.state === 'running' || node.state === 'asking' || node.state === 'waiting';
    const target = clickable && node.execJob ? claim(run, node.key, node.jobId, node.execJob, seen) : {};
    const chunk = nodeText(node, now);
    const start = first ? `${first} ` : '';
    const sep = j ? muted(' · ') : i ? arrow() : start;
    const candidate = line + sep + chunk;
    if (line && ((at.item && target.item) || visualLength(candidate) + 4 > width)) flush();
    line = line ? candidate : (j || !i ? start : `${muted(mark('▶', '>'))} `) + chunk;
    if (target.item) at = target;
  }
  if (facts) {
    if (line && visualLength(line + facts) + 6 > width) flush();
    if (line) line = pair(line, facts, width - 4);
    else line = facts;
  }
  flush();
  return rows;
}

function queueRows(run: ExecutionRun, selected: string | undefined, seen: Set<string>, width: number, now: number): MonitorRow[] {
  const { prefix, current, blocked } = run.queueWaves!;
  const own = new Set(run.tickets.map((ticket) => ticket.ticket));
  const label = (ref: string) => !run.unattended && own.has(ref) ? ticketKey(ref) : ref;
  const rows = collapsed('landed', prefix.map((ticket) => label(ticket.ticket)), width);
  current.forEach((ticket, i) => {
    const duplicate = !!ticket.jobId && seen.has(ticket.jobId);
    const at = claim(run, `ticket:${ticket.ticket}`, ticket.jobId, ticket.execJob, seen);
    const stage = ticketStageView(ticket);
    const joint = muted(i === current.length - 1 ? mark('└─', '`-') : mark('├─', '|-'));
    const key = monitorText(label(ticket.ticket));
    const left = `${cursorMark(selected !== undefined && selected === at.item)}  ${joint} ${stage.ink(stage.glyph)} ${key}`;
    const role = !duplicate && ticket.stage === 'worker' && ticket.role ? roleIcon(ticket.role) : '';
    const fact = ticket.landProgress ? landFact(ticket.landProgress, now) : stage.shortText;
    const age = !duplicate && ['worker', 'land-gate'].includes(ticket.stage) && ticket.landProgress?.kind !== 'lease' ? compactAge(ticket.since, now) : '';
    const right = [[role, fact, age], [fact, age], [fact]].map((parts) => parts.filter(Boolean).join(' '))
      .find((part) => visualLength(left + part) + 2 <= width) ?? '';
    rows.push({ ...at, text: fit(pair([left, ticket.title && !duplicate ? theme.board.text(monitorText(ticket.title)) : ''].filter(Boolean).join(' '), stage.ink(right), width), width) });
  });
  rows.push(...blockedRows(blocked, (ticket) => future(label(ticket.ticket), ticket.blockers?.map(label)), width));
  const counts = [t('todo {n}', { n: run.todo.length }), t('held {n}', { n: run.heldCount }),
    ...(run.repairRounds ? [t('repairs {n}', { n: run.repairRounds })] : [])].join(' · ');
  const review = run.steps.find((step) => step.key === 'review'), accept = run.steps.find((step) => step.key === 'accept');
  rows.push(...chainRows(run, [[{ ...run.reviewer, key: 'review', word: 'review', role: 'reviewer', state: run.reviewer?.state ?? review?.state ?? 'waiting' }],
    [{ ...run.lead, key: 'accept', word: 'Acceptance', role: 'lead', label: run.lead ? 'lead' : run.acceptanceSeat ?? 'lead', state: run.lead?.state ?? accept?.state ?? 'waiting' }]],
  down(), selected, seen, width, now, muted(counts)));
  return rows;
}

function batchRows(run: ExecutionRun, width: number, now: number): MonitorRow[] {
  const batch = run.batch!;
  const { done, failed, running, waiting, cancelled } = batch.totals;
  const counters = `${done}${stateMark.done()} · ${running}${mark('◉', '@')} · ${waiting}${stateMark.queued()} · ${failed}${stateMark.failed()}`
    + (cancelled ? ` · ${cancelled}${stateMark.stopped()}` : '');
  const pilots = batch.pilots;
  const nodes: WorkflowNode[][] = [
    ...(pilots && pilots.total > 0 ? [[{ key: 'pilot', word: 'Pilot', label: `${pilots.done}/${pilots.total}`,
      state: pilots.state }]] : []),
    [{ key: 'pool', word: 'Pool', label: counters, state: running ? 'running' : waiting ? 'waiting' : 'done' }],
    [{ key: 'summary', word: 'summary', state: run.endedAt === undefined ? 'waiting' : 'done' }],
  ];
  return chainRows(run, nodes, '', undefined, new Set(), width, now);
}

function graphRows(run: ExecutionRun, selected: string | undefined, seen: Set<string>, width: number, now: number): MonitorRow[] {
  const waves = run.nodes ?? [], settled = (node: WorkflowNode) => node.state === 'done' || node.state === 'skipped';
  const firstOpen = waves.findIndex((wave) => !wave.every(settled));
  const prefix = (firstOpen < 0 ? waves : waves.slice(0, firstOpen)).flat().filter((node) => node.state === 'done');
  const rows = collapsed('done', prefix.map((node) => node.key), width);
  const done = new Set(waves.flat().filter(settled).map((node) => node.key));
  const current: WorkflowNode[] = [], blocked: WorkflowNode[][] = [];
  for (const wave of firstOpen < 0 ? [] : waves.slice(firstOpen)) {
    const futureNodes: WorkflowNode[] = [];
    for (const node of wave) (node.state === 'waiting' && node.blockers?.some((id) => !done.has(id)) ? futureNodes : current).push(node);
    if (futureNodes.length) blocked.push(futureNodes);
  }
  current.forEach((node, i) => {
    const duplicate = !!node.jobId && seen.has(node.jobId);
    const at = claim(run, node.key, node.jobId, node.execJob, seen);
    const joint = i === current.length - 1 ? mark('└─', '`-') : mark('├─', '|-');
    const left = `${cursorMark(selected !== undefined && selected === at.item)}  ${muted(joint)} ${nodeText(duplicate ? { ...node, role: undefined } : node, now)}`;
    const right = !duplicate && (node.state === 'running' || node.state === 'asking')
      ? [t(node.state === 'asking' ? 'asking' : 'working'), compactAge(node.since, now)].filter(Boolean).join(' ') : '';
    rows.push({ ...at, text: fit(pair(left, muted(right), width), width) });
  });
  rows.push(...blockedRows(blocked, (node) => future(node.key, node.blockers), width));
  return rows;
}

export function workflowRows(run: ExecutionRun, selected: string | undefined, seen: Set<string>, width: number, now: number): MonitorRow[] {
  const item = runItem(run.flow), state = runStateView(run.state);
  const label = workflowLabel(run), id = muted(monitorText(run.flow.slice(0, 8)));
  const head = `${cursorMark(selected === item)}${state.ink(state.glyph)} `;
  const batch = run.batch;
  const status = batch?.slots !== undefined && batch.state === 'working'
    ? t('slots {n}/{total}', { n: batch.totals.running, total: batch.slots })
    : t(run.kind === 'land' && run.nodes?.some((wave) => wave.some((node) => node.progress?.kind === 'lease'))
      ? 'waiting' : run.state === 'working' ? 'running' : run.state);
  const right = [status, runElapsed(run, now)].filter(Boolean).join(' · ');
  const titleRoom = Math.max(0, width - visualLength(head + id + right) - 4);
  const title = `${head}${theme.board.text(fit(label, Math.min(titleRoom, visualLength(label))).trimEnd())}  ${id}`;
  const header = { item, execRun: run.flow, ...(batch && { batch }), text: fit(pair(title, muted(right), width), width) };
  const body = run.kind === 'queue' ? queueRows(run, selected, seen, width, now) : run.kind === 'batch' ? batchRows(run, width, now)
    : run.kind === 'graph' ? graphRows(run, selected, seen, width, now)
      : chainRows(run, run.nodes ?? [], run.kind === 'council' || run.kind === 'prewalk' ? muted(mark('├─', '|-')) : '', selected, seen, width, now);
  return [header, ...body];
}

export function workflowDetailRows(run: ExecutionRun, width: number, now: number): MonitorRow[] {
  return run.kind === 'batch' ? batchRows(run, width, now) : (run.nodes ?? []).flat().flatMap((node) => [
    boardRow(fit(pair(`  ${nodeText(node, now)}`, muted(node.jobId?.slice(0, 8) ?? ''), width), width)),
    ...(node.reason ? stemLines(node.reason, width).map((line) => boardRow(line)) : []),
  ]);
}
