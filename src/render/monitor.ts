/** Default F12 view: a monitor, not another transcript. No I/O or terminal input here. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { GitChanges, GitChangedFile } from '../collectors/git-changes.js';
import type { WorktreesSnapshot, WorktreeInfo } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { initialPanelState, reconcileSelection, visibleRows, applyKey, countExpired, guardianCount, isGuardian, type PanelState } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi, getContextColor, getMeterColor } from './colors.js';
import { palette } from './palette.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { displayConfig, iconSet } from './hud-config.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry, AgentLogKind } from '../collectors/agent-log.js';
import type { StatusCard } from './status-block.js';
import { t } from './i18n.js';
import { agentTitle, shownName, labelled } from './agent-title.js';
import { briefFields, taskLines, richRows, briefLine } from './cards.js';
import { drawAgentsView, WHEEL_ROWS } from './agents-view.js';
import { controlBar, paneHead, icon, look } from './control-bar.js';
import { planFoot, nextLevel, type StatusLevel, type FootInfo } from './status-foot.js';
import { formatWindowLabel } from './quota.js';
import type { WorkbenchEvent } from './workbench-state.js';

export const MONITOR_PANES = ['agents', 'worktrees', 'changes', 'details', 'timeline'] as const;
export type MonitorPane = typeof MONITOR_PANES[number];
export type PaneMode = 'open' | 'closed';
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
  /** A label, once arrived, stands where the agent's name is shown. The panel sets it from settings. */
  labelAsName?: boolean;
  /** How far the status card's brief is scrolled. */
  statusScroll?: number;
  /**
   * The panes as a browser's tabs: one shown at a time, the bar's tabs
   * switching between them, and `modes` kept as the stacked panes left them.
   * The panel sets it from settings.
   */
  tabbed?: boolean;
}
export type PanelStyle = 'rich' | 'compact';
/** A click target on a row; `x` counts from the row's start. */
export interface RowControl { kind: MonitorControl['kind']; item?: string; x: number; width: number }
/**
 * `item` is what a click selects. `key` names the block a row belongs to, so a scrolled view can
 * keep its place; `controls` are click targets on the row.
 */
export interface MonitorRow { text: string; item?: string; key?: string; controls?: RowControl[];
  /** The text shortened, for where it does not fit: the agents' counts without their words. */
  short?: string }
export interface MonitorRect {
  id: MonitorPane;
  x: number; y: number; width: number; height: number;
  offset: number;
  contentLength: number;
  rows: MonitorRow[];
  /** Rows above the content: 1 for a pane's band, 0 for Agents (its band is its pinned summary). */
  edge?: number;
  /** Leading rows that stay put while the rest scrolls: Agents' summary line. */
  pinned?: number;
  /** Content rows drawn, pinned ones included, when fewer than the frame holds: the rest is the scroll hint. */
  visible?: number;
}
export interface MonitorControl {
  /**
   * `expand` opens or closes a card's timeline (and selects it), `switch`
   * (a card's name) selects it and switches Codex to it, `level` (the status card's band) changes how
   * much the card shows. `tab` (a pane's button on the control bar) opens
   * or closes that pane; `zoom` (a pane's band) zooms or restores it;
   * `older` shows or hides what the linger window put away; `help` opens
   * the keys.
   */
  kind: 'main' | 'settings' | 'tab' | 'older' | 'help' | 'brief' | 'level' | 'log' | 'expand' | 'switch' | 'zoom';
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
  /** The tmux prefix as the help writes it ("Ctrl+]"). */
  prefix?: string;
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
  return {agents:settings.agentsPane, worktrees:settings.worktreesPane, changes:settings.changesPane, details:settings.detailsPane, timeline:settings.timelinePane};
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
  // In the tabs layout any pane can be the one shown, whatever the stacked layout left closed.
  const focus = state.tabbed || state.modes[state.focus] !== 'closed' ? state.focus : MONITOR_PANES.find(id => state.modes[id] !== 'closed') ?? 'agents';
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
 * Wrap prose that may mix Chinese and English, filling each line: a line can
 * break between any two characters of Chinese, as Chinese is set, but not
 * inside a Latin word. A word longer than a line is split anyway. Takes
 * sanitized text.
 */
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined,{granularity:'grapheme'}) : null;
/** What a line may break between: runs of ASCII, spaces, and each character of other text. */
function flowTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(/[\x21-\x7e]+|\s+|[^\s\x21-\x7e]+/gu) ?? []) {
    if (/^[\s\x21-\x7e]/u.test(run)) tokens.push(run);
    else if (graphemes) for (const {segment} of graphemes.segment(run)) tokens.push(segment);
    else tokens.push(...run);
  }
  return tokens;
}
/**
 * Closing punctuation stays with the text before it and opening punctuation
 * with the text after it: a line that starts with "。" or "，", or ends with
 * "「", reads as a stray mark.
 */
