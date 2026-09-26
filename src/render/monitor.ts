/** Default F12 view: a monitor, not another transcript. No I/O or terminal input here. */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { WorktreesSnapshot, WorktreeInfo } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { initialPanelState, reconcileSelection, visibleRows, applyKey, countExpired, type PanelState } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { displayConfig } from './hud-config.js';

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
}
export interface MonitorControl {
  kind: 'main' | 'settings' | 'fold' | 'close';
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
  action?: {type:'settings'} | {type:'switch'; id:string};
}

export function initialMonitorState(): MonitorState {
  return {tree:{...initialPanelState(),sort:'active'}, focus:'agents',
    modes:{agents:'open',worktrees:'open',changes:'closed',details:'closed'},
    scroll:{agents:0,worktrees:0,changes:0,details:0}, selectedWorktree:null,selectedFile:null,
    preview:'agent',help:false,zoom:false,helpScroll:0,expanded:false};
}
export function monitorModes(settings: HudSettings): MonitorModes {
  return {agents:settings.agentsPane, worktrees:settings.worktreesPane, changes:settings.changesPane, details:settings.detailsPane};
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
function basename(path: string): string { return path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1) || path; }
function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const found = findNode(node.children,id); if (found) return found; }
  return undefined;
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
    `${paint(icon)}${n}${words ? colors.dim(` ${word}`) : ''}`;
  // Only what is there: "▸0 run" beside thirty finished agents is noise.
  const summary = [
    totals.error ? count('!',theme.error,totals.error,'failed') : '',
    totals.run ? count('▸',theme.info,totals.run,'run') : '',
    totals.done ? count('✓',theme.success,totals.done,'done') : '',
    totals.unknown ? count('?',colors.dim,totals.unknown,'unknown') : '',
  ].filter(Boolean).join(words ? '  ' : ' ');
  // The summary doubles as the switch for what the linger window hid.
  const toggle = !expired ? '' : state.tree.showAll ? colors.dim(words ? 'hide old' : '−old')
    : theme.accent(words ? `+${expired} older` : `+${expired}`);
  const result: MonitorRow[] = [{text:pair(summary,toggle,width),...(expired ? {action:'toggle-finished' as const} : {})}];
  for (const row of visibleRows(input.tree.nodes,state.tree,now)) {
    const node = row.node;
    const status = nodeStatus(node,now);
    const branch = visualLength(row.prefix) > Math.floor(width/4) ? '… ' : row.prefix;
    const prefix = `${node.id === state.tree.selectedId ? '›' : ' '}${colors.dim(branch)}${row.collapsed && row.hasChildren ? '+' : ''}${status.paint(status.icon)} `;
    // A finished parent kept only to show whose child a live agent is recedes.
    const name = row.context ? colors.dim(monitorText(node.name)) : monitorText(node.name);
    // Same celestial badges as the compact HUD. Narrow panes keep glyphs only.
    const token = width < 10 ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
      mode: width < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
    });
    const badge = token ? truncateAnsi(token, Math.max(2, Math.floor(width/4))) : '';
    // How long the turn has been running, or how long ago the agent finished:
    // the second is how a reader knows a row is about to leave.
    const when = width < 24 ? '' : node.status === 'running' ? status.label
      : node.status === 'completed' && !row.context ? `${age(finishedAt(node),now)}${width >= 40 ? ' ago' : ''}` : '';
    // The agent's own context fill, where the row is wide enough to carry it
    // without pushing the badge off: 26 content columns is a 30-column pane,
    // the widest the default split makes, minus its borders. Absent data
    // shows nothing rather than 0%.
    const ctx = width >= 26 && node.contextUsage ? colors.dim(`${node.contextUsage.percent}%`) : '';
    const right = [badge,when ? colors.dim(when) : '',ctx].filter(Boolean).join(' ');
    result.push({text:pair(prefix+name,right,width),item:node.id});
  }
  if (result.length === 1) {
    const empty = !everyone.length ? 'No subagents yet'
      : expired && !state.tree.showAll && state.tree.filter === 'all' ? 'All finished · a shows' : 'No matching agents';
    result.push({text:colors.dim(truncateAnsi(empty,width))});
  }
  return result;
}

