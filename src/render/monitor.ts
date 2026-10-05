/** Default F12 view: a monitor, not another transcript. No I/O or terminal input here. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { WorktreesSnapshot, WorktreeInfo } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { initialPanelState, reconcileSelection, visibleRows, applyKey, countExpired, guardianCount, isGuardian, type PanelState } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi, getContextColor } from './colors.js';
import { palette } from './palette.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { displayConfig } from './hud-config.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry, AgentLogKind } from '../collectors/agent-log.js';
import type { StatusCard } from './status-block.js';
import { t } from './i18n.js';
import { agentTitle } from './agent-title.js';
import { briefFields, taskLines, richRows } from './cards.js';
import { drawAgentsView, WHEEL_ROWS } from './agents-view.js';
import { planFoot, nextLevel, type StatusLevel, type FootInfo } from './status-foot.js';
import { formatWindowLabel } from './quota.js';
import type { WorkbenchEvent } from './workbench-state.js';

export const MONITOR_PANES = ['agents', 'worktrees', 'changes', 'details', 'timeline'] as const;
export type MonitorPane = typeof MONITOR_PANES[number];
export type PaneMode = 'open' | 'folded' | 'closed';
export type MonitorModes = Record<MonitorPane, PaneMode>;
export interface MonitorState {
  tree: PanelState;
  focus: MonitorPane;
  modes: MonitorModes;
  scroll: Record<MonitorPane, number>;
  selectedWorktree: string | null;
  selectedFile: string | null;
  preview: 'agent' | 'worktree' | 'file';
  help: boolean;
  zoom: boolean;
  helpScroll?: number;
  expanded?: boolean;
  /**
   * How the agents are shown: `rich`, a card each; `compact` (or absent), the
   * tree with the brief and log under it. The panel sets it from settings.
   */
  style?: PanelStyle;
  /** Rich: the cards opened to their timeline, by agent id. Panel state, reset with the session. */
  cards?: ReadonlySet<string>;
  /**
   * The agent the agents view last scrolled into view: the view follows the
   * selection when it moves, and otherwise stays where the reader put it.
   */
  revealed?: string | null;
  /**
   * The first row in view, as a block key and how far into it, so content
   * arriving above does not move what the reader is looking at; `offset` is
   * the scroll it was taken at, so a scroll since then is not undone.
   */
  anchor?: {key: string; delta: number; offset: number};
  /** How much the status card shows; absent is `full`. The panel sets it from settings. */
  statusLevel?: StatusLevel;
  /** How far the status card's brief is scrolled. */
  statusScroll?: number;
}
export type PanelStyle = 'rich' | 'compact';
/** A click target on a row; `x` counts from the row's start. */
export interface RowControl { kind: MonitorControl['kind']; item?: string; x: number; width: number }
/**
 * `item` is what a click selects; `action` is a row that is a control
 * instead. `key` names the block a row belongs to, so a scrolled view can
 * keep its place; `controls` are click targets on the row.
 */
export interface MonitorRow { text: string; item?: string; action?: 'toggle-finished'; key?: string; controls?: RowControl[] }
export interface MonitorRect {
  id: MonitorPane;
  x: number; y: number; width: number; height: number;
  offset: number;
  contentLength: number;
  rows: MonitorRow[];
  /** Rows of frame above and below the content: 1 for a box, 0 for Agents. */
  edge?: number;
  /** Leading rows that stay put while the rest scrolls: Agents' summary line. */
  pinned?: number;
  /** Content rows drawn, pinned ones included, when fewer than the frame holds: the rest is the scroll hint. */
  visible?: number;
}
export interface MonitorControl {
  /**
   * `expand` opens or closes a card's timeline (and selects it), `switch`
   * (a card's name) selects it and switches Codex to it, `more` scrolls the
   * agents view a page, `level` (the status card's top edge) changes how
   * much the card shows.
   */
  kind: 'main' | 'settings' | 'fold' | 'close' | 'brief' | 'level' | 'log' | 'expand' | 'more' | 'switch';
  pane?: MonitorPane;
  /** The agent a log line belongs to: a click selects it. */
  item?: string;
  x: number; y: number; width: number;
}
export interface MonitorFrame { lines: string[]; panes: MonitorRect[]; controls: MonitorControl[]; state: MonitorState; helpPage?: {count:number; total:number};
  /** The status card's place and its brief's scroll, for the wheel. */
  statusCard?: FootInfo }
export interface MonitorData {
  tree: SubagentTree;
  state: MonitorState;
  width: number; height: number;
  git?: GitChanges | null;
  worktrees?: WorktreesSnapshot | null;
  diff?: string[];
  nowMs?: number;
  notice?: string | null;
  error?: string | null;
  /**
   * The brief, when one is configured; `paused` puts the model calls on hold.
   */
  brief?: Brief & {paused?: boolean};
  /**
   * The status bar's fields for the card at the foot of the panel (while the
   * panel is open it replaces the bar), as parts the monitor fits to the
   * card's edges.
   */
  status?: (nowMs: number) => StatusCard | null;
  /**
   * Each agent's log, oldest entry first, by agent id: shown under the brief
   * for the agents the tree shows, and whole in the Inspector.
   */
  agentLog?: ReadonlyMap<string, readonly AgentLogEntry[]>;
  /**
   * What the main session is doing, as the status card words it, for the
   * card's one-line form; `attention` while it waits on the person, `failed`
   * while a tool or agent has failed.
   */
  session?: (nowMs: number) => {text: string; short?: string; attention: boolean; failed?: boolean} | null;
  /** The session's observed events, newest first, for the Timeline pane. */
  timeline?: readonly WorkbenchEvent[];
  /**
   * Model-written readings, each shown marked as such: the pending approval's
   * command in plain words, and what the current diff does (`current` false
   * once the diff has moved on since it was written).
   */
  notes?: {approval?: string; changes?: {lines: string[]; at: number; current: boolean}};
  /** The session has not been read yet: an empty tree is not news. */
  loading?: boolean;
  /**
   * Decoration for the empty stretch above the foot: lines at most `cols`
   * wide and `rows` tall, or null when nothing fits.
   */
  art?: (cols: number, rows: number) => string[] | null;
}
export interface MonitorContext {
  tree: SubagentTree;
  /** The clock the frame was drawn with, so a click resolves against the rows it saw. */
  nowMs?: number;
  git?: GitChanges | null;
  worktrees?: WorktreesSnapshot | null;
  frame?: MonitorFrame;
}
export interface MonitorOutcome {
  state: MonitorState;
  close: boolean;
  action?: {type:'settings'} | {type:'switch'; id:string} | {type:'brief-toggle'} | {type:'status-level'};
}

export function initialMonitorState(): MonitorState {
  return {tree:{...initialPanelState(),sort:'active'}, focus:'agents',
    modes:{agents:'open',worktrees:'closed',changes:'closed',details:'closed',timeline:'closed'},
    scroll:{agents:0,worktrees:0,changes:0,details:0,timeline:0}, selectedWorktree:null,selectedFile:null,
    preview:'agent',help:false,zoom:false,helpScroll:0,expanded:false};
}
/** Toggle one card's timeline. */
export function toggleCard(state: MonitorState, id: string): MonitorState {
  const cards = new Set(state.cards ?? []);
  if (cards.has(id)) cards.delete(id); else cards.add(id);
  return {...state, cards};
}
/** Agents is the page itself: always there, whatever an older settings file says. */
export function monitorModes(settings: HudSettings): MonitorModes {
  return {agents:'open', worktrees:settings.worktreesPane, changes:settings.changesPane, details:settings.detailsPane, timeline:settings.timelinePane};
}
export function monitorPreferences(state: MonitorState): Partial<HudSettings> {
  return {agentsPane:state.modes.agents, worktreesPane:state.modes.worktrees,
    changesPane:state.modes.changes, detailsPane:state.modes.details, timelinePane:state.modes.timeline};
}
export function reconcileMonitor(state: MonitorState, tree: SubagentTree, git?: GitChanges | null, worktrees?: WorktreesSnapshot | null, nowMs: number = Date.now()): MonitorState {
  const rows = visibleRows(tree.nodes, state.tree, nowMs);
  const selected = reconcileSelection(state.tree, tree.nodes, rows);
  const entries = worktrees?.entries ?? [];
  const selectedWorktree = entries.some(w => w.path === state.selectedWorktree) ? state.selectedWorktree
    : entries.find(w => !w.bare && w.prunable === undefined)?.path ?? entries[0]?.path ?? null;
  const selectedFile = git?.files.some(f => f.path === state.selectedFile) ? state.selectedFile : git?.files[0]?.path ?? null;
  const focus = state.modes[state.focus] !== 'closed' ? state.focus : MONITOR_PANES.find(id => state.modes[id] !== 'closed') ?? 'agents';
  const changed = selected.selectedId !== state.tree.selectedId || selectedWorktree !== state.selectedWorktree || selectedFile !== state.selectedFile;
  // A selection the panel made for itself (the first agent, or a stand-in
  // for one that left) is not the reader moving: the view stays put.
  const revealed = selected.selectedId !== state.tree.selectedId ? selected.selectedId : state.revealed;
  return {...state, tree:selected, selectedWorktree, selectedFile, focus, revealed,
    scroll:{...state.scroll,details:changed ? 0 : state.scroll.details}};
}

