/** Default F12 view: a monitor, not another transcript. No I/O or terminal input here. */
import type { SubagentTree } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { WorktreesSnapshot } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import { initialPanelState, reconcileSelection, visibleRows, type PanelState, type PanelRow } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { modelLegend } from './model-glyphs.js';
import { iconSet } from './hud-config.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import type { StatusCard } from './status-block.js';
import { t } from './i18n.js';
import { drawAgentsView } from './agents-view.js';
import { controlBar, paneHead, icon, look, type CountsText } from './control-bar.js';
import { planFoot, type StatusLevel, type FootInfo } from './status-foot.js';
import type { WorkbenchEvent } from './workbench-state.js';
import { fit, wrapped, helpLines } from './monitor-text.js';
import { TURN_CLOCKS, TURN_CLOCK_LONG, isUntracked, UNTRACKED_ROW, listsWorktrees, worktreeOfItem } from './monitor-labels.js';
import { paneRows, agentsView, putAwayCount, summaryRow } from './monitor-panes.js';
import { timelineCount, type TimelineStyle } from './monitor-timeline.js';
import { roleSet } from './directions.js';

// The panel is drawn by the modules beside this one; what they export is
// exported here too, so a caller imports the monitor from one place.
export { monitorText, plainText, fit, pair, flowLines, squeeze, diffRows } from './monitor-text.js';
export { iconic, agoText, age, nodeStatus, worktreeLabel, worktreeName, worktreePlace, TURN_CLOCKS, QUIET_MS, FRESH_FINISH_MS,
  isLive, isQuiet, turnClock, nextRepaintDelay, finishedAt, agentPaint, writtenAge } from './monitor-labels.js';
export { CONTEXT_METER_WIDTH, contextLine, METER_MIN, meterText, meterRow, type EdgeMeter } from './monitor-meter.js';
export { summaryRow, guardianChip, changeCounts, shownPaths, briefSaid, briefRuleRow, briefRule } from './monitor-panes.js';
export { timelineText, TIMELINE_STYLES, TIMELINE_HOURS, TIMELINE_STEP, TIMELINE_EARLIER, type TimelineStyle } from './monitor-timeline.js';
export { MODEL_LOG_KINDS } from './monitor-inspector.js';
export { clickTab, monitorRowAt, monitorItemAt, canMonitorDiff, handleMonitorInput } from './monitor-input.js';


export const MONITOR_PANES = ['agents', 'timeline', 'changes', 'details'] as const;
export type MonitorPane = typeof MONITOR_PANES[number];
export type PaneMode = 'open' | 'closed';
export type MonitorModes = Record<MonitorPane, PaneMode>;
export interface MonitorState {
  tree: PanelState;
  focus: MonitorPane;
  modes: MonitorModes;
  scroll: Record<MonitorPane, number>;
  /** The worktree whose changes are listed. */
  selectedWorktree: string | null;
  /**
   * The changes' cursor: a file's path, the untracked files' row, or a
   * worktree's row (`worktreeItem`), where the list heads its files with them.
   */
  selectedFile: string | null;
  /** Changes: the untracked files listed under their row, not folded into it. */
  untrackedOpen?: boolean;
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
  /** How the timeline draws its levels: off a rail, indented, or in lanes. The panel sets it from settings. */
  timelineStyle?: TimelineStyle;
  /** The timeline's window, the newest hours. The panel sets it from settings. */
  timelineHours?: number;
  /** Entries the reader brought back from before the window. Panel state, reset with the session. */
  timelineMore?: number;
  /** The L2 roles the timeline and the cards give a line of their own. The panel sets it from settings. */
  importantRoles?: ReadonlySet<string>;
  /** The cards' corners. The panel sets it from settings. */
  cardCorners?: 'square' | 'round';
  /** False leaves out the line on a card counting its subtasks by role. The panel sets it from settings. */
  roleCounts?: boolean;
}
export type PanelStyle = 'rich' | 'compact';
/** A click target on a row; `x` counts from the row's start. */
export interface RowControl { kind: MonitorControl['kind']; item?: string; x: number; width: number }
/**
 * `item` is what a click selects. `key` names the block a row belongs to, so a scrolled view can
 * keep its place; `controls` are click targets on the row.
 */
