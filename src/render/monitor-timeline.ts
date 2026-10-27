/**
 * The Timeline pane: the session on the main session's axis, newest first.
 *
 * The main session's own events sit at the left: a finished turn with the
 * head of what it told the person, approvals, compaction, quota, failures.
 * An L1 agent's stages are a level in, each at its end, with how long it
 * took, the subtasks under it, at any depth, that finished in that time and,
 * for its newest, what it returned; a running stage sits at its start, with
 * its clock and what the agent said it would do. Of the L2s only those that
 * matter get a line, a level further in, at their end: failed, in a role the
 * reader named, or flagged by the brief. An agent's line is in its
 * direction's colour (src/render/directions.ts).
 *
 * Three styles draw the levels: off a rail for the main session, indented,
 * or in a lane per direction. The newest hours show, the window the reader
 * chose; a row at the end counts what is earlier and brings back twenty at
 * a time.
 */
import type { SubagentTreeNode } from '../types.js';
import type { WorkbenchEvent } from './workbench-state.js';
import type { MonitorData, MonitorRow } from './monitor.js';
import { isGuardian } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { t } from './i18n.js';
import { agentTitle } from './agent-title.js';
import { monitorText, plainText, flowLines, pair } from './monitor-text.js';
import { formatWindowLabel } from './quota.js';
import { age, iconic, isLive, agentPaint, clockFace } from './monitor-labels.js';
import { directions, subtasks, isImportant, type Directions } from './directions.js';

export type TimelineStyle = 'rail' | 'indent' | 'lanes';
export const TIMELINE_STYLES: readonly TimelineStyle[] = ['rail', 'indent', 'lanes'];
/** The windows a reader can pick, in hours. */
export const TIMELINE_HOURS: readonly number[] = [1, 3, 6, 12, 24];
/** Entries one press of the earlier row brings back. */
export const TIMELINE_STEP = 20;
/** The earlier row, as an item: no agent's id holds a NUL. */
export const TIMELINE_EARLIER = '\0earlier';

/** An agent entry's rows, as an item: the agent's id, a NUL, the entry's, so each entry is a cursor stop of its own. */
export const timelineItem = (agent: string, entry: string): string => `${agent}\0${entry}`;
/** The agent a timeline item opens; none for the earlier row. */
export function timelineAgent(item: string | null | undefined): string | undefined {
  const at = item ? item.indexOf('\0') : -1;
  return at > 0 ? item!.slice(0, at) : undefined;
}
/** The fewest entries shown, however old, before the rest fold into the earlier row. */
const MIN_SHOWN = 8;
/** Lines under an entry: an L1's newest result, an important L2's, what a running L1 said it would do. */
const L1_LINES = 3;
const L2_LINES = 1;
const INTENT_LINES = 2;
/** How far apart a stage's end and the failure the log saw can be and still be one event. */
const FAILURE_SLACK_MS = 120_000;
/** The time column, "59m", and the space after it. */
const TIME = 3;
const GUTTER = TIME + 1;

type Paint = (s: string) => string;
type Stage = NonNullable<WorkbenchEvent['stage']>;
const plain: Paint = s => s;

const STAGE_GLYPHS: Record<Stage, [string, Paint]> = {
  running: ['▸', theme.info], done: ['✓', theme.success], failed: ['✗', theme.error], aborted: ['◌', theme.warning],
};
const STAGE_WORDS: Record<Stage, string> = {
  running: '{agent} started', done: '{agent} finished', failed: '{agent} failed', aborted: '{agent} stopped',
};

/** A timeline event in the reader's words. Facts as recorded; nothing inferred. */
export function timelineText(event: WorkbenchEvent): string {
  const subject = event.subject ? monitorText(event.subject) : '';
  switch (event.kind) {
    case 'approval-requested': return subject ? t('Approval asked: {what}', { what: subject }) : t('Approval asked');
    case 'approval-answered': return t('Approval answered');
    case 'compacted': return t('Context compacted');
    case 'quota': {
      const window = formatWindowLabel(event.windowMinutes);
      return t('Quota past {n}%', { n: event.threshold ?? '?' }) + (window ? ` (${window})` : '');
    }
    case 'turn-finished': return t('Turn finished');
    case 'turn-interrupted': return t('Turn interrupted');
    case 'turn-failed': return t('Turn failed');
    case 'agent-started': return t('{agent} started', { agent: subject });
    case 'agent-finished': return t('{agent} finished', { agent: subject });
    case 'agent-failed': return t('{agent} failed', { agent: subject });
    case 'agent-stage': return t(STAGE_WORDS[event.stage ?? 'done'], { agent: subject });
    case 'tool-failed': return t('Tool failed: {what}', { what: subject });
    default: return monitorText(event.title);
  }
}

