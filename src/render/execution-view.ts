/**
 * Execution: workflow diagram, single worker cards and recent outcomes. Facts and screens are collected outside paint.
 */
import type { EndedExecutionJob, ExecutionJob, ExecutionRun, ExecutionView } from '../collectors/execution.js';
import { SCREEN_INTERVAL_MS, SCREEN_ROWS } from '../collectors/execution-screens.js';
import { workState } from '../collectors/work-job.js';
import type { MonitorRow } from './monitor.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { roleIcon } from './model-glyphs.js';
import { runItem, workflowLabel, workflowRows } from './execution-workflow.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { jobTitle, roleInk } from './work-job-row.js';
import { jobTarget } from './work-jobs.js';
import { isHeadless, workerModelName } from './worker-roster.js';
import { t } from './i18n.js';
import { PROJECT_STRIP_MORE } from './project-strip.js';

/** Narrower than this a frame leaves no room for its content. */
const FRAME_MIN = 16;
const PROGRESS_ROWS = 3;
const HARNESS_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'pi' };
type Ink = (text: string) => string;
const muted: Ink = (text) => theme.board.muted(text);
const shortId = (jobId: string) => jobId.slice(0, 8);
const roleOf = (job: ExecutionJob) => monitorText(job.worker.role ?? 'job');
const titleOf = (job: Pick<ExecutionJob, 'worker'>) =>
  [monitorText(job.worker.displayId ?? ''), jobTitle(job.worker, !!job.worker.parentJobId)].filter(Boolean).join(' ');
