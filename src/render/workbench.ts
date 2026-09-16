import { taskText } from '../utils/task-text.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { formatTokenRate } from '../collectors/token-rate.js';
/** Pure layout/rendering for the tree workbench. Rectangles also drive mouse hit testing. */
import type { SubagentTree, SubagentTreeNode, ToolCall } from '../types.js';
import type { RolloutParseResult } from '../collectors/rollout.js';
import type { GitChanges } from '../collectors/git-changes.js';
import { summarizeSubagents } from '../collectors/subagent-tree.js';
import { visibleRows } from './panel-state.js';
import { subagentVisual, formatElapsedShort } from './subagent-chip.js';
import { formatAge } from './subagent-tree-view.js';
import { colors, theme, truncateAnsi, visualLength, stripAnsi } from './colors.js';
import { reconcileWorkbench, type PaneId, type PaneRect, type WorkbenchState, type WorkbenchEvent } from './workbench-state.js';

export interface WorkbenchInputData {
  tree: SubagentTree;
  state: WorkbenchState;
  width: number;
  height: number;
  git?: GitChanges | null;
  diff?: string[];
  main?: RolloutParseResult | null;
  agent?: RolloutParseResult | null;
  events?: WorkbenchEvent[];
  nowMs?: number;
  error?: string | null;
  notice?: string | null;
}
export interface WorkbenchFrame { lines: string[]; panes: PaneRect[]; state: WorkbenchState }

