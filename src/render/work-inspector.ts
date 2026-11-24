/** Job details, local facts and openable workflow files. No I/O. */
import { OUTPUT_ROWS } from '../collectors/headless-output.js';
import type { OwnerWorker } from '../collectors/workboard-types.js';
import { projectWorkJob } from '../collectors/work-job.js';
import type { SubagentTree } from '../types.js';
import type { MonitorRow } from './monitor.js';
import { flowSummary, jobDetailRows, requestLines, stemLines, workPhaseText, quietDecisionSummary } from './work-job-detail.js';
import { failed, renderJobRow } from './work-job-row.js';
import { jobRows } from './work-jobs.js';
import {
  ageText,
  kvRows,
  section,
  itemRow,
  mark,
  minuteAge,
  boardRow,
  asciiBoard,
} from './workboard-rows.js';
import { theme, visualLength } from './colors.js';
import { monitorText, fit, squeeze } from './monitor-text.js';
import { providerMark } from './providers.js';
import { t } from './i18n.js';
import { diffStatRows } from './diff-stat-rows.js';
import { formatTokenCount } from './lines/activity-line.js';
import { answerable, answerKeys } from './job-actions.js';
export function localTime(at: number | null, now: number): string {
  if (at === null) return '';
  const date = new Date(at),
    today = new Date(now);
  return (
    (date.toDateString() === today.toDateString()
      ? ''
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ') + date.toTimeString().slice(0, 5)
  );
}
function facts(entries: [string, string][], width: number): MonitorRow[] {
  const parts = entries
    .filter(([, value]) => value)
    .map(([label, value]) => kvRows(label, value, width >= 80 ? Math.floor(width / 2) - 1 : width));
  if (width < 80) return parts.flat();
  const rows: MonitorRow[] = [],
    half = Math.floor(width / 2);
  for (let i = 0; i < parts.length; i += 2)
    for (let j = 0; j < Math.max(parts[i].length, parts[i + 1]?.length ?? 0); j++)
      rows.push(boardRow(fit(parts[i][j]?.text ?? '', half) + fit(parts[i + 1]?.[j]?.text ?? '', width - half)));
  return rows;
}
/** A headless job has no tab to look at: show its newest output, one row per line. */
function outputRows(worker: OwnerWorker, width: number): MonitorRow[] {
  const { output } = worker;
  if (!output) return [];
  const rows = [boardRow(''), section(t('Output'), width, worker.settledAt === null ? t('live') : '')];
  if (!output.lines.length) return [...rows, itemRow('', theme.board.muted(t(output.bytes === 0 ? 'No output yet' : 'Nothing displayable')), '', width)];
  for (const { kind, text } of output.lines.slice(-OUTPUT_ROWS)) {
    const [glyph, ink] = kind === 'tool' ? [mark('▸', '>'), theme.board.muted] : kind === 'error' ? [mark('✗', 'x'), theme.board.danger] : [' ', theme.board.body];
    rows.push(itemRow(ink(glyph), ink(monitorText(text)), '', width));
  }
  return rows;
}
export function workInspectorRows(
  worker: OwnerWorker,
  width: number,
  now: number,
  children: readonly OwnerWorker[] = [],
): MonitorRow[] {
  const job = projectWorkJob(worker, now);
  const rows = [boardRow(theme.board.title(renderJobRow(job, width)))];
  if (worker.homeNeedsHuman) {
    rows.push(section(t('Question for main'), width));
    const question = requestLines(job, true, answerable(worker) !== undefined);
    for (const line of question.length ? question : [worker.ask ?? job.reason ?? ''])
      rows.push(...stemLines(line, width, theme.board.attention).map((text) => boardRow(text)));
    const keys = answerKeys(worker);
    if (keys.length) rows.push(...stemLines(keys.join('  '), width, theme.board.muted, 1).map((text) => boardRow(text)));
  }
  const summary = worker.reportMeta?.summary, report = worker.report;
  rows.push(...jobDetailRows(job, width, !worker.homeNeedsHuman && !summary && (!report || failed(job))).map((text) => boardRow(text)));
  if (summary || report) {
    rows.push(section(t('Report'), width));
    if (summary) rows.push(...stemLines(summary, width).map((text) => boardRow(text)));
    if (report) {
      if (summary) rows.push(boardRow(''));
      for (const line of report.text.trimEnd().split(/\r?\n/))
        rows.push(...stemLines(line, width).map((text) => boardRow(text)));
      if (report.truncated) rows.push(boardRow(fit(theme.board.muted(t('Truncated: {files}', { files: 'report.md' })), width)));
    }
  }
  const progress = worker.progress?.length ? worker.progress : worker.latest_progress ? [worker.latest_progress] : [];
  if (progress.length) {
    rows.push(boardRow(''), section(t('Progress'), width));
    for (const entry of progress) rows.push(...stemLines(`${entry.at} · ${entry.text}`, width).map((text) => boardRow(text)));
  }
  if (children.length) rows.push(boardRow(''), section(t('Sonic children'), width), ...jobRows(children, width));
  rows.push(...outputRows(worker, width));
  const stamp = (at: number | null) =>
    at === null ? '' : `${localTime(at, now)} · ${t('{age} ago', { age: minuteAge(at, now) })}`;
  const end = worker.settledAt ?? (worker.state === 'working' ? now : null);
  const ran = worker.startedAt !== null && end !== null && end >= worker.startedAt
    ? ageText(Math.floor((end - worker.startedAt) / 60000), true) : '';
  const model = worker.model?.replace(/^.*\//, '') ?? '',
    glyph = !asciiBoard() ? providerMark({ id: model, provider: worker.provider })?.glyph : '';
  rows.push(
    boardRow(''),
    ...facts(
      [
        ['role', [worker.role, worker.overflowFrom ? t('from {role}', { role: worker.overflowFrom }) : '', worker.harness].filter(Boolean).join(' · ')],
        ['model', [model ? `${glyph ? glyph + ' ' : ''}${model}` : '', worker.effort].filter(Boolean).join(' · ')],
        [
          worker.nativeDepth !== undefined ? 'parent' : 'package',
          worker.nativeDepth !== undefined
            ? (worker.parentName ?? t('this session'))
            : worker.laneId.replace(/^thin-job:package:/, ''),
        ],
        ['state', [t(worker.state), worker.queuePosition !== undefined ? `#${worker.queuePosition}` : '', worker.phase && worker.phase !== worker.state ? workPhaseText(worker.phase) : ''].filter(Boolean).join(' · ')],
        ['flow', worker.flow ? flowSummary(worker.flow) : ''],
        [
          'resources',
          [
            worker.resources?.context === undefined ? '' : `${worker.resources.context}%`,
            worker.resources?.rate ? `~${Math.round(worker.resources.rate.tokensPerSecond)} tok/s` : '',
            worker.resources?.spent
              ? `${formatTokenCount(worker.resources.spent.input + worker.resources.spent.output)} ${t('tokens spent')}`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ],
        // A settled job's old decision is history, unless it is why the job failed.
        ['quiet', worker.settledAt === null || (failed(job) && worker.quietDecision?.action === 'fail') ? quietDecisionSummary(worker.quietDecision) : ''],
        ['started', stamp(worker.startedAt)],
        [
          worker.homeNeedsHuman ? 'asked' : worker.settledAt !== null ? 'ended' : 'activity',
          stamp(worker.homeNeedsHuman ? worker.humanEndedAt : (worker.settledAt ?? worker.work?.activityAt ?? null)),
        ],
        ['ran', ran],
      ],
      width
    )
  );
  const changes = diffStatRows(worker.diffStat, width);
  if (changes.length) rows.push(boardRow(''), section(t('Changes'), width), ...changes);
  const reported = worker.reportMeta?.files;
  if (!changes.length && reported?.length) {
    const shown = reported.slice(0, 12);
    rows.push(boardRow(''), section(t('Reported files'), width, String(reported.length)));
    for (const file of shown) rows.push(itemRow('', theme.board.identifier(monitorText(file)), '', width));
    if (reported.length > shown.length)
      rows.push(itemRow('', t('+{n} more files', { n: reported.length - shown.length }), '', width));
  }
  const files = worker.files ?? [];
  if (files.length) rows.push(boardRow(''), section(t('Files'), width, String(files.length)));
  for (const file of files) {
    const decision = file.qid ? file.state : undefined;
    const glyph =
      decision === 'open'
        ? '?'
        : decision
          ? mark(decision === 'departure' ? '◆' : '◇', decision === 'departure' ? '*' : 'o')
          : '';
    const ink = decision === 'open' || decision === 'departure' ? theme.board.attention : theme.board.muted;
    const row = itemRow(
      ink(glyph),
      monitorText(file.qid ? `${file.qid}  ${file.title ?? ''}` : file.rel) +
        (file.verdict
          ? '  ' + (file.verdict === 'accept' ? theme.board.success : theme.board.attention)(monitorText(file.verdict))
          : ''),
      file.state === 'open' && worker.homeNeedsHuman
        ? `${t('asking')} ${minuteAge(file.at, now)}`
        : localTime(file.at, now),
      width
    );
    rows.push({ ...row, item: 'file:' + file.paths[0], files: file.paths });
  }
  return rows;
}

/** This is the panel's calling native session, not a second list of HUD jobs. */
export function nativeInspectorRows(tree: SubagentTree | undefined, width: number): MonitorRow[] {
  if (!tree) return [boardRow(fit(t('Loading…'), width))];
  const rows = [section(t('This session'), width)];
  if (tree.incomplete) rows.push(boardRow(fit(theme.board.attention(t('Partial')), width)));
  if (!tree.nodes.length) rows.push(boardRow(fit(t(tree.rootId && !tree.incomplete ? 'No subagents observed' : 'Native tree unavailable'), width)));
  const add = (nodes: SubagentTree['nodes'], depth: number) => {
    for (const node of nodes) {
      const lead = ' '.repeat(Math.min(2 * depth, Math.floor(width / 4)));
      const label = monitorText(node.label || node.name);
      const status = t(node.status);
      const extra = monitorText([node.model, node.effort].filter(Boolean).join(' · '));
      const context = node.contextUsage ? `${node.contextUsage.percent}%` : '';
      const rate = node.outputRate ? `~${Math.round(node.outputRate.tokensPerSecond)} tok/s` : '';
      const spent = node.tokensSpent
        ? `${formatTokenCount(node.tokensSpent.input + node.tokensSpent.output)} ${t('tokens spent')}` : '';
      const facts = [extra, context, rate, spent].filter(Boolean);
      let detail = [status, ...facts].join(' · ');
      while (facts.length && visualLength(lead + label + detail) + 2 > width) {
        facts.pop();
        detail = [status, ...facts].join(' · ');
      }
      const row = itemRow(' ' + lead, label, detail, width);
      rows.push(node.rolloutPath ? { ...row, item: `native:${node.id}`, files: [node.rolloutPath] } : row);
      // Claude's bounded tail replay exposes one observed step, never a generated summary.
      if (node.transcriptStep) {
        const indent = lead + '    ';
        rows.push(boardRow(fit(indent + theme.board.muted(squeeze(monitorText(node.transcriptStep), width - indent.length)), width)));
      }
      add(node.children, depth + 1);
    }
  };
  add(tree.nodes, 0);
  return rows;
}