/** One entry of the timeline before it is drawn: where it sits, what it says, what hangs under it. */
interface Entry {
  at: Date;
  /** 0 the main session, 1 an L1, 2 an L2. */
  level: 0 | 1 | 2;
  /** The direction it is in: its L1, or the lead a helper's stage was for. */
  dir?: string;
  /** Its glyph, painted; empty where words stand in for glyphs. */
  glyph: string;
  text: string;
  /** " → lead", shown where the line has room for it whole. */
  target: string;
  right: string;
  /** What hangs under it, dim, at most `lines` lines. */
  summary: string;
  lines: number;
  /** A model's reading of a failure, marked as such. */
  cause?: string;
  /** Its rows' key: the event's id, the newest one where it folds several. */
  id: string;
  /** The agent it is about, in the tree: its rows are an item that opens it in the Inspector. */
  agent?: string;
  /** What makes two of the main session's entries one, "×2". */
  fold: string;
  count: number;
  live: boolean;
}

const flat = (text: string) => monitorText(plainText(text).replace(/\s+/g, ' ').trim());

/**
 * The entries, newest first. An agent's start the log paired with a finish
 * later in the list is one entry, at the finish; the same main-session
 * event again with nothing between is one entry, "×5".
 */
function timelineEntries(input: MonitorData, now: number): Entry[] {
  const events = input.timeline ?? [];
  const dirs = directions(input.tree);
  const roles = input.state.importantRoles ?? new Set<string>();
  const words = !iconic();
  // An agent the log saw start and finish: one entry, at the finish.
  const finishes = new Map<string, WorkbenchEvent>();
  const paired = new Set<WorkbenchEvent>();
  const startOf = new Map<WorkbenchEvent, WorkbenchEvent>();
  for (const event of events) {
    if (!event.agentId) continue;
    if (event.kind === 'agent-finished' || event.kind === 'agent-failed') finishes.set(event.agentId, event);
    else if (event.kind === 'agent-started') {
      const end = finishes.get(event.agentId);
      if (end) { paired.add(event); startOf.set(end, event); finishes.delete(event.agentId); }
    }
  }
  // A failure the log saw at a stage's end is that stage's: one entry, failed, with the log's cause.
  const failure = new Map<WorkbenchEvent, WorkbenchEvent>();
  const merged = new Set<WorkbenchEvent>();
  for (const event of events) {
    if (event.kind !== 'agent-failed' || !event.agentId) continue;
    const stage = events.find(other => other.kind === 'agent-stage' && other.agentId === event.agentId && other.stage !== 'running'
      && !failure.has(other) && Math.abs(other.at.getTime() - event.at.getTime()) <= FAILURE_SLACK_MS);
    if (stage) { failure.set(stage, event); merged.add(event); }
  }
  // When each L1's subtasks, at any depth, ended, to count those a stage of it saw finish.
  const ends = new Map<string, Array<{ at: number; failed: boolean }>>();
  for (const event of events) {
    const hit = event.agentId ? dirs.node.get(event.agentId) : undefined;
    if (!hit || hit.level === 0 || isGuardian(hit.node) || merged.has(event)) continue;
    const failed = event.stage === 'failed' || event.kind === 'agent-failed' || failure.has(event);
    if (event.kind === 'agent-stage' ? event.stage === 'running' : !failed && event.kind !== 'agent-finished') continue;
    const l1 = dirs.family.get(hit.node.id)!;
    const list = ends.get(l1) ?? [];
    list.push({ at: event.at.getTime(), failed });
    ends.set(l1, list);
  }
  const out: Entry[] = [];
  // An agent's newest ended stage says what it returned; its earlier ones are a line each.
  const told = new Set<string>();
  for (const event of events) {
    if (event.kind === 'agent-stage' || event.kind === 'agent-started' || event.kind === 'agent-finished' || event.kind === 'agent-failed') {
      if (paired.has(event) || merged.has(event)) continue;
      const log = failure.get(event);
      const entry = agentEntry(log ? { ...event, stage: 'failed', cause: event.cause ?? log.cause } : event, input, dirs, roles, startOf.get(event), ends, told, now, words);
      if (entry) out.push(entry);
      continue;
    }
    const entry = mainEntry(event, words);
    const last = out.at(-1);
    // The same event again, with nothing between and nothing written about it: one entry.
    if (last && last.level === 0 && last.fold === entry.fold && !last.cause && !entry.cause) { last.count++; continue; }
    out.push(entry);
  }
  return out;
}