function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  if (id === 'agents') return agentRows(input,state,width,now);
  if (id === 'worktrees') {
    const snapshot = input.worktrees;
    if (!snapshot) return [{text:colors.dim('Reading worktrees…')}];
    if (snapshot.error) return [{text:theme.warning('No readable repository')}, {text:colors.dim('Set worktreeRoot')}, ...wrapped(snapshot.error,width).map(text=>({text:colors.dim(text)}))];
    const rows: MonitorRow[] = [];
    if (snapshot.truncated) rows.push({text:theme.warning('Worktree list limited')});
    for (const entry of snapshot.entries) {
      const label = worktreeLabel(entry,now);
      const mark = (entry.path === state.selectedWorktree ? '›' : ' ') + (entry.locked !== undefined ? 'L' : ' ');
      const name = monitorText(entry.branch ?? (entry.detached ? 'detached' : basename(entry.path)))
        + (width >= 40 ? ' · '+monitorText(basename(entry.path)) : '');
      const paint = label.startsWith('!') || entry.error ? theme.warning : label === 'clean' ? colors.dim : theme.value;
      rows.push({text:pair(mark+name,paint(label),width),item:entry.path});
      // A directory label is useful identity, not a log line. Two lines only when it fits.
      if (width >= 20 && width < 40) rows.push({text:colors.dim(truncateAnsi('  '+monitorText(basename(entry.path)),width)),item:entry.path});
    }
    return rows.length ? rows : [{text:colors.dim('No worktrees recorded')}];
  }
  if (id === 'changes') {
    const git = input.git;
    const rows: MonitorRow[] = [];
    if (!git) return [{text:colors.dim('Reading selected worktree…')}];
    if (git.error) rows.push({text:theme.warning('Git incomplete')});
    if (!git.root) return [...rows,{text:colors.dim('No selected worktree')}];
    const changed = (x:string) => x !== ' ' && x !== '.' && x !== '?';
    const conflicts = git.files.filter(file=>file.conflict).length;
    if (conflicts) rows.push({text:theme.warning(`! ${conflicts} conflicts`)});
    if (git.files.length) {
      const staged=git.files.filter(f=>!f.conflict&&changed(f.index)).length;
      const unstaged=git.files.filter(f=>!f.conflict&&changed(f.worktree)).length;
      rows.push({text:colors.dim(width<36?`${git.files.length}Δ ${staged}S ${unstaged}U`:`${git.files.length} files · ${staged} staged · ${unstaged} unstaged`)});
    }
    return [...rows, ...git.files.map(file => ({item:file.path,
      text:truncateAnsi(`${file.path===state.selectedFile?'›':' '} ${file.conflict?theme.error('!!'):file.index+file.worktree} ${monitorText(width<36?basename(file.path):file.path)}`,width)})),
      ...(git.files.length ? [] : [{text:colors.dim(git.error ? 'Status unknown' : 'Working tree clean')}])];
  }
  // Inspector is explicitly opened (Enter/v/4), never follows agent clicks into a transcript.
  let lines: string[] = [];
  if (state.preview === 'agent') {
    const node = findNode(input.tree.nodes,state.tree.selectedId);
    if (!node) lines = ['Select an agent'];
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
      const finished = node.status === 'completed' ? colors.dim(` · ${age(finishedAt(node),now)} ago`) : '';
      rows.push({text:truncateAnsi(`${status.paint(status.icon)} ${node.status}${finished}`,width)});
      const ctx = node.contextUsage;
      if (ctx) rows.push({text:truncateAnsi(
        `${colors.dim('Ctx')} ${ctx.percent}% (${formatTokenCount(ctx.used)}/${formatTokenCount(ctx.total)})`,width)});
      lines = [`Turn age: ${age(node.turnStartedAt,now)}`,`Last activity: ${age(node.lastEventAt,now)}`];
      // Codex's transcript still calls the agent by its nickname.
      if (node.nickname && node.nickname !== node.name) lines.push(`Nickname: ${node.nickname}`);
      if (node.role) lines.push(`Role: ${node.role}`);
      if (state.expanded) lines.push(`Turn start: ${node.turnStartedAt && Number.isFinite(node.turnStartedAt.getTime()) ? node.turnStartedAt.toISOString() : 'unknown'}`,`UUID: ${node.id}`);
      rows.push(...lines.flatMap(line=>wrapped(line,width).map(text=>({text}))));
      rows.push({text:colors.dim(truncateAnsi(state.expanded?'v Less':'v More',width))});
      return rows;
    }
  } else if (state.preview === 'worktree') {
    const entry = input.worktrees?.entries.find(e=>e.path===state.selectedWorktree);
    if (!entry) lines = ['Select a worktree'];
    else {
      lines = [`Branch: ${entry.branch ?? (entry.bare?'bare':'detached')}`,`Status: ${worktreeLabel(entry,now)}`,basename(entry.path)];
      if (entry.error) lines.push(entry.error);
      if (entry.locked !== undefined) lines.push(`Locked: ${entry.locked || 'yes'}`);
      if (entry.prunable !== undefined) lines.push(`Prunable: ${entry.prunable || 'yes'}`);
      if (entry.status) lines.push(`${entry.status.staged} staged / ${entry.status.unstaged} unstaged`,`${entry.status.untracked} untracked / ${entry.status.conflicts} conflicts`,
        `Ahead ${entry.status.ahead ?? '?'} / behind ${entry.status.behind ?? '?'}`);
      lines.push('Workspace status, not agent ownership');
      if (state.expanded) lines.push(entry.path,`HEAD: ${entry.head ?? '?'}`);
      lines.push(state.expanded?'v Less':'v More');
    }
  } else {
    lines = [state.selectedFile ? basename(state.selectedFile) : 'No selected file'];
    if (state.expanded) lines.push(input.git?.root ?? 'No selected worktree',state.selectedFile ?? '');
    return [...lines.flatMap(t=>wrapped(t,width).map(text=>({text:theme.strong(text)}))), ...(input.diff ?? ['Reading diff…']).flatMap(line=>{
      const paint = line.startsWith('@@') ? theme.info : line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.error : theme.value;
      return wrapped(line,width).map(text=>({text:paint(text)}));
    })];
  }
  return lines.flatMap(line => wrapped(line,width).map(text=>({text})));
}