/** External strings are escaped before width calculation or painting. */
export function monitorText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ch => {
    const cp = ch.charCodeAt(0);
    return ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
      : cp > 255 ? `\\u${cp.toString(16).padStart(4,'0')}` : `\\x${cp.toString(16).padStart(2,'0')}`;
  });
}
/**
 * An agent's own words with the markdown it writes for a chat window taken
 * out, for a card or the Inspector: a link is its text, bold, code and
 * heading marks go, and a full commit hash is cut to the seven characters git shows. The
 * raw text stays the log's and the brief material's. Takes raw text; the
 * result still needs `monitorText`.
 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g,'$1')
    .replace(/\*\*([^*\n]+?)\*\*/g,'$1')
    .replace(/__([^_\n]+?)__/g,'$1')
    .replace(/`+/g,'')
    .replace(/(^|\s)#{1,6}(?=\s)/g,'$1')
    .replace(/\b[0-9a-f]{40}\b/g,hash=>hash.slice(0,7));
}
export function fit(text: string, width: number): string {
  const clipped = truncateAnsi(text, Math.max(0,width));
  return clipped + ' '.repeat(Math.max(0,width-visualLength(clipped)));
}
export function pair(left: string, right: string, width: number): string {
  if (!right) return truncateAnsi(left,width);
  const rightWidth = visualLength(right);
  if (rightWidth >= width) return truncateAnsi(right,width);
  return fit(left,width-rightWidth-1)+' '+right;
}
function wrapped(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = []; let line = '';
  for (const char of monitorText(text)) {
    if (visualLength(line+char) > width && line) { lines.push(line); line=''; }
    line += char;
  }
  lines.push(line);
  return lines.map(s => truncateAnsi(s,width));
}
function helpLines(text: string, width: number): string[] {
  const lines: string[]=[];let line='';
  for(const word of text.split(/\s+/)){
    if(line&&visualLength(line+' '+word)>width){lines.push(line);line='';}
    if(visualLength(word)>width){if(line)lines.push(line);lines.push(...wrapped(word,width));line='';}
    else line+=(line?' ':'')+word;
  }
  if(line)lines.push(line);
  return lines;
}
/**
 * Wrap prose that may mix Chinese and English. A line can break between any
 * two CJK characters but not inside a Latin word, so a Chinese sentence fills
 * its lines instead of breaking only at the few spaces it has. A word longer
 * than a line is split anyway. Takes sanitized text.
 */
const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh',{granularity:'word'}) : null;
/**
 * What a line may break between: runs of ASCII, spaces, and for other text
 * its words where the runtime can tell them (「实验」 is not split into 实 and
 * 验), else its characters.
 */
function flowTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(/[\x21-\x7e]+|\s+|[^\s\x21-\x7e]+/gu) ?? []) {
    if (/^[\s\x21-\x7e]/u.test(run) || !wordSegmenter) tokens.push(...(/^[\s\x21-\x7e]/u.test(run) ? [run] : run));
    else for (const {segment} of wordSegmenter.segment(run)) tokens.push(segment);
  }
  return tokens;
}
export function flowLines(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  let line = '';
  const push = () => { lines.push(line.trimEnd()); line = ''; };
  // Closing punctuation stays with the text before it: a line that starts
  // with "。" or "，" reads as a stray mark.
  const closing = /^[。，、；：！？）」』】》〉…%,.;:!?)\]}]/u;
  let last = '';
  for (const token of flowTokens(text)) {
    if (/^\s+$/.test(token)) { if (line) line += ' '; continue; }
    if (line && visualLength(line+token) > width) {
      if (closing.test(token) && visualLength(line+token) <= width+2 && [...line].length > 1) {
        // Carry the last word down with it rather than strand the mark; a
        // word that is the whole line gives up its last character instead.
        const whole = last && line.endsWith(last) && line.length > last.length;
        const carried = whole ? last : [...line].pop()!;
        line = line.slice(0,line.length-carried.length);
        push();
        line = carried;
      } else push();
    }
    last = token;
    if (visualLength(token) > width) {
      for (const char of token) { if (visualLength(line+char) > width) push(); line += char; }
    } else line += token;
  }
  if (line.trim()) push();
  return lines;
}
/**
 * `flowLines`, evened out: the same number of lines, wrapped at the narrowest
 * width that still gives that number, so a paragraph does not end in a line
 * of one or two characters.
 */
export function balancedLines(text: string, width: number): string[] {
  const lines = flowLines(text,width);
  if (lines.length < 2) return lines;
  let best = lines;
  for (let narrower = width-1; narrower >= Math.ceil(width/2); narrower--) {
    const tried = flowLines(text,narrower);
    if (tried.length !== lines.length) break;
    best = tried;
  }
  return best;
}
/**
 * Icons stand in for the panel's words (a brief field's label, "ago" after a
 * time) unless the reader set glyphs to text; then the words stay.
 */
export function iconic(): boolean {
  return displayConfig().glyphs !== 'text';
}
/** How long ago, as the panel says it: "12d" where icons stand in for words, else "12d ago". */
export function agoText(at: Date | undefined, now: number): string {
  return iconic() ? age(at,now) : t('{age} ago',{age:age(at,now)});
}
/**
 * Seconds, minutes, hours or days since `at`, the coarsest unit that is not
 * zero; days past two of them, where "308h" is a sum the reader has to do.
 * The panel's one relative-time formatter: cards, timeline, inspector and
 * status card all say a time this way.
 */
export function age(at: Date | undefined, now: number): string {
  if (!at || !Number.isFinite(at.getTime())) return '?';
  const seconds = Math.max(0, Math.floor((now-at.getTime())/1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m`
    : seconds < 2*86_400 ? `${Math.floor(seconds/3600)}h` : `${Math.floor(seconds/86_400)}d`;
}
export function nodeStatus(node: SubagentTreeNode, now: number): {icon:string; label:string; paint:(s:string)=>string} {
  switch (node.status) {
    case 'running': return {icon:'▸',label:node.turnStartedAt ? age(node.turnStartedAt,now) : 'run',paint:theme.info};
    case 'starting': return {icon:'·',label:'start',paint:theme.info};
    case 'completed': return {icon:'✓',label:'done',paint:theme.success};
    case 'error': return {icon:'!',label:'error',paint:theme.error};
    default: return {icon:'?',label:'unknown',paint:colors.dim};
  }
}
export function worktreeLabel(entry: WorktreeInfo, now: number): string {
  if (entry.bare) return 'bare';
  if (entry.prunable !== undefined) return 'prunable';
  if (entry.error) return 'unreadable';
  if (!entry.status || entry.observedAt === undefined) return '?';
  if (now-entry.observedAt > 30_000) return 'stale';
  if (entry.status.conflicts) return `!${entry.status.conflicts}`;
  return entry.status.changed ? `${entry.status.changed} mod` : 'clean';
}
/** A worktree label in the reader's language; the label itself stays a stable code. */
function worktreeLabelText(label: string): string {
  const changed = label.match(/^(\d+) mod$/);
  return changed ? t('{n} mod',{n:changed[1]}) : label.startsWith('!') ? label : t(label);
}
function basename(path: string): string { return path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1) || path; }
function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const found = findNode(node.children,id); if (found) return found; }
  return undefined;
}

/**
 * How long the current turn has run, as a clock face rather than a number:
 * the hand sits in the quarter of the hour the turn has reached, an empty
 * face is a turn under a minute old and a filled one has run past the hour.
 * The exact figure is one Enter away in the Inspector. All six glyphs are
 * one column wide in CJK terminals too, and none is an effort glyph.
 */
export const TURN_CLOCKS: ReadonlyArray<readonly [number, string]> = [
  [60_000,'◌'],[900_000,'◷'],[1_800_000,'◶'],[2_700_000,'◵'],[3_600_000,'◴'],
];
const TURN_CLOCK_LONG = '◉';
/** Columns of an agent row's context meter. */
export const CONTEXT_METER_WIDTH = 3;

/**
 * An agent's context fill as a short horizontal line: heavy where used,
 * light where free, with a half step. Block characters fill the whole cell
 * height in many fonts and read as a tile rather than a fill; a line stays
 * a line. Colour follows the same thresholds as the bar's context meter.
 */
export function contextLine(percent: number, cells: number): string {
  const clamped = Math.max(0,Math.min(100,percent));
  const halves = clamped > 0 ? Math.max(1,Math.round(clamped/100*cells*2)) : 0;
  const full = Math.floor(halves/2);
  const half = halves%2 ? '╸' : '';
  const used = '━'.repeat(full)+half;
  return getContextColor(clamped)(used)+colors.dim('─'.repeat(Math.max(0,cells-visualLength(used))));
}
/** A running agent with no event of any kind for this long is quiet, not necessarily stuck. */
export const QUIET_MS = 5 * 60_000;
/** A finished row stays bright this long, then recedes until the linger window takes it. */
export const FRESH_FINISH_MS = 60_000;

export function isLive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}
export function isQuiet(node: SubagentTreeNode, now: number): boolean {
  const at = node.lastEventAt?.getTime();
  return isLive(node) && at !== undefined && Number.isFinite(at) && now-at > QUIET_MS;
}
export function turnClock(node: SubagentTreeNode, now: number): string {
  if (!isLive(node)) return '';
  const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
  if (start === undefined || !Number.isFinite(start)) return '';
  const elapsed = Math.max(0,now-start);
  const glyph = TURN_CLOCKS.find(([limit]) => elapsed < limit)?.[1] ?? TURN_CLOCK_LONG;
  return isQuiet(node,now) ? theme.warning(glyph) : theme.info(glyph);
}

/** Past a clock's boundary, so the repaint lands after its second has turned. */
const REPAINT_SLACK_MS = 20;

/**
 * How long until the panel's text next changes with no new data. Nothing in
 * the panel animates faster than a second: its clocks and ages count whole
 * seconds ("4m07s", "12s ago", "↺45s") and the agent rows' clock glyphs move
 * on the quarter hour. So it repaints once a second, timed to just after the
 * main turn clock's second turns over while a turn runs (`anchorMs`, its
 * start: those are the digits a reader watches tick), otherwise after the
 * wall clock's. A fixed phase also keeps a clock from skipping a second
 * when a timer runs late.
 */