function agentEntry(event: WorkbenchEvent, input: MonitorData, dirs: Directions, roles: ReadonlySet<string>, start: WorkbenchEvent | undefined,
  ends: ReadonlyMap<string, ReadonlyArray<{ at: number; failed: boolean }>>, told: Set<string>, now: number, words: boolean): Entry | null {
  const stage: Stage = event.kind === 'agent-stage' ? event.stage ?? 'done' : event.kind === 'agent-started' ? 'running'
    : event.kind === 'agent-failed' ? 'failed' : 'done';
  const hit = event.agentId ? dirs.node.get(event.agentId) : undefined;
  const node = hit?.node;
  // A guardian review's comings and goings are the ◈ chip's; its failure stays.
  if (node && isGuardian(node) && stage !== 'failed') return null;
  const level: 1 | 2 = !hit || hit.level === 0 ? 1 : 2;
  // Of the L2s, only those that matter, at their end.
  if (node && level === 2 && (stage === 'running' || (stage !== 'failed' && !isImportant(node, input.agentLog?.get(node.id), roles)))) return null;
  const l1 = node ? dirs.family.get(node.id) : undefined;
  const dir = event.serves ?? (l1 ? dirs.serves.get(l1) ?? l1 : undefined);
  // Names: their colour only where agent colours are on names.
  const paint = dir ? dirs.name(dir) : event.agentId ? agentPaint(event.agentId) : plain;
  const name = (of: SubagentTreeNode) => monitorText(agentTitle(of, input.state.labelAsName).name);
  const called = paint(node ? name(node) : monitorText(event.subject ?? ''));
  const lead = event.serves && event.serves !== l1 ? dirs.node.get(event.serves)?.node : undefined;
  // When it started: the stage's start, the log's start paired with this end, or this event, a start.
  const began = event.startedAt ?? start?.at ?? (stage === 'running' ? event.at : undefined);
  // How long it took; running, its clock face: the time column already says when it started.
  let right = '';
  if (began) right = stage === 'running' ? theme.info(clockFace(now - began.getTime())) : colors.dim(age(began, event.at.getTime()));
  if (level === 1 && began && node) {
    // The subtasks that finished while the stage ran.
    const until = stage === 'running' ? now : event.at.getTime();
    let ok = 0, bad = 0;
    for (const end of ends.get(node.id) ?? []) if (end.at >= began.getTime() && end.at <= until) { if (end.failed) bad++; else ok++; }
    const finished = [ok ? colors.dim(`✓${ok}`) : '', bad ? theme.error(`✗${bad}`) : ''].filter(Boolean).join(' ');
    if (finished) right = right ? `${finished} ${right}` : finished;
  }
  let summary = '';
  let lines = 0;
  if (stage === 'running') {
    // What it said it would do, in its own words.
    if (level === 1 && event.intent) { summary = flat(event.intent); lines = INTENT_LINES; }
  } else {
    const id = node?.id ?? event.agentId ?? '';
    if (!told.has(id) && event.summary) { summary = flat(event.summary); lines = level === 1 ? L1_LINES : L2_LINES; }
    told.add(id);
  }
  const [glyph, glyphPaint] = STAGE_GLYPHS[stage];
  let text = level === 1 ? theme.bold(called) : called;
  if (words) {
    // "name finished", the state's word where the language puts it.
    const [before, after = ''] = t(STAGE_WORDS[stage], { agent: '\0' }).split('\0');
    const word = stage === 'failed' ? theme.error : stage === 'running' ? theme.info : colors.dim;
    text = `${before ? word(before) : ''}${text}${after ? word(after) : ''}`;
  }
  return {
    at: event.at, level, dir, glyph: words ? '' : glyphPaint(glyph), text, target: lead ? colors.dim(' → ') + paint(name(lead)) : '',
    right, summary, lines, cause: event.cause, id: event.id, fold: event.id, count: 1, live: stage === 'running',
    ...(node ? { agent: node.id } : {}),
  };
}

