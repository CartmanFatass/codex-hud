/**
 * Each pane's rows: the agents (the compact tree, or the cards and their
 * summary), the worktrees, the changes, the timeline, and the brief and
 * the agent log under the compact tree. The Inspector's are its own module's.
 */
import type { SubagentTreeNode } from '../types.js';
import type { GitChangedFile } from '../collectors/git-changes.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import type { MonitorData, MonitorPane, MonitorRow, MonitorState } from './monitor.js';
import type { CountsText } from './control-bar.js';
import { visibleRows, countExpired, guardianCount } from './panel-state.js';
import { agentCounts, type StatusCounts } from '../collectors/subagent-tree.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, shownName } from './agent-title.js';
import { briefFields, taskLines, richRows, briefLine } from './cards.js';
import { monitorText, fit, pair, wrapped, flowLines, squeeze } from './monitor-text.js';
import { nodeStatus, isQuiet, turnClock, finishedAt, FRESH_FINISH_MS, writtenAge, worktreeLabel, worktreeLabelText, worktreeName,
  isUntracked, UNTRACKED_ROW, changeLetter, lineCounts, listsWorktrees, worktreeItem } from './monitor-labels.js';
import { contextLine, CONTEXT_METER_WIDTH } from './monitor-meter.js';
import { inspectorRows, logEntryLines } from './monitor-inspector.js';
import { timelineRows } from './monitor-timeline.js';

/**
 * What the linger window put away from the list, counted whether or not it
 * is showing: in rich the L1s alone, the list's rows (their subtasks are on
 * their cards, and showing the rest brings none of them back as rows);
 * compact, every agent in the tree.
 */
export function putAwayCount(nodes: SubagentTreeNode[], state: MonitorState, now: number): number {
  if (state.style !== 'rich') return countExpired(nodes,{...state.tree,showAll:false},now);
  const listed = (showAll: boolean) => visibleRows(nodes,{...state.tree,collapsed:new Set(),showAll},now).filter(row=>row.depth === 0).length;
  return listed(true)-listed(false);
}

/**
 * The agents' heading, in both layouts the counts every view gives
 * (`agentCounts`): the agents the main session started by how they stand,
 * one at work while a subtask of it is, the guardian reviews, and their
 * subtasks as one figure with how many of them failed. The switch for what
 * the linger window put away is on the control bar.
 */
export function summaryRow(input: Pick<MonitorData,'tree'>): {row: MonitorRow} {
  const {agents,subtasks:subs,reviews} = agentCounts(input.tree.nodes);
  // "!1 失败  ▸1 运行  ✓5 完成": an icon and a count alone said nothing to a
  // reader without the legend, so each count carries its word where it fits.
  // The title row says as much as fits, each form whole (`paneHead`).
  const build: CountsText = (words, subtasks) => {
    const count = (icon: string, paint: (s: string) => string, n: number, word: string) =>
      `${paint(icon)}${n}${words ? colors.dim(` ${t(word)}`) : ''}`;
    // Only what is there: "▸0 run" beside thirty finished agents is noise.
    // A column in, under the entries' status icons; failures lead.
    const counts = [
      agents.failed ? count('!',theme.error,agents.failed,'failed') : '',
      agents.completed ? count('✓',theme.success,agents.completed,'done') : '',
      agents.active ? count('▸',theme.info,agents.active,'run') : '',
      agents.unknown ? count('?',colors.dim,agents.unknown,'unknown') : '',
      reviews.total ? `${reviewChip(reviews)}${words ? colors.dim(` ${t('reviews')}`) : ''}` : '',
    ].filter(Boolean).join(words ? '  ' : ' ');
    const tasks = subtasks && subs.total ? colors.dim(t('· {n} subtasks',{n:subs.total}))+(subs.failed ? theme.error(t(', {n} failed',{n:subs.failed})) : '') : '';
    return [counts,tasks].filter(Boolean).join('  ');
  };
  const text = build(true,true);
  return {row:{text:text && ' '+text,counts:build}};
}