export interface MonitorRow { text: string; item?: string; key?: string; controls?: RowControl[];
  /** On the agents' heading: its counts in each form, for the title row to say as much as fits. */
  counts?: CountsText }
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
    modes:{agents:'open',timeline:'closed',changes:'closed',details:'closed'},
    scroll:{agents:0,timeline:0,changes:0,details:0}, selectedWorktree:null,selectedFile:null,
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
  return {agents:settings.agentsPane, timeline:settings.timelinePane, changes:settings.changesPane, details:settings.detailsPane};
}
/** What the settings say about how the panel shows things, as its state. */
export function monitorSettings(settings: HudSettings): Partial<MonitorState> {
  return {tabbed:settings.paneLayout === 'tabs', style:settings.panelStyle, statusLevel:settings.statusCard, labelAsName:settings.labelAsName,
    timelineStyle:settings.timelineStyle, timelineHours:settings.timelineHours, importantRoles:roleSet(settings.importantRoles),
    cardCorners:settings.cardCorners, roleCounts:settings.cardRoleCounts};
}
/**
 * The agents the agents view lists, in its order: in rich style the L1s
 * alone, a card each, their subtasks counted and the ones that matter named
 * on it; compact, the whole tree.
 */
export function listedAgents(nodes: SubagentTree['nodes'], state: MonitorState, nowMs: number): PanelRow[] {
  const rows = visibleRows(nodes, state.tree, nowMs);
  return state.style === 'rich' ? rows.filter(row => row.depth === 0) : rows;
}
export function monitorPreferences(state: MonitorState): Partial<HudSettings> {
  return {agentsPane:state.modes.agents, timelinePane:state.modes.timeline, changesPane:state.modes.changes, detailsPane:state.modes.details};
}
/**
 * The changes' cursor: the row it was on while that row is listed (a
 * worktree's, or a file's), the untracked files' row when its file is folded
 * into it, else the first file. Only the reader puts it on a worktree's row:
 * the files of a worktree just listed are still being read.
 */
function fileSelection(state: MonitorState, git?: GitChanges | null, worktrees?: WorktreesSnapshot | null): string | null {
  const on = worktreeOfItem(state.selectedFile);
  if (on !== undefined && listsWorktrees(worktrees) && worktrees!.entries.some(w => w.path === on)) return state.selectedFile;
  const files = git?.files ?? [];
  const folded = files.some(isUntracked);
  if (state.selectedFile === UNTRACKED_ROW && folded) return UNTRACKED_ROW;
  const file = files.find(f => f.path === state.selectedFile);
  if (file) return isUntracked(file) && !state.untrackedOpen ? UNTRACKED_ROW : file.path;
  return files.find(f => !isUntracked(f))?.path ?? (folded ? UNTRACKED_ROW : null);
}
export function reconcileMonitor(state: MonitorState, tree: SubagentTree, git?: GitChanges | null, worktrees?: WorktreesSnapshot | null, nowMs: number = Date.now()): MonitorState {
  const rows = listedAgents(tree.nodes, state, nowMs);
  const selected = reconcileSelection(state.tree, tree.nodes, rows);
  const entries = worktrees?.entries ?? [];
  const selectedWorktree = entries.some(w => w.path === state.selectedWorktree) ? state.selectedWorktree
    : entries.find(w => !w.bare && w.prunable === undefined)?.path ?? entries[0]?.path ?? null;
  const selectedFile = fileSelection(state,git,worktrees);
  // In the tabs layout any pane can be the one shown, whatever the stacked layout left closed.
  const focus = state.tabbed || state.modes[state.focus] !== 'closed' ? state.focus : MONITOR_PANES.find(id => state.modes[id] !== 'closed') ?? 'agents';
  const changed = selected.selectedId !== state.tree.selectedId || selectedWorktree !== state.selectedWorktree || selectedFile !== state.selectedFile;
  // A selection the panel made for itself (the first agent, or a stand-in
  // for one that left) is not the reader moving: the view stays put.
  const revealed = selected.selectedId !== state.tree.selectedId ? selected.selectedId : state.revealed;
  return {...state, tree:selected, selectedWorktree, selectedFile, focus, revealed,
    scroll:{...state.scroll,details:changed ? 0 : state.scroll.details}};
}

