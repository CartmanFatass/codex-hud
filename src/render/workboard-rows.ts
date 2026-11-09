/** Shared Home/Work rows: evidence-derived text, exact cells, no I/O. */
import type { DecisionRecord, OwnerWorker, WorkLane, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { callTime, isLocalDay } from '../collectors/workboard.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { displayConfig } from './hud-config.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import type { WorkRole } from './palette.js';
export const asciiBoard = () => displayConfig().icons === 'text';
export const mark = (unicode: string, ascii: string) => (asciiBoard() ? ascii : unicode);
export function minuteAge(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return t(minutes < 1 ? '<1m' : '{n}m', { n: minutes });
}
export function roleWord(role: string | null): string {
  if (!role) return '';
  const safe = monitorText(role);
  const key = role.toLowerCase() as WorkRole;
  return Object.hasOwn(theme.board.roleInk, key) ? theme.board.roleInk[key](safe) : theme.value(safe);
}
export function boardRow(text: string, target?: WorkTarget): MonitorRow {
  const key = target ? targetKey(target) : undefined;
  return { text, ...(key ? { item: key, key } : {}) };
}
export function section(text: string, width: number, heavy = false): MonitorRow {
  const rule = mark(heavy ? '━' : '─', heavy ? '=' : '-');
  return {
    text: `${heavy ? theme.board.attention(text) : theme.board.muted(text)} ${theme.board.frame(rule.repeat(Math.max(0, width - visualLength(text) - 1)))}`,
  };
}
export const callCount = (n: number) => t(n === 1 ? '{n} call' : '{n} calls', { n });
/** An ordinal phase axis, never a percent complete or an inferred phase. */
export function phaseBar(phase: string | null): string {
  const index =
    phase === 'design'
      ? 1
      : phase === 'build'
        ? 3
        : phase && /^review(?: r[1-9][0-9]*)?$/.test(phase)
          ? 5
          : phase === 'awaiting-acceptance' || phase === 'accept'
            ? 6
            : null;
  if (index === null) return '';
  return (
    theme.board.muted(mark('━', '=').repeat(index)) +
    theme.board.active(mark('▸', '>')) +
    theme.board.frame(mark('─', '-').repeat(9 - index))
  );
}
export function laneRow(lane: WorkLane, width: number, now: number, withBar = false): MonitorRow {
  const calls = lane.decisions.filter((d) => isLocalDay(callTime(d), now));
  const count = calls.length ? callCount(calls.length) : '';
  const ink = calls.some((d) => d.oneWay) ? theme.board.danger : theme.board.muted;
  const phase = lane.phase
    ? t(withBar && lane.phase === 'awaiting-acceptance' ? 'await accept' : lane.phase)
    : t('phase unknown');
  const label = width >= 100 ? `${monitorText(lane.label)}  ${monitorText(lane.title)}` : monitorText(lane.label);
  const bar = withBar ? phaseBar(lane.phase) : '';
  const identity = withBar && bar ? fit(theme.bold(label), 8) : theme.bold(label);
  return boardRow(
    pair(`${mark('│', '|')} ${identity} ${bar ? bar + ' ' : ''}${theme.board.muted(phase)}`, ink(count), width),
    {
      kind: 'lane',
      laneId: lane.id,
    }
  );
}
export function workerGlyph(worker: OwnerWorker): string {
  if (
    worker.homeNeedsHuman ||
    worker.state === 'waiting_orchestrator' ||
    worker.state === 'failed' ||
    worker.state === 'error'
  )
    return '?';
  if (worker.stale || worker.state === 'unknown') return mark('◷', '~');
  if (['closed', 'idle_grace', 'completed', 'done', 'awaiting-acceptance'].includes(worker.state))
    return mark('✓', '+');
  return mark('▸', '>');
}
const workerAge = (worker: OwnerWorker, now: number) =>
  minuteAge(worker.homeNeedsHuman ? worker.humanEndedAt : (worker.settledAt ?? worker.startedAt), now);
const modelEffort = (worker: OwnerWorker) =>
  [monitorText(worker.model ?? ''), monitorText(worker.effort ?? '')].filter(Boolean).join(mark('·', '.'));
export function workerColumns(workers: readonly OwnerWorker[], width: number, now: number) {
  let harness = 6;
  const role = Math.max(8, ...workers.map((w) => visualLength(monitorText(w.role ?? '')))),
    age = Math.max(4, ...workers.map((w) => visualLength(workerAge(w, now)))),
    fullModel = Math.max(0, ...workers.map((w) => visualLength(modelEffort(w))));
  const fixed = () => 2 + harness + 1 + role + 1 + 1 + 1 + age;
  if (fixed() + fullModel > width) harness = 3;
  const model = Math.min(fullModel, Math.max(0, width - fixed()));
  return { harness, role, age, model, task: Math.max(0, width - fixed() - model) };
}
export function workerRow(
  worker: OwnerWorker,
  width: number,
  now: number,
  columns = workerColumns([worker], width, now)
): MonitorRow {
  // Shared columns: drop task first, then shorten harness, then model; retain role/effort and right-hand age.
  const harness = monitorText(worker.harness ?? ''),
    short = harness === 'codex' ? 'cdx' : harness === 'claude' ? 'cc' : harness;
  const effort = monitorText(worker.effort ?? ''),
    suffix = effort ? mark('·', '.') + effort : '';
  let model = monitorText(worker.model ?? '');
  if (visualLength(model + suffix) > columns.model)
    model = truncateAnsi(
      model.replace(/^(?:openai|anthropic)\//, '').replace('gpt-6.1-sol', '6.1-sol'),
      Math.max(0, columns.model - visualLength(suffix))
    );
  const glyph = worker.homeNeedsHuman
    ? theme.board.attention(workerGlyph(worker))
    : worker.stale
      ? theme.board.muted(workerGlyph(worker))
      : theme.board.active(workerGlyph(worker));
  const left = `${glyph} ${fit(columns.harness === 3 ? short : harness, columns.harness)} ${fit(roleWord(worker.role), columns.role)} ${fit(monitorText(worker.task), columns.task)} ${fit(model + suffix, columns.model)}`;
  return boardRow(pair(left, workerAge(worker, now), width), {
    kind: 'worker',
    laneId: worker.laneId,
    workerId: worker.id,
  });
}
export function decisionTitle(record: DecisionRecord): string {
  if (record.kind === 'answer')
    return [record.question, record.option ?? record.title]
      .filter((s): s is string => !!s)
      .map(monitorText)
      .join(' ' + mark('→', '>') + ' ');
  return (record.kind === 'recommendation' ? `${t('recommendation')}: ` : '') + monitorText(record.title);
}
export function decisionRows(
  record: DecisionRecord,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const target: WorkTarget = { kind: 'decision', laneId: lane.id, decisionId: record.id },
    key = targetKey(target);
  const expanded = state.boardExpanded?.has(key);
  const selection = state.mainTab === 'work' ? state.workTarget : state.homeTarget;
  const focused = !!selection && targetKey(selection) === key;
  const glyph = record.oneWay
    ? '!'
    : record.departure
      ? mark('≠', '~')
      : record.verdict === 'changes-required'
        ? '<'
        : mark('·', '.');
  const paint = record.oneWay ? theme.board.danger : record.departure ? theme.value : theme.board.muted;
  const sourceLabel =
    record.kind === 'recommendation' ? t('recommendation') : record.kind === 'review' ? t('review') : t('answer');
  const title =
    record.kind === 'review'
      ? t(record.verdict === 'accept' ? 'Review accepted' : 'Sent back') + (record.round ? ` r${record.round}` : '')
      : state.mainTab === 'work'
        ? (record.kind === 'recommendation' ? `${t('recommendation')}: ` : '') + monitorText(record.title)
        : decisionTitle(record);
  const q =
    state.mainTab !== 'work' && record.kind === 'answer'
      ? record.evidence[0]?.relativePath.match(/\/(q[1-9][0-9]*)\.md$/)?.[1]
      : '';
  const prefix = `${paint(glyph)} ${monitorText(lane.label)}${q ? ' ' + q : ''} `;
  const age = minuteAge(callTime(record), now);
  const titleRoom = Math.max(1, width - visualLength(prefix) - visualLength(age) - 1);
  const compact =
    state.mainTab !== 'work' && record.kind === 'answer' && record.question
      ? truncateAnsi(monitorText(record.question), Math.max(1, Math.floor((titleRoom - 3) / 2))) +
        ' ' +
        mark('→', '>') +
        ' ' +
        truncateAnsi(monitorText(record.option ?? record.title), Math.max(1, Math.ceil((titleRoom - 3) / 2)))
      : truncateAnsi(title, titleRoom);
  const titles = record.oneWay || expanded ? flowLines(title, titleRoom) : [compact];
  const rows = titles.map((text, i) =>
    boardRow(
      i === 0 ? pair(prefix + text, age, width) : ' '.repeat(Math.min(width, visualLength(prefix))) + text,
      target
    )
  );
  if (record.oneWay || expanded || record.departure) {
    const detail = [record.oneWay ? t('one-way') : '', sourceLabel, record.stale ? t('stale evidence') : '']
      .filter(Boolean)
      .join(' · ');
    rows.push(boardRow(`  ${paint(detail)}`, target));
    const extras = [
      record.instead ? `${t('instead:')} ${monitorText(record.instead)}` : '',
      record.rationale ? `${t('why:')} ${monitorText(record.rationale)}` : '',
      record.context && (expanded || focused || width >= 55)
        ? `${t('source context:')} ${monitorText(record.context)}`
        : '',
    ].filter(Boolean);
    for (const text of extras)
      for (const line of record.oneWay || expanded
        ? flowLines(text, Math.max(1, width - 2))
        : [truncateAnsi(text, Math.max(1, width - 2))])
        rows.push(boardRow(`  ${theme.dim(line)}`, target));
    if (expanded)
      for (const evidence of record.evidence)
        rows.push(boardRow(`  ${theme.dim(monitorText(evidence.relativePath))}`, target));
  }
  return rows.map((row) => ({ ...row, text: fit(row.text, width) }));
}
