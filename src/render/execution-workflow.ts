/** Cached workflow facts rendered as Hairline metro maps on Execution, and compact step lists in Run Detail. */
import type { ExecutionRun, LandProgress, WorkflowNode } from '../collectors/execution-runs.js';
import { theme, visualLength } from './colors.js';
import { stepStateView } from './execution-run-detail.js';
import { metroFlowFromRun, renderMetroFlow, renderMetroLegend, runItem, type MetroFlow } from './execution-metro.js';
import { t } from './i18n.js';
import { roleIcon } from './model-glyphs.js';
import type { MonitorRow } from './monitor.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { stemLines } from './work-job-detail.js';
import { boardRow, compactAge, mark, stateMark } from './workboard-rows.js';

export { runItem };
const muted = (text: string) => theme.board.muted(text);

export function workflowLabel(run: ExecutionRun): string {
  const word = { queue: 'Queue', batch: 'Batch', council: 'Council', prewalk: 'Scouting', land: 'Land', graph: 'Graph' }[run.kind];
  return `${t(word)} ${monitorText(run.label)}`;
}

/** Render one open workflow as a Hairline metro map (header + 1–3 lane rows + detail line). */
export function workflowRows(run: ExecutionRun, selected: string | undefined, seen: Set<string>, width: number, now: number): MonitorRow[] {
  return renderMetroFlow(metroFlowFromRun(run, seen), selected, width, now);
}

/** Render all open workflows under Workflow, stacked directly with the contextual 0–2 row legend once below. */
export function workflowSectionRows(runs: readonly ExecutionRun[], selected: string | undefined, seen: Set<string>, width: number, now: number): MonitorRow[] {
  const flows: MetroFlow[] = runs.map((run) => metroFlowFromRun(run, seen));
  const rows = flows.flatMap((flow) => renderMetroFlow(flow, selected, width, now));
  return [...rows, ...renderMetroLegend(flows, width)];
}

/* ───────────────────────── Run Detail step summary (non-queue flows) ───────────────────────── */

function landFact(progress: LandProgress, now: number): string {
  if (progress.kind === 'lease') return [mark('◷', '~'), t('Lease wait'), compactAge(progress.since, now)].filter(Boolean).join(' ');
  const index = progress.index === undefined ? '' : ` ${progress.index}${progress.total === undefined ? '' : `/${progress.total}`}`;
  return progress.kind === 'repair' ? `${mark('↻', '~')} ${t('Repair')}${index}` : `${t('Gate')}${index}`;
}

function detailNodeText(node: WorkflowNode, now: number): string {
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

function batchDetailRows(run: ExecutionRun, width: number): MonitorRow[] {
  const batch = run.batch!;
  const { done, failed, running, waiting, cancelled } = batch.totals;
  const counters = `${done}${stateMark.done()} · ${running}${mark('◉', '@')} · ${waiting}${stateMark.queued()} · ${failed}${stateMark.failed()}`
    + (cancelled ? ` · ${cancelled}${stateMark.stopped()}` : '');
  const arrow = muted(mark(' ─▶ ', ' -> '));
  const parts: string[] = [];
  if (batch.pilots && batch.pilots.total > 0) {
    const p = stepStateView(batch.pilots.state);
    parts.push(`${p.ink(p.glyph)} ${t('Pilot')} ${batch.pilots.done}/${batch.pilots.total}`);
  }
  const poolState = stepStateView(running ? 'running' : waiting ? 'waiting' : 'done');
  parts.push(`${poolState.ink(poolState.glyph)} ${t('Pool')} ${counters}`);
  const sumState = stepStateView(run.endedAt === undefined ? 'waiting' : 'done');
  parts.push(`${sumState.ink(sumState.glyph)} ${t('summary')}`);
  const rows: MonitorRow[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? `${line}${arrow}${part}` : part;
    if (line && visualLength(candidate) + 2 > width) {
      rows.push(boardRow(fit(`  ${line}`, width)));
      line = part;
    } else line = candidate;
  }
  if (line) rows.push(boardRow(fit(`  ${line}`, width)));
  return rows;
}

export function workflowDetailRows(run: ExecutionRun, width: number, now: number): MonitorRow[] {
  return run.kind === 'batch' ? batchDetailRows(run, width) : (run.nodes ?? []).flat().flatMap((node) => [
    boardRow(fit(pair(`  ${detailNodeText(node, now)}`, muted(node.jobId?.slice(0, 8) ?? ''), width), width)),
    ...(node.reason ? stemLines(node.reason, width).map((line) => boardRow(line)) : []),
  ]);
}
