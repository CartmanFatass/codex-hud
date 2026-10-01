/** Default F12 view: a monitor, not another transcript. No I/O or terminal input here. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { WorktreesSnapshot, WorktreeInfo } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { initialPanelState, reconcileSelection, visibleRows, applyKey, countExpired, type PanelState } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi, getContextColor } from './colors.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { displayConfig } from './hud-config.js';
import type { Brief } from '../collectors/briefing.js';
import type { StatusCard } from './status-block.js';
import { t } from './i18n.js';

export const MONITOR_PANES = ['agents', 'worktrees', 'changes', 'details'] as const;
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
}
/** `item` is what a click selects; `action` is a row that is a control instead. */
export interface MonitorRow { text: string; item?: string; action?: 'toggle-finished' }
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
}
export interface MonitorControl {
  kind: 'main' | 'settings' | 'fold' | 'close' | 'brief';
  pane?: MonitorPane;
  x: number; y: number; width: number;
}
export interface MonitorFrame { lines: string[]; panes: MonitorRect[]; controls: MonitorControl[]; state: MonitorState; helpPage?: {count:number; total:number} }
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
  /** The brief, when one is configured; `paused` puts the model calls on hold. */
  brief?: Brief & {paused?: boolean};
  /**
   * The status bar's fields for the card at the foot of the panel (while the
   * panel is open it replaces the bar): at most `maxRows` rows, each fitted
   * to `width`, the most wanted kept when they do not all fit, and short
   * texts for the frame's edges, which the monitor fits.
   */
  status?: (width: number, maxRows: number) => StatusCard | null;
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
  action?: {type:'settings'} | {type:'switch'; id:string} | {type:'brief-toggle'};
}

