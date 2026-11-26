/**
 * The Project Execution page: a readout, one square frame per running or waiting job with its tab worker's screen (a headless
 * job's progress instead), and who started whom. Pure: jobs and screens are collected outside paint.
 */
import type { ExecutionJob, ExecutionNode, ExecutionSession, ExecutionView } from '../collectors/execution.js';
import { SCREEN_INTERVAL_MS, SCREEN_ROWS } from '../collectors/execution-screens.js';
import { workState } from '../collectors/work-job.js';
import type { MonitorRow } from './monitor.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { fit, monitorText, pair } from './monitor-text.js';
import { boardRow, compactAge, mark, section, stateMark } from './workboard-rows.js';
import { jobTitle, roleInk } from './work-job-row.js';
import { jobTarget } from './work-jobs.js';
import { isHeadless, workerModelName } from './worker-roster.js';
import { t } from './i18n.js';

/** Narrower than this a frame leaves no room for its content. */
const FRAME_MIN = 16;
const PROGRESS_ROWS = 3;
const HARNESS_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'pi' };
type Ink = (text: string) => string;
const muted: Ink = (text) => theme.board.muted(text);
const shortId = (jobId: string) => jobId.slice(0, 8);
const roleOf = (job: ExecutionJob) => monitorText(job.worker.role ?? 'job');
const titleOf = (job: ExecutionJob) => [monitorText(job.worker.displayId ?? ''), jobTitle(job.worker, !!job.parentId)].filter(Boolean).join(' ');
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

function sessionLabel(session: Pick<ExecutionSession, 'harness' | 'id' | 'pane'>): string {
  if (session.id) return `${monitorText(HARNESS_NAMES[session.harness ?? ''] ?? session.harness ?? '')} ${monitorText(session.id.slice(0, 8))}`.trim();
  return session.pane ? t('pane {id}', { id: monitorText(session.pane) }) : t('unknown session');
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
      : screen.lines.length ? screen.lines.map((line) => theme.board.text(monitorText(line))) : [muted(t('screen is blank'))];
  // A fixed height: a new sample never moves the cards below.
  return [...lines, ...Array<string>(Math.max(0, SCREEN_ROWS - lines.length)).fill('')];
}

/** A card's body: its title, an open question, then the worker's screen or the headless job's own record. */
function cardBody(job: ExecutionJob, view: ExecutionView): ({ rule: string } | string)[] {
  const { worker } = job, arrow = muted(mark('›', '>'));
  const body: ({ rule: string } | string)[] = [theme.board.text(titleOf(job))];
  if (job.phase === 'waiting' && worker.ask) body.push(theme.board.attention(`${stateMark.asking()} ${monitorText(worker.ask)}`));
  if (job.phase === 'queued') return body;
  const progress = worker.progress?.length ? worker.progress : worker.latest_progress ? [worker.latest_progress] : [];
  const entry = (p: (typeof progress)[number]) => `${muted(clock(p.at))} ${monitorText(p.text)}`;
  if (!isHeadless(worker)) {
    const latest = progress.at(-1);
    return [...body, ...(latest ? [`${arrow} ${entry(latest)}`] : []), { rule: t('screen') }, ...screenLines(job, view)];
  }
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
    ...cardBody(job, view).map((line) => typeof line === 'string' ? line : muted(line.rule))];
  const ink: Ink = selected ? theme.board.active : theme.board.frame, side = ink(mark('│', '|'));
  // Preset, model and then the state word give way; the role and the elapsed time stay.
  const [head, right] = edgeChoice([[name(3), facts], [name(2), facts], [name(1), facts], [name(1), muted(age)]], width);
  const kind = job.phase === 'queued' ? t('queued') : t(isHeadless(job.worker) ? 'headless' : 'tab');
  const id = muted(shortId(job.jobId)), origin = muted(t('from {parent}', { parent: from }));
  const [parent, tail] = edgeChoice([[origin, `${muted(kind)} ${id}`], [origin, id], [origin, '']], width);
  return [
    edge(mark('┌', '+'), mark('┐', '+'), head, right, width, ink),
    ...cardBody(job, view).map((line) => typeof line === 'string' ? `${side} ${fit(line, width - 4)} ${side}`
      : edge(mark('├', '+'), mark('┤', '+'), muted(line.rule), '', width, ink)),
    edge(mark('└', '+'), mark('┘', '+'), parent, tail, width, ink),
  ];
}