export function nextRepaintDelay(nowMs: number, anchorMs?: number): number {
  const origin = anchorMs !== undefined && Number.isFinite(anchorMs) ? anchorMs : 0;
  const into = (((nowMs - origin) % 1000) + 1000) % 1000;
  return 1000 - into + REPAINT_SLACK_MS;
}

/**
 * Cut the middle out of a name that does not fit. Agent names share their
 * beginnings (`b05_result_review`, `b05_result_diagnosis`); the end is what
 * tells them apart. Takes sanitized text with no escapes in it.
 */
export function squeeze(text: string, width: number): string {
  if (visualLength(text) <= width) return text;
  if (width < 4) return truncateAnsi(text,width);
  const chars = [...text];
  let head = '';
  for (const ch of chars) { if (visualLength(head+ch) > Math.ceil((width-1)*0.6)) break; head += ch; }
  let tail = '';
  for (let i = chars.length-1; i >= 0; i--) {
    if (visualLength(head)+1+visualLength(chars[i]+tail) > width) break;
    tail = chars[i]+tail;
  }
  return `${head}…${tail}`;
}

/** When a finished agent finished: its completion event, else its last sign of life. */
export function finishedAt(node: SubagentTreeNode): Date | undefined {
  return node.statusAt ?? node.lastEventAt;
}

/**
 * The agents' heading: what is running, failed and done, and the switch for
 * what the linger window put away. The whole row is that switch.
 */
export function summaryRow(input: MonitorData, state: MonitorState, width: number, now: number): {row: MonitorRow; total: number; expired: number} {
  const everyone = visibleRows(input.tree.nodes,{...state.tree,filter:'all',collapsed:new Set(),showAll:true},now);
  const totals = {run:0,done:0,error:0,unknown:0};
  for (const {node} of everyone) totals[node.status === 'running' || node.status === 'starting' ? 'run' : node.status === 'completed' ? 'done' : node.status === 'error' ? 'error' : 'unknown']++;
  // What the linger window puts away, counted whether or not it is showing.
  const expired = countExpired(input.tree.nodes,{...state.tree,showAll:false},now);
  const words = width >= 22;
  const count = (icon: string, paint: (s: string) => string, n: number, word: string) =>
    `${paint(icon)}${n}${words ? colors.dim(` ${t(word)}`) : ''}`;
  // Only what is there: "▸0 run" beside thirty finished agents is noise.
  const summary = [
    totals.error ? count('!',theme.error,totals.error,'failed') : '',
    totals.run ? count('▸',theme.info,totals.run,'run') : '',
    totals.done ? count('✓',theme.success,totals.done,'done') : '',
    totals.unknown ? count('?',colors.dim,totals.unknown,'unknown') : '',
  ].filter(Boolean).join(words ? '  ' : ' ');
  // Guardian reviews under the main session count here, not as agents.
  const chip = guardianChip(input.tree.nodes);
  const headed = chip ? `${summary}${summary ? colors.dim(' · ') : ''}${chip}` : summary;
  // The summary doubles as the switch for what the linger window hid.
  const toggle = !expired ? '' : state.tree.showAll ? colors.dim(t(words ? 'hide old' : '−old'))
    : theme.accent(words ? t('+{n} older',{n:expired}) : `+${expired}`);
  return {row:{text:pair(headed,toggle,width),...(expired ? {action:'toggle-finished' as const} : {})},total:everyone.length,expired};
}

/**
 * "◈5": the guardian reviews among `nodes`, in the info colour while one is
 * running. Empty when there are none.
 */
export function guardianChip(nodes: readonly SubagentTreeNode[]): string {
  const {count,running} = guardianCount(nodes);
  return count ? (running ? theme.info : colors.dim)(`◈${count}`) : '';
}

/** What the agents view says when it has no agent to show. */
export function emptyAgentsText(input: MonitorData, state: MonitorState, total: number, expired: number): string {
  // Until the first read of the rollout lands, an empty tree means nothing.
  return t(!total ? input.loading ? 'Reading session…' : 'No subagents yet'
    : expired && !state.tree.showAll && state.tree.filter === 'all' ? 'All finished · a shows' : 'No matching agents');
}

function agentRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  const {row:head,total,expired} = summaryRow(input,state,width,now);
  const result: MonitorRow[] = [head];
  for (const row of visibleRows(input.tree.nodes,state.tree,now)) {
    const node = row.node;
    const status = nodeStatus(node,now);
    const branch = visualLength(row.prefix) > Math.floor(width/4) ? '… ' : row.prefix;
    const prefix = `${node.id === state.tree.selectedId ? theme.accent('›') : ' '}${colors.dim(branch)}${row.collapsed && row.hasChildren ? '+' : ''}${status.paint(status.icon)} `;
    // A finished parent kept only to show whose child a live agent is recedes,
    // and so does a finished row once the news of it finishing is a minute old.
    const finished = node.status === 'completed' && now-(finishedAt(node)?.getTime() ?? 0) > FRESH_FINISH_MS;
    const dimName = row.context || finished;
    // Same celestial badges as the compact HUD. Narrow panes keep glyphs only.
    const token = width < 10 ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
      mode: width < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
    });
    const badge = token ? truncateAnsi(token, Math.max(2, Math.floor(width/4))) : '';
    // The agent's own context fill, where the row is wide enough to carry it
    // without pushing the badge off: 26 content columns is a 30-column pane,
    // the widest the default split makes, minus its borders. Absent data
    // shows nothing rather than an empty meter.
    // The meter and the clock keep their columns on every row, blank when
    // there is nothing to draw, so meters and clocks line up down the pane.
    const ctx = width < 26 ? '' : node.contextUsage ? contextLine(node.contextUsage.percent,CONTEXT_METER_WIDTH) : ' '.repeat(CONTEXT_METER_WIDTH);
    const clock = width < 12 ? '' : turnClock(node,now) || ' ';
    const right = [guardianChip(node.children),badge,ctx,clock].filter(Boolean).join(' ');
    const room = Math.max(1,width-visualLength(prefix)-(right ? visualLength(right)+1 : 0));
    // Codex's own name, as its /subagents picker prints it: what the agent
    // is doing is the log's to say, under the tree.
    const squeezed = squeeze(monitorText(node.name),room);
    const name = dimName ? colors.dim(squeezed) : squeezed;
    result.push({text:pair(prefix+name,right,width),item:node.id,key:`row:${node.id}`});
  }
  if (result.length === 1) result.push({text:colors.dim(truncateAnsi(emptyAgentsText(input,state,total,expired),width))});
  return result;
}

/** A timeline event in the reader's words. Facts as recorded; nothing inferred. */
export function timelineText(event: WorkbenchEvent): string {
  const subject = event.subject ? monitorText(event.subject) : '';
  switch (event.kind) {
    case 'approval-requested': return subject ? t('Approval asked: {what}',{what:subject}) : t('Approval asked');
    case 'approval-answered': return t('Approval answered');
    case 'compacted': return t('Context compacted');
    case 'quota': {
      const window = formatWindowLabel(event.windowMinutes);
      return t('Quota past {n}%',{n:event.threshold ?? '?'})+(window ? ` (${window})` : '');
    }
    case 'turn-finished': return t('Turn finished');
    case 'turn-interrupted': return t('Turn interrupted');
    case 'turn-failed': return t('Turn failed');
    case 'agent-started': return t('{agent} started',{agent:subject});
    case 'agent-finished': return t('{agent} finished',{agent:subject});
    case 'agent-failed': return t('{agent} failed',{agent:subject});
    case 'tool-failed': return t('Tool failed: {what}',{what:subject});
    default: return monitorText(event.title);
  }
}

/**
 * An agent's own colour, the same on every repaint and in every pane: for
 * following one agent down the timeline and into the Inspector. Not on its
 * card, whose colour is its state.
 */
export function agentPaint(id: string): (s: string) => string {
  const colours = palette().agents;
  let hash = 0;
  for (const ch of id) hash = (hash*31+ch.charCodeAt(0)) >>> 0;
  return colours[hash%colours.length];
}

/** A timeline line before its time: what it says, the agent it is about, and how many it folds. */
interface TimelineLine { at: Date; text: string; paint: (s: string) => string; key: string; count: number; cause?: string }

/**
 * The timeline's lines, newest first, made shorter to read: an agent that
 * started and finished in the list is one line, at the finish ("▸ name 12m
 * ✓"); a guardian review's comings and goings are left out (its failure
 * stays); the same event in a row is one line, "×5", at its newest time.
 * With glyphs on, a finished turn is ⏎, a failed tool ✗, and the rest of an
 * agent's run "▸ name" or "name ✓".
 */
