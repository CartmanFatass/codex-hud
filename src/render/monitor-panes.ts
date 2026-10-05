/**
 * Each pane's rows: the agents (the compact tree, or the cards and their
 * summary), the worktrees, the changes, the timeline, and the brief and
 * the agent log under the compact tree. The Inspector's are its own module's.
 */
import type { SubagentTreeNode } from '../types.js';
import type { GitChangedFile } from '../collectors/git-changes.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import type { WorkbenchEvent } from './workbench-state.js';
import type { MonitorData, MonitorPane, MonitorRow, MonitorState } from './monitor.js';
import { visibleRows, countExpired, guardianCount, isGuardian } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, shownName, labelled } from './agent-title.js';
import { briefFields, taskLines, richRows, briefLine } from './cards.js';
import { formatWindowLabel } from './quota.js';
import { monitorText, fit, pair, wrapped, flowLines, squeeze } from './monitor-text.js';
import { age, iconic, nodeStatus, isQuiet, turnClock, finishedAt, FRESH_FINISH_MS, agentPaint, writtenAge, worktreeLabel, worktreeLabelText, worktreeName } from './monitor-labels.js';
import { contextLine, CONTEXT_METER_WIDTH } from './monitor-meter.js';
import { inspectorRows, logEntryLines } from './monitor-inspector.js';

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

export function paneRows(id: MonitorPane, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
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
  return inspectorRows(input,state,width,now);
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

function walkTree(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkTree(node.children,visit); }
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