/** Escape terminal controls in external data, including filenames and tool text. */
export function safeText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ch => ch === '\t' ? '  ' : ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const ch of safeText(raw)) {
      if (visualLength(line + ch) > width && line) { lines.push(line); line = ''; }
      line += ch;
    }
    lines.push(line);
  }
  return lines;
}
function fit(line: string, width: number): string {
  const clipped = truncateAnsi(line, Math.max(0, width));
  return clipped + ' '.repeat(Math.max(0, width - visualLength(clipped)));
}
function allNodes(nodes: SubagentTreeNode[]): SubagentTreeNode[] {
  return nodes.flatMap(node => [node, ...allNodes(node.children)]);
}
function rectangles(width: number, height: number, state: WorkbenchState, agentCount: number): PaneRect[] {
  const make = (id: PaneId, x: number, y: number, w: number, h: number): PaneRect => ({ id, x, y, width:w, height:h, offset:0, contentLength:0 });
  const available = Math.max(0, height - 2);
  if (state.zoom || available < 12 || width < 12) return available > 0 ? [make(state.focus, 0, 1, width, state.collapsed[state.focus] ? 1 : available)] : [];
  const stack = (ids: PaneId[], x:number, w:number): PaneRect[] => {
    const expanded = ids.filter(id => !state.collapsed[id]);
    const reserved = ids.length - expanded.length;
    const space = available - reserved;
    let y = 1;
    let remaining = space;
    let count = expanded.length;
    return ids.map(id => {
      const h = state.collapsed[id] ? 1 : count === 1 ? remaining : Math.max(3, Math.floor(remaining / count));
      if (!state.collapsed[id]) { remaining -= h; count--; }
      const rect = make(id,x,y,w,h); y += h; return rect;
    });
  };
  if (width >= 70) {
    const left = Math.min(44, Math.floor(width * 0.38));
    return [...stack(['agents','changes'],0,left), ...stack(['details','activity'],left,width-left)];
  }
  return stack(['agents','details','changes','activity'],0,width);
}
function command(call: ToolCall): string {
  const args = call.arguments;
  return typeof args?.code === 'string' ? args.code : typeof args?.cmd === 'string' ? args.cmd : typeof args?.command === 'string' ? args.command : call.target ?? call.name;
}
function statusLine(call: ToolCall, label = command(call)): string {
  const symbol = call.status === 'error' ? '✗' : call.status === 'running' ? '▸' : call.resultSuccess === true ? '✓' : '·';
  const paint = call.status === 'error' ? theme.error : call.status === 'running' ? theme.info : call.resultSuccess === true ? theme.success : colors.dim;
  return paint(`${symbol} ${safeText(label)}`);
}
function agentDetails(input: WorkbenchInputData, state: WorkbenchState, width: number): string[] {
  const node = allNodes(input.tree.nodes).find(node => node.id === state.tree.selectedId);
  if (!node) return [colors.dim('Select an agent')];
  const now = input.nowMs ?? Date.now();
  const {icon, paint} = subagentVisual(node);
  const lines = [paint(`${icon} ${safeText(node.name)} · ${node.status}`)];
  const expanded = state.detailExpanded;
  if (node.model || node.effort) lines.push(expanded ? theme.model(`${safeText(node.model ?? '')}${node.effort ? ` · ${safeText(node.effort)}` : ''}`) : renderModelEffortToken(safeText(node.model ?? ''),safeText(node.effort ?? '')));
  const task = taskText(node.task);
  if (task) lines.push(...(expanded ? wrap(`Task: ${task}`, width) : [truncateAnsi(`Task: ${safeText(task)}`,width)]));
  if (node.status === 'running' || node.status === 'starting') {
    const start = node.turnStartedAt ?? node.startedAt;
    if (start) lines.push(`This turn ${formatElapsedShort(start, now)}`);
  }
  lines.push(colors.dim(`Last event ${formatAge(node.lastEventAt, now) ?? 'unknown'}`));
  const agent = input.agent;
  if (agent && (!agent.session || agent.session.id === node.id)) {
    const rate = formatTokenRate(agent.outputRate, now);
    if (rate) {
      lines.push(theme.value(`Out ${rate}`));
      if (expanded) lines.push(colors.dim(`Sample ${(agent.outputRate!.sampleMs / 1000).toFixed(1)}s; includes waits`));
    }
    const calls = agent.toolActivity.recentCalls;
    const latest = calls[calls.length - 1];
    if (latest) {
      if (expanded) {
      lines.push(theme.strong('Latest tool'), ...wrap(stripAnsi(statusLine(latest)), width));
      if (latest.output) lines.push(...latest.output.split('\n').slice(-12).flatMap(line => wrap(line, width)));
      if (latest.duration !== undefined) lines.push(colors.dim(`${(latest.duration / 1000).toFixed(1)}s`));
      } else {
        const result = latest.exitCode !== undefined ? ` · exit ${latest.exitCode}` : '';
        const duration = latest.duration !== undefined ? ` · ${(latest.duration/1000).toFixed(1)}s` : '';
        const name = truncateAnsi(safeText(latest.name.replace(/^functions\./,'')),Math.max(1,width-2-visualLength(result+duration)));
        lines.push(truncateAnsi(statusLine(latest,stripAnsi(name)+result+duration),width));
      }
    }
    const plan = agent.planProgress;
    if (expanded && plan && state.tasksEnabled) lines.push(theme.strong(`Agent tasks ${plan.completedSteps}/${plan.totalSteps}`), ...plan.steps.flatMap(step => wrap(`${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▸' : '·'} ${step.step}`, width)));
  } else if (node.rolloutPath) lines.push(colors.dim('Loading agent activity…'));
  if (expanded) lines.push(colors.dim(`ID ${safeText(node.id)}`));
  return lines;
}
function detailLines(input: WorkbenchInputData, state: WorkbenchState, width: number): string[] {
  if (state.preview === 'file') {
    if (!state.selectedFile) return [colors.dim('No changed file selected')];
    return [theme.strong(safeText(state.selectedFile)), colors.dim('Workspace changes'), ...(input.diff ?? ['Loading diff…']).flatMap(raw => {
      const paint = raw.startsWith('+') ? theme.success : raw.startsWith('-') ? theme.error : raw.startsWith('@@') ? theme.info : theme.value;
      return wrap(raw, width).map(line => paint(line));
    })];
  }
  if (state.preview === 'event') {
    const event = input.events?.find(event => event.id === state.selectedEvent);
    return event ? [theme.strong(safeText(event.title)), colors.dim(event.at.toLocaleTimeString()), ...event.detail.flatMap(line => wrap(line, width))] : [colors.dim('Select an event')];
  }
  return agentDetails(input, state, width);
}
export function renderWorkbench(input: WorkbenchInputData): WorkbenchFrame {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const state = reconcileWorkbench(input.state, input.tree, input.git);
  if (!width || !height) return {lines:[], panes:[], state};
  const events = input.events ?? [];
  if (!events.some(event => event.id === state.selectedEvent)) state.selectedEvent = events[0]?.id ?? null;
  if (state.help) {
    const help = ['Workbench keys', 'Tab / Shift+Tab  focus pane', '1 Agents  2 Details', '3 Changes  4 Activity', 'j k / arrows  move', 'PgUp PgDn  page', 'g G  first / last', 'h l  fold / unfold tree', 'f  filter agents', 's  active / creation order', '[ ] or t  activity tab', 'Enter  enter detail', 'v / [v+]  expand agent detail', 'Esc  back / unzoom', 'z  zoom pane', 'Mouse: click / wheel', 'Click pane title: fold / open', ',  Settings    m  Main session', 'Click agent / o: switch Codex', 'q  close workbench', ...modelLegend().split('\n'), '? or Esc  close help'];
    return {lines:help.slice(0,height).map(line => truncateAnsi(line,width)),panes:[],state};
  }
  const rows = visibleRows(input.tree.nodes, state.tree);
  const panes = rectangles(width,height,state,rows.length);
  const summary = summarizeSubagents(input.tree.nodes);
  const git = input.git;
  const repo = git?.root ? `${safeText(git.branch ?? 'HEAD')} ↑${git.ahead}↓${git.behind}${git.files.some(file => file.conflict) ? ' CONFLICT' : ''}` : git?.error ? safeText(git.error) : 'No Git repository';
  const rate = formatTokenRate(input.main?.outputRate,input.nowMs);
  const compactSummary = `${summary.active}▸ ${summary.completed}✓${summary.failed ? ` ${summary.failed}✗` : ''}`;
  const heading = width < 60 ? `${repo} | ${compactSummary}`
    : `${summary.active} run · ${summary.completed} done${summary.failed ? ` · ${summary.failed} fail` : ''} | ${repo}${rate ? ` | Out ${rate}` : ''}`;
  const header = theme.accent('[Main] [Settings]') + ' ' + (input.error ? theme.error(safeText(input.error)) : theme.info(heading));
  const blocks = new Map<PaneId,string[]>();
  for (const pane of panes) {
    const inner = Math.max(1,pane.width - 2);
    let lines: string[] = [];
    let selected = -1;
    let title = '';
    if (pane.id === 'agents') {
      title = `1 Agents · ${state.tree.sort === 'created' ? 'created' : 'active'}${state.tree.filter !== 'all' ? ` · ${state.tree.filter}` : ''}`;
      selected = rows.findIndex(row => row.node.id === state.tree.selectedId);
      lines = rows.map(row => {
        const {icon,paint} = subagentVisual(row.node);
        const sub = summarizeSubagents(row.node.children);
        const badge = sub.active ? ` ${sub.active}▸` : sub.failed ? ` ${sub.failed}✗` : row.collapsed ? ` +${sub.total}` : '';
        const prefix = visualLength(row.prefix) > Math.floor(inner / 3) ? '… ' : row.prefix;
        const lead = `${row.node.id === state.tree.selectedId ? '▌' : ' '}${prefix}${row.collapsed ? '+' : icon} `;
        const token = truncateAnsi(renderModelEffortToken(safeText(row.node.model ?? ''),safeText(row.node.effort ?? ''),
          {mode:inner < 32 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs}),Math.max(2,Math.floor(inner/3)));
        const suffix = `${token ? ' '+token : ''}${badge}`;
        const name = truncateAnsi(safeText(row.node.name), Math.max(1,inner - visualLength(lead + suffix)));
        const line = `${lead}${name}${suffix}`;
        return row.context ? colors.dim(line) : paint(line);
      });
      if (!lines.length) lines = [colors.dim(input.tree.nodes.length ? 'No matching agents' : 'No subagents')];
    } else if (pane.id === 'details') {
      title = state.preview === 'file' ? '2 Diff' : state.preview === 'event' ? '2 Event detail' : '2 Agent detail';
      lines = [...(input.error ? wrap(input.error,inner).map(theme.warning) : []),...detailLines(input,state,inner)];
    } else if (pane.id === 'changes') {
      title = `3 Changes · ${git?.files.length ?? 0}`;
      selected = git?.files.findIndex(file => file.path === state.selectedFile) ?? -1;
      lines = git?.files.map(file => {
        const marker = file.path === state.selectedFile ? '▌' : ' ';
        const status = file.conflict ? '!!' : `${file.index}${file.worktree}`;
        const counts = file.binary ? ' bin' : file.added !== null && file.removed !== null ? ` +${file.added}-${file.removed}` : '';
        const name = truncateAnsi(safeText(file.path), Math.max(1,inner - visualLength(marker + status + ' ' + counts)));
        const text = `${marker}${status} ${name}${counts}`;
        return file.conflict ? theme.error(text) : file.index === '?' ? theme.info(text) : theme.value(text);
      }) ?? [];
      if (!lines.length) lines = [colors.dim(git?.error ? safeText(git.error) : git?.root ? 'Working tree clean' : 'No Git repository')];
    } else {
      title = `4 ${state.activityTab === 'tasks' ? 'Tasks' : state.activityTab === 'checks' ? 'Checks' : 'Events'} [ ]`;
      if (state.activityTab === 'tasks') {
        const plan = input.main?.planProgress;
        lines = plan ? plan.steps.map(step => (step.status === 'completed' ? theme.success : step.status === 'in_progress' ? theme.info : colors.dim)(`${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▸' : '·'} ${safeText(step.step)}`)) : [colors.dim('No plan reported')];
      } else if (state.activityTab === 'checks') {
        const calls = input.main?.toolActivity.recentCalls ?? [];
        lines = calls.filter(call => /\b(test|build|lint|check|tsc|pytest|vitest|jest)\b/i.test(command(call))).reverse().map(call=>statusLine(call));
        if (!lines.length) lines = [colors.dim('No check commands recorded')];
      } else {
        selected = events.findIndex(event => event.id === state.selectedEvent);
        lines = events.map(event => (event.status === 'error' ? theme.error : theme.value)(`${event.id === state.selectedEvent ? '▌' : ' '}${event.at.toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit'})} ${safeText(event.title)}`));
        if (!lines.length) lines = [colors.dim('No events recorded')];
      }
    }
    pane.contentLength = lines.length;
    const count = Math.max(0,pane.height - 2);
    let offset = Math.min(state.scroll[pane.id], Math.max(0,lines.length-count));
    if (selected >= 0 && count > 0) {
      if (selected < offset) offset = selected;
      else if (selected >= offset + count) offset = selected - count + 1;
    }
    pane.offset = offset;
    state.scroll[pane.id] = offset;
    const border = pane.id === state.focus ? theme.accent : colors.dim;
    const toggle = pane.id === 'details' && state.preview === 'agent' && pane.width >= 8 ? `[v${state.detailExpanded ? '−' : '+'}]` : '';
    const top = border(`┌${fit(` ${state.collapsed[pane.id] ? "+" : "−"} ${title} `,Math.max(0,pane.width-2-toggle.length))}${toggle}┐`);
    const overflow = lines.length > count ? ` ${offset+1}-${Math.min(lines.length,offset+count)}/${lines.length} ` : '';
    const bottom = border(`└${fit(overflow,Math.max(0,pane.width-2)).replace(/ /g,'─')}┘`);
    const body = Array.from({length:count},(_,i) => `${border('│')}${fit(lines[offset+i] ?? '',Math.max(0,pane.width-2))}${border('│')}`);
    blocks.set(pane.id,[top,...body,bottom].slice(0,pane.height).map(line => truncateAnsi(line,pane.width)));
  }
  const canvas: string[] = [truncateAnsi(header,width)];
  for (let y=1; y<height-1; y++) {
    const onRow = panes.filter(p => y >= p.y && y < p.y+p.height).sort((a,b)=>a.x-b.x);
    canvas.push(truncateAnsi(onRow.map(p => fit(blocks.get(p.id)?.[y-p.y] ?? '',p.width)).join(''),width));
  }
  if (height > 1) {
    const hint = state.focus === 'agents' ? 'j/k move  h/l fold  s sort  f filter' : state.focus === 'changes' ? 'j/k file  Enter diff' : state.focus === 'activity' ? '[ ] tab  j/k scroll' : state.preview === 'agent' ? 'v more/less  j/k scroll' : 'j/k scroll  Esc back';
    canvas.push(truncateAnsi(input.notice ? theme.info(safeText(input.notice)) : input.error ? theme.warning(safeText(input.error)) : colors.dim(width >= 60 ? `Tab pane  ${hint}  z zoom  ? keys  q close` : `, settings  m main  ? keys`),width));
  }
  return {lines:canvas.slice(0,height),panes,state};
}