function timelineLines(input: MonitorData): TimelineLine[] {
  const events = input.timeline ?? [];
  const nodes = new Map<string, SubagentTreeNode>();
  walkTree(input.tree.nodes,node=>nodes.set(node.id,node));
  const guardian = (event: WorkbenchEvent) => Boolean(event.agentId && nodes.get(event.agentId) && isGuardian(nodes.get(event.agentId)!));
  // Starts paired with a finish later in the list (the list is newest first).
  const finishes = new Map<string, WorkbenchEvent>();
  const paired = new Set<WorkbenchEvent>();
  const startOf = new Map<WorkbenchEvent, WorkbenchEvent>();
  for (const event of events) {
    if (!event.agentId) continue;
    if (event.kind === 'agent-finished' || event.kind === 'agent-failed') finishes.set(event.agentId,event);
    else if (event.kind === 'agent-started') {
      const end = finishes.get(event.agentId);
      if (end) { paired.add(event); startOf.set(end,event); finishes.delete(event.agentId); }
    }
  }
  const lines: TimelineLine[] = [];
  for (const event of events) {
    if (guardian(event) && event.kind !== 'agent-failed') continue;
    if (event.kind === 'agent-started' && paired.has(event)) continue;
    const plainPaint = (s: string) => s;
    const paint = event.status === 'error' ? theme.error : event.kind === 'quota' || event.kind === 'approval-requested' ? theme.warning : plainPaint;
    const name = event.agentId ? agentPaint(event.agentId)(monitorText(event.subject ?? '')) : '';
    let text = paint(timelineText(event));
    const start = startOf.get(event);
    if (start) {
      const ran = age(start.at,event.at.getTime());
      const mark = event.kind === 'agent-failed' ? theme.error('✗') : theme.success('✓');
      text = iconic() ? `${theme.info('▸')} ${name} ${colors.dim(ran)} ${mark}` : `${t('{agent} ran {time}',{agent:name,time:ran})} ${mark}`;
    } else if (iconic() && event.subject && (event.kind === 'agent-started' || event.kind === 'agent-finished' || event.kind === 'agent-failed')) {
      // Half a run in the list: "▸ name" while it runs, "name ✓" or "name ✗" at its end.
      const who = event.agentId ? name : monitorText(event.subject);
      text = event.kind === 'agent-started' ? `${theme.info('▸')} ${who}` : `${who} ${event.kind === 'agent-failed' ? theme.error('✗') : theme.success('✓')}`;
    } else if (event.agentId && event.subject) {
      // The agent's name in its own colour, the rest in the event's.
      const words = timelineText(event);
      const subject = monitorText(event.subject);
      const at = words.indexOf(subject);
      if (at >= 0) text = paint(words.slice(0,at))+name+paint(words.slice(at+subject.length));
    } else if (iconic() && event.kind === 'turn-finished') text = colors.dim('⏎');
    else if (iconic() && event.kind === 'tool-failed') text = `${theme.error('✗')} ${monitorText(event.subject ?? '')}`;
    const key = `${event.kind ?? event.title}|${event.subject ?? ''}|${event.status}|${start ? 'ran' : ''}`;
    const last = lines.at(-1);
    // The same event again, with nothing between and nothing written about it: one line.
    if (last && last.key === key && !event.cause && !last.cause && !start) { last.count++; continue; }
    lines.push({at:event.at,text,paint,key,count:1,cause:event.cause});
  }
  return lines;
}

function timelineRows(input: MonitorData, width: number, now: number): MonitorRow[] {
  const lines = timelineLines(input);
  if (!lines.length) return [{text:colors.dim(t('No events yet'))}];
  const rows: MonitorRow[] = [];
  for (const line of lines) {
    const when = age(line.at,now);
    rows.push({text:truncateAnsi(`${colors.dim(when.padStart(3))} ${line.text}${line.count > 1 ? colors.dim(` ×${line.count}`) : ''}`,width)});
    // A model-written reading of a failure, marked as such.
    if (line.cause) rows.push(...flowLines(monitorText(line.cause),Math.max(1,width-6)).map((text,i)=>({text:`    ${i ? ' ' : colors.dim('~')} ${text}`})));
  }
  return rows;
}

function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  if (id === 'agents') return agentRows(input,state,width,now);
  if (id === 'timeline') return timelineRows(input,width,now);
  if (id === 'worktrees') {
    const snapshot = input.worktrees;
    if (!snapshot) return [{text:colors.dim(t('Reading worktrees…'))}];
    if (snapshot.error) return [{text:theme.warning(t('No readable repository'))}, {text:colors.dim(t('Set worktreeRoot'))}, ...wrapped(snapshot.error,width).map(text=>({text:colors.dim(text)}))];
    const rows: MonitorRow[] = [];
    if (snapshot.truncated) rows.push({text:theme.warning(t('Worktree list limited'))});
    for (const entry of snapshot.entries) {
      const label = worktreeLabel(entry,now);
      const mark = (entry.path === state.selectedWorktree ? '›' : ' ') + (entry.locked !== undefined ? 'L' : ' ');
      const name = monitorText(entry.branch ?? (entry.detached ? 'detached' : basename(entry.path)))
        + (width >= 40 ? ' · '+monitorText(basename(entry.path)) : '');
      const paint = label.startsWith('!') || entry.error ? theme.warning : label === 'clean' ? colors.dim : theme.value;
      rows.push({text:pair(mark+name,paint(worktreeLabelText(label)),width),item:entry.path});
      // A directory label is useful identity, not a log line. Two lines only when it fits.
      if (width >= 20 && width < 40) rows.push({text:colors.dim(truncateAnsi('  '+monitorText(basename(entry.path)),width)),item:entry.path});
    }
    return rows.length ? rows : [{text:colors.dim(t('No worktrees recorded'))}];
  }
  if (id === 'changes') {
    const git = input.git;
    const rows: MonitorRow[] = [];
    if (!git) return [{text:colors.dim(t('Reading selected worktree…'))}];
    if (git.error) rows.push({text:theme.warning(t('Git incomplete'))});
    if (!git.root) return [...rows,{text:colors.dim(t('No selected worktree'))}];
    const changed = (x:string) => x !== ' ' && x !== '.' && x !== '?';
    const conflicts = git.files.filter(file=>file.conflict).length;
    if (conflicts) rows.push({text:theme.warning(t('! {n} conflicts',{n:conflicts}))});
    if (git.files.length) {
      const staged=git.files.filter(f=>!f.conflict&&changed(f.index)).length;
      const unstaged=git.files.filter(f=>!f.conflict&&changed(f.worktree)).length;
      rows.push({text:colors.dim(width<36?`${git.files.length}Δ ${staged}S ${unstaged}U`:t('{n} files · {s} staged · {u} unstaged',{n:git.files.length,s:staged,u:unstaged}))});
      // What the diff does, in the model's words, marked as such; older than the diff, it says so.
      const summary = input.notes?.changes;
      if (summary) {
        for (const line of summary.lines) rows.push(...flowLines(monitorText(line),Math.max(1,width-2)).map((text,i)=>({text:`${i ? ' ' : colors.dim('~')} ${text}`})));
        if (!summary.current) rows.push(...flowLines(t('(written {age}, before the latest edits)',{age:writtenAge(summary.at,now)}),Math.max(1,width-2)).map(text=>({text:colors.dim(`  ${text}`)})));
      }
    }
    return [...rows, ...git.files.map(file => ({item:file.path,
      text:truncateAnsi(`${file.path===state.selectedFile?'›':' '} ${file.conflict?theme.error('!!'):file.index+file.worktree} ${monitorText(width<36?basename(file.path):file.path)}`,width)})),
      ...(git.files.length ? [] : [{text:colors.dim(t(git.error ? 'Status unknown' : 'Working tree clean'))}])];
  }
  // Inspector is explicitly opened (Enter/v/4), never follows agent clicks into a transcript.
  let lines: string[] = [];
  if (state.preview === 'agent') {
    const node = findNode(input.tree.nodes,state.tree.selectedId);
    if (!node) lines = [t('Select an agent')];
    else {
      const token = renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined);
      const status = nodeStatus(node,now);
      // Sanitize external text before painting. Never pass our own ANSI spans
      // back through monitorText (which correctly escapes untrusted controls).
      // Both names show here: the model's name for what the agent does, and
      // the name Codex's own picker and transcript print.
      // The heading in the agent's own colour, as the timeline names it.
      const own = agentPaint(node.id);
      const rows: MonitorRow[] = wrapped(node.label ?? node.name,width).map(text=>({text:theme.strong(own(text))}));
      if (node.label && node.label !== node.name) rows.push(...wrapped(t('Name: {name}',{name:node.name}),width).map(text=>({text:colors.dim(text)})));
      // The full task path locates a nested agent; a one-segment path says
      // nothing the name did not.
      if (node.agentPath && node.agentPath.split('/').filter(Boolean).length > 2)
        rows.push(...wrapped(node.agentPath,width).map(text=>({text:colors.dim(text)})));
      if (token) rows.push({text:truncateAnsi(token,width)});
      const finished = node.status === 'completed' ? colors.dim(` · ${t('{age} ago',{age:age(finishedAt(node),now)})}`) : '';
      rows.push({text:truncateAnsi(`${status.paint(status.icon)} ${t(node.status)}${finished}`,width)});
      const ctx = node.contextUsage;
      if (ctx) rows.push({text:truncateAnsi(
        `${colors.dim(t('Ctx'))} ${ctx.percent}% (${formatTokenCount(ctx.used)}/${formatTokenCount(ctx.total)})`,width)});
      // What the agent last said about its work. It is the agent's own words,
      // not a checked result, so it is labelled as such and kept to a few
      // lines until asked for in full.
      const report = node.lastReport;
      if (report) {
        const prior = node.turnStartedAt && report.at < node.turnStartedAt;
        rows.push({text:colors.dim(truncateAnsi(`${t(prior ? 'Previous turn' : 'Latest update')} · ${t('{age} ago',{age:age(report.at,now)})}`,width))});
        const text = flowLines(monitorText(plainText(report.text).replace(/\s+/g,' ').trim()),width);
        const shown = state.expanded ? text : text.slice(0,REPORT_LINES);
        if (shown.length < text.length) {
          let last = [...shown[shown.length-1]];
          while (last.length && visualLength(`${last.join('')} …`) > width) last = last.slice(0,-1);
          shown[shown.length-1] = `${last.join('').trimEnd()} …`;
        }
        rows.push(...shown.map(line=>({text:line})));
      }
      // What a model read from the final answer and from the failure, marked as such.
      const log = input.agentLog?.get(node.id) ?? [];
      const latest = (kind: AgentLogKind) => [...log].reverse().find(entry=>entry.kind===kind);
      const written = (kind: AgentLogKind, heading: string) => {
        const entry = latest(kind);
        if (!entry || (kind === 'digest' && node.status !== 'completed') || (kind === 'cause' && node.status !== 'error')) return;
        rows.push({text:colors.dim(truncateAnsi(`~ ${t(heading)} · ${writtenAge(entry.at,now)}`,width))});
        rows.push(...entry.text.split(' · ').flatMap(part=>flowLines(monitorText(part),width)).map(line=>({text:line})));
      };
      written('digest','Result digest');
      written('cause','Failure cause');
      // A guardian's task is Codex's review prompt, the same every time.
      if (node.task && !isGuardian(node) && (state.expanded || !report)) {
        rows.push({text:colors.dim(t('Task'))});
        rows.push(...flowLines(monitorText(node.task.replace(/\s+/g,' ').trim()),width).map(line=>({text:line})));
      }
      // The agent's whole log, newest first.
      if (log.length) {
        rows.push({text:colors.dim(t('Log'))});
        for (const entry of [...log].reverse()) rows.push(...logEntryLines(entry,width,now,0).map(text=>({text})));
      }
      lines = [t('Turn age: {age}',{age:age(node.turnStartedAt,now)}),t('Last activity: {age}',{age:age(node.lastEventAt,now)})+(isQuiet(node,now) ? t(' (quiet)') : '')];
      // Codex's transcript still calls the agent by its nickname.
      if (node.nickname && node.nickname !== node.name) lines.push(t('Nickname: {name}',{name:node.nickname}));
      if (node.role) lines.push(t('Role: {role}',{role:node.role}));
      if (state.expanded) lines.push(t('Turn start: {at}',{at:node.turnStartedAt && Number.isFinite(node.turnStartedAt.getTime()) ? node.turnStartedAt.toISOString() : t('unknown')}),`UUID: ${node.id}`);
      rows.push(...lines.flatMap(line=>helpLines(monitorText(line),width).map(text=>({text}))));
      rows.push({text:colors.dim(truncateAnsi(t(state.expanded?'v Less':'v More'),width))});
      return rows;
    }
  } else if (state.preview === 'worktree') {
    const entry = input.worktrees?.entries.find(e=>e.path===state.selectedWorktree);
    if (!entry) lines = [t('Select a worktree')];
    else {
      lines = [t('Branch: {branch}',{branch:entry.branch ?? t(entry.bare?'bare':'detached')}),t('Status: {status}',{status:worktreeLabelText(worktreeLabel(entry,now))}),basename(entry.path)];
      if (entry.error) lines.push(entry.error);
      if (entry.locked !== undefined) lines.push(t('Locked: {reason}',{reason:entry.locked || t('yes')}));
      if (entry.prunable !== undefined) lines.push(t('Prunable: {reason}',{reason:entry.prunable || t('yes')}));
      if (entry.status) lines.push(t('{s} staged / {u} unstaged',{s:entry.status.staged,u:entry.status.unstaged}),
        t('{n} untracked / {c} conflicts',{n:entry.status.untracked,c:entry.status.conflicts}),
        t('Ahead {a} / behind {b}',{a:entry.status.ahead ?? '?',b:entry.status.behind ?? '?'}));
      lines.push(t('Workspace status, not agent ownership'));
      if (state.expanded) lines.push(entry.path,`HEAD: ${entry.head ?? '?'}`);
      lines.push(t(state.expanded?'v Less':'v More'));
    }
  } else {
    lines = [state.selectedFile ? basename(state.selectedFile) : t('No selected file')];
    if (state.expanded) lines.push(input.git?.root ?? t('No selected worktree'),state.selectedFile ?? '');
    return [...lines.flatMap(line=>wrapped(line,width).map(text=>({text:theme.strong(text)}))), ...(input.diff ?? [t('Reading diff…')]).flatMap(line=>{
      const paint = line.startsWith('@@') ? theme.info : line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.error : theme.value;
      return wrapped(line,width).map(text=>({text:paint(text)}));
    })];
  }
  return lines.flatMap(line => wrapped(line,width).map(text=>({text})));
}