/**
 * The panel's top as the display config now draws it: the control bar and
 * the focused pane's title (the agents' with their counts; in the tabs
 * layout, the counts alone), for the settings page to preview a look, its
 * icons, a theme or the panes before they are saved. A one-row bar has a
 * blank row under it, as a tall panel parts its sections, so every look is
 * three rows and the page holds still while the looks are stepped through.
 */
export function panelTop(input: Pick<MonitorData,'tree'|'brief'|'nowMs'>, state: MonitorState, width: number): string[] {
  const now = input.nowMs ?? Date.now();
  const bar = controlBar(state,{brief:input.brief,expired:putAwayCount(input.tree.nodes,state,now)},width);
  const info = state.focus === 'agents' ? summaryRow(input).row.counts : undefined;
  return [...bar.lines,...(bar.lines.length < 2 ? [''] : []),paneHead(state.focus,width,{focused:true,zoomed:false,named:!state.tabbed,info})];
}

/** An agents view shorter than this drops its blank lines rather than scroll past most of what it holds. */
const DENSE_BELOW = 12;
/** Rows from which a blank row parts the panel's sections. */
const PARTED_FROM = 30;
/** The widest the help's key column grows: a longer key pushes its own line on. */
const HELP_KEY_COLUMN = 12;

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
      ...(tabbed ? ['{p} 1–4  show a pane  {p} Tab  next'] : ['{p} 1–4  open / close a pane  {p} Tab  next','{p} x  close pane']),
      '{p} j k ↑ ↓  select, repeats','{p} PgUp PgDn  scroll  {p} g G  first / last',
      tabbed ? '{p} Enter / v  inspect' : '{p} Enter / v  inspect  {p} z  zoom',...(rich ? ['{p} e / Space  open / close card'] : []),
      ...(rich ? [] : ['{p} h l  fold / unfold agent']),'{p} f  filter  {p} s  order',
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
    ...['1 Cards  2 Timeline','3 Changes  4 Inspector','✓ = turn completed','? = no status evidence','! = needs a look',
      '⌕ research  ⚗ experiment  ⚒ fix','◈ review  ✎ writing  ∑ summary'].map(line=>t(line)),
    t('{clocks} turn <1m, the quarter hour, 1h+',{clocks:TURN_CLOCKS.map(([,glyph])=>glyph).join('')+TURN_CLOCK_LONG}),
    ...['~ = written by a model','Brief: ! needs  ◎ goal  ▸ now  ✓ done  ⚑ approve',
      'status card gutter colour = main session state','┃ = auto-compact point','◈N = guardian reviews  +N = folded agents','Timeline: ⏎ turn finished  ×N in a row','yellow clock = quiet 5m+','──56%── = context or quota used, the % at the fill','meter: blue, yellow past 70%, red past 85%','dim name = done 1m+ ago','mod = changed files','stale = >30s since read'].map(line=>t(line)),
    ...stripAnsi(modelLegend()).split('\n'),
  ];
}

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
    // An entry is a key, two spaces, what it does: "{p} {p}  {p} itself" is
    // one. A line of two shortcuts is split between them, never inside one.
    const prefix = input.prefix ?? 'Ctrl+]';
    const keyStart = new RegExp(`  (?=(?:${prefix.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')}|Shift\\+F12) )`);
    const split = (line: string) => {
      const out: string[] = [];
      for (const part of line.split(keyStart)) {
        if (out.length && !out[out.length-1].includes('  ')) out[out.length-1] += `  ${part}`;
        else out.push(part);
      }
      return out;
    };
    const entries = (line: string) => visualLength(line) <= width ? [line] : split(line);
    const text = helpText(state.style === 'rich',prefix,Boolean(state.tabbed));
    // The shortcuts, up to the second heading, are a table: each key without
    // the prefix its heading names, in a column, and what it does beside it,
    // wrapped under itself. A line with no key is a sentence.
    const shortcuts = Math.max(1,text.findIndex((line,i)=>i > 0 && typeof line !== 'string'));
    const keyed = (entry: string) => {
      const bare = entry.startsWith(`${prefix} `) ? entry.slice(prefix.length+1) : entry;
      const at = bare.indexOf('  ');
      return at > 0 ? {key:bare.slice(0,at),does:bare.slice(at+2)} : null;
    };
    const keys = text.slice(0,shortcuts).flatMap(line=>typeof line === 'string' ? split(line).flatMap(entry=>keyed(entry) ?? []) : []);
    const column = Math.min(HELP_KEY_COLUMN,Math.max(1,...keys.map(entry=>visualLength(entry.key))));
    const help = text.flatMap((line,i) => {
      // A blank line parts the sections.
      if (typeof line !== 'string') return [...(i ? [''] : []),...helpLines(line.head,width).map(text=>theme.accent(text))];
      if (i >= shortcuts) return entries(line).flatMap(entry=>helpLines(entry,width));
      return split(line).flatMap(entry => {
        const shortcut = keyed(entry);
        if (!shortcut) return helpLines(entry,width);
        const key = shortcut.key+' '.repeat(Math.max(0,column-visualLength(shortcut.key)));
        const hang = visualLength(key)+2;
        return helpLines(shortcut.does,Math.max(1,width-hang)).map((does,j)=>j ? ' '.repeat(hang)+does : `${theme.value(key)}  ${does}`);
      });
    });
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
  // The status card takes the foot, at the level chosen, at most about a
  // third of the panel; it replaces the key hint's own line.
  let footPlan = planFoot(input,state,width,height,now,noticeRows.length);
  let footRows = footPlan.rows;
  // Every control the panel has is on its first rows; nothing else is a button.
  const bar = controlBar(state,{brief:input.brief,expired:putAwayCount(input.tree.nodes,state,now)},width);
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
  // Rows no pane has a use for are the status card's, as far as its brief fills them.
  if (budget > 0 && footRows) {
    footPlan = planFoot(input,state,width,height,now,noticeRows.length,footRows+budget);
    budget += footRows-footPlan.rows;
    footRows = footPlan.rows;
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
      // In the tabs layout the tab above names the pane: its title is its counts and where its rows are.
      drawAgentsView(frame,state,rows,y,cw,h,(counts,range)=>paneHead(id,width,{info:counts,right:range && colors.dim(range),focused,zoomed,named:!state.tabbed}),framed ? 2 : 0);
      if (rows.length) titles.add(y);
      y += h; continue;
    }
    const edge = edgeOf(id);
    const count = Math.max(0,h-edge);
    let offset = Math.max(0,Math.min(state.scroll[id],Math.max(0,rows.length-count)));
    const selected = id==='changes'?state.selectedFile:null;
    const index = selected ? rows.findIndex(row=>row.item===selected) : -1;
    if (index>=0 && count>0) { if(index<offset)offset=index;else if(index>=offset+count)offset=index-count+1; }
    state.scroll[id]=offset;
    const pane = {id,x:framed ? 2 : 0,y,width:cw,height:h,rows,offset,contentLength:rows.length,edge,pinned:0}; frame.panes.push(pane);
    // The title: the pane's icon and name on the left, where its rows are or
    // how many there are on the right, as the look draws it; a click anywhere
    // on it zooms or restores the pane.
    const range = rows.length>count&&count ? `${offset+1}–${Math.min(rows.length,offset+count)}/${rows.length}` : '';
    const total = id==='changes' ? input.git?.files.length ?? 0 : id==='timeline' ? timelineCount(rows) : 0;
    const right = range || (total ? t(id==='changes'?'{n} files':'{n} events',{n:total}) : '');
    frame.lines[y] = paneHead(id,width,{right:right && colors.dim(right),focused,zoomed,named:!state.tabbed});
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