function mainEntry(event: WorkbenchEvent, words: boolean): Entry {
  let glyph = '';
  let text: string;
  switch (event.kind) {
    case 'turn-finished': {
      // The head of what the turn told the person; the words alone where it said nothing.
      const said = flat(event.summary ?? '');
      glyph = colors.dim('⏎');
      text = said ? (words ? `${colors.dim(`${t('Turn finished')}:`)} ` : '') + theme.value(said) : colors.dim(t('Turn finished'));
      break;
    }
    case 'turn-interrupted': glyph = theme.warning('⏎'); text = colors.dim(t('Turn interrupted')); break;
    case 'turn-failed': glyph = theme.error('⏎'); text = theme.error(t('Turn failed')); break;
    case 'approval-requested': glyph = theme.warning('⚑'); text = theme.warning(timelineText(event)); break;
    case 'approval-answered': glyph = colors.dim('⚑'); text = colors.dim(t('Approval answered')); break;
    case 'compacted': glyph = colors.dim('⇣'); text = colors.dim(t('Context compacted')); break;
    case 'quota': glyph = theme.warning('◔'); text = theme.warning(timelineText(event)); break;
    case 'tool-failed': glyph = theme.error('✗'); text = words ? theme.error(timelineText(event)) : monitorText(event.subject ?? ''); break;
    default: text = event.status === 'error' ? theme.error(monitorText(event.title)) : monitorText(event.title);
  }
  return {
    at: event.at, level: 0, glyph: words ? '' : glyph, text, target: '', right: '', summary: '', lines: 0, cause: event.cause,
    id: event.id, fold: `${event.kind ?? ''}|${stripAnsi(text)}|${event.status}`, count: 1, live: false,
  };
}

/**
 * The entries in the window: the newest `hours`, at least the newest few
 * however old, and `more` earlier ones the reader brought back; a stage still
 * running shows wherever it started.
 */
function windowed(all: readonly Entry[], hours: number, more: number, now: number): { shown: Entry[]; hidden: number } {
  const cutoff = now - hours * 3_600_000;
  const recent = all.filter(entry => entry.at.getTime() >= cutoff).length;
  const take = Math.max(MIN_SHOWN, recent) + Math.max(0, more);
  const shown = [...all.slice(0, take), ...all.slice(take).filter(entry => entry.live)];
  return { shown, hidden: all.length - shown.length };
}

/** An entry's words in `room` columns: its target too where both fit whole. */
function named(entry: Entry, room: number): string {
  const both = entry.text + entry.target;
  return visualLength(both) <= room ? both : truncateAnsi(entry.text, Math.max(1, room));
}

/** What hangs under an entry, in `room` columns: at most its lines, the last ending " …" where there was more. */
function underLines(entry: Entry, room: number): string[] {
  if (!entry.summary || !entry.lines || room < 6) return [];
  const flowed = flowLines(entry.summary, room);
  if (flowed.length <= entry.lines) return flowed;
  const cut = flowed.slice(0, entry.lines);
  let last = [...cut[cut.length - 1]];
  while (last.length && visualLength(`${last.join('')} …`) > room) last = last.slice(0, -1);
  cut[cut.length - 1] = `${last.join('').trimEnd()} …`;
  return cut;
}