/**
 * What the brief said besides its fields: a reply in another shape than the
 * JSON asked for, as the text it is, and a failed call. Model output is
 * sanitized like any other external string.
 */
export function briefSaid(input: MonitorData, width: number): string[] {
  const brief = input.brief;
  const failure = brief?.error ? flowLines(monitorText(brief.error),Math.max(1,width)).map(text=>theme.warning(text)) : [];
  // A reply in another shape than the JSON asked for is shown as the text it is.
  const body = brief?.text && !brief.structured && !brief.items && !brief.overall
    ? brief.text.split('\n').map(line=>line.trim()).filter(Boolean).flatMap(line=>flowLines(monitorText(line),Math.max(1,width))) : [];
  // A line restored from an earlier panel has no reply text behind it: its failure is all there is.
  const spoke = Boolean(brief?.text || brief?.overall);
  return [...body,...(spoke ? failure.slice(0,1) : failure)];
}

/** The brief's rule as a row, its switch a click target. */
export function briefRuleRow(brief: NonNullable<MonitorData['brief']>, width: number): MonitorRow {
  const rule = briefRule(brief,width);
  return {text:rule.line,key:'brief',...(rule.control ? {controls:[{kind:'brief' as const,x:rule.control.x,width:rule.control.width}]} : {})};
}

/**
 * Compact: the area under the agents: the Brief rule, then the main recap,
 * the whole-picture sentence, and the per-agent log. With no brief
 * configured but the log asked for, the rule names the log alone and carries
 * no switch. `spaced` puts a blank line between the parts.
 */
function briefRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const brief = input.brief;
  if (!brief && !input.agentLog) return [];
  const rule = brief ? briefRuleRow(brief,width) : {text:colors.dim(truncateAnsi(`${t('─ Agent log')} ${'─'.repeat(width)}`,width)),key:'brief'};
  // The same fields as the status card's, a column in from the rule.
  const head: MonitorRow[] = brief?.recap ? [{text:colors.dim(truncateAnsi(` ${t('Main recap')} · ${writtenAge(brief.recap.at,now)}`,width)),key:'recap'}] : [];
  let top: MonitorRow[] = [...head,...briefFields(input,Math.max(1,width-1)).flatMap(field=>field.lines.map(line=>({text:' '+line,key:field.id === 'said' ? 'said' : 'recap'})))];
  // Paused, the last brief stays for reference but steps back.
  if (brief?.paused) top = top.map(row=>({...row,text:colors.dim(stripAnsi(row.text))}));
  const gap = (on: unknown): MonitorRow[] => on && spaced ? [{text:''}] : [];
  const log = input.agentLog ? logRows(input,state,width,now,spaced) : [];
  return [{text:''},rule,...top,...gap(top.length && log.length),...log];
}

/** Entries a model wrote, marked as such wherever they are shown. */
export const MODEL_LOG_KINDS: ReadonlySet<AgentLogKind> = new Set(['note','digest','cause']);
/** Log entries shown per agent; the selected agent shows more, the Inspector all. */
const LOG_ENTRIES = 2;
const LOG_ENTRIES_SELECTED = 6;

/**
 * One log entry: its age, then what happened. Status changes are words in
 * the tree's colours; an update is the agent's own excerpt; what a model
 * wrote is marked with a muted "~".
 */
function logEntryLines(entry: AgentLogEntry, width: number, now: number, indent: number): string[] {
  const when = age(new Date(entry.at),now);
  const status = entry.kind === 'started' ? theme.info : entry.kind === 'finished' ? theme.success : entry.kind === 'failed' ? theme.error : null;
  const model = MODEL_LOG_KINDS.has(entry.kind);
  const text = status ? t(entry.kind) : entry.text;
  const paint = status ?? (entry.attention ? theme.warning : (s: string) => s);
  const lead = `${when} ${model ? '~ ' : ''}`;
  return flowLines(monitorText(`${lead}${text}`),Math.max(1,width-indent)).map((line,i)=>{
    const pad = ' '.repeat(indent);
    if (i) return pad+paint(line);
    return pad+colors.dim(line.slice(0,lead.length))+paint(line.slice(lead.length));
  });
}

/**
 * The per-agent log: a block per agent the tree shows, newest news first
 * (the selected agent leads, opened up), each headed by the agent as its
 * tree row shows it. What the tree hides, the log hides; a collapsed parent
 * gets one line counting the logs folded under it. Nothing is deleted by
 * hiding: showing the agent again shows all of it.
 */
function logRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const logs = input.agentLog!;
  const shown = visibleRows(input.tree.nodes,state.tree,now);
  const blocks: Array<{node: SubagentTreeNode; entries: readonly AgentLogEntry[]; folded: number; newest: number}> = [];
  for (const row of shown) {
    const entries = logs.get(row.node.id) ?? [];
    const folded = row.collapsed && row.hasChildren
      ? visibleRows(row.node.children,{...state.tree,collapsed:new Set()},now).filter(child=>(logs.get(child.node.id)?.length ?? 0) > 0).length : 0;
    if (!entries.length && !folded) continue;
    blocks.push({node:row.node,entries,folded,newest:entries.at(-1)?.at ?? 0});
  }
  const selected = state.tree.selectedId;
  blocks.sort((a,b)=>Number(b.node.id === selected)-Number(a.node.id === selected) || b.newest-a.newest);
  const rows: MonitorRow[] = [];
  for (const [index,{node,entries,folded}] of blocks.entries()) {
    // A blank line between agents is what makes one block end and the next
    // begin at a glance.
    if (spaced && index) rows.push({text:''});
    // Each line of the block is a click target that selects its agent.
    const push = (text: string) => rows.push({text,key:`log:${node.id}`,controls:[{kind:'log',item:node.id,x:0,width}]});
    const st = nodeStatus(node,now);
    // What the panel knows for itself is not left to the model: a failed or
    // quiet agent needs a look, and so does one the latest note flagged.
    const attention = node.status === 'error' || isQuiet(node,now) || Boolean(entries.at(-1)?.attention);
    const title = agentTitle(node);
    const head = `${attention ? theme.warning('!') : ' '}${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
    const name = squeeze(title.name,Math.max(1,width-visualLength(head)));
    push(head+(attention ? theme.warning(name) : theme.strong(name)));
    // Under the name that identifies it, what the agent is for.
    for (const line of taskLines(title,Math.max(1,width-3)).lines) push('   '+(title.renamed ? line : colors.dim(line)));
    const count = node.id === selected ? LOG_ENTRIES_SELECTED : LOG_ENTRIES;
    for (const entry of [...entries].reverse().slice(0,count)) for (const line of logEntryLines(entry,width,now,3)) push(line);
    if (folded) push(colors.dim(truncateAnsi(`   ${t('+{n} folded below',{n:folded})}`,width)));
  }
  return rows;
}

/** When something written once was written: no seconds ticking, days for an old one. */
export function writtenAge(at: number, now: number): string {
  const seconds = Math.max(0,Math.floor((now-at)/1000));
  if (seconds < 60) return t('just now');
  return t('{age} ago',{age:age(new Date(at),now)});
}

/**
 * "─ Brief · writing… ──────── b pause": the rule heading the brief, with
 * the switch that holds the model calls at its right end. No age: a counter
 * ticking up every second said nothing a reader acts on. The switch is where
 * the eye already is, and says what pressing it does.
 */
export function briefRule(brief: NonNullable<MonitorData['brief']>, width: number): {line: string; control?: {x: number; width: number}} {
  const status = brief.paused ? t('paused') : brief.running ? t('writing…') : brief.error ? t('failed') : '';
  const label = `${t('─ Brief')}${status ? ` · ${status}` : ''} `;
  const switchText = ` ${t(brief.paused ? 'b resume' : 'b pause')} `;
  const room = width-visualLength(label)-visualLength(switchText);
  if (room < 1) return {line:colors.dim(truncateAnsi(label+'─'.repeat(Math.max(0,width-visualLength(label))),width))};
  const paint = brief.paused ? theme.accent : colors.dim;
  return {line:colors.dim(label+'─'.repeat(room))+paint(switchText),control:{x:width-visualLength(switchText),width:visualLength(switchText)}};
}

function walkTree(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkTree(node.children,visit); }
}

/** An agents view shorter than this drops its blank lines rather than scroll past most of what it holds. */
const DENSE_BELOW = 12;

/**
 * The agents view's rows, its summary line first: in rich style a card per
 * agent (the main session's brief is in the status card at the foot); in
 * compact the tree, then the brief and log under it. One view, scrolled as one.
 */
function agentsView(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  if (state.style === 'rich') return richRows(input,state,width,now,spaced);
  return [...agentRows(input,state,width,now),...briefRows(input,state,width,now,spaced)];
}

/** Lines of the latest update the Inspector shows before "v More". */
const REPORT_LINES = 6;
const TITLES: Record<MonitorPane,string> = {agents:'1 Agents',worktrees:'2 Worktrees',changes:'3 Changes',details:'4 Inspector',timeline:'5 Timeline'};
export function renderMonitor(input: MonitorData): MonitorFrame {
  const width = Math.max(0,Math.floor(input.width)); const height = Math.max(0,Math.floor(input.height));
  const state = reconcileMonitor(input.state,input.tree,input.git,input.worktrees,input.nowMs ?? Date.now());
  const frame: MonitorFrame = {lines:[],panes:[],controls:[],state};
  if (!width || !height) return frame;
  if (state.help) {
    const rich = state.style === 'rich';
    // The keys as the current layout has them: cards in rich, the tree in compact.
    const help = [rich ? '1 Cards  2 Worktrees' : '1 Agents  2 Worktrees','3 Changes  4 Inspector','5 Timeline','x close pane  - fold','2–5 open a pane','Tab next visible pane','j/k select  o switch','g/G first / last','PgUp/PgDn or wheel scroll',
      ...(rich ? ['e or Space open / close card','Click card: select','Click its name: switch','Click top rule or ▾: open'] : []),
      'h/l fold / unfold agent','f or / filter  s order',...(rich ? [] : ['Click agent: switch']),'m return Main','a show/hide older','Enter / v inspect','v more / less details','z zoom  Esc back','q close tree  , settings','b pause / resume brief',rich ? 'r status card: min / status / full' : 'r status card: min / status',...(rich ? ['Wheel over the card: its brief'] : []),'Click the card\'s top edge: same as r',...(rich ? [] : ['Click a log line: select agent']),'✓ = turn completed','? = no status evidence','! = needs a look',
      '⌕ research  ⚗ experiment  ⚒ fix','◈ review  ✎ writing  ∑ summary']
      .map(line=>t(line))
      .concat(t('{clocks} turn <1m, the quarter hour, 1h+',{clocks:TURN_CLOCKS.map(([,glyph])=>glyph).join('')+TURN_CLOCK_LONG}),
        ...['~ = written by a model','Brief: ! needs  ◎ goal  ▸ now  ✓ done  ⚑ approve','b‖ / b▸ pause / resume brief  ~… writing',
          'status card frame colour = main session state','┃ = auto-compact point','◈N = guardian reviews  +N = folded agents','Timeline: ⏎ turn finished  ×N in a row','yellow clock = quiet 5m+','━╸─ = context or quota used','dim name = done 1m+ ago','mod / Δ = changed files','S staged · U unstaged','L = locked worktree','stale = >30s since read'].map(line=>t(line)),
        ...stripAnsi(modelLegend()).split('\n'))
      .flatMap(line=>helpLines(line,width));
    const count = Math.max(0,height-2);
    state.helpScroll = Math.max(0,Math.min(state.helpScroll??0,Math.max(0,help.length-count)));
    frame.helpPage = {count,total:help.length};
    frame.lines = [theme.accent(t('Monitor keys')),...help.slice(state.helpScroll,state.helpScroll+count)];
    while(frame.lines.length<height-1)frame.lines.push('');
    if(height>1)frame.lines.push(colors.dim(t('↑↓ {at}/{total} Esc back',{at:state.helpScroll+1,total:help.length})));
    frame.lines = frame.lines.slice(0,height).map(line=>truncateAnsi(line,width));return frame;
  }
  // Under 24 columns the frame costs more than it earns: two border columns
  // out of sixteen is an eighth of every row spent on decoration. Narrow panes
  // keep the rules that separate them and give the rest back to the content.
  const bordered = width>=24;
  const padding = bordered ? ' ' : '';
  const inner = bordered ? Math.max(0,width-2-2*padding.length) : width;
  const now = input.nowMs ?? Date.now();
  const notice = input.notice || input.error;
  const noticeRows = notice && height >= 6 ? wrapped(notice,Math.max(1,width-2)).slice(0,2) : [];
  // The status card takes the foot, at the level chosen, at most about half
  // the panel; it replaces the key hint's own line.
  const footPlan = planFoot(input,state,width,height,now,noticeRows.length);
  const footRows = footPlan.rows;
  let budget = Math.max(0,height-1-footRows-noticeRows.length);
  const ids = MONITOR_PANES.filter(id=>(id==='agents' || state.modes[id] !== 'closed') && (!state.zoom || id===state.focus));
  // Agents is the page, not one box among several: no frame, no title, and
  // it can be neither closed nor folded. The other panes stay boxes.
  const edgeOf = (id: MonitorPane) => id === 'agents' ? 0 : 1;
  const content = new Map(ids.map(id=>[id,id === 'agents' ? agentsView(input,state,width,now,true) : paneRows(id,input,state,edgeOf(id) ? inner : width,now)]));
  const sizes = new Map<MonitorPane,number>();
  for (const id of ids) { sizes.set(id,budget>0?1:0); if (budget>0) budget--; }
  const order = [state.focus,...ids.filter(id=>id!==state.focus)].filter(id=>ids.includes(id));
  while (budget > 0) {
    let grew = false;
    for (const id of order) {
      if (!budget) break;
      const rows = content.get(id)?.length ?? 0;
      const target = state.modes[id] === 'folded' && edgeOf(id) ? 1 : state.zoom ? height : rows + 2*edgeOf(id);
      const size = sizes.get(id) ?? 0;
      if (size && size < target) { sizes.set(id,size+1);budget--;grew=true; }
    }
    if (!grew) break;
  }
  // What is left goes to the inspector when it has focus, else to the agents
  // view, where it is the room the art may use. Small worktree lists stay compact.
  const fillable = order.filter(id => (state.modes[id] !== 'folded' || !edgeOf(id)) && (sizes.get(id) ?? 0) > 0);
  const fill = state.focus==='details'&&fillable.includes('details') ? 'details' : fillable.includes('agents') ? 'agents' : fillable[0];
  if(fill){sizes.set(fill,(sizes.get(fill)??0)+budget);budget=0;}
  // Spacing gives way to scrolling, not the other way round, except where the
  // view is so short that blank lines would hide most of what it could show.
  const agentsHeight = sizes.get('agents') ?? 0;
  if (ids.includes('agents') && agentsHeight < DENSE_BELOW && (content.get('agents')?.length ?? 0) > agentsHeight)
    content.set('agents',agentsView(input,state,width,now,false));
  frame.lines = Array.from({length:height},()=>fit('',width));
  frame.lines[0] = theme.accent(pair(t(width < 20 ? ' ← Main' : ' ← Main session'),'m ',width));
  frame.controls.push({kind:'main',x:0,y:0,width});
  let y = 1;
  for (const id of ids) {
    const h = sizes.get(id) ?? 0; if (!h) continue;
    const rows = content.get(id) ?? [];
    if (id === 'agents') { drawAgentsView(frame,state,rows,y,width,h); y += h; continue; }
    const edge = edgeOf(id);
    const width_ = edge ? inner : width;
    const count = Math.max(0,h-2*edge);
    let offset = Math.max(0,Math.min(state.scroll[id],Math.max(0,rows.length-count)));
    const selected = id==='worktrees'?state.selectedWorktree:id==='changes'?state.selectedFile:null;
    const index = selected ? rows.findIndex(row=>row.item===selected) : -1;
    if (index>=0 && count>0) { if(index<offset)offset=index;else if(index>=offset+count)offset=index-count+1; }
    state.scroll[id]=offset;
    const pane = {id,x:0,y,width,height:h,rows,offset,contentLength:rows.length,edge,pinned:0}; frame.panes.push(pane);
    const border = colors.dim;
    const heading = id===state.focus ? theme.accent : colors.dim;
    const buttons = width>=12 ? `[${state.modes[id]==='folded'?'+':'-'}][x]` : '';
    const shortTitle = t({agents:'Agents',worktrees:width<20?'WT':'Worktrees',changes:'Changes',details:'Inspect',timeline:'Timeline'}[id]);
    if(bordered) {
      const title = fit(' '+t(TITLES[id])+' ',Math.max(0,width-2-buttons.length));
      frame.lines[y] = truncateAnsi(heading('┌'+title+buttons+'┐'),width);
    } else {
      // "─ Agents ────[-][x]": the rule doubles as the frame.
      const room = Math.max(0,width-buttons.length);
      const label = truncateAnsi('─ '+shortTitle+' ',room);
      frame.lines[y] = truncateAnsi(heading(label+'─'.repeat(Math.max(0,room-visualLength(label)))+buttons),width);
    }
    if(buttons) {
      const right = bordered ? width-1 : width;
      frame.controls.push({kind:'fold',pane:id,x:right-6,y,width:3},{kind:'close',pane:id,x:right-3,y,width:3});
    }
    for(let i=0;i<count;i++) {
      const row=rows[offset+i];
      const clipped=truncateAnsi(row?.text??'',width_);
      // The highlight covers the row's words, not the blank run after them:
      // a selected short name should not paint a bar across the pane.
      const highlight=row?.item&&row.item===selected&&id===state.focus;
      const body=(highlight?theme.selected(clipped):clipped)+' '.repeat(Math.max(0,width_-visualLength(clipped)));
      frame.lines[y+1+i]=truncateAnsi(bordered?border('│')+padding+body+padding+border('│'):body,width);
    }
    if(h>1) {
      const range=rows.length>count&&count?` ${offset+1}–${Math.min(rows.length,offset+count)}/${rows.length} `:'';
      if(bordered) {
        frame.lines[y+h-1]=truncateAnsi(border('└'+fit(range,Math.max(0,width-2)).replace(/ /g,'─')+'┘'),width);
      } else {
        const head=truncateAnsi('─'+range,width);
        frame.lines[y+h-1]=truncateAnsi(border(head+'─'.repeat(Math.max(0,width-visualLength(head)))),width);
      }
    }
    y+=h;
  }
  const foot = height-footRows;
  if(input.art) placeArt(frame.lines,foot-noticeRows.length,width,input.art);
  for(let i=0;i<noticeRows.length;i++) frame.lines[foot-noticeRows.length+i]=theme.warning(fit(noticeRows[i],width));
  footPlan.draw(frame,foot);
  return frame;
}

/**
 * Put the decoration in the blank run of lines that ends just above `end`,
 * centred, with a blank line kept above and below it so it never touches the
 * brief or the card. It only ever takes lines nothing else drew on, so it
 * goes away by itself as agents and brief text need the room.
 */
function placeArt(lines: string[], end: number, width: number, art: NonNullable<MonitorData['art']>): void {
  let start = end;
  while (start > 1 && stripAnsi(lines[start-1]).trim() === '') start--;
  const rows = end-start-2;
  if (rows <= 0 || width < 8) return;
  const drawing = art(width-2,rows);
  if (!drawing?.length) return;
  const cols = Math.max(...drawing.map(visualLength));
  const left = ' '.repeat(Math.max(0,Math.floor((width-cols)/2)));
  const top = start+1+Math.floor((rows-drawing.length)/2);
  drawing.forEach((line,i)=>{lines[top+i]=fit(left+line,width);});
}

/** Fewest columns of bar a meter draws; under it the meter is its label alone. */
export const METER_MIN = 6;
/**
 * A meter drawn in the gap of a rule, as omp draws its context meter in the
 * top border of its input box: the border is the meter.
 */
export interface EdgeMeter {
  /** How full, 0–100: the share of the bar drawn heavy. */
  percent: number;
  /** The fill's colour, by the same thresholds as its reading. */
  paint: (s: string) => string;
  /** At the head of the bar, painted: "56%", "7d 99%". */
  label?: string;
  /** Closing the bar, painted: the window size, "246K". */
  tail?: string;
  /** Where a known threshold sits, 0–100, drawn "┃". Only one the HUD can read, never a guess. */
  tick?: number;
}

/**
 * The bar alone, `cells` wide: heavy and coloured where used, with a half
 * step, the rest in the rule's own paint, and the tick where it has not been
 * passed yet.
 */
export function meterBar(meter: EdgeMeter, cells: number, rule: (s: string) => string = colors.dim): string {
  const clamped = Math.max(0,Math.min(100,meter.percent));
  const halves = clamped > 0 ? Math.max(1,Math.round(clamped/100*cells*2)) : 0;
  const full = Math.min(cells,Math.floor(halves/2));
  const half = halves%2 && full < cells ? '╸' : '';
  const used = full+half.length;
  const tick = meter.tick !== undefined && meter.tick > 0 && meter.tick < 100 ? Math.min(cells-1,Math.round(meter.tick/100*cells)) : -1;
  let rest = '';
  for (let i = used; i < cells; i++) rest += i === tick ? '┃' : '─';
  return meter.paint('━'.repeat(full)+half)+rule(rest);
}

/**
 * A rule's gap filled as a meter, exactly `room` columns:
 * "56%━━━━━━──────┃─246K". The bar takes what the label and tail leave, in
 * proportion. Short of room the tail goes first, then the bar (under
 * `METER_MIN` columns), then the label; what is left is plain rule. `bar`
 * says whether the bar was drawn, `tail` whether the tail was.
 */
export function meterGap(room: number, meter: EdgeMeter | undefined, rule: (s: string) => string = colors.dim): {text: string; bar: boolean; tail: boolean} {
  const plainRule = {text:rule('─'.repeat(Math.max(0,room))),bar:false,tail:false};
  if (!meter || room <= 0) return plainRule;
  const label = meter.label ?? '';
  const head = visualLength(label);
  const tail = meter.tail ? visualLength(meter.tail)+1 : 0;
  if (room-head-tail >= METER_MIN && tail) return {text:label+meterBar(meter,room-head-tail,rule)+rule('─')+meter.tail,bar:true,tail:true};
  if (room-head >= METER_MIN) return {text:label+meterBar(meter,room-head,rule),bar:true,tail:false};
  if (head && room >= head) return {text:label+rule('─'.repeat(room-head)),bar:false,tail:false};
  return plainRule;
}

/**
 * A rule with texts riding on it, `width` wide: `lead`, " left ", the gap,
 * " right ", `trail`. The gap is plain rule, at least one column, or a meter
 * (`meterGap`). Null when the texts leave no gap, or when `needBar` and the
 * meter's bar would be under `METER_MIN` (or `needTail` and its tail would
 * not fit beside it): the caller then tries a shorter
 * set of texts. `rightX` is where the right text starts, its padding
 * included. The rule's glyphs take `rule`; what rides on it keeps its own
 * colours.
 */
export function edgeLine(width: number, lead: string, trail: string, left: string, right: string,
  meter?: EdgeMeter, needBar = false, rule: (s: string) => string = colors.dim, needTail = false): {line: string; rightX: number; bar: boolean} | null {
  const shownLeft = left ? ` ${left} ` : ' ';
  const shownRight = right ? ` ${right} ` : '';
  const room = width-visualLength(lead)-visualLength(trail)-visualLength(shownLeft)-visualLength(shownRight);
  if (room < 1) return null;
  let gap = meterGap(room,meter,rule);
  // A tail at the end of the rule keeps a space before the corner, as a right text does.
  const spaced = !right && gap.tail && room > 1;
  if (spaced) gap = meterGap(room-1,meter,rule);
  if (meter && ((needBar && !gap.bar) || (needTail && meter.tail && !gap.tail))) return null;
  const line = rule(lead)+shownLeft+gap.text+(spaced && gap.tail ? ' ' : spaced ? rule('─') : '')+shownRight+rule(trail);
  return {line,rightX:visualLength(lead)+visualLength(shownLeft)+room,bar:gap.bar};
}

function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = id==='agents'?'agent':id==='worktrees'?'worktree':id==='changes'?'file':state.preview;
  return {...state,focus:id,preview,modes:{...state.modes,[id]:'open'},scroll:{...state.scroll,details:preview===state.preview?state.scroll.details:0}};
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height - edge) return undefined;
  // Past the rows drawn is the scroll hint, not a row.
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  return monitorRowAt(pane,x,y)?.item || undefined;
}
export function canMonitorDiff(frame?: MonitorFrame): boolean {
  return Boolean(frame?.panes.some(p=>p.id==='details'&&p.height>2&&p.width>=16));
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  let next: MonitorState = {...state,tree:{...state.tree},modes:{...state.modes},scroll:{...state.scroll}};
  let key = input.type==='key'?input.key:'';
  const result = (action?:MonitorOutcome['action'],close=false): MonitorOutcome => ({state:next,close,action});
  if(key==='close') return result(undefined,true);
  // Space is Enter, except on the cards, where it opens or closes the selected one.
  if(key==='space')key=next.style==='rich'&&next.focus==='agents'&&!next.help?'expand':'enter';
  if(next.help) {
    if(['escape','help','enter'].includes(key))next.help=false;
    else {
      if(input.type==='mouse')key=input.button==='wheel-down'?'down':input.button==='wheel-up'?'up':'';
      const page=Math.max(1,ctx.frame?.helpPage?.count??1);
      const delta=key==='down'?1:key==='up'?-1:key==='page-down'?page:key==='page-up'?-page:0;
      const max=Math.max(0,(ctx.frame?.helpPage?.total??0)-page);
      next.helpScroll=key==='home'?0:key==='end'?max:Math.max(0,Math.min(max,(next.helpScroll??0)+delta));
    }
    return result();
  }
  if(input.type==='mouse') {
    const control = input.button==='left'?ctx.frame?.controls.find(c=>input.y===c.y&&input.x>=c.x&&input.x<c.x+c.width):undefined;
    if(control?.kind==='main') return result({type:'switch',id:ctx.tree.rootId});
    if(control?.kind==='settings') return result({type:'settings'});
    if(control?.kind==='brief') return result({type:'brief-toggle'});
    if(control?.kind==='level'){next.statusLevel=nextLevel(next);next.statusScroll=0;return result({type:'status-level'});}
    // What was clicked is in view already: selecting it does not scroll.
    const pick=(id: string)=>{next.tree.selectedId=id;next.preview='agent';next.scroll.details=0;next.revealed=id;next.focus='agents';};
    if(control?.kind==='log'&&control.item){pick(control.item);return result();}
    // A card's top rule or its ▾/▴: open or close its timeline, and select it.
    if(control?.kind==='expand'&&control.item){pick(control.item);next=toggleCard(next,control.item);return result();}
    // A card's name: go to that agent's session, as `o` does on it.
    if(control?.kind==='switch'&&control.item){pick(control.item);return result({type:'switch',id:control.item});}
    if(control?.kind==='more') {
      const pane=ctx.frame?.panes.find(p=>p.id==='agents');
      const page=Math.max(1,(pane?.visible??1)-(pane?.pinned??0));
      const end=pane?pane.offset+(pane.visible??0)>=pane.contentLength:true;
      next.scroll.agents=end?0:next.scroll.agents+page;return result();
    }
    // The wheel over the status card scrolls its brief, the rows above it stay.
    const card=ctx.frame?.statusCard;
    if(input.button!=='left'&&card&&input.y>=card.y&&input.y<card.y+card.height) {
      if(card.total>card.brief) next.statusScroll=Math.max(0,Math.min(card.total-card.brief,(next.statusScroll??0)+(input.button==='wheel-down'?WHEEL_ROWS:-WHEEL_ROWS)));
      return result();
    }
    if(control?.pane) {
      next.focus=control.pane;
      key=control.kind==='close'?'pane-close':'pane-fold';
    } else {
      const pane=ctx.frame?.panes.find(p=>input.x>=p.x&&input.x<p.x+p.width&&input.y>=p.y&&input.y<p.y+p.height);
      if(!pane) return result();
      next.focus=pane.id;
      if(input.button==='left') {
        if((pane.edge ?? 1)&&input.y===pane.y) key='pane-fold';
        else {
          const row=monitorRowAt(pane,input.x,input.y);
          if(row?.action==='toggle-finished'){next.tree.showAll=!next.tree.showAll;return result();}
          const id=row?.item;
          if(!id)return result();
          if(pane.id==='agents') {
            if(!visibleRows(ctx.tree.nodes,next.tree,ctx.nowMs).some(row=>row.node.id===id))return result();
            pick(id);
            // A card is a place to read: a click selects it, `o` switches.
            // A tree row is a list to pick from: a click switches.
            return next.style==='rich'?result():result({type:'switch',id});
          }
          if(pane.id==='worktrees') {next.selectedWorktree=id;next.preview='worktree';}
          if(pane.id==='changes') {next.selectedFile=id;next.preview='file';}
          next.scroll.details=0;return result();
        }
      } else if(pane.id==='agents') {
        // The wheel scrolls what is under it, and leaves the selection be.
        next.scroll.agents=Math.max(0,next.scroll.agents+(input.button==='wheel-down'?WHEEL_ROWS:-WHEEL_ROWS));
        return result();
      } else key=input.button==='wheel-down'?'down':'up';
    }
  }
  if(key==='settings')return result({type:'settings'});
  if(key==='brief-toggle')return result({type:'brief-toggle'});
  // `r` is Reset on the settings page; here it changes how much the status card shows.
  if(key==='reset'){next.statusLevel=nextLevel(next);next.statusScroll=0;return result({type:'status-level'});}
  if(key==='main')return result({type:'switch',id:ctx.tree.rootId});
  if(key==='open-session')return next.focus==='agents'&&next.tree.selectedId?result({type:'switch',id:next.tree.selectedId}):result();
  if(key==='expand'){if(next.style==='rich'&&next.tree.selectedId){next=toggleCard(next,next.tree.selectedId);next.focus='agents';next.revealed=null;}}
  else if(key==='show-all')next.tree.showAll=!next.tree.showAll;
  else if(key==='help'){next.help=true;next.helpScroll=0;}
  // Agents stays; closing or folding it is not a choice the page offers.
  else if(key==='pane-close') {
    if(next.focus!=='agents'){
      next.modes[next.focus]='closed';next.zoom=false;
      next.focus=MONITOR_PANES.find(id=>next.modes[id]!=='closed')??'agents';
    }
  } else if(key==='pane-fold'){if(next.focus!=='agents')next.modes[next.focus]=next.modes[next.focus]==='folded'?'open':'folded';}
  else if(MONITOR_PANES.includes(key as MonitorPane))next=openPane(next,key as MonitorPane);
  else if(key==='tab'||key==='shift-tab') {
    const visible=MONITOR_PANES.filter(id=>next.modes[id]!=='closed');
    if(visible.length)next.focus=visible[(visible.indexOf(next.focus)+(key==='tab'?1:visible.length-1))%visible.length];
  } else if(key==='enter'||key==='detail-toggle') {
    const from=next.focus;
    if(from==='details') {next.expanded=!next.expanded;next.scroll.details=0;return result();}
    if(from==='agents')next.preview='agent';else if(from==='worktrees')next.preview='worktree';else if(from==='changes')next.preview='file';
    next=openPane(next,'details');next.scroll.details=0;
    next.expanded=false;
    if(from==='changes')next.zoom=true;
  } else if(key==='zoom')next.zoom=!next.zoom;
  else if(key==='escape') {
    if(next.zoom)next.zoom=false;
    else if(next.focus==='details'){next.modes.details='closed';next.focus=next.preview==='agent'?'agents':next.preview==='worktree'?'worktrees':'changes';}
    else return result(undefined,true);
  } else {
    const pane=ctx.frame?.panes.find(p=>p.id===next.focus);
    const page=Math.max(1,(pane?.height??5)-2*(pane?.edge??1));
    // A two-line worktree card is one item, not two keyboard destinations.
    const visibleItems = pane ? new Set(pane.rows.slice(pane.offset,pane.offset+page).flatMap(row=>row.item ? [row.item] : [])) : new Set<string>();
    const itemPage = visibleItems.size || page;
    const delta=key==='down'?1:key==='up'?-1:key==='page-down'?itemPage:key==='page-up'?-itemPage:0;
    const move=delta!==0||key==='home'||key==='end';
    if(next.focus==='agents') {
      const rows=visibleRows(ctx.tree.nodes,next.tree,ctx.nowMs);
      // A page key scrolls the view a page; the selection keys move the
      // selection, and the view follows it there.
      if(key==='page-down'||key==='page-up'){
        const view=Math.max(1,(pane?.visible??page)-(pane?.pinned??0)-1);
        next.scroll.agents=Math.max(0,next.scroll.agents+(key==='page-down'?view:-view));
      } else if(move){next.revealed=null;const index=rows.findIndex(row=>row.node.id===next.tree.selectedId);const target=key==='home'?0:key==='end'?rows.length-1:Math.max(0,index)+delta;
        const row=rows[Math.max(0,Math.min(rows.length-1,target))];if(row)next.tree.selectedId=row.node.id;
      } else if(key==='sort')next.tree.sort=next.tree.sort==='active'?'created':'active';
      else if(['left','right','filter'].includes(key))next.tree=applyKey(next.tree,key as 'left'|'right'|'filter',rows).state;
    } else if(move) {
      const ids=pane?[...new Set(pane.rows.map(row=>row.item).filter((id):id is string=>id!==undefined))]:[];
      if(ids.length&&(next.focus==='worktrees'||next.focus==='changes')) {
        const current=next.focus==='worktrees'?next.selectedWorktree:next.selectedFile;
        const index=ids.indexOf(current??'');const target=key==='home'?0:key==='end'?ids.length-1:Math.max(0,index)+delta;
        const id=ids[Math.max(0,Math.min(ids.length-1,target))];
        if(next.focus==='worktrees'){next.selectedWorktree=id;next.preview='worktree';}else{next.selectedFile=id;next.preview='file';}
      }else next.scroll[next.focus]=key==='home'?0:key==='end'?Math.max(0,(pane?.contentLength??0)-page):Math.max(0,next.scroll[next.focus]+delta);
    }
  }
  if(next.tree.selectedId!==state.tree.selectedId||next.selectedWorktree!==state.selectedWorktree||next.selectedFile!==state.selectedFile)next.scroll.details=0;
  return result();
}
