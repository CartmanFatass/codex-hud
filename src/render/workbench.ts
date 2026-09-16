import { taskText } from '../utils/task-text.js';
import { renderModelEffortToken, modelLegend } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { layoutWorkbench, panePadding, paneContentWidth, summaryOnly, workspaceSummary, workspaceCounts, gitFailureNotice, toolCommand, toolResult, FILE_LIST_MIN_CONTENT_WIDTH } from './workbench-layout.js';
import { formatTokenRate } from '../collectors/token-rate.js';
/** Pure layout/rendering for the tree workbench. Rectangles also drive mouse hit testing. */
import type { SubagentTree, SubagentTreeNode, ToolCall } from '../types.js';
import type { RolloutParseResult } from '../collectors/rollout.js';
import type { GitChanges } from '../collectors/git-changes.js';
import { summarizeSubagents } from '../collectors/subagent-tree.js';
import { visibleRows } from './panel-state.js';
import { subagentVisual, formatElapsedShort } from './subagent-chip.js';
import { formatAge } from './subagent-tree-view.js';
import { colors, theme, truncateAnsi, visualLength } from './colors.js';
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
  return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ch => ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch.charCodeAt(0) > 255 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
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
/** Bounded field previews; full text remains available with v. */
function field(text: string, width: number, maxLines = 2): string[] {
  const lines = wrap(text, width);
  if (lines.length <= maxLines) return lines;
  const preview = lines.slice(0, maxLines);
  preview[maxLines - 1] = truncateAnsi(`${preview[maxLines - 1]}…`, width);
  return preview;
}
/** Preserve the filename and nearest useful parent, not an uninformative path prefix. */
function pathLabel(path: string, width: number): string {
  const text = safeText(path);
  if (visualLength(text) <= width) return text;
  const parts = text.split('/');
  let tail = parts.pop() ?? '';
  while (parts.length && visualLength(`…/${parts.at(-1)}/${tail}`) <= width) tail = `${parts.pop()}/${tail}`;
  if (visualLength(`…/${tail}`) <= width) return `…/${tail}`;
  const chars = Array.from(tail);
  while (chars.length && visualLength(`…${chars.join('')}`) > width) chars.shift();
  return truncateAnsi(`…${chars.join('')}`,width);
}
function workspaceDetails(git: GitChanges | null | undefined, width: number): string[] {
  const lines = [theme.strong('Workspace · read only'), ...workspaceSummary(git).map(line => line.startsWith('!') || line.startsWith('Git ') ? theme.warning(line) : theme.value(line))];
  if (git?.root) {
    lines.push(...wrap(`Branch: ${safeText(git.branch ?? 'HEAD')} · ↑${git.ahead} ↓${git.behind}`,width).map(colors.dim));
    lines.push(...wrap('Staged and unstaged can overlap. Files belong to the workspace, not an agent.',width).map(colors.dim));
    if (workspaceCounts(git).binary) lines.push(colors.dim(`${workspaceCounts(git).binary} binary files`));
  }
  const notice = gitFailureNotice(git?.error);
  if (notice) lines.push(...wrap(notice,width).map(theme.warning));
  return lines;
}
function command(call: ToolCall): string {
  const args = call.arguments;
  return typeof args?.code === 'string' ? args.code : typeof args?.cmd === 'string' ? args.cmd : typeof args?.command === 'string' ? args.command : call.target ?? call.name;
}
function statusLine(call: ToolCall, label = command(call)): string {
  const failed = call.status === 'error' || call.resultSuccess === false || (call.exitCode !== undefined && call.exitCode !== 0);
  const succeeded = call.resultSuccess === true || call.exitCode === 0;
  const symbol = failed ? '✗' : call.status === 'running' ? '▸' : succeeded ? '✓' : '·';
  const paint = failed ? theme.error : call.status === 'running' ? theme.info : succeeded ? theme.success : colors.dim;
  return paint(`${symbol} ${safeText(label)}`);
}
function agentDetails(input: WorkbenchInputData, state: WorkbenchState, width: number): string[] {
  const node = allNodes(input.tree.nodes).find(node => node.id === state.tree.selectedId);
  if (!node) return [colors.dim('Select an agent')];
  const now = input.nowMs ?? Date.now();
  const {icon, paint} = subagentVisual(node);
  const expanded = state.detailExpanded;
  const lines = field(`${icon} ${node.status} · ${safeText(node.name)}`,width,expanded ? Infinity : 1).map(paint);
  lines.push(...field(`Task: ${taskText(node.task) ?? 'No task reported'}`,width,expanded ? Infinity : 2));
  if (node.lastReport) {
    const prior = node.turnStartedAt && node.lastReport.at < node.turnStartedAt;
    lines.push(colors.dim(prior ? 'Agent report · prior turn · unverified' : 'Agent report · unverified'), ...wrap(node.lastReport.text,width));
  }
  const agent = input.agent;
  if (agent && (!agent.session || agent.session.id === node.id)) {
    const calls = agent.toolActivity.recentCalls;
    const latest = calls[calls.length - 1];
    if (latest) {
      const earlier = node.turnStartedAt && latest.timestamp < node.turnStartedAt;
      lines.push(colors.dim(earlier ? 'Tool · prior turn' : 'Latest tool'));
      lines.push(...field(toolCommand(latest,expanded),width,expanded ? Infinity : 2));
      const result = `${toolResult(latest)} · ${latest.name.replace(/^functions\./,'')}${latest.duration !== undefined ? ` · ${(latest.duration/1000).toFixed(1)}s` : ''}`;
      lines.push(statusLine(latest,result));
      if (expanded && latest.output) lines.push(...latest.output.split('\n').slice(-12).flatMap(line => wrap(line,width)));
    } else lines.push(colors.dim('No tool event reported'));
    const plan = agent.planProgress;
    if (plan && state.tasksEnabled) {
      if (expanded) lines.push(theme.strong(`Reported plan ${plan.completedSteps}/${plan.totalSteps}`), ...plan.steps.flatMap(step => wrap(`${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▸' : '·'} ${step.step}`,width)));
      else {
        const current = plan.steps.find(step => step.status === 'in_progress');
        if (current) lines.push(...field(`Plan: ${current.step}`,width));
      }
    }
    const rate = formatTokenRate(agent.outputRate,now);
    if (expanded && rate) lines.push(theme.value(`Out ${rate}`), ...wrap(`Sample ${(agent.outputRate!.sampleMs/1000).toFixed(1)}s; includes waits`,width).map(colors.dim));
  } else lines.push(colors.dim(node.rolloutPath ? 'Loading agent activity…' : 'No tool evidence'));
  // Creation time is not this turn's start; quiet is not evidence of a stall.
  if ((node.status === 'running' || node.status === 'starting') && node.turnStartedAt) lines.push(colors.dim(`This turn ${formatElapsedShort(node.turnStartedAt,now)}`));
  lines.push(...field(`Last evidence ${formatAge(node.lastEventAt,now) ?? 'unknown'}`,width).map(colors.dim));
  if (node.model || node.effort) lines.push(...field(`${node.model ?? 'Unknown model'}${node.effort ? ` · ${node.effort}` : ''}`,width).map(theme.model));
  if (expanded) lines.push(...wrap(`ID ${node.id}`,width).map(colors.dim));
  return lines;
}
/** Every agent, independent of selection/folds; the existing sibling sort is retained. */
function teamReports(input: WorkbenchInputData, state: WorkbenchState, width: number): string[] {
  const rows = visibleRows(input.tree.nodes, {...state.tree, filter:'all', collapsed:new Set<string>()});
  if (!rows.length) return [colors.dim('No subagents')];
  const now = input.nowMs ?? Date.now();
  const lines: string[] = [colors.dim('Agent reports · unverified')];
  for (const {node, prefix} of rows) {
    const {icon, paint} = subagentVisual(node);
    const report = node.lastReport;
    const status = node.status === 'completed' ? 'turn done' : node.status;
    const age = report ? formatAge(report.at,now) : undefined;
    const suffix = ` ${status}${age && width >= 38 ? ' · '+age : ''}`;
    const branch = visualLength(prefix) > Math.floor(width/4) ? '… ' : prefix;
    const lead = `${branch}${icon} `;
    // Status wins over a long name. No selected/current marker: HUD selection
    // does not prove which thread Codex is currently displaying.
    const name = truncateAnsi(safeText(node.name),Math.max(1,width-visualLength(lead+suffix)));
    lines.push(truncateAnsi(paint(`${lead}${name}${suffix}`),width));
    if (report) {
      const prior = node.turnStartedAt && report.at < node.turnStartedAt;
      const label = prior ? 'Prev' : report.kind === 'reply' ? 'Reply' : 'Says';
      lines.push(...field(`${label}: ${report.text}`,width,width >= 38 ? 2 : 1));
    } else {
      // Task text describes the assignment, not the actual execution state.
      lines.push(colors.dim('No public report yet'));
    }
  }
  return lines;
}
function detailLines(input: WorkbenchInputData, state: WorkbenchState, width: number): string[] {
  if (state.preview === 'workspace') return workspaceDetails(input.git,width);
  if (state.preview === 'file') {
    if (!state.selectedFile) return [colors.dim('No changed file selected')];
    const file = input.git?.files.find(file => file.path === state.selectedFile);
    const lines = [colors.dim('Workspace · read only'), ...wrap(safeText(state.selectedFile),width).map(theme.strong)];
    if (file?.previousPath) lines.push(...wrap(`From: ${safeText(file.previousPath)}`,width).map(colors.dim));
    const notice = gitFailureNotice(input.git?.error);
    if (notice) lines.push(...field(notice,width).map(theme.warning));
    if (file) {
      lines.push(file.conflict ? theme.error('Conflict') : colors.dim(`Index ${file.index === ' ' ? '·' : safeText(file.index)} / Worktree ${file.worktree === ' ' ? '·' : safeText(file.worktree)}`));
      lines.push(colors.dim(file.binary ? 'Binary file' : file.added !== null && file.removed !== null ? `+${file.added} -${file.removed}${width >= FILE_LIST_MIN_CONTENT_WIDTH ? ' (index + worktree)' : ''}` : 'Line counts unknown'));
    }
    if (width < FILE_LIST_MIN_CONTENT_WIDTH) return [...lines, colors.dim('Widen for diff')];
    lines.push(colors.dim('Long lines clipped · z zoom'));
    return [...lines, ...(input.diff ?? ['Loading diff…']).map(raw => {
      const paint = raw.startsWith('+') ? theme.success : raw.startsWith('-') ? theme.error : raw.startsWith('@@') ? theme.info : theme.value;
      // One source line stays one screen line; no narrow-column diff wrapping.
      return paint(truncateAnsi(safeText(raw),width));
    })];
  }
  if (state.preview === 'event') {
    const event = input.events?.find(event => event.id === state.selectedEvent);
    return event ? [theme.strong(safeText(event.title)), colors.dim(event.at.toLocaleTimeString()), ...event.detail.flatMap(line => wrap(line, width))] : [colors.dim('Select an event')];
  }
  return state.detailExpanded ? agentDetails(input, state, width) : teamReports(input,state,width);
}
export function renderWorkbench(input: WorkbenchInputData): WorkbenchFrame {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const state = reconcileWorkbench(input.state, input.tree, input.git);
  if (!width || !height) return {lines:[], panes:[], state};
  const events = input.events ?? [];
  if (!events.some(event => event.id === state.selectedEvent)) state.selectedEvent = events[0]?.id ?? null;
  if (state.help) {
    const help = ['Workbench keys', 'Tab / Shift+Tab  focus pane', '1 Agents  2 Reports / Inspector', '3 Changes  4 Activity', 'j k / arrows  move', 'PgUp PgDn  page', 'g G  first / last', 'h l  fold / unfold tree', 'f  filter agents', 's  active / creation order', '[ ] or t  activity tab', 'Enter  inspect without switching', 'v / [v+]  team / inspector', 'Esc  back / unzoom', 'z  zoom pane', 'Mouse: click / wheel', 'Click pane title: fold / open', ',  Settings    m  Main session', 'Click agent / o: switch Codex', 'q  close workbench', ...modelLegend().split('\n'), '? or Esc  close help'];
    return {lines:help.slice(0,height).map(line => truncateAnsi(line,width)),panes:[],state};
  }
  const rows = visibleRows(input.tree.nodes, state.tree);
  const panes = layoutWorkbench(width,height,state,rows.length,workspaceSummary(input.git).length);
  if (state.focus === 'changes') {
    const preview = panes.find(p => p.id === 'changes')?.summary ? 'workspace' : 'file';
    if (state.preview !== preview) state.scroll.details = 0;
    state.preview = preview;
  }
  const summary = summarizeSubagents(input.tree.nodes);
  const git = input.git;
  const repo = git?.root ? `${safeText(git.branch ?? 'HEAD')} ↑${git.ahead}↓${git.behind}${git.files.some(file => file.conflict) ? ' CONFLICT' : ''}` : git?.error ? 'Git unavailable' : 'No Git repository';
  const rate = formatTokenRate(input.main?.outputRate,input.nowMs);
  const compactSummary = `${summary.active}▸ ${summary.completed}✓${summary.failed ? ` ${summary.failed}✗` : ''}`;
  const heading = width < 60 ? `${repo} | ${compactSummary}`
    : `${summary.active} run · ${summary.completed} done${summary.failed ? ` · ${summary.failed} fail` : ''} | ${repo}${rate ? ` | Out ${rate}` : ''}`;
  const header = theme.accent('[Main] [Settings]') + ' ' + (input.error ? theme.error(safeText(input.error)) : theme.info(heading));
  const blocks = new Map<PaneId,string[]>();
  for (const pane of panes) {
    const padding = panePadding(pane.width);
    const inner = paneContentWidth(pane.width);
    const count = Math.max(0,pane.height - 2);
    let lines: string[] = [];
    let selected = -1;
    let title = '';
    if (pane.id === 'agents') {
      title = `1 Agents${pane.width >= 40 ? ` · ${state.tree.sort === 'created' ? 'created' : 'active'}` : ''}${state.tree.filter !== 'all' ? ` · ${state.tree.filter}` : ''}`;
      const cardHeight = inner >= 16 && count >= 4 ? 2 : 1;
      pane.rowItems = [];
      rows.forEach((row,index) => {
        const {icon,paint} = subagentVisual(row.node);
        const sub = summarizeSubagents(row.node.children);
        const badge = sub.active ? ` ${sub.active}▸` : sub.failed ? ` ${sub.failed}✗` : row.collapsed ? ` +${sub.total}` : '';
        const prefix = visualLength(row.prefix) > Math.floor(inner / 3) ? '… ' : row.prefix;
        const lead = `${row.node.id === state.tree.selectedId ? '▌' : ' '}${prefix}${row.collapsed ? '+' : icon} `;
        const token = truncateAnsi(renderModelEffortToken(safeText(row.node.model ?? ''),safeText(row.node.effort ?? ''),
          {mode:inner < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs}),Math.max(2,Math.floor(inner/4)));
        const suffix = `${token ? ' '+token : ''}${badge}`;
        const name = truncateAnsi(safeText(row.node.name),Math.max(1,inner-visualLength(lead+suffix)));
        lines.push((row.context ? colors.dim : paint)(`${lead}${name}${suffix}`));
        pane.rowItems!.push(index);
        if (cardHeight === 2) {
          lines.push(colors.dim(truncateAnsi(`  ${prefix}${safeText(taskText(row.node.task) ?? 'No task reported')}`,inner)));
          pane.rowItems!.push(index);
        }
      });
      selected = pane.rowItems.indexOf(rows.findIndex(row => row.node.id === state.tree.selectedId));
      if (!lines.length) lines = [colors.dim(input.tree.nodes.length ? 'No matching agents' : 'No subagents')];
    } else if (pane.id === 'details') {
      title = state.preview === 'workspace' ? '2 Workspace' : state.preview === 'file' ? (inner < FILE_LIST_MIN_CONTENT_WIDTH ? '2 File' : '2 Diff') : state.preview === 'event' ? '2 Event' : state.detailExpanded ? '2 Inspector' : '2 Reports';
      lines = [...(input.error ? wrap(input.error,inner).map(theme.warning) : []),...detailLines(input,state,inner)];
    } else if (pane.id === 'changes') {
      title = pane.width < 40 ? '3 Changes' : '3 Changes · workspace';
      pane.rowItems = [];
      if (pane.summary) {
        lines = workspaceSummary(git).map(line => line.startsWith('!') || line.startsWith('Git ') ? theme.warning(line) : theme.value(line));
        pane.rowItems = lines.map(() => null);
      } else {
        if (git?.error) { lines.push(theme.warning('! Git incomplete · see Details')); pane.rowItems.push(null); }
        const stats = git?.files.map(file => file.binary ? 'binary' : file.added !== null && file.removed !== null ? `+${file.added} -${file.removed}` : 'unknown') ?? [];
        const statWidth = inner >= 52 ? Math.min(24,stats.reduce((max,stat) => Math.max(max,visualLength(stat)),0)) : git?.files.some(file => file.binary) ? 3 : 0;
        git?.files.forEach((file,index) => {
          const marker = file.path === state.selectedFile ? '▌' : ' ';
          const status = file.conflict ? '!!' : `${file.index === ' ' ? '·' : safeText(file.index)}${file.worktree === ' ' ? '·' : safeText(file.worktree)}`;
          const stat = inner >= 52 ? stats[index] : file.binary ? 'bin' : '';
          const suffix = statWidth ? ` ${truncateAnsi(stat,statWidth).padStart(statWidth)}` : '';
          const nameWidth = Math.max(1,inner-5-visualLength(suffix));
          const text = `${marker} ${status} ${fit(pathLabel(file.path,nameWidth),nameWidth)}${suffix}`;
          if (file.path === state.selectedFile) selected = lines.length;
          lines.push((file.conflict ? theme.error : file.index === '?' ? theme.info : theme.value)(text));
          pane.rowItems!.push(index);
        });
        if (!git?.files.length) {
          lines.push(...workspaceSummary(git).map(colors.dim));
          pane.rowItems = lines.map(() => null);
        }
      }
    } else {
      title = `4 ${state.activityTab === 'tasks' ? 'Tasks' : state.activityTab === 'checks' ? 'Checks' : 'Events'}${pane.width >= 24 ? ' [ ]' : ''}`;
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
    let offset = Math.min(state.scroll[pane.id], Math.max(0,lines.length-count));
    if (selected >= 0 && count > 0) {
      if (selected < offset) offset = selected;
      else {
        const item = pane.rowItems?.[selected];
        let end = selected;
        while (item !== null && item !== undefined && pane.rowItems?.[end + 1] === item) end++;
        if (end >= offset + count) offset = Math.min(selected,end-count+1);
      }
      // Keep card headers visible at the top; do not start on a task continuation.
      while (offset > 0 && pane.rowItems?.[offset] != null && pane.rowItems?.[offset] === pane.rowItems?.[offset-1]) offset++;
    }
    pane.offset = offset;
    state.scroll[pane.id] = offset;
    const border = pane.id === state.focus ? theme.accent : colors.dim;
    const toggle = pane.id === 'details' && state.preview === 'agent' && pane.width >= 8 ? `[v${state.detailExpanded ? '−' : '+'}]` : '';
    const titleWidth = Math.max(0,pane.width-2-toggle.length);
    const label = truncateAnsi(` ${state.collapsed[pane.id] ? '+' : '−'} ${title} `,titleWidth);
    const top = border(`┌${label}${'─'.repeat(Math.max(0,titleWidth-visualLength(label)))}${toggle}┐`);
    const overflow = lines.length > count ? ` ${offset ? '↑ ' : ''}${offset+count < lines.length ? '↓ more' : ''} ` : pane.id === 'changes' ? (pane.summary ? ' workspace ' : ' XY index/worktree ') : '';
    const bottom = border(`└${fit(overflow,Math.max(0,pane.width-2)).replace(/ /g,'─')}┘`);
    const body = Array.from({length:count},(_,i) => `${border('│')}${' '.repeat(padding)}${fit(lines[offset+i] ?? '',inner)}${' '.repeat(padding)}${border('│')}`);
    blocks.set(pane.id,[top,...body,bottom].slice(0,pane.height).map(line => truncateAnsi(line,pane.width)));
  }
  const canvas: string[] = [truncateAnsi(header,width)];
  for (let y=1; y<height-1; y++) {
    const onRow = panes.filter(p => y >= p.y && y < p.y+p.height).sort((a,b)=>a.x-b.x);
    let cursor = 0;
    const line = onRow.map(p => { const gap = ' '.repeat(Math.max(0,p.x-cursor)); cursor=p.x+p.width; return gap+fit(blocks.get(p.id)?.[y-p.y] ?? '',p.width); }).join('');
    canvas.push(fit(line,width));
  }
  if (height > 1) {
    const hint = state.focus === 'agents' ? 'j/k move  h/l fold  s sort  f filter' : state.focus === 'changes' ? (summaryOnly(width) ? 'Workspace summary · widen for files' : 'j/k file  Enter diff') : state.focus === 'activity' ? '[ ] tab  j/k scroll' : state.preview === 'agent' ? 'v team/inspect  j/k scroll' : 'j/k scroll  Esc back';
    canvas.push(truncateAnsi(input.notice ? theme.info(safeText(input.notice)) : input.error ? theme.warning(safeText(input.error)) : colors.dim(width >= 60 ? `Tab pane  ${hint}  z zoom  ? keys  q close` : state.focus === 'changes' && panes.find(p => p.id === 'changes')?.summary ? 'Widen for files · ? keys' : `, settings  m main  ? keys`),width));
  }
  return {lines:canvas.slice(0,height),panes,state};
}