export function executionRows(view: ExecutionView | undefined, cursor: string | undefined, width: number, now: number): MonitorRow[] {
  const plain = (text: string) => boardRow(fit(text, width));
  if (!view) return [plain(''), plain(`  ${muted(t('Reading jobs…'))}`)];
  const partial = view.complete ? '' : muted(t('Partial'));
  if (!view.jobs.length) return [plain(''), plain(pair(`  ${muted(t('No running or waiting jobs'))}`, partial, width))];
  const known = new Map<string, ExecutionJob>(), origin = new Map<string, string>();
  const visit = (node: ExecutionNode, session: ExecutionSession) => {
    known.set(node.job.jobId, node.job);
    origin.set(node.job.jobId, sessionLabel(session));
    for (const child of node.children) visit(child, session);
  };
  for (const session of view.sessions) for (const node of session.nodes) visit(node, session);
  const cardItem = (job: ExecutionJob) => `project:exec:${job.jobId}`, treeItem = (job: ExecutionJob) => `project:exec-tree:${job.jobId}`;
  const items = [...view.jobs.map(cardItem), ...[...known.values()].map(treeItem)];
  // The panel starts on the first row it can act on, and a vanished selection returns there.
  const selected = cursor && items.includes(cursor) ? cursor : items[0];
  const target = (job: ExecutionJob, item: string) => ({ item,
    execJob: { target: jobTarget(job.worker), dir: job.dir, tab: !isHeadless(job.worker) && job.worker.state !== 'queued' } });
  const from = (job: ExecutionJob) => {
    const parent = job.parentId && known.get(job.parentId);
    return parent ? `${roleOf(parent)} ${shortId(parent.jobId)}` : job.parentId ? shortId(job.parentId) : origin.get(job.jobId) ?? t('unknown session');
  };

  const count = (phase: ExecutionJob['phase'], word: string, ink: Ink) => {
    const n = view.jobs.filter((job) => job.phase === phase).length;
    return `${(n ? ink : muted)(String(n))} ${muted(t(word))}`;
  };
  const readout = `  ${[count('running', 'running', theme.board.title), count('waiting', 'waiting', theme.board.attention),
    count('queued', 'queued', theme.board.title)].join('   ')}`;
  // What the page's data is, when there is room beside the figures.
  const source = [partial, view.jobs.some((job) => job.hasScreen) ? muted(t('screens every {n}s', { n: SCREEN_INTERVAL_MS / 1000 })) : '']
    .filter(Boolean).join(muted(' · '));
  const right = [source, partial].find((text) => visualLength(readout) + 2 + visualLength(text) <= width) ?? '';
  const rows: MonitorRow[] = [plain(''), plain(pair(readout, right, width)), plain(''),
    section(t('Workers'), width, String(view.jobs.length))];
  for (const job of view.jobs) {
    const at = target(job, cardItem(job));
    rows.push(...cardRows(job, view, from(job), selected === at.item, width, now).map((text) => ({ ...at, text: fit(text, width) })));
  }

  rows.push(plain(''), section(t('Delegation'), width));
  const branch = (node: ExecutionNode, stem: string, last: boolean) => {
    const { job } = node, state = stateOf(job, now), at = target(job, treeItem(job));
    const marker = selected === at.item ? `${theme.board.active(mark('▸', '>'))} ` : '  ';
    const joint = `${stem}${last ? mark('└─', '`-') : mark('├─', '|-')} `;
    const scout = job.scout ? muted(` · ${t('{kind} scout', { kind: monitorText(job.scout) })}`) : '';
    const left = `${marker}${theme.board.frame(joint)}${state.ink(state.glyph)} ${roleInk(job.worker.role ?? '')(roleOf(job))}${scout}`;
    const fact = job.phase === 'settled' ? state.ink(state.word) : muted(compactAge(job.worker.startedAt ?? undefined, now));
    const room = width - visualLength(left) - visualLength(fact) - 3;
    const title = room > 3 ? `  ${truncateAnsi(titleOf(job), room - 1)}` : '';
    rows.push({ ...at, text: fit(pair(left + title, fact, width), width) });
    const below = stem + (last ? '   ' : `${theme.board.frame(mark('│', '|'))}  `);
    node.children.forEach((child, i) => branch(child, below, i === node.children.length - 1));
  };
  for (const session of view.sessions) {
    rows.push(plain(`  ${theme.board.title(sessionLabel(session))}${session.here ? muted(` · ${t('this pane')}`) : ''}`));
    session.nodes.forEach((node, i) => branch(node, '', i === session.nodes.length - 1));
  }
  return rows;
}