/** "◈5": reviews, red when one failed, in the info colour while one is running. Empty when there are none. */
function reviewChip(reviews: Pick<StatusCounts,'total'|'active'|'failed'>): string {
  return reviews.total ? (reviews.failed ? theme.error : reviews.active ? theme.info : colors.dim)(`◈${reviews.total}`) : '';
}

/** "◈5": the guardian reviews among `nodes`, as `reviewChip` paints them. */
export function guardianChip(nodes: readonly SubagentTreeNode[]): string {
  const {count,running,failed} = guardianCount(nodes);
  return reviewChip({total:count,active:running ? 1 : 0,failed});
}

function agentRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  // With no agent to show the view is empty: the summary's counts, the bar's
  // +N and the status card already say why, so no line says it again.
  const {row:head} = summaryRow(input);
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

/** The changed files, tracked then untracked, each with its path as the list shows it. */
interface ChangesSplit {
  files: readonly GitChangedFile[];
  width: number;
  tracked: Array<[GitChangedFile, string]>;
  untracked: Array<[GitChangedFile, string]>;
}
let changesCache: ChangesSplit | undefined;
function splitChanges(files: readonly GitChangedFile[], width: number): ChangesSplit {
  const shown = shownPaths(files.map(file=>file.path),width);
  const split: ChangesSplit = {files,width,tracked:[],untracked:[]};
  files.forEach((file,i) => (isUntracked(file) ? split.untracked : split.tracked).push([file,shown[i]]));
  return split;
}

/**
 * The worktrees over the changes, where there is more than one: a row each,
 * the one whose changes are listed marked "●" and named in bold, how far its
 * branch is from upstream and its state on the right. Then a rule naming it
 * again, with its counts, over its files.
 */
function worktreeRows(input: MonitorData, state: MonitorState, width: number, now: number, counts: string): MonitorRow[] {
  const entries = input.worktrees?.entries ?? [];
  const names = entries.map(worktreeName);
  const rows: MonitorRow[] = [];
  let listed = '';
  for (const [i,entry] of entries.entries()) {
    const item = worktreeItem(entry.path);
    const current = entry.path === state.selectedWorktree;
    const label = worktreeLabel(entry,now);
    const paint = label.startsWith('!') || entry.error ? theme.warning : label === 'clean' ? colors.dim : theme.value;
    const ahead = entry.status?.ahead ? theme.success(`↑${entry.status.ahead}`)+' ' : '';
    const behind = entry.status?.behind ? theme.error(`↓${entry.status.behind}`)+' ' : '';
    // Locked is a word after the status, not a letter glued to the name.
    const locked = entry.locked !== undefined ? colors.dim(` · ${t('locked')}`) : '';
    // Two of the same name are told apart by what their HEAD commit says,
    // never by a hash: it stands in for the name, which the Inspector gives.
    const twin = names.filter(name=>name === names[i]).length > 1;
    const name = monitorText(twin && entry.subject ? entry.subject : names[i]);
    if (current) listed = name;
    const left = `${item === state.selectedFile ? '›' : ' '}${current ? theme.accent('●') : ' '} ${current ? theme.strong(name) : name}`;
    rows.push({item,text:pair(left,`${ahead}${behind}${paint(worktreeLabelText(label))}${locked}`,width)});
  }
  const head = `${colors.dim('─ ')}${theme.strong(listed || t('Changes'))}${counts ? colors.dim(' · ')+counts : ''} `;
  rows.push({text:truncateAnsi(head+colors.dim('─'.repeat(Math.max(0,width-visualLength(head)))),width)});
  return rows;
}

/**
 * The changes: the worktrees on top where there is a choice of them, then
 * the listed one's counts, what the model said the diff does, and its files,
 * the untracked folded into one row at the end. One cursor runs through the
 * worktrees and the files alike.
 */
function changesRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  const snapshot = input.worktrees;
  const git = input.git;
  const rows: MonitorRow[] = [];
  // Empty, loading or clean is no line of its own; an error says what is wrong.
  if (snapshot?.error) rows.push({text:theme.warning(t('No readable repository'))}, {text:colors.dim(t('Set worktreeRoot'))}, ...wrapped(snapshot.error,width).map(text=>({text:colors.dim(text)})));
  if (snapshot?.truncated) rows.push({text:theme.warning(t('Worktree list limited'))});
  if (git?.error) rows.push({text:theme.warning(t('Git incomplete'))});
  // Worked out once per git read and width, not on every repaint.
  const pathWidth = Math.max(1,width-4);
  const files = git?.root ? git.files : [];
  if (changesCache?.files !== files || changesCache.width !== pathWidth) changesCache = splitChanges(files,pathWidth);
  const {tracked,untracked} = changesCache;
  // The untracked files are counted on their own row, at the end.
  const counts = files.length ? changeCounts(tracked.map(([file])=>file),width) : '';
  if (listsWorktrees(snapshot)) rows.push(...worktreeRows(input,state,width,now,counts));
  else if (counts) rows.push({text:counts});
  if (!git?.root) return rows;
  // What the diff does, in the model's words, marked as such; older than the diff, it says so.
  const summary = files.length ? input.notes?.changes : undefined;
  if (summary) {
    for (const line of summary.lines) rows.push(...flowLines(monitorText(line),Math.max(1,width-2)).map((text,i)=>({text:`${i ? ' ' : colors.dim('~')} ${text}`})));
    if (!summary.current) rows.push(...flowLines(t('(written {age}, before the latest edits)',{age:writtenAge(summary.at,now)}),Math.max(1,width-2)).map(text=>({text:colors.dim(`  ${text}`)})));
  }
  const mark = (item: string) => item === state.selectedFile ? '›' : ' ';
  // A letter for what happened, the path, and the lines it adds and removes at the right where they fit.
  for (const [file,shown] of tracked) {
    const left = `${mark(file.path)} ${changeLetter(file)} ${monitorText(shown)}`;
    const lines = lineCounts(file);
    const gap = width-visualLength(left)-visualLength(lines);
    rows.push({item:file.path,text:truncateAnsi(lines && gap >= 2 ? left+' '.repeat(gap)+lines : left,width)});
  }
  // The untracked files folded into a row that counts them; Enter or a click lists them under it.
  if (untracked.length) {
    const open = Boolean(state.untrackedOpen);
    rows.push({item:UNTRACKED_ROW,text:`${mark(UNTRACKED_ROW)} ${colors.dim(`${open ? '▾' : '▸'} ${t('{n} untracked',{n:untracked.length})}`)}`});
    if (open) for (const [file,shown] of untracked) rows.push({item:file.path,text:truncateAnsi(`${mark(file.path)}   ${monitorText(shown)}`,width)});
  }
  return rows;
}

export function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  if (id === 'agents') return agentRows(input,state,width,now);
  if (id === 'timeline') return timelineRows(input,width,now);
  if (id === 'changes') return changesRows(input,state,width,now);
  return inspectorRows(input,state,width,now);
}

/**
 * What the brief said besides its fields: a reply in another shape than the
 * JSON asked for, as the text it is, and a failed call. Model output is
 * sanitized like any other external string.
 */
export function briefSaid(input: MonitorData, width: number): string[] {
  const brief = input.brief;
  // A failure the panel itself names is in the reader's language; a backend's is as it came.
  const failure = brief?.error ? flowLines(monitorText(t(brief.error)),Math.max(1,width)).map(text=>theme.warning(text)) : [];
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

/** Log entries shown per agent; the selected agent shows more, the Inspector all. */
const LOG_ENTRIES = 2;
const LOG_ENTRIES_SELECTED = 6;

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

/**
 * The agents view's rows, its summary line first: in rich style a card per
 * agent (the main session's brief is in the status card at the foot); in
 * compact the tree, then the brief and log under it. One view, scrolled as one.
 */
export function agentsView(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  if (state.style === 'rich') return richRows(input,state,width,now,spaced);
  return [...agentRows(input,state,width,now),...briefRows(input,state,width,now,spaced)];
}