const clock = (at: string) => {
  const date = new Date(at), two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** The state in the records' own terms: its mark, word and ink. */
function stateOf(job: ExecutionJob, now: number): { glyph: string; word: string; ink: Ink } {
  const { worker } = job, board = theme.board;
  if (job.phase === 'waiting') return { glyph: stateMark.asking(), word: t(worker.homeNeedsHuman ? 'asking' : 'waiting for main'), ink: board.attention };
  if (job.phase === 'queued') return { glyph: stateMark.queued(), ink: muted,
    word: worker.queuePosition !== undefined ? t('queued #{n}', { n: worker.queuePosition }) : t('queued') };
  if (job.phase === 'running') return workState(worker, now) === 'stalled'
    ? { glyph: stateMark.stalled(), word: t('stalled'), ink: board.stalled }
    : { glyph: mark('◉', '@'), word: t('working'), ink: board.active };
  if (worker.state === 'failed') return { glyph: stateMark.failed(), word: t('failed'), ink: board.danger };
  if (worker.state === 'stopped') return { glyph: stateMark.stopped(), word: t('stopped'), ink: muted };
  return { glyph: stateMark.done(), word: t('done'), ink: board.success };
}

function sessionLabel(session: ExecutionJob['session']): string {
  if (session?.id) return `${monitorText(HARNESS_NAMES[session.harness ?? ''] ?? session.harness ?? '')} ${monitorText(session.id.slice(0, 8))}`.trim();
  return session?.pane ? t('pane {id}', { id: monitorText(session.pane) }) : t('unknown session');
}

/** A square frame's edge with its title set into it, and optionally a second fact near the far corner. */
function edge(open: string, close: string, left: string, right: string, width: number, ink: Ink): string {
  const line = mark('─', '-'), tail = right ? ` ${right} ${ink(line)}` : '';
  const head = truncateAnsi(left, Math.max(0, width - 5 - visualLength(tail)));
  const fill = Math.max(0, width - 5 - visualLength(head) - visualLength(tail));
  return fit(`${ink(open + line)} ${head} ${ink(line.repeat(fill))}${tail}${ink(close)}`, width);
}
/** The first choice that fits the edge whole with a stroke between its two facts; the last is cut. */
const edgeChoice = (choices: [string, string][], width: number) =>
  choices.find(([left, right]) => 5 + visualLength(left) + (right ? visualLength(right) + 3 : 0) < width) ?? choices[choices.length - 1]!;

function screenLines(job: ExecutionJob, view: ExecutionView): string[] {
  if (!job.hasScreen) return [muted(t('no screen yet'))];
  const screen = view.screens.get(job.jobId);
  const lines = !screen ? [muted(t('reading screen'))] : screen.state === 'closed' ? [muted(t('tab closed'))]
    : screen.state === 'unavailable' ? [muted(t('screen unavailable'))]
      : screen.lines.length ? screen.lines.slice(-SCREEN_ROWS).map((line) => theme.board.text(monitorText(line))) : [muted(t('screen is blank'))];
  // A fixed height: a new sample never moves the cards below.
  return [...lines, ...Array<string>(Math.max(0, SCREEN_ROWS - lines.length)).fill('')];
}

/** A card's body: its title, an open question, then the worker's screen or the headless job's own record. */
function cardBody(job: ExecutionJob, view: ExecutionView, now: number): ({ rule: string } | string)[] {
  const { worker } = job, arrow = muted(mark('›', '>'));
  const body: ({ rule: string } | string)[] = [theme.board.text(titleOf(job))];
  if (job.phase === 'waiting' && worker.ask) body.push(theme.board.attention(`${stateMark.asking()} ${monitorText(worker.ask)}`));
  const progress = worker.progress?.length ? worker.progress : worker.latest_progress ? [worker.latest_progress] : [];
  const entry = (p: (typeof progress)[number]) => `${muted(clock(p.at))} ${monitorText(p.text)}`;
  const tab = !isHeadless(worker), latest = progress.at(-1);
  if (tab && job.phase !== 'queued' && latest) body.push(`${arrow} ${entry(latest)}`);
  if (job.children?.length) {
    const children = job.children.map((child) => {
      const state = stateOf(child, now);
      const label = child.scout ? t('{kind} prewalk scout', { kind: monitorText(child.scout) }) : roleOf(child);
      return `${label} ${state.ink(state.glyph)}`;
    });
    body.push(`${muted(mark('ϟ', '*'))} ${t('Children: {summary}', { summary: children.join(muted(' · ')) })}`);
  }
  if (job.phase === 'queued') return body;
  if (tab) return [...body, { rule: t('screen') }, ...screenLines(job, view)];
  const rule = (what?: string) => ({ rule: [t('headless'), what].filter(Boolean).join(' · ') });
  if (progress.length) return [...body, rule(t('progress')), ...progress.slice(-PROGRESS_ROWS).map(entry)];
  const output = job.output?.lines.slice(-PROGRESS_ROWS) ?? [];
  if (output.length) return [...body, rule(t('output')),
    ...output.map((line) => (line.kind === 'error' ? theme.board.danger : muted)(monitorText(line.text)))];
  return [...body, rule(), muted(t('No progress yet'))];
}

function cardRows(job: ExecutionJob, view: ExecutionView, from: string, selected: boolean, width: number, now: number): string[] {
  const state = stateOf(job, now), age = compactAge(job.worker.startedAt ?? undefined, now);
  const marker = selected ? `${theme.board.active(mark('▸', '>'))} ` : '';
  const names = [roleInk(job.worker.role ?? '')(roleOf(job)),
    monitorText(workerModelName(job.worker.model, job.worker.provider)), monitorText(job.preset ?? '')];
  const name = (n: number) => `${marker}${state.ink(state.glyph)} ${names.slice(0, n).filter(Boolean).join(muted(' · '))}`;
  const facts = [state.ink(state.word), muted(age)].filter(Boolean).join(' ');
  if (width < FRAME_MIN) return [pair(name(1), state.ink(state.glyph), width),
    ...cardBody(job, view, now).map((line) => typeof line === 'string' ? line : muted(line.rule))];
  const ink: Ink = selected ? theme.board.active : theme.board.frame, side = ink(mark('│', '|'));
  // Preset, model and then the state word give way; the role and the elapsed time stay.
  const [head, right] = edgeChoice([[name(3), facts], [name(2), facts], [name(1), facts], [name(1), muted(age)]], width);
  const kind = job.phase === 'queued' ? t('queued') : t(isHeadless(job.worker) ? 'headless' : 'tab');
  const id = muted(shortId(job.jobId)), origin = muted(t('from {parent}', { parent: from }));
  const [parent, tail] = edgeChoice([[origin, `${muted(kind)} ${id}`], [origin, id], [origin, '']], width);
  return [
    edge(mark('┌', '+'), mark('┐', '+'), head, right, width, ink),
    ...cardBody(job, view, now).map((line) => typeof line === 'string' ? `${side} ${fit(line, width - 4)} ${side}`
      : edge(mark('├', '+'), mark('┤', '+'), muted(line.rule), '', width, ink)),
    edge(mark('└', '+'), mark('┘', '+'), parent, tail, width, ink),
  ];
}

const cardItem = (job: Pick<ExecutionJob, 'jobId'>) => `project:exec:${job.jobId}`;

function endedState(result: EndedExecutionJob['result']): { glyph: string; ink: Ink } {
  const b = theme.board;
  switch (result) {
    case 'done': case 'landed': return { glyph: stateMark.done(), ink: b.success };
    case 'not landed': return { glyph: mark('◌', 'o', '\uF05D'), ink: muted };
    case 'failed': return { glyph: stateMark.failed(), ink: b.danger };
    case 'stopped': return { glyph: stateMark.stopped(), ink: muted };
    default: return { glyph: mark('·', '.'), ink: muted };
  }
}

function endedRow(entry: EndedExecutionJob | (ExecutionRun & { endedAt: number }), selected: string | undefined, width: number, now: number): MonitorRow {
  const state = endedState(entry.result);
  const age = muted(compactAge(entry.endedAt, now));
  const facts = entry.result ? `${state.ink(t(entry.result))} ${age}` : age;
  const at = 'flow' in entry ? { item: runItem(entry.flow), execRun: entry.flow }
    : { item: cardItem(entry), execJob: { target: jobTarget(entry.worker), dir: entry.dir, tab: false } };
  const title = !('flow' in entry) ? titleOf(entry) : entry.kind === 'queue'
    ? t(entry.tickets.length === 1 ? 'Queue {label} · 1 ticket' : 'Queue {label} · {n} tickets',
      { label: monitorText(entry.label), n: entry.tickets.length }) : workflowLabel(entry);
  const icon = 'flow' in entry ? muted(mark('≡', '=', '\uF0C9')) : roleInk(entry.worker.role ?? '')(roleIcon(entry.worker.role ?? ''));
  const marker = selected === at.item ? `${theme.board.active(mark('▸', '>'))} ` : '  ';
  const prefix = `${marker}${state.ink(state.glyph)} `;
  const left = visualLength(prefix + icon) + visualLength(facts) + 4 <= width ? `${prefix}${icon} ` : prefix;
  const right = visualLength(left) + visualLength(facts) + 2 <= width ? facts : age;
  return { ...at, text: fit(pair(left + theme.board.text(title), right, width), width) };
}

export function executionRows(view: ExecutionView | undefined, cursor: string | undefined, width: number, now: number): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width));
  if (!view) return [plain(''), plain(`  ${muted(t('Reading jobs…'))}`)];
  const runs = (view.runs ?? []).filter((run) => run.endedAt === undefined && (run.state === 'paused' || run.state === 'working'));
  const endedRuns = (view.runs ?? []).filter((run): run is ExecutionRun & { endedAt: number } => run.endedAt !== undefined);
  const recent = [...(view.endedJobs ?? []), ...endedRuns].sort((a, b) => b.endedAt - a.endedAt);
  const partial = view.complete ? '' : t('Partial');
  if (!runs.length && !view.jobs.length && !recent.length)
    return [plain(''), plain(pair(`  ${muted(t('No running or waiting jobs'))}`, muted(partial), width))];
  // The first actionable body row is the first open workflow, otherwise the first card or outcome.
  const first = runs.length ? runItem(runs[0].flow) : view.jobs.length ? cardItem(view.jobs[0])
    : 'flow' in recent[0] ? runItem(recent[0].flow) : cardItem(recent[0]);
  const seen = new Set<string>();
  const selected = cursor === PROJECT_STRIP_MORE ? undefined : cursor ?? first;
  const workflows = runs.flatMap((run, i) => [...(i ? [plain('')] : []), ...workflowRows(run, selected, seen, width, now)]);
  const from = (job: ExecutionJob) => job.parentId
    ? [job.parentRole && monitorText(job.parentRole), shortId(job.parentId)].filter(Boolean).join(' ') : sessionLabel(job.session);

  const rows: MonitorRow[] = [];
  let missingCoverage = partial;
  if (view.jobs.length) {
    const count = (phase: ExecutionJob['phase'], word: string, ink: Ink) => {
      const n = view.jobs.filter((job) => job.phase === phase).length;
      return `${(n ? ink : muted)(String(n))} ${muted(t(word))}`;
    };
    const readout = `  ${[count('running', 'running', theme.board.title), count('waiting', 'waiting', theme.board.attention),
      count('queued', 'queued', theme.board.title)].join('   ')}`;
    const source = [partial, view.jobs.some((job) => job.hasScreen) ? t('screens every {n}s', { n: SCREEN_INTERVAL_MS / 1000 }) : '']
      .filter(Boolean).join(' · ');
    const right = [source, partial].find((text) => visualLength(readout) + 2 + visualLength(text) <= width) ?? '';
    rows.push(plain(''), plain(pair(readout, muted(right), width)));
    if (right) missingCoverage = '';
  }
  if (runs.length) {
    if (rows.length) rows.push(plain(''));
    rows.push(section(t('Workflow'), width, [String(runs.length), !view.jobs.length && !recent.length && partial].filter(Boolean).join(' · ')), ...workflows);
  }
  if (view.jobs.length) {
    if (rows.length) rows.push(plain(''));
    rows.push(section(t('Workers'), width, [String(view.jobs.length), missingCoverage].filter(Boolean).join(' · ')));
    for (const job of view.jobs) {
      const at = { item: cardItem(job), execJob: { target: jobTarget(job.worker), dir: job.dir, tab: !isHeadless(job.worker) && job.worker.state !== 'queued' } };
      rows.push(...cardRows(job, view, from(job), selected === at.item, width, now).map((text) => ({ ...at, text: fit(text, width) })));
    }
  }
  if (recent.length) {
    if (rows.length) rows.push(plain(''));
    const heading = t('Recently ended'), coverage = !view.jobs.length ? partial : '';
    const summary = [String(recent.length), t('within 24 h'), coverage].filter(Boolean).join(' · ');
    const compact = [String(recent.length), coverage].filter(Boolean).join(' · ');
    rows.push(section(heading, width, visualLength(heading + summary) + 2 <= width ? summary : compact));
    rows.push(...recent.map((entry) => endedRow(entry, selected, width, now)));
  }
  return cursor && cursor !== PROJECT_STRIP_MORE && !rows.some((row) => row.item === cursor) ? executionRows(view, undefined, width, now) : rows;
}