const CLOSING = /^[。，、；：！？）」』】》〉〕］｝”’…%,.;:!?)\]}]/u;
const OPENING = /^[「『（《〈【〔［｛“‘]$/u;
export function flowLines(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  // The line's words, each with the space before it: a word moved down takes its space, and loses it there.
  let parts: string[] = [];
  const used = () => visualLength(parts.join(''));
  const add = (piece: string) => { parts.push(parts.length ? piece : piece.trimStart()); };
  const push = () => { lines.push(parts.join('').trimEnd()); parts = []; };
  let space = false;
  for (const token of flowTokens(text)) {
    if (/^\s+$/.test(token)) { space = parts.length > 0; continue; }
    const piece = (space ? ' ' : '')+token;
    space = false;
    if (visualLength(token) > width) {
      [...token].forEach((char,i) => {
        const bit = i ? char : piece.slice(0,piece.length-token.length)+char;
        if (parts.length && used()+visualLength(bit) > width) push();
        add(bit);
      });
      continue;
    }
    if (parts.length && used()+visualLength(piece) > width) {
      let carried: string[] = [];
      const room = (moved: string[]) => visualLength((moved.join('')+piece).trimStart()) <= width;
      if (CLOSING.test(token)) {
        // Down with the mark goes the word before it, and any marks just before that word.
        const take: string[] = [];
        while (parts.length-take.length > 1) {
          take.unshift(parts[parts.length-1-take.length]);
          if (!CLOSING.test(take[0].trimStart())) break;
        }
        if (take.length && !CLOSING.test(take[0].trimStart()) && room(take)) { carried = take; parts.length -= take.length; }
      }
      while (parts.length > 1 && OPENING.test(parts.at(-1)!.trim()) && room([parts.at(-1)!,...carried])) carried.unshift(parts.pop()!);
      push();
      for (const moved of carried) add(moved);
    }
    add(piece);
  }
  if (parts.length) push();
  // A last line of one Chinese character, its closing marks aside, reads as
  // a stray: the character before it comes down with it.
  if (lines.length > 1) {
    const split = (line: string) => graphemes ? [...graphemes.segment(line)].map(part=>part.segment) : [...line];
    const last = split(lines.at(-1)!);
    const before = split(lines.at(-2)!);
    const bare = last.filter(char=>!CLOSING.test(char));
    const lone = (char: string | undefined) => char !== undefined && !/^[\x00-\x7f]/.test(char) && !CLOSING.test(char) && !OPENING.test(char);
    if (bare.length === 1 && lone(bare[0]) && before.length > 2 && lone(before.at(-1)) && visualLength(before.at(-1)!+lines.at(-1)!) <= width) {
      lines[lines.length-1] = before.at(-1)!+lines.at(-1)!;
      lines[lines.length-2] = before.slice(0,-1).join('').trimEnd();
    }
  }
  return lines;
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
/** A directory name that is an id, not a name: hex of 7 or more characters, or a UUID. */
const ID_NAME = /^(?:[0-9a-f]{7,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/**
 * What a worktree is called on screen: its branch; detached, its
 * directory's name, or, where that is an id, the nearest directory above it
 * that is neither an id nor `.git` (`atlas-launch-sources`, not a 32-digit
 * hash). No hash is ever shown.
 */
export function worktreeName(entry: WorktreeInfo): string {
  if (entry.branch) return entry.branch;
  const parts = entry.path.split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length-1; i >= 0; i--) if (!ID_NAME.test(parts[i]) && parts[i] !== '.git') return parts[i];
  return t(entry.bare ? 'bare' : 'detached');
}
/**
 * Where a worktree is, relative to the repository's main worktree: up to its
 * first id directory, then "…" (`.git/atlas-launch-sources/…`). Empty for
 * the main worktree itself.
 */
export function worktreePlace(entry: WorktreeInfo, root: string | undefined): string {
  const path = entry.path.replace(/[\\/]+$/,'');
  const base = root?.replace(/[\\/]+$/,'');
  const relative = base && path.startsWith(base+'/') ? path.slice(base.length+1) : base === path ? '' : path;
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  const id = parts.findIndex(part => ID_NAME.test(part));
  return id < 0 ? parts.join('/') : [...parts.slice(0,id),'…'].join('/');
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
 * The agents' heading: what is running, failed and done, as counts. The
 * switch for what the linger window put away is on the control bar.
 */
export function summaryRow(input: MonitorData, state: MonitorState, width: number, now: number): {row: MonitorRow; total: number; expired: number} {
  const everyone = visibleRows(input.tree.nodes,{...state.tree,filter:'all',collapsed:new Set(),showAll:true},now);
  const totals = {run:0,done:0,error:0,unknown:0};
  for (const {node} of everyone) totals[node.status === 'running' || node.status === 'starting' ? 'run' : node.status === 'completed' ? 'done' : node.status === 'error' ? 'error' : 'unknown']++;
  // What the linger window puts away, counted whether or not it is showing.
  const expired = countExpired(input.tree.nodes,{...state.tree,showAll:false},now);
  // Guardian reviews under the main session count here, not as agents.
  const reviews = guardianCount(input.tree.nodes).count;
  // "!1 失败  ▸1 运行  ✓5 完成": an icon and a count alone said nothing to a
  // reader without the legend, so each count carries its word; the short
  // form, the counts alone, is for where the words do not fit.
  const build = (words: boolean) => {
    const count = (icon: string, paint: (s: string) => string, n: number, word: string) =>
      `${paint(icon)}${n}${words ? colors.dim(` ${t(word)}`) : ''}`;
    // Only what is there: "▸0 run" beside thirty finished agents is noise.
    // A column in, under the entries' status icons; failures lead.
    const counts = [
      totals.error ? count('!',theme.error,totals.error,'failed') : '',
      totals.done ? count('✓',theme.success,totals.done,'done') : '',
      totals.run ? count('▸',theme.info,totals.run,'run') : '',
      totals.unknown ? count('?',colors.dim,totals.unknown,'unknown') : '',
      reviews ? `${guardianChip(input.tree.nodes)}${words ? colors.dim(` ${t('reviews')}`) : ''}` : '',
    ].filter(Boolean).join(words ? '  ' : ' ');
    return counts ? truncateAnsi(' '+counts,width) : '';
  };
  return {row:{text:build(true),short:build(false)},total:everyone.length,expired};
}

/**
 * "◈5": the guardian reviews among `nodes`, in the info colour while one is
 * running. Empty when there are none.
 */
export function guardianChip(nodes: readonly SubagentTreeNode[]): string {
  const {count,running} = guardianCount(nodes);
  return count ? (running ? theme.info : colors.dim)(`◈${count}`) : '';
}

function agentRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  // With no agent to show the view is empty: the summary's counts, the bar's
  // +N and the status card already say why, so no line says it again.
  const {row:head} = summaryRow(input,state,width,now);
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
    const squeezed = squeeze(monitorText(shownName(node,state.labelAsName)),room);
    const name = dimName ? colors.dim(squeezed) : squeezed;
    const selected = node.id === state.tree.selectedId;
    const line = pair(prefix+name,right,width);
    result.push({text:selected ? theme.selectedBand(fit(line,width)) : line,item:node.id,key:`row:${node.id}`});
    // The selected row says how far its agent got, under its name; the rest
    // stay one line each, so the tree stays compact.
    const at = visualLength(prefix)+1;
    const brief = selected && width > at+4 ? briefLine(node,input.agentLog?.get(node.id) ?? [],agentTitle(node,state.labelAsName)) : '';
    if (brief) result.push({text:' '.repeat(at)+colors.dim(truncateAnsi(brief,width-at)),item:node.id,key:`row:${node.id}`});
  }
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
 * With glyphs on, a finished turn is "⏎ Turn finished", a failed tool "✗ exec",
 * and the rest of an agent's run "▸ name" or "name ✓": the icon, and a word.
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
  // With labels as names, an agent's events say its label once it has one.
  const relabel = (event: WorkbenchEvent): WorkbenchEvent => {
    const node = event.agentId ? nodes.get(event.agentId) : undefined;
    return node && event.subject && input.state.labelAsName && labelled(node) ? {...event,subject:node.label} : event;
  };
  for (const original of events) {
    const event = relabel(original);
    if (guardian(event) && event.kind !== 'agent-failed') continue;
    if (event.kind === 'agent-started' && paired.has(original)) continue;
    const plainPaint = (s: string) => s;
    const paint = event.status === 'error' ? theme.error : event.kind === 'quota' || event.kind === 'approval-requested' ? theme.warning : plainPaint;
    const name = event.agentId ? agentPaint(event.agentId)(monitorText(event.subject ?? '')) : '';
    let text = paint(timelineText(event));
    const start = startOf.get(original);
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
    } else if (iconic() && event.kind === 'turn-finished') text = colors.dim(`⏎ ${t('Turn finished')}`);
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
  // No events, no rows: the pane's frame says what it is.
  if (!lines.length) return [];
  const rows: MonitorRow[] = [];
  for (const line of lines) {
    const when = age(line.at,now);
    rows.push({text:truncateAnsi(`${colors.dim(when.padStart(3))} ${line.text}${line.count > 1 ? colors.dim(` ×${line.count}`) : ''}`,width)});
    // A model-written reading of a failure, marked as such.
    if (line.cause) rows.push(...flowLines(monitorText(line.cause),Math.max(1,width-6)).map((text,i)=>({text:`    ${i ? ' ' : colors.dim('~')} ${text}`})));
  }
  return rows;
}

/**
 * The changes' counts in words, zero counts left out, in the order
 * conflicts, staged, unstaged, untracked: "5 未暂存 · 2924 未跟踪". Short of
 * room the least wanted count goes first, untracked, then staged; the words
 * stay.
 */
export function changeCounts(files: readonly GitChangedFile[], width: number): string {
  const changed = (x: string) => x !== ' ' && x !== '.' && x !== '?';
  const count = {
    conflicts: files.filter(f=>f.conflict).length,
    staged: files.filter(f=>!f.conflict&&changed(f.index)).length,
    unstaged: files.filter(f=>!f.conflict&&changed(f.worktree)).length,
    untracked: files.filter(f=>!f.conflict&&f.index==='?'&&f.worktree==='?').length,
  };
  const part = (key: keyof typeof count) => count[key] ? (key === 'conflicts' ? theme.warning : colors.dim)(t(`{n} ${key}`,{n:count[key]})) : '';
  const line = (keys: Array<keyof typeof count>) => keys.map(part).filter(Boolean).join(colors.dim(' · '));
  for (const keys of [['conflicts','staged','unstaged','untracked'],['conflicts','staged','unstaged'],['conflicts','unstaged']] as Array<Array<keyof typeof count>>) {
    const text = line(keys);
    if (text && visualLength(text) <= width) return text;
  }
  return truncateAnsi(line(['conflicts','unstaged']) || line(['conflicts','staged','unstaged','untracked']),width);
}

/**
 * Each path as the changes list shows it in `width` columns: whole where it
 * fits, else the shortest ending that no other path in the list shares
 * ("a/SKILL.md", "SKILL.md" for a name only it has). Where that ending is
 * still too long, the directory that tells it apart stays with the name and
 * the middle goes (".agents/…/SKILL.md", then ".ag…/SKILL.md"), and last the
 * start is cut ("…/SKILL.md").
 */
let shownCache: {files: readonly unknown[]; width: number; shown: string[]} | undefined;
export function shownPaths(paths: readonly string[], width: number): string[] {
  // An untracked directory keeps its slash on its name: "r02/".
  const split = paths.map(path=>{
    const parts = path.split('/').filter(Boolean);
    if (path.endsWith('/') && parts.length) parts[parts.length-1] += '/';
    return parts;
  });
  const ending = (n: number, of: string[]) => of.slice(-n).join('/');
  // How many paths end in each run of n parts, counted once per n: a list of
  // thousands of untracked files is drawn on every repaint.
  const counts = new Map<number, Map<string, number>>();
  const shared = (n: number, parts: string[]) => {
    let byEnding = counts.get(n);
    if (!byEnding) {
      byEnding = new Map();
      for (const other of split) if (other.length >= n) { const key = ending(n,other); byEnding.set(key,(byEnding.get(key) ?? 0)+1); }
      counts.set(n,byEnding);
    }
    return (byEnding.get(ending(n,parts)) ?? 0) > 1;
  };
  return paths.map((path,i) => {
    if (visualLength(path) <= width) return path;
    const parts = split[i];
    let k = 1;
    while (k < parts.length && shared(k,parts)) k++;
    const unique = ending(k,parts);
    if (visualLength(unique) <= width) return unique;
    if (k > 1) {
      const kept = `${parts[parts.length-k]}/…/${parts.at(-1)}`;
      if (visualLength(kept) <= width) return kept;
      // Narrower still, the start of that directory is what tells it apart: ".ag…/SKILL.md".
      let head = '';
      let used = visualLength(`…/${parts.at(-1)}`);
      for (const ch of parts[parts.length-k]) { used += visualLength(ch); if (used > width) break; head += ch; }
      if (head) return `${head}…/${parts.at(-1)}`;
    }
    let tail = '';
    let used = 1;
    for (const ch of [...unique].reverse()) { used += visualLength(ch); if (used > width) break; tail = ch+tail; }
    return '…'+tail;
  });
}

function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  if (id === 'agents') return agentRows(input,state,width,now);
  if (id === 'timeline') return timelineRows(input,width,now);
  if (id === 'worktrees') {
    const snapshot = input.worktrees;
    // Empty, loading or clean is no line of its own; an error says what is wrong.
    if (!snapshot) return [];
    if (snapshot.error) return [{text:theme.warning(t('No readable repository'))}, {text:colors.dim(t('Set worktreeRoot'))}, ...wrapped(snapshot.error,width).map(text=>({text:colors.dim(text)}))];
    const rows: MonitorRow[] = [];
    if (snapshot.truncated) rows.push({text:theme.warning(t('Worktree list limited'))});
    const names = snapshot.entries.map(worktreeName);
    for (const [i,entry] of snapshot.entries.entries()) {
      const label = worktreeLabel(entry,now);
      const mark = (entry.path === state.selectedWorktree ? '›' : ' ')+' ';
      const subject = entry.subject ? monitorText(entry.subject) : '';
      // Two of the same name are told apart by what their HEAD commit says,
      // never by a hash: where it has no line of its own, it stands in for the name.
      const twin = names.filter(name=>name === names[i]).length > 1;
      const name = twin && subject && width < 20 ? subject : monitorText(names[i]);
      const paint = label.startsWith('!') || entry.error ? theme.warning : label === 'clean' ? colors.dim : theme.value;
      // Locked is a word after the status, not a letter glued to the name.
      const locked = entry.locked !== undefined ? colors.dim(` · ${t('locked')}`) : '';
      rows.push({text:pair(mark+name,paint(worktreeLabelText(label))+locked,width),item:entry.path});
      // Under it, what its HEAD commit says, where a second line fits.
      if (width >= 20 && subject) rows.push({text:colors.dim(truncateAnsi('  '+subject,width)),item:entry.path});
    }
    return rows;
  }
  if (id === 'changes') {
    const git = input.git;
    const rows: MonitorRow[] = [];
    if (!git) return [];
    if (git.error) rows.push({text:theme.warning(t('Git incomplete'))});
    if (!git.root) return rows;
    if (git.files.length) {
      rows.push({text:changeCounts(git.files,width)});
      // What the diff does, in the model's words, marked as such; older than the diff, it says so.
      const summary = input.notes?.changes;
      if (summary) {
        for (const line of summary.lines) rows.push(...flowLines(monitorText(line),Math.max(1,width-2)).map((text,i)=>({text:`${i ? ' ' : colors.dim('~')} ${text}`})));
        if (!summary.current) rows.push(...flowLines(t('(written {age}, before the latest edits)',{age:writtenAge(summary.at,now)}),Math.max(1,width-2)).map(text=>({text:colors.dim(`  ${text}`)})));
      }
    }
    // Worked out once per git read and width, not on every repaint.
    const pathWidth = Math.max(1,width-5);
    if (shownCache?.files !== git.files || shownCache.width !== pathWidth)
      shownCache = {files:git.files,width:pathWidth,shown:shownPaths(git.files.map(file=>file.path),pathWidth)};
    const shown = shownCache.shown;
    return [...rows, ...git.files.map((file,i) => ({item:file.path,
      text:truncateAnsi(`${file.path===state.selectedFile?'›':' '} ${file.conflict?theme.error('!!'):file.index+file.worktree} ${monitorText(shown[i])}`,width)}))];
  }
  // Inspector is explicitly opened (Enter/v/4), never follows agent clicks into a transcript.
  let lines: string[] = [];
  if (state.preview === 'agent') {
    const node = findNode(input.tree.nodes,state.tree.selectedId);
    if (!node) lines = [];
    else {
      const token = renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined);
      const status = nodeStatus(node,now);
      // Sanitize external text before painting. Never pass our own ANSI spans
      // back through monitorText (which correctly escapes untrusted controls).
      // Both names show here: the model's name for what the agent does, and
      // the name Codex's own picker and transcript print.
      // The heading in the agent's own colour, as the timeline names it.
      // With labels as names the label heads it and Codex's name is under
      // it; without, the name heads it and the label is under it.
      const own = agentPaint(node.id);
      const rows: MonitorRow[] = wrapped(shownName(node,state.labelAsName),width).map(text=>({text:theme.strong(own(text))}));
      if (labelled(node)) rows.push(...wrapped(state.labelAsName ? t('name {name}',{name:node.name}) : t('label {label}',{label:node.label!}),width)
        .map(text=>({text:colors.dim(text)})));
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
      rows.push({text:colors.dim(truncateAnsi(t(state.expanded?'▴ Less':'▾ More'),width))});
      return rows;
    }
  } else if (state.preview === 'worktree') {
    const entry = input.worktrees?.entries.find(e=>e.path===state.selectedWorktree);
    if (!entry) lines = [];
    else {
      // Its name, where it is and what its HEAD commit says; no hash, not even a short one.
      const place = worktreePlace(entry,input.worktrees?.entries[0]?.path);
      const rows: MonitorRow[] = wrapped(worktreeName(entry),width).map(text=>({text:theme.strong(text)}));
      if (entry.subject) rows.push(...flowLines(monitorText(entry.subject),width).map(text=>({text:colors.dim(text)})));
      lines = [t('Branch: {branch}',{branch:entry.branch ?? t(entry.bare?'bare':'detached')}),
        t('Status: {status}',{status:worktreeLabelText(worktreeLabel(entry,now))})+(entry.locked !== undefined ? ` · ${t('locked')}` : '')];
      if (place) lines.push(place);
      if (entry.error) lines.push(entry.error);
      if (entry.locked) lines.push(t('Locked: {reason}',{reason:entry.locked}));
      if (entry.prunable !== undefined) lines.push(t('Prunable: {reason}',{reason:entry.prunable || t('yes')}));
      if (entry.status) lines.push(t('{s} staged / {u} unstaged',{s:entry.status.staged,u:entry.status.unstaged}),
        t('{n} untracked / {c} conflicts',{n:entry.status.untracked,c:entry.status.conflicts}),
        t('Ahead {a} / behind {b}',{a:entry.status.ahead ?? '?',b:entry.status.behind ?? '?'}));
      lines.push(t('Workspace status, not agent ownership'));
      // The full path is more, where it holds no id; there is nothing else more to show.
      const full = entry.path.split(/[\\/]+/).some(part => ID_NAME.test(part)) ? '' : entry.path;
      if (full && state.expanded) lines.push(full);
      if (full) lines.push(t(state.expanded?'▴ Less':'▾ More'));
      return [...rows,...lines.flatMap(line => wrapped(line,width).map(text=>({text})))];
    }
  } else {
    if (!state.selectedFile) return [];
    lines = [basename(state.selectedFile)+(state.selectedFile.endsWith('/') ? '/' : '')];
    if (state.expanded) lines.push(...(input.git?.root ? [input.git.root] : []),state.selectedFile);
    const heading = lines.flatMap(line=>wrapped(line,width).map(text=>({text:theme.strong(text)})));
    // An untracked directory: how many files it holds, in the reader's words, then each one's path inside it.
    const listing = state.selectedFile.endsWith('/') && input.diff?.[0] === 'Untracked' ? /^(\d+) files?$/.exec(input.diff[1] ?? '') : null;
    if (listing) {
      const n = Number(listing[1]);
      return [...heading, {text:colors.dim(truncateAnsi(`${t('Untracked')} · ${n === 1 ? t('1 file') : t('{n} files',{n})}`,width))},
        ...input.diff!.slice(2).flatMap(line=>wrapped(line,width).map(text=>({text:theme.value(text)})))];
    }
    // A file's git header repeats its path and names its blobs by hash: the
    // heading above says which file it is, so only the hunks are shown.
    let header = false;
    const body = (input.diff ?? []).filter(line=>{
      if (line.startsWith('diff --git ')) { header = true; return false; }
      if (line.startsWith('@@')) header = false;
      return !(header && /^(index [0-9a-f]+\.\.[0-9a-f]+|--- |\+\+\+ )/.test(line));
    });
    return [...heading, ...body.flatMap(line=>{
      const paint = line.startsWith('@@') ? theme.info : line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.error : theme.value;
      return wrapped(line,width).map(text=>({text:paint(text)}));
    })];
  }
  return lines.flatMap(line => wrapped(line,width).map(text=>({text})));
}