export function initialMonitorState(): MonitorState {
  return {tree:{...initialPanelState(),sort:'active'}, focus:'agents',
    modes:{agents:'open',worktrees:'closed',changes:'closed',details:'closed'},
    scroll:{agents:0,worktrees:0,changes:0,details:0}, selectedWorktree:null,selectedFile:null,
    preview:'agent',help:false,zoom:false,helpScroll:0,expanded:false};
}
/** Agents is the page itself: always there, whatever an older settings file says. */
export function monitorModes(settings: HudSettings): MonitorModes {
  return {agents:'open', worktrees:settings.worktreesPane, changes:settings.changesPane, details:settings.detailsPane};
}
export function monitorPreferences(state: MonitorState): Partial<HudSettings> {
  return {agentsPane:state.modes.agents, worktreesPane:state.modes.worktrees,
    changesPane:state.modes.changes, detailsPane:state.modes.details};
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
  return {...state, tree:selected, selectedWorktree, selectedFile, focus,
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
function fit(text: string, width: number): string {
  const clipped = truncateAnsi(text, Math.max(0,width));
  return clipped + ' '.repeat(Math.max(0,width-visualLength(clipped)));
}
function pair(left: string, right: string, width: number): string {
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
function flowLines(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  let line = '';
  const push = () => { lines.push(line.trimEnd()); line = ''; };
  // Closing punctuation stays with the text before it: a line that starts
  // with "。" or "，" reads as a stray mark.
  const closing = /^[。，、；：！？）」』】》〉…%,.;:!?)\]}]/u;
  for (const token of text.match(/[\x21-\x7e]+|\s+|./gu) ?? []) {
    if (/^\s+$/.test(token)) { if (line) line += ' '; continue; }
    if (line && visualLength(line+token) > width) {
      if (closing.test(token) && visualLength(line+token) <= width+2 && [...line].length > 1) {
        // Carry the last character down with it rather than strand the mark.
        const chars = [...line];
        const carried = chars.pop()!;
        line = chars.join('');
        push();
        line = carried;
      } else push();
    }
    if (visualLength(token) > width) {
      for (const char of token) { if (visualLength(line+char) > width) push(); line += char; }
    } else line += token;
  }
  if (line.trim()) push();
  return lines;
}
function age(at: Date | undefined, now: number): string {
  if (!at || !Number.isFinite(at.getTime())) return '?';
  const seconds = Math.max(0, Math.floor((now-at.getTime())/1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m` : `${Math.floor(seconds/3600)}h`;
}
function nodeStatus(node: SubagentTreeNode, now: number): {icon:string; label:string; paint:(s:string)=>string} {
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
const CONTEXT_METER_WIDTH = 3;

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
const QUIET_MS = 5 * 60_000;
/** A finished row stays bright this long, then recedes until the linger window takes it. */
const FRESH_FINISH_MS = 60_000;

function isLive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}
function isQuiet(node: SubagentTreeNode, now: number): boolean {
  const at = node.lastEventAt?.getTime();
  return isLive(node) && at !== undefined && Number.isFinite(at) && now-at > QUIET_MS;
}
function turnClock(node: SubagentTreeNode, now: number): string {
  if (!isLive(node)) return '';
  const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
  if (start === undefined || !Number.isFinite(start)) return '';
  const elapsed = Math.max(0,now-start);
  const glyph = TURN_CLOCKS.find(([limit]) => elapsed < limit)?.[1] ?? TURN_CLOCK_LONG;
  return isQuiet(node,now) ? theme.warning(glyph) : theme.info(glyph);
}

/**
 * Cut the middle out of a name that does not fit. Agent names share their
 * beginnings (`b05_result_review`, `b05_result_diagnosis`); the end is what
 * tells them apart. Takes sanitized text with no escapes in it.
 */
function squeeze(text: string, width: number): string {
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
function finishedAt(node: SubagentTreeNode): Date | undefined {
  return node.statusAt ?? node.lastEventAt;
}

function agentRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
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
  // The summary doubles as the switch for what the linger window hid.
  const toggle = !expired ? '' : state.tree.showAll ? colors.dim(t(words ? 'hide old' : '−old'))
    : theme.accent(words ? t('+{n} older',{n:expired}) : `+${expired}`);
  const result: MonitorRow[] = [{text:pair(summary,toggle,width),...(expired ? {action:'toggle-finished' as const} : {})}];
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
    const right = [badge,ctx,clock].filter(Boolean).join(' ');
    const room = Math.max(1,width-visualLength(prefix)-(right ? visualLength(right)+1 : 0));
    const squeezed = squeeze(monitorText(node.name),room);
    const name = dimName ? colors.dim(squeezed) : squeezed;
    result.push({text:pair(prefix+name,right,width),item:node.id});
  }
  if (result.length === 1) {
    // Until the first read of the rollout lands, an empty tree means nothing.
    const empty = t(!everyone.length ? input.loading ? 'Reading session…' : 'No subagents yet'
      : expired && !state.tree.showAll && state.tree.filter === 'all' ? 'All finished · a shows' : 'No matching agents');
    result.push({text:colors.dim(truncateAnsi(empty,width))});
  }
  return result;
}

function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  if (id === 'agents') return agentRows(input,state,width,now);
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
      const rows: MonitorRow[] = wrapped(node.name,width).map(text=>({text:theme.strong(text)}));
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
        const text = flowLines(monitorText(report.text.replace(/\s+/g,' ').trim()),width);
        const shown = state.expanded ? text : text.slice(0,REPORT_LINES);
        if (shown.length < text.length) {
          let last = [...shown[shown.length-1]];
          while (last.length && visualLength(`${last.join('')} …`) > width) last = last.slice(0,-1);
          shown[shown.length-1] = `${last.join('').trimEnd()} …`;
        }
        rows.push(...shown.map(line=>({text:line})));
      }
      if (node.task && (state.expanded || !report)) {
        rows.push({text:colors.dim(t('Task'))});
        rows.push(...flowLines(monitorText(node.task.replace(/\s+/g,' ').trim()),width).map(line=>({text:line})));
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
 * The brief under the agents. When the model answered in the shape asked
 * for, each agent it mentions gets a block that looks like its tree row (the
 * same status icon, name and clock) with the note indented under it, so the
 * eye can go from a line in the brief to the agent it is about. Agents that
 * need the developer lead, marked ! in the column where the tree marks the
 * selection. A reply in any other shape is shown as the text it is. Model
 * output is sanitized like any other external string.
 */
function briefRows(brief: MonitorData['brief'], nodes: SubagentTreeNode[], width: number, now: number, spaced = false): string[] {
  if (!brief) return [];
  const rule = briefRule(brief,width).line;
  const failure = brief.error ? flowLines(monitorText(brief.error),Math.max(1,width-1)).map(text=>theme.warning(' '+text)) : [];
  const flow = (text: string, indent: number, paint: (s: string) => string = s => s) =>
    flowLines(monitorText(text),Math.max(1,width-indent)).map(line=>' '.repeat(indent)+paint(line));
  let body: string[];
  if (brief.items?.length || brief.overall) {
    const byName = new Map<string,SubagentTreeNode>();
    walkTree(nodes,node=>{
      for (const key of [node.name,node.nickname,node.agentPath?.split('/').at(-1)]) if (key && !byName.has(key)) byName.set(key,node);
    });
    body = brief.overall ? flow(brief.overall,1,colors.dim) : [];
    // What the panel knows for itself is not left to the model: a failed or
    // quiet agent needs a look whatever the brief says about it.
    const items = (brief.items ?? []).map(item=>{
      const node = byName.get(item.agent);
      return {item,node,attention:item.attention || node?.status === 'error' || (node ? isQuiet(node,now) : false)};
    }).sort((a,b)=>briefRank(a)-briefRank(b));
    for (const [index,{item,node,attention}] of items.entries()) {
      // A blank line between agents, when the room allows it, is what makes
      // one block end and the next begin at a glance.
      if (spaced && (index || brief.overall)) body.push('');
      const icon = node ? (()=>{const st=nodeStatus(node,now);return st.paint(st.icon);})() : colors.dim('·');
      const mark = attention ? theme.warning('!') : ' ';
      const head = `${mark}${icon} `;
      const name = squeeze(monitorText(node?.name ?? item.agent),Math.max(1,width-visualLength(head)));
      body.push(head+(attention ? theme.warning(name) : theme.strong(name)));
      body.push(...flow(item.note,3,attention ? theme.warning : (s: string) => s));
    }
  } else {
    body = (brief.text ?? '').split('\n').map(line=>line.trim()).filter(Boolean).flatMap(line=>flow(line,1));
  }
  // Paused, the last brief stays for reference but steps back.
  if (brief.paused) body = body.map(line=>colors.dim(stripAnsi(line)));
  return ['',rule,...(brief.text ? body : failure),...(brief.text ? failure.slice(0,1) : [])];
}

/**
 * "─ Brief · writing… ──────── b pause": the rule heading the brief, with
 * the switch that holds the model calls at its right end. No age: a counter
 * ticking up every second said nothing a reader acts on. The switch is where
 * the eye already is, and says what pressing it does.
 */
function briefRule(brief: NonNullable<MonitorData['brief']>, width: number): {line: string; control?: {x: number; width: number}} {
  const status = brief.paused ? t('paused') : brief.running ? t('writing…') : brief.error ? t('failed') : '';
  const label = `${t('─ Brief')}${status ? ` · ${status}` : ''} `;
  const switchText = ` ${t(brief.paused ? 'b resume' : 'b pause')} `;
  const room = width-visualLength(label)-visualLength(switchText);
  if (room < 1) return {line:colors.dim(truncateAnsi(label+'─'.repeat(Math.max(0,width-visualLength(label))),width))};
  const paint = brief.paused ? theme.accent : colors.dim;
  return {line:colors.dim(label+'─'.repeat(room))+paint(switchText),control:{x:width-visualLength(switchText),width:visualLength(switchText)}};
}

/** Brief order, the tree's order: what needs a look, then live, then the rest, then done. */
function briefRank({node,attention}: {node?: SubagentTreeNode; attention: boolean}): number {
  return attention ? 0 : node && isLive(node) ? 1 : node?.status === 'completed' ? 3 : 2;
}

function walkTree(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkTree(node.children,visit); }
}

/** Lines of the latest update the Inspector shows before "v More". */
const REPORT_LINES = 6;
const TITLES: Record<MonitorPane,string> = {agents:'1 Agents',worktrees:'2 Worktrees',changes:'3 Changes',details:'4 Inspector'};
export function renderMonitor(input: MonitorData): MonitorFrame {
  const width = Math.max(0,Math.floor(input.width)); const height = Math.max(0,Math.floor(input.height));
  const state = reconcileMonitor(input.state,input.tree,input.git,input.worktrees,input.nowMs ?? Date.now());
  const frame: MonitorFrame = {lines:[],panes:[],controls:[],state};
  if (!width || !height) return frame;
  if (state.help) {
    const help = ['1 Agents  2 Worktrees','3 Changes  4 Inspector','x close pane  - fold','2–4 open a pane','Tab next visible pane','j/k select  o switch','Click agent: switch','m return Main','a show/hide older','Enter / v inspect','v more / less details','z zoom  Esc back','q close tree  , settings','b pause / resume brief','✓ = turn completed','? = no status evidence','! = needs a look']
      .map(line=>t(line))
      .concat(t('{clocks} turn <1m, the quarter hour, 1h+',{clocks:TURN_CLOCKS.map(([,glyph])=>glyph).join('')+TURN_CLOCK_LONG}),
        ...['yellow clock = quiet 5m+','━╸─ = agent context used','dim name = done 1m+ ago','mod / Δ = changed files','S staged · U unstaged','L = locked worktree','stale = >30s since read'].map(line=>t(line)),
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
  // The status card takes the foot of the panel when it is tall enough to
  // keep the agents in view as well; a shorter panel gets fewer of its rows.
  // Under 24 columns the frame would cost more than it holds: no card.
  const cardRows = width >= 24 ? (height >= 24 ? 5 : height >= 18 ? 4 : height >= 13 ? 2 : 0) : 0;
  const card = cardRows && input.status ? input.status(width-4,cardRows) : null;
  const status = card?.rows.slice(0,cardRows) ?? [];
  // The card is its rows plus a top and bottom edge; the top edge carries the
  // key hint, so it replaces the hint's own line.
  const footRows = status.length ? status.length+2 : 1;
  let budget = Math.max(0,height-1-footRows-noticeRows.length);
  const ids = MONITOR_PANES.filter(id=>(id==='agents' || state.modes[id] !== 'closed') && (!state.zoom || id===state.focus));
  // Agents is the page, not one box among several: no frame, no title, and
  // it can be neither closed nor folded. The other panes stay boxes.
  const edgeOf = (id: MonitorPane) => id === 'agents' ? 0 : 1;
  const content = new Map(ids.map(id=>[id,paneRows(id,input,state,edgeOf(id) ? inner : width,now)]));
  let brief = ids.includes('agents') ? briefRows(input.brief,input.tree.nodes,width,now) : [];
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
  // Spare height goes to the brief under the agents first: it is written to
  // fill exactly this room. What is left goes to the inspector when it has
  // focus, else below the agents. Small worktree lists stay compact.
  if (brief.length && brief.length < budget) {
    const spaced = briefRows(input.brief,input.tree.nodes,width,now,true);
    if (spaced.length <= budget) brief = spaced;
  }
  let briefHeight = Math.min(budget,brief.length);
  budget -= briefHeight;
  const fillable = order.filter(id => (state.modes[id] !== 'folded' || !edgeOf(id)) && (sizes.get(id) ?? 0) > 0);
  const fill = state.focus==='details'&&fillable.includes('details') ? 'details' : fillable.includes('agents') ? 'agents' : fillable[0];
  if(fill==='agents'&&briefHeight){briefHeight+=budget;budget=0;}
  else if(fill){sizes.set(fill,(sizes.get(fill)??0)+budget);budget=0;}
  frame.lines = Array.from({length:height},()=>fit('',width));
  frame.lines[0] = theme.accent(pair(t(width < 20 ? ' ← Main' : ' ← Main session'),'m ',width));
  frame.controls.push({kind:'main',x:0,y:0,width});
  let y = 1;
  for (const id of ids) {
    const h = sizes.get(id) ?? 0; if (!h) continue;
    const rows = content.get(id) ?? [];
    const edge = edgeOf(id);
    const width_ = edge ? inner : width;
    const count = Math.max(0,h-2*edge);
    // With no box title above it, the agents' summary line is the heading:
    // it stays at the top while the agents under it scroll.
    const pinned = edge ? 0 : Math.min(1,count);
    let offset = Math.max(0,Math.min(state.scroll[id],Math.max(0,rows.length-count)));
    const selected = id==='agents'?state.tree.selectedId:id==='worktrees'?state.selectedWorktree:id==='changes'?state.selectedFile:null;
    const index = selected ? rows.findIndex(row=>row.item===selected) : -1;
    if (index>=pinned && count>pinned) { if(index-pinned<offset)offset=index-pinned;else if(index>=offset+count)offset=index-count+1; }
    state.scroll[id]=offset;
    const pane = {id,x:0,y,width,height:h,rows,offset,contentLength:rows.length,edge,pinned}; frame.panes.push(pane);
    const border = colors.dim;
    const heading = id===state.focus ? theme.accent : colors.dim;
    const buttons = width>=12 ? `[${state.modes[id]==='folded'?'+':'-'}][x]` : '';
    const shortTitle = t({agents:'Agents',worktrees:width<20?'WT':'Worktrees',changes:'Changes',details:'Inspect'}[id]);
    if(!edge) {
      // No title row: the agents' summary line heads the page.
    } else if(bordered) {
      const title = fit(' '+t(TITLES[id])+' ',Math.max(0,width-2-buttons.length));
      frame.lines[y] = truncateAnsi(heading('┌'+title+buttons+'┐'),width);
    } else {
      // "─ Agents ────[-][x]": the rule doubles as the frame.
      const room = Math.max(0,width-buttons.length);
      const label = truncateAnsi('─ '+shortTitle+' ',room);
      frame.lines[y] = truncateAnsi(heading(label+'─'.repeat(Math.max(0,room-visualLength(label)))+buttons),width);
    }
    if(buttons && edge) {
      const right = bordered ? width-1 : width;
      frame.controls.push({kind:'fold',pane:id,x:right-6,y,width:3},{kind:'close',pane:id,x:right-3,y,width:3});
    }
    for(let i=0;i<count;i++) {
      const row=i<pinned?rows[i]:rows[offset+i];
      const clipped=truncateAnsi(row?.text??'',width_);
      // The highlight covers the row's words, not the blank run after them:
      // a selected short name should not paint a bar across the pane. An
      // agent row carries no highlight at all: inverse video hid its colours,
      // and its › marker already says which one is selected.
      const highlight=row?.item&&row.item===selected&&id===state.focus&&id!=='agents';
      const body=(highlight?theme.selected(clipped):clipped)+' '.repeat(Math.max(0,width_-visualLength(clipped)));
      frame.lines[y+edge+i]=truncateAnsi(edge&&bordered?border('│')+padding+body+padding+border('│'):body,width);
    }
    if(edge&&h>1) {
      const range=rows.length>count&&count?` ${offset+1}–${Math.min(rows.length,offset+count)}/${rows.length} `:'';
      if(bordered) {
        frame.lines[y+h-1]=truncateAnsi(border('└'+fit(range,Math.max(0,width-2)).replace(/ /g,'─')+'┘'),width);
      } else {
        const head=truncateAnsi('─'+range,width);
        frame.lines[y+h-1]=truncateAnsi(border(head+'─'.repeat(Math.max(0,width-visualLength(head)))),width);
      }
    }
    y+=h;
    if(id==='agents'&&briefHeight) {
      brief.slice(0,briefHeight).forEach((line,i)=>{frame.lines[y+i]=fit(line,width);});
      // The rule is the brief's second line, after the blank that sets it off.
      const control = briefHeight>1 && input.brief ? briefRule(input.brief,width).control : undefined;
      if(control) frame.controls.push({kind:'brief',x:control.x,y:y+1,width:control.width});
      y+=briefHeight;
    }
  }
  const foot = height-footRows;
  if(input.art) placeArt(frame.lines,foot-noticeRows.length,width,input.art);
  for(let i=0;i<noticeRows.length;i++) frame.lines[foot-noticeRows.length+i]=theme.warning(fit(noticeRows[i],width));
  if(card && status.length) {
    const title = colors.dim(` ${t('Status')} `);
    const top = cardEdge('╭','╮',width,card.top ? `${title}${card.top} ` : title,title,
      [` ${t(', Settings  ? keys')} `,` ${t(', ?')} `]);
    frame.lines[foot]=top.line;
    // The whole hint opens settings; `?` works from the keyboard.
    if(top.right) frame.controls.push({kind:'settings',x:top.right.x+1,y:foot,width:visualLength(top.right.text)-2});
    status.forEach((line,i)=>{frame.lines[foot+1+i]=colors.dim('│ ')+fit(line,width-4)+colors.dim(' │');});
    frame.lines[foot+status.length+1]=cardEdge('╰','╯',width,card.bottom ? ` ${card.bottom} ` : '','',card.bottomRight ? [` ${card.bottomRight} `] : [],true).line;
  } else if(height>1) {
    frame.lines[foot]=colors.dim(truncateAnsi(t(width<24 ? ', Settings  ?' : ', Settings  ? keys  1–4'),width));
    frame.controls.push({kind:'settings',x:0,y:foot,width:Math.min(width,12)});
  }
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

/**
 * One edge of the status card: "╭─ left ──────── right ─╮". The left text is
 * tried whole, with each right text in turn and then none, before the same
 * again with `fallback`; the first pairing that leaves a dash between them
 * wins. With `squeeze` the left
 * text is cut to fit instead of falling back. The frame is muted; what rides
 * on it keeps its own colours.
 */
function cardEdge(open: string, close: string, width: number, left: string, fallback: string, rights: string[], squeeze = false):
  {line: string; right?: {x: number; text: string}} {
  const room = width-4;
  // The left text matters more: every right text is tried with it before
  // the fallback is.
  for (const candidate of squeeze ? [left] : [left,fallback]) {
    for (const right of [...rights,'']) {
      const space = room-visualLength(right)-1;
      if (space < 0) continue;
      // Cut inside the padding, so the text still ends in a space before the rule.
      const shown = squeeze && visualLength(candidate) > space ? truncateAnsi(candidate,Math.max(0,space-1))+' ' : candidate;
      if (visualLength(shown) > space) continue;
      const fill = room-visualLength(shown)-visualLength(right);
      const line = colors.dim(open+'─')+shown+colors.dim('─'.repeat(fill))
        +colors.dim(right)+colors.dim('─'+close);
      return {line,right:right ? {x:2+visualLength(shown)+fill,text:right} : undefined};
    }
  }
  return {line:colors.dim(open+'─'.repeat(Math.max(0,width-2))+close)};
}

function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = id==='agents'?'agent':id==='worktrees'?'worktree':id==='changes'?'file':state.preview;
  return {...state,focus:id,preview,modes:{...state.modes,[id]:'open'},scroll:{...state.scroll,details:preview===state.preview?state.scroll.details:0}};
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  const edge = pane.edge ?? 1;
  if (x < pane.x || x >= pane.x + pane.width || y < pane.y + edge || y >= pane.y + pane.height - edge) return undefined;
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
            next.tree.selectedId=id;next.preview='agent';next.scroll.details=0;
            return result({type:'switch',id});
          }
          if(pane.id==='worktrees') {next.selectedWorktree=id;next.preview='worktree';}
          if(pane.id==='changes') {next.selectedFile=id;next.preview='file';}
          next.scroll.details=0;return result();
        }
      } else key=input.button==='wheel-down'?'down':'up';
    }
  }
  if(key==='settings')return result({type:'settings'});
  if(key==='brief-toggle')return result({type:'brief-toggle'});
  if(key==='main')return result({type:'switch',id:ctx.tree.rootId});
  if(key==='open-session')return next.focus==='agents'&&next.tree.selectedId?result({type:'switch',id:next.tree.selectedId}):result();
  if(key==='show-all')next.tree.showAll=!next.tree.showAll;
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
      if(move){const index=rows.findIndex(row=>row.node.id===next.tree.selectedId);const target=key==='home'?0:key==='end'?rows.length-1:Math.max(0,index)+delta;
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