const TITLES: Record<MonitorPane,string> = {agents:'1 Agents',worktrees:'2 Worktrees',changes:'3 Changes',details:'4 Inspector'};
export function renderMonitor(input: MonitorData): MonitorFrame {
  const width = Math.max(0,Math.floor(input.width)); const height = Math.max(0,Math.floor(input.height));
  const state = reconcileMonitor(input.state,input.tree,input.git,input.worktrees,input.nowMs ?? Date.now());
  const frame: MonitorFrame = {lines:[],panes:[],controls:[],state};
  if (!width || !height) return frame;
  if (state.help) {
    const help = ['1 Agents  2 Worktrees','3 Changes  4 Inspector','x close pane  - fold','1–4 reopen closed pane','Tab next visible pane','j/k select  o switch','Click agent: switch','m return Main','a show/hide older','Enter / v inspect','v more / less details','z zoom  Esc back','q close tree  , settings','✓ = turn completed','? = no status evidence','mod / Δ = changed files','S staged · U unstaged','L = locked worktree','stale = >30s since read',...stripAnsi(modelLegend()).split('\n')].flatMap(line=>helpLines(line,width));
    const count = Math.max(0,height-2);
    state.helpScroll = Math.max(0,Math.min(state.helpScroll??0,Math.max(0,help.length-count)));
    frame.helpPage = {count,total:help.length};
    frame.lines = [theme.accent('Monitor keys'),...help.slice(state.helpScroll,state.helpScroll+count)];
    while(frame.lines.length<height-1)frame.lines.push('');
    if(height>1)frame.lines.push(colors.dim(`↑↓ ${state.helpScroll+1}/${help.length} Esc back`));
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
  let budget = Math.max(0,height-2-noticeRows.length);
  const ids = MONITOR_PANES.filter(id=>state.modes[id] !== 'closed' && (!state.zoom || id===state.focus));
  const content = new Map(ids.map(id=>[id,paneRows(id,input,state,inner,now)]));
  const sizes = new Map<MonitorPane,number>();
  for (const id of ids) { sizes.set(id,budget>0?1:0); if (budget>0) budget--; }
  const order = [state.focus,...ids.filter(id=>id!==state.focus)].filter(id=>ids.includes(id));
  while (budget > 0) {
    let grew = false;
    for (const id of order) {
      if (!budget) break;
      const rows = content.get(id)?.length ?? 0;
      const target = state.modes[id] === 'folded' ? 1 : state.zoom ? height : rows + 2;
      const size = sizes.get(id) ?? 0;
      if (size && size < target) { sizes.set(id,size+1);budget--;grew=true; }
    }
    if (!grew) break;
  }
  // Give spare height to the tree or the inspector; small worktree lists stay compact.
  const fillable = order.filter(id => state.modes[id] !== 'folded' && (sizes.get(id) ?? 0) > 0);
  const fill = state.focus==='details'&&fillable.includes('details') ? 'details' : fillable.includes('agents') ? 'agents' : fillable[0];
  if(fill){sizes.set(fill,(sizes.get(fill)??0)+budget);budget=0;}
  frame.lines = Array.from({length:height},()=>fit('',width));
  frame.lines[0] = theme.accent(pair(width < 20 ? ' ← Main' : ' ← Main session','m ',width));
  frame.controls.push({kind:'main',x:0,y:0,width});
  let y = 1;
  for (const id of ids) {
    const h = sizes.get(id) ?? 0; if (!h) continue;
    const rows = content.get(id) ?? [];
    const count = Math.max(0,h-2);
    let offset = Math.max(0,Math.min(state.scroll[id],Math.max(0,rows.length-count)));
    const selected = id==='agents'?state.tree.selectedId:id==='worktrees'?state.selectedWorktree:id==='changes'?state.selectedFile:null;
    const index = selected ? rows.findIndex(row=>row.item===selected) : -1;
    if (index>=0 && count) { if(index<offset)offset=index;else if(index>=offset+count)offset=index-count+1; }
    state.scroll[id]=offset;
    const pane = {id,x:0,y,width,height:h,rows,offset,contentLength:rows.length}; frame.panes.push(pane);
    const border = colors.dim;
    const heading = id===state.focus ? theme.accent : colors.dim;
    const buttons = width>=12 ? `[${state.modes[id]==='folded'?'+':'-'}][x]` : '';
    const shortTitle = {agents:'Agents',worktrees:width<20?'WT':'Worktrees',changes:'Changes',details:'Inspect'}[id];
    if(bordered) {
      const title = fit(' '+TITLES[id]+' ',Math.max(0,width-2-buttons.length));
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
      const clipped=truncateAnsi(row?.text??'',inner);
      // The highlight covers the row's words, not the blank run after them:
      // a selected short name should not paint a bar across the pane.
      const body=(row?.item&&row.item===selected&&id===state.focus?theme.selected(clipped):clipped)
        +' '.repeat(Math.max(0,inner-visualLength(clipped)));
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
  for(let i=0;i<noticeRows.length;i++) frame.lines[height-1-noticeRows.length+i]=theme.warning(fit(noticeRows[i],width));
  if(height>1) {
    frame.lines[height-1]=colors.dim(truncateAnsi(width<24 ? ', Settings  ?' : ', Settings  ? keys  1–4',width));
    frame.controls.push({kind:'settings',x:0,y:height-1,width:Math.min(width,12)});
  }
  return frame;
}

function openPane(state: MonitorState, id: MonitorPane): MonitorState {
  const preview = id==='agents'?'agent':id==='worktrees'?'worktree':id==='changes'?'file':state.preview;
  return {...state,focus:id,preview,modes:{...state.modes,[id]:'open'},scroll:{...state.scroll,details:preview===state.preview?state.scroll.details:0}};
}
/** The row under a point inside a pane's frame, or nothing on its borders. */
export function monitorRowAt(pane: MonitorRect, x: number, y: number): MonitorRow | undefined {
  if (x < pane.x || x >= pane.x + pane.width || y <= pane.y || y >= pane.y + pane.height - 1) return undefined;
  const line = pane.offset + y - pane.y - 1;
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
    if(control?.pane) {
      next.focus=control.pane;
      key=control.kind==='close'?'pane-close':'pane-fold';
    } else {
      const pane=ctx.frame?.panes.find(p=>input.x>=p.x&&input.x<p.x+p.width&&input.y>=p.y&&input.y<p.y+p.height);
      if(!pane) return result();
      next.focus=pane.id;
      if(input.button==='left') {
        if(input.y===pane.y) key='pane-fold';
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
  if(key==='main')return result({type:'switch',id:ctx.tree.rootId});
  if(key==='open-session')return next.focus==='agents'&&next.tree.selectedId?result({type:'switch',id:next.tree.selectedId}):result();
  if(key==='show-all')next.tree.showAll=!next.tree.showAll;
  else if(key==='help'){next.help=true;next.helpScroll=0;}
  else if(key==='pane-close') {
    next.modes[next.focus]='closed';next.zoom=false;
    next.focus=MONITOR_PANES.find(id=>next.modes[id]!=='closed')??'agents';
  } else if(key==='pane-fold')next.modes[next.focus]=next.modes[next.focus]==='folded'?'open':'folded';
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
    const page=Math.max(1,(pane?.height??5)-2);
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