/**
 * The panel's top as the display config now draws it: the control bar and
 * the focused pane's title, for the settings page to preview a look, its
 * icons or a theme before they are saved.
 */
export function panelTop(input: Pick<MonitorData,'tree'|'brief'|'nowMs'>, state: MonitorState, width: number): string[] {
  const now = input.nowMs ?? Date.now();
  const bar = controlBar(state,{brief:input.brief,expired:countExpired(input.tree.nodes,{...state.tree,showAll:false},now)},width);
  return [...bar.lines,paneHead(state.focus,width,{focused:true,zoomed:false})];
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

/** The brief's rule as a row. Its switch is on the control bar. */
export function briefRuleRow(brief: NonNullable<MonitorData['brief']>, width: number): MonitorRow {
  return {text:briefRule(brief,width),key:'brief'};
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
    const title = agentTitle(node,state.labelAsName);
    const head = `${attention ? theme.warning('!') : ' '}${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
    const name = squeeze(title.name,Math.max(1,width-visualLength(head)));
    push(head+(attention ? theme.warning(name) : theme.strong(name)));
    // Under the name that identifies it, what the agent is for.
    for (const line of taskLines(title,Math.max(1,width-3)).lines) push('   '+(title.renamed || title.original ? line : colors.dim(line)));
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
 * "─ Brief · writing… ────────": the rule heading the brief and its state.
 * No age: a counter ticking up every second said nothing a reader acts on.
 * The switch that holds the model calls is the pause button on the control bar.
 */
export function briefRule(brief: NonNullable<MonitorData['brief']>, width: number): string {
  const status = brief.paused ? t('paused') : brief.running ? t('writing…') : brief.error ? t('failed') : '';
  const label = `${t('─ Brief')}${status ? ` · ${status}` : ''} `;
  return colors.dim(truncateAnsi(label+'─'.repeat(Math.max(0,width-visualLength(label))),width));
}

function walkTree(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkTree(node.children,visit); }
}

/** An agents view shorter than this drops its blank lines rather than scroll past most of what it holds. */
const DENSE_BELOW = 12;
/** Rows from which a blank row parts the panel's sections. */
const PARTED_FROM = 30;

/**
 * The agents view's rows, its summary line first: in rich style a card per
 * agent (the main session's brief is in the status card at the foot); in
 * compact the tree, then the brief and log under it. One view, scrolled as one.
 */
function agentsView(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  if (state.style === 'rich') return richRows(input,state,width,now,spaced);
  return [...agentRows(input,state,width,now),...briefRows(input,state,width,now,spaced)];
}

/**
 * The help: the shortcuts (the tmux prefix, then a key; nothing typed in the
 * panel is the panel's), the buttons, the mouse, then the legend. `prefix`
 * is the prefix as people write it, "Ctrl+]".
 */
function helpText(rich: boolean, prefix: string, tabbed = false): Array<string | {head: string}> {
  const p = {p:prefix};
  const head = (text: string) => ({head:t(text,p)});
  return [
    head('Shortcuts: {p}, then a key'),
    ...['Keys typed in the panel go to Codex','F12  panel on / off  Shift+F12  into it',
      '{p} ,  settings  {p} ?  help','{p} b  pause / resume brief','{p} a  show / hide older',
      '{p} m  main session  {p} o  switch to selected',
      // The tabs layout shows one pane at a time: nothing to close or zoom.
      ...(tabbed ? ['{p} 1–5  show a pane  {p} Tab  next'] : ['{p} 1–5  open / close a pane  {p} Tab  next','{p} x  close pane']),
      '{p} j k ↑ ↓  select, repeats','{p} PgUp PgDn  scroll  {p} g G  first / last',
      tabbed ? '{p} Enter / v  inspect' : '{p} Enter / v  inspect  {p} z  zoom',...(rich ? ['{p} e / Space  open / close card'] : []),
      '{p} h l  fold / unfold agent','{p} f  filter  {p} s  order',
      rich ? '{p} r  status card: min / status / full' : '{p} r  status card: min / status',
      '{p} Esc  back  {p} q  close panel','{p} {p}  {p} itself, to Codex'].map(line=>t(line,p)),
    head('Buttons, top row'),
    // With icons on, what each icon is; with words, the words say it.
    ...(iconSet() !== 'text' ? [t('{icon} main session',{icon:icon('main')}),
      t('{icons} the panes, as titled',{icons:MONITOR_PANES.map(id=>icon(id)).join(' ')}),
      t('{pause} / {resume} pause / resume brief',{pause:icon('pause'),resume:icon('resume')}),
      t('{show} show older  {hide} hide them',{show:icon('show'),hide:icon('hide')}),
      t('{settings} settings  {help} help',{settings:icon('settings'),help:icon('help')})] : []),
    t(tabbed ? 'Click a pane\'s tab: show it' : 'Click a pane\'s button: open or close it'),
    head('Mouse'),
    ...[...(rich ? ['Click card: select','Click its name: switch','Click top rule or ▾: open','Wheel over the card: its brief'] : ['Click agent: switch','Click a log line: select agent']),
      ...(tabbed ? [] : ["Click a pane's title: zoom / restore"]),"Click the card's band: its level",'PgUp/PgDn or wheel scroll'].map(line=>t(line)),
    head('Legend'),
    ...['1 Cards  2 Worktrees','3 Changes  4 Inspector','5 Timeline','✓ = turn completed','? = no status evidence','! = needs a look',
      '⌕ research  ⚗ experiment  ⚒ fix','◈ review  ✎ writing  ∑ summary'].map(line=>t(line)),
    t('{clocks} turn <1m, the quarter hour, 1h+',{clocks:TURN_CLOCKS.map(([,glyph])=>glyph).join('')+TURN_CLOCK_LONG}),
    ...['~ = written by a model','Brief: ! needs  ◎ goal  ▸ now  ✓ done  ⚑ approve',
      'status card gutter colour = main session state','┃ = auto-compact point','◈N = guardian reviews  +N = folded agents','Timeline: ⏎ turn finished  ×N in a row','yellow clock = quiet 5m+','──56%── = context or quota used, the % at the fill','meter: blue, yellow past 70%, red past 85%','dim name = done 1m+ ago','mod = changed files','stale = >30s since read'].map(line=>t(line)),
    ...stripAnsi(modelLegend()).split('\n'),
  ];
}

/** Lines of the latest update the Inspector shows before "▾ More". */
const REPORT_LINES = 6;
/** Whether a pane is drawn, and so worth reading for: open when stacked, the one shown in the tabs layout. */
export function paneShown(state: MonitorState, id: MonitorPane): boolean {
  return state.tabbed ? state.focus === id : state.modes[id] === 'open';
}

export function renderMonitor(input: MonitorData): MonitorFrame {
  const width = Math.max(0,Math.floor(input.width)); const height = Math.max(0,Math.floor(input.height));
  const state = reconcileMonitor(input.state,input.tree,input.git,input.worktrees,input.nowMs ?? Date.now());
  const frame: MonitorFrame = {lines:[],panes:[],controls:[],state};
  if (!width || !height) return frame;
  if (state.help) {
    // A heading is painted line by line once wrapped, so each of its lines keeps the colour.
    // A line of two shortcuts too wide for the panel splits between them, not
    // inside one ("Ctrl+] m  main session" stays whole where it fits). An
    // entry is a key, two spaces, what it does: "{p} {p}  {p} itself" is one.
    const prefix = input.prefix ?? 'Ctrl+]';
    const keyStart = new RegExp(`  (?=(?:${prefix.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')}|Shift\\+F12) )`);
    const entries = (line: string) => {
      if (visualLength(line) <= width) return [line];
      const out: string[] = [];
      for (const part of line.split(keyStart)) {
        if (out.length && !out[out.length-1].includes('  ')) out[out.length-1] += `  ${part}`;
        else out.push(part);
      }
      return out;
    };
    const help = helpText(state.style === 'rich',prefix,Boolean(state.tabbed))
      .flatMap(line=>typeof line === 'string' ? entries(line).flatMap(entry=>helpLines(entry,width)) : helpLines(line.head,width).map(text=>theme.accent(text)));
    const count = Math.max(0,height-2);
    state.helpScroll = Math.max(0,Math.min(state.helpScroll??0,Math.max(0,help.length-count)));
    frame.helpPage = {count,total:help.length};
    // A modal: its keys are real while it is open, and its way out is a button.
    const back = t('[Back]');
    frame.controls.push({kind:'help',x:0,y:0,width:visualLength(back)});
    frame.lines = [`${colors.dim(back)} ${theme.accent(t('Help'))}`,...help.slice(state.helpScroll,state.helpScroll+count)];
    while(frame.lines.length<height-1)frame.lines.push('');
    if(height>1)frame.lines.push(colors.dim(`↕ ${state.helpScroll+1}/${help.length}`));
    frame.lines = frame.lines.slice(0,height).map(line=>truncateAnsi(line,width));return frame;
  }
  // A pane is drawn as the status card is: a title naming it, then its rows
  // behind a gutter on the left only. Under 24 columns the gutter is its rule
  // alone, without the space after it. In the frame look the rows sit
  // between the frame's sides instead, `cw` wide, and the side is the gutter.
  const framed = look(width) === 'frame';
  const cw = framed ? width-4 : width;
  const gutter = framed ? '' : width>=24 ? '│ ' : '│';
  const inner = Math.max(0,cw-gutter.length);
  const now = input.nowMs ?? Date.now();
  const notice = input.notice || input.error;
  const noticeRows = notice && height >= 6 ? wrapped(notice,Math.max(1,cw-2)).slice(0,2) : [];
  // The status card takes the foot, at the level chosen, at most about half
  // the panel; it replaces the key hint's own line.
  const footPlan = planFoot(input,state,width,height,now,noticeRows.length);
  const footRows = footPlan.rows;
  // Every control the panel has is on its first rows; nothing else is a button.
  const bar = controlBar(state,{brief:input.brief,expired:countExpired(input.tree.nodes,{...state.tree,showAll:false},now)},width);
  const top = Math.min(height,bar.lines.length);
  let budget = Math.max(0,height-top-footRows-noticeRows.length);
  // A closed pane takes no row at all; in the tabs layout only the one shown
  // has rows, all of them, and there is nothing to zoom.
  const zoom = state.zoom && !state.tabbed;
  const ids = state.tabbed ? [state.focus] : MONITOR_PANES.filter(id=>state.modes[id] !== 'closed' && (!zoom || id===state.focus));
  // Where the panel is tall enough a blank row parts its sections: under the
  // bar, between two panes and above the status card. Not in the frame look,
  // whose edges part them already, and never at a pane's expense: short of
  // a title and a row for each pane besides, there are none.
  const footed = footRows+noticeRows.length > 0;
  let gaps = !framed && height >= PARTED_FROM && ids.length ? ids.length+(footed ? 1 : 0) : 0;
  if (budget-gaps < 2*ids.length) gaps = 0;
  budget -= gaps;
  // Agents has no band of its own: its summary line, pinned at its top, is
  // painted as one. The other panes have a band row above their rows.
  const edgeOf = (id: MonitorPane) => id === 'agents' ? 0 : 1;
  const content = new Map(ids.map(id=>[id,id === 'agents' ? agentsView(input,state,cw,now,true) : paneRows(id,input,state,inner,now)]));
  const sizes = new Map<MonitorPane,number>();
  for (const id of ids) { sizes.set(id,budget>0?1:0); if (budget>0) budget--; }
  const order = [state.focus,...ids.filter(id=>id!==state.focus)].filter(id=>ids.includes(id));
  while (budget > 0) {
    let grew = false;
    for (const id of order) {
      if (!budget) break;
      const rows = content.get(id)?.length ?? 0;
      const target = zoom ? height : rows + edgeOf(id);
      const size = sizes.get(id) ?? 0;
      if (size && size < target) { sizes.set(id,size+1);budget--;grew=true; }
    }
    if (!grew) break;
  }
  // What is left goes to the inspector when it has focus, else to the agents
  // view, where it is the room the art may use. Small worktree lists stay compact.
  const fillable = order.filter(id => (sizes.get(id) ?? 0) > 0);
  const fill = state.focus==='details'&&fillable.includes('details') ? 'details' : fillable.includes('agents') ? 'agents' : fillable[0];
  if(fill){sizes.set(fill,(sizes.get(fill)??0)+budget);budget=0;}
  // Spacing gives way to scrolling, not the other way round, except where the
  // view is so short that blank lines would hide most of what it could show.
  const agentsHeight = sizes.get('agents') ?? 0;
  if (ids.includes('agents') && agentsHeight < DENSE_BELOW && (content.get('agents')?.length ?? 0) > agentsHeight)
    content.set('agents',agentsView(input,state,cw,now,false));
  // In the frame look a row no pane draws on is blank between the frame's sides, `cw` wide.
  frame.lines = Array.from({length:height},()=>fit('',cw));
  bar.lines.slice(0,top).forEach((line,i)=>{frame.lines[i]=fit(line,width);});
  frame.controls.push(...bar.controls.filter(control=>control.y<top));
  // The rows that are titles: in the frame look they are its edges, not rows between its sides.
  const titles = new Set<number>();
  let y = top+(gaps ? 1 : 0);
  for (const id of ids) {
    const h = sizes.get(id) ?? 0; if (!h) continue;
    // The blank row after the pane before (the last one's is above the card).
    if (gaps && y > top+1) y++;
    const rows = content.get(id) ?? [];
    const focused = id===state.focus;
    const zoomed = zoom && focused;
    if (id === 'agents') {
      // Its title, then the counts the summary row has; where its rows are on the right.
      drawAgentsView(frame,state,rows,y,cw,h,(summary,range)=>paneHead(id,width,{info:summary,right:range && colors.dim(range),focused,zoomed}),framed ? 2 : 0);
      if (rows.length) titles.add(y);
      y += h; continue;
    }
    const edge = edgeOf(id);
    const count = Math.max(0,h-edge);
    let offset = Math.max(0,Math.min(state.scroll[id],Math.max(0,rows.length-count)));
    const selected = id==='worktrees'?state.selectedWorktree:id==='changes'?state.selectedFile:null;
    const index = selected ? rows.findIndex(row=>row.item===selected) : -1;
    if (index>=0 && count>0) { if(index<offset)offset=index;else if(index>=offset+count)offset=index-count+1; }
    state.scroll[id]=offset;
    const pane = {id,x:framed ? 2 : 0,y,width:cw,height:h,rows,offset,contentLength:rows.length,edge,pinned:0}; frame.panes.push(pane);
    // The title: the pane's icon and name on the left, where its rows are or
    // how many there are on the right, as the look draws it; a click anywhere
    // on it zooms or restores the pane.
    const range = rows.length>count&&count ? `${offset+1}–${Math.min(rows.length,offset+count)}/${rows.length}` : '';
    const total = id==='worktrees' ? input.worktrees?.entries.length ?? 0 : id==='changes' ? input.git?.files.length ?? 0 : id==='timeline' ? input.timeline?.length ?? 0 : 0;
    const right = range || (total ? t(id==='worktrees'?'{n} worktrees':id==='changes'?'{n} files':'{n} events',{n:total}) : '');
    frame.lines[y] = paneHead(id,width,{right:right && colors.dim(right),focused,zoomed});
    titles.add(y);
    frame.controls.push({kind:'zoom',pane:id,x:0,y,width});
    // The gutter in the pane's state colour: the accent where the keys go.
    const rule = focused ? theme.accent : colors.dim;
    for(let i=0;i<count;i++) {
      const row=rows[offset+i];
      const clipped=truncateAnsi(row?.text??'',inner);
      // The highlight covers the row's words, not the blank run after them:
      // a selected short name should not paint a bar across the pane.
      const highlight=row?.item&&row.item===selected&&focused;
      const body=(highlight?theme.selected(clipped):clipped)+' '.repeat(Math.max(0,inner-visualLength(clipped)));
      frame.lines[y+1+i]=truncateAnsi(rule(gutter)+body,cw);
    }
    y+=h;
  }
  const foot = height-footRows;
  if(input.art) placeArt(frame.lines,foot-noticeRows.length,cw,input.art,top);
  for(let i=0;i<noticeRows.length;i++) frame.lines[foot-noticeRows.length+i]=theme.warning(fit(noticeRows[i],cw));
  if (framed) {
    // Between the frame's sides: the left one in the accent beside the pane the keys go to.
    const shown = frame.panes.find(pane=>pane.id===state.focus);
    for (let row = top; row < foot; row++) {
      if (titles.has(row)) continue;
      const side = shown && row >= shown.y && row < shown.y+shown.height ? theme.accent : theme.frame;
      frame.lines[row] = `${side('│')} ${fit(frame.lines[row],cw)} ${theme.frame('│')}`;
    }
  }
  footPlan.draw(frame,foot);
  return frame;
}

/**
 * Put the decoration in the blank run of lines that ends just above `end`,
 * centred, with a blank line kept above and below it so it never touches the
 * brief or the card. It only ever takes lines nothing else drew on, so it
 * goes away by itself as agents and brief text need the room.
 */
function placeArt(lines: string[], end: number, width: number, art: NonNullable<MonitorData['art']>, first = 1): void {
  let start = end;
  while (start > first && stripAnsi(lines[start-1]).trim() === '') start--;
  const rows = end-start-2;
  if (rows <= 0 || width < 8) return;
  const drawing = art(width-2,rows);
  if (!drawing?.length) return;
  const cols = Math.max(...drawing.map(visualLength));
  const left = ' '.repeat(Math.max(0,Math.floor((width-cols)/2)));
  const top = start+1+Math.floor((rows-drawing.length)/2);
  drawing.forEach((line,i)=>{lines[top+i]=fit(left+line,width);});
}

/** Fewest columns of bar a meter keeps beside its reading; under it the tail goes first. */
export const METER_MIN = 4;
/**
 * A meter drawn as a thin line, as omp draws its context meter in the gap
 * of its status band: "────56%──────────────246K". One look for every meter
 * in the panel: the status card's context and quota, the agent cards'
 * bottom rules and the finished agents' rows.
 */
export interface EdgeMeter {
  /** How full, 0–100: the share of the line drawn in the zone colour. */
  percent: number;
  /** The reading at the fill's head, plain: "56%", "44% left". Absent is the percentage. */
  label?: string;
  /** Painted, just before the reading: "~" while it waits on a newer turn. */
  mark?: string;
  /** Plain, closing the line in the tick colour: the window size, "246K". */
  tail?: string;
  /** Where a known threshold sits, 0–100, drawn "┃". Only one the HUD can read, never a guess. */
  tick?: number;
}

/**
 * The meter `cells` wide, exactly: the fill in its zone colour (info, then
 * warning past 70%, danger past 85%), the reading in bold at the fill's head
 * and moving with it, the track in the track colour, then "─" and the tail
 * in the tick colour. Short of room the tail goes, then the bar shrinks to
 * nothing but the reading; under the reading's width it is track alone. With
 * no colour at all (`none`) the fill is heavy and the track light, so the
 * reading still shows how full. `bar` says whether at least `METER_MIN`
 * columns of bar were drawn (`cols` how many), `tail` whether the tail was.
 */
export function meterText(meter: EdgeMeter, cells: number): {text: string; bar: boolean; tail: boolean; cols: number} {
  if (cells <= 0) return {text:'',bar:false,tail:false,cols:0};
  const percent = Math.max(0,Math.min(100,meter.percent));
  const zone = getMeterColor(percent);
  const label = meter.label ?? `${Math.round(meter.percent)}%`;
  const mark = meter.mark ?? '';
  const head = visualLength(mark)+visualLength(label);
  if (cells < head) return {text:theme.track('─'.repeat(cells)),bar:false,tail:false,cols:0};
  const tailCols = meter.tail ? 1+visualLength(meter.tail) : 0;
  const withTail = tailCols > 0 && cells-head-tailCols >= METER_MIN;
  const bar = cells-head-(withTail ? tailCols : 0);
  const full = Math.max(0,Math.min(bar,Math.round(percent/100*bar)));
  const heavy = palette().name === 'none';
  const tick = meter.tick !== undefined && meter.tick > 0 && meter.tick < 100 ? Math.min(bar-1,Math.round(meter.tick/100*bar)) : -1;
  let track = '';
  let run = '';
  for (let i = full; i < bar; i++) {
    if (i === tick) { track += theme.track(run)+theme.tick('┃'); run = ''; }
    else run += '─';
  }
  if (run) track += theme.track(run);
  const fill = full ? zone((heavy ? '━' : '─').repeat(full)) : '';
  const tail = withTail ? theme.track('─')+theme.tick(meter.tail!) : '';
  return {text:fill+mark+theme.bold(zone(label))+track+tail,bar:bar >= METER_MIN,tail:withTail,cols:bar};
}

/**
 * Texts with a meter in the gap between them, `width` wide exactly:
 * `left`, the meter, `right`, each given with whatever spacing it wants.
 * Without a meter the gap is blank. Null when the texts leave no gap, or
 * when the meter's bar would be under `needBar` columns (or `needTail` and
 * its tail would not fit): the caller then tries a shorter set of texts.
 */
export function meterRow(width: number, left: string, right: string, meter?: EdgeMeter, needBar = 0, needTail = false): string | null {
  const room = width-visualLength(left)-visualLength(right);
  if (room < 1) return null;
  if (!meter) return left+' '.repeat(room)+right;
  const drawn = meterText(meter,room);
  if ((needBar && drawn.cols < needBar) || (needTail && meter.tail && !drawn.tail)) return null;
  return left+drawn.text+right;
}

/**
 * A click on a pane's button, or its number after the prefix: an open pane
 * closes, a closed one opens and takes focus. Closed, it takes no row, and
 * the focus moves to the next pane still open.
 */
export function clickTab(state: MonitorState, id: MonitorPane): MonitorState {
  // In the tabs layout a tab shows its pane, as a browser's does: none opens or closes.
  if (state.tabbed) return openPane(state,id);
  if (state.modes[id] === 'closed') return openPane({...state,zoom:false},id);
  return closePane(state,id);
}
function closePane(state: MonitorState, id: MonitorPane): MonitorState {
  const modes = {...state.modes,[id]:'closed' as const};
  const focus = state.focus !== id ? state.focus : MONITOR_PANES.find(pane=>modes[pane]!=='closed') ?? id;
  return {...state,modes,zoom:state.zoom && state.focus !== id,focus};
}
function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = id==='agents'?'agent':id==='worktrees'?'worktree':id==='changes'?'file':state.preview;
  // The tabs layout shows it and leaves the stacked layout's panes as they were.
  const modes = state.tabbed ? state.modes : {...state.modes,[id]:'open' as const};
  return {...state,focus:id,preview,modes,scroll:{...state.scroll,details:preview===state.preview?state.scroll.details:0}};
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height) return undefined;
  // Past the rows drawn is the scroll hint, not a row.
  if (pane.visible !== undefined && y - pane.y - edge >= pane.visible) return undefined;
  const line = y - pane.y - edge < (pane.pinned ?? 0) ? y - pane.y - edge : pane.offset + y - pane.y - edge;
  return line >= 0 ? pane.rows[line] : undefined;
}
export function monitorItemAt(pane: MonitorRect, x: number, y: number): string | undefined {
  return monitorRowAt(pane,x,y)?.item || undefined;
}
export function canMonitorDiff(frame?: MonitorFrame): boolean {
  return Boolean(frame?.panes.some(p=>p.id==='details'&&p.height>1&&p.width>=16));
}
export function handleMonitorInput(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  let next: MonitorState = {...state,tree:{...state.tree},modes:{...state.modes},scroll:{...state.scroll}};
  let key = input.type==='key'?input.key:'';
  const result = (action?:MonitorOutcome['action'],close=false): MonitorOutcome => ({state:next,close,action});
  if(key==='close') return result(undefined,true);
  // Space is Enter, except on the cards, where it opens or closes the selected one.
  if(key==='space')key=next.style==='rich'&&next.focus==='agents'&&!next.help?'expand':'enter';
  if(next.help) {
    const back=input.type==='mouse'&&input.button==='left'&&ctx.frame?.controls.some(c=>c.kind==='help'&&input.y===c.y&&input.x>=c.x&&input.x<c.x+c.width);
    if(back||['escape','help','enter'].includes(key))next.help=false;
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
    if(control?.kind==='help'){next.help=true;next.helpScroll=0;return result();}
    if(control?.kind==='older'){next.tree.showAll=!next.tree.showAll;return result();}
    if(control?.kind==='tab'&&control.pane){next=clickTab(next,control.pane);return result();}
    // A pane's band, or the agents' summary: zoom that pane, or restore it.
    if(control?.kind==='zoom'&&control.pane){if(!next.tabbed)next.zoom=!(next.zoom&&next.focus===control.pane);next.focus=control.pane;return result();}
    if(control?.kind==='brief') return result({type:'brief-toggle'});
    if(control?.kind==='level'){next.statusLevel=nextLevel(next);next.statusScroll=0;return result({type:'status-level'});}
    // What was clicked is in view already: selecting it does not scroll.
    const pick=(id: string)=>{next.tree.selectedId=id;next.preview='agent';next.scroll.details=0;next.revealed=id;next.focus='agents';};
    if(control?.kind==='log'&&control.item){pick(control.item);return result();}
    // A card's top rule or its ▾/▴: open or close its timeline, and select it.
    if(control?.kind==='expand'&&control.item){pick(control.item);next=toggleCard(next,control.item);return result();}
    // A card's name: go to that agent's session, as `o` does on it.
    if(control?.kind==='switch'&&control.item){pick(control.item);return result({type:'switch',id:control.item});}
    // The wheel over the status card scrolls its brief, the rows above it stay.
    const card=ctx.frame?.statusCard;
    if(input.button!=='left'&&card&&input.y>=card.y&&input.y<card.y+card.height) {
      if(card.total>card.brief) next.statusScroll=Math.max(0,Math.min(card.total-card.brief,(next.statusScroll??0)+(input.button==='wheel-down'?WHEEL_ROWS:-WHEEL_ROWS)));
      return result();
    }
    {
      const pane=ctx.frame?.panes.find(p=>input.x>=p.x&&input.x<p.x+p.width&&input.y>=p.y&&input.y<p.y+p.height);
      if(!pane) return result();
      next.focus=pane.id;
      if(input.button==='left') {
        {
          const row=monitorRowAt(pane,input.x,input.y);
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
  else if(key==='pane-close'){if(!next.tabbed&&next.modes[next.focus]!=='closed')next=closePane(next,next.focus);}
  // A pane's number, as its button: open it, or close it.
  else if(MONITOR_PANES.includes(key as MonitorPane))next=clickTab(next,key as MonitorPane);
  else if(key==='tab'||key==='shift-tab') {
    const visible=MONITOR_PANES.filter(id=>next.tabbed||next.modes[id]!=='closed');
    if(visible.length)next.focus=visible[(visible.indexOf(next.focus)+(key==='tab'?1:visible.length-1))%visible.length];
  } else if(key==='enter'||key==='detail-toggle') {
    const from=next.focus;
    if(from==='details') {next.expanded=!next.expanded;next.scroll.details=0;return result();}
    if(from==='agents')next.preview='agent';else if(from==='worktrees')next.preview='worktree';else if(from==='changes')next.preview='file';
    next=openPane(next,'details');next.scroll.details=0;
    next.expanded=false;
    if(from==='changes'&&!next.tabbed)next.zoom=true;
  } else if(key==='zoom'){if(!next.tabbed)next.zoom=!next.zoom;}
  else if(key==='escape') {
    if(next.zoom&&!next.tabbed)next.zoom=false;
    else if(next.focus==='details'){
      // Back to what was inspected; the tabs layout closes nothing on the way.
      if(!next.tabbed)next.modes.details='closed';
      next.focus=next.preview==='agent'?'agents':next.preview==='worktree'?'worktrees':'changes';
    }
    else return result(undefined,true);
  } else {
    const pane=ctx.frame?.panes.find(p=>p.id===next.focus);
    const page=Math.max(1,(pane?.height??5)-(pane?.edge??1));
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