/** The pane's rows: the entries in the window as the style draws them, then the earlier row. */
export function timelineRows(input: MonitorData, width: number, now: number): MonitorRow[] {
  const all = timelineEntries(input, now);
  // No events, no rows: the pane's frame says what it is.
  if (!all.length) return [];
  const { shown, hidden } = windowed(all, input.state.timelineHours ?? 3, input.state.timelineMore ?? 0, now);
  const style = input.state.timelineStyle ?? 'rail';
  const dirs = directions(input.tree);
  const rows: MonitorRow[] = [];
  const blank = ' '.repeat(GUTTER);
  // A time only where it changes: a run of entries of one age says it once, at its top.
  let previous = '';
  const when = (entry: Entry) => {
    const said = age(entry.at, now);
    const time = said === previous ? '' : said;
    previous = said;
    return `${colors.dim(time.padStart(TIME))} `;
  };
  // An entry's first row, `first` before its words in `room` columns; under it, after `hang`, what it returned and a failure's cause.
  const push = (entry: Entry, first: string, hang: string, room: number) => {
    const key = `entry:${entry.id}`;
    // An agent's entry is an item: the cursor stops on it, Enter or a click opens the agent.
    const item = entry.agent ? { item: timelineItem(entry.agent, entry.id) } : {};
    const words = `${named(entry, room - (entry.right ? visualLength(entry.right) + 1 : 0))}${entry.count > 1 ? colors.dim(` ×${entry.count}`) : ''}`;
    rows.push({ text: truncateAnsi(first + pair(words, entry.right, Math.max(1, room)), width), key, ...item });
    const under = Math.max(1, width - visualLength(hang) - 2);
    for (const line of underLines(entry, under)) rows.push({ text: truncateAnsi(`${hang}  ${colors.dim(line)}`, width), key, ...item });
    // A model-written reading of a failure, marked as such.
    if (entry.cause) flowLines(monitorText(entry.cause), under)
      .forEach((line, i) => rows.push({ text: truncateAnsi(`${hang}${i ? '  ' : `${colors.dim('~')} `}${line}`, width), key, ...item }));
  };
  const glyphed = (entry: Entry, otherwise = '') => entry.glyph ? `${entry.glyph} ` : otherwise;
  if (style === 'lanes') {
    // The main session's axis, then a lane for each direction with subtasks or
    // still at work, as many as fit, in the order they come into view; a
    // direction still at work runs from the top.
    const max = width >= 48 ? 4 : 3;
    const laned = (dir: string) => { const node = dirs.node.get(dir)?.node; return Boolean(node && (subtasks(node).length || isLive(node))); };
    const lanes: string[] = [];
    for (const entry of shown) if (entry.dir && laned(entry.dir) && !lanes.includes(entry.dir) && lanes.length < max) lanes.push(entry.dir);
    const span = new Map<string, [number, number]>();
    shown.forEach((entry, i) => {
      if (!entry.dir || !lanes.includes(entry.dir)) return;
      const known = span.get(entry.dir);
      span.set(entry.dir, known ? [known[0], i] : [i, i]);
    });
    for (const lane of lanes) {
      const node = dirs.node.get(lane)!.node;
      const known = span.get(lane);
      if (known && (isLive(node) || subtasks(node).some(isLive))) span.set(lane, [0, known[1]]);
    }
    const graph = (i: number, entry: Entry | null) => {
      const axis = entry && entry.level === 0 ? entry.glyph || colors.dim('•') : colors.dim('│');
      const cells = lanes.map(lane => {
        if (entry && entry.dir === lane && entry.level > 0) return entry.glyph || dirs.paint(lane)('•');
        const [top, bottom] = span.get(lane) ?? [-1, -1];
        return i >= top && i <= bottom && !(entry === null && i === bottom) ? dirs.paint(lane)('│') : ' ';
      });
      return [axis, ...cells].join(' ');
    };
    const across = 1 + lanes.length * 2;
    shown.forEach((entry, i) => {
      const off = entry.level > 0 && !(entry.dir && lanes.includes(entry.dir));
      const indent = entry.level === 2 ? '  ' : '';
      const lead = off ? glyphed(entry) : '';
      const room = width - GUTTER - across - 1 - indent.length - visualLength(lead);
      push(entry, `${when(entry)}${graph(i, entry)} ${indent}${lead}`, `${blank}${graph(i, null)} ${indent}`, room);
    });
  } else if (style === 'rail') {
    // A rail for the main session; an L1 branches off it, an L2 hangs a step further.
    for (const entry of shown) {
      const paint = dirs.paint(entry.dir);
      const rail = colors.dim('│');
      const [lead, hang] = entry.level === 0 ? [glyphed(entry, `${rail} `), `${rail} `]
        : entry.level === 1 ? [`${paint('├─')}${glyphed(entry, ' ')}`, `${rail}  `]
          : [`${rail} ${paint('╰')}${glyphed(entry, ' ')}`, `${rail}    `];
      push(entry, `${when(entry)}${lead}`, `${blank}${hang}`, width - GUTTER - visualLength(lead));
    }
  } else {
    // Indented: a level in for an L1, two for an L2.
    for (const entry of shown) {
      const indent = '  '.repeat(entry.level);
      const lead = `${indent}${glyphed(entry)}`;
      push(entry, `${when(entry)}${lead}`, `${blank}${indent}`, width - GUTTER - visualLength(lead));
    }
  }
  if (hidden) rows.push({ item: TIMELINE_EARLIER, text: truncateAnsi(`${blank}${colors.dim(`▸ ${t('{n} earlier', { n: hidden })}`)}`, width) });
  return rows;
}

/** How many entries the pane's rows show, for its title. */
export function timelineCount(rows: readonly MonitorRow[]): number {
  return new Set(rows.flatMap(row => row.key?.startsWith('entry:') ? [row.key] : [])).size;
}
