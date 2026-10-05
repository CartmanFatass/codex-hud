/** The Inspector: the selected agent in full, a worktree's details, or a changed file's diff. */
import type { SubagentTreeNode } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import type { AgentLogEntry, AgentLogKind } from '../collectors/agent-log.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { isGuardian } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { renderModelEffortToken, classifyModelFamily } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { formatTokenCount } from './lines/activity-line.js';
import { t } from './i18n.js';
import { shownName, labelled } from './agent-title.js';
import { monitorText, plainText, pair, wrapped, helpLines, flowLines, diffRows, pathRows } from './monitor-text.js';
import { age, nodeStatus, isQuiet, finishedAt, agentPaint, writtenAge, worktreeLabel, worktreeLabelText, worktreeName, worktreePlace, ID_NAME,
  UNTRACKED_ROW, lineCounts } from './monitor-labels.js';

function basename(path: string): string { return path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1) || path; }

function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const found = findNode(node.children,id); if (found) return found; }
  return undefined;
}

/** Lines of the latest update the Inspector shows before "▾ More". */
const REPORT_LINES = 6;

/** The Inspector's rows: the agent, worktree or file it was opened on. */
export function inspectorRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  // Inspector is explicitly opened (Enter/v/4), never follows agent clicks into a transcript.
  let lines: string[] = [];
  if (state.preview === 'agent') {
    const node = findNode(input.tree.nodes,state.tree.selectedId);
    if (!node) lines = [];
    else {
      // The glyphs, then the model and the effort in words: here there is room to say them.
      const model = node.model ? monitorText(node.model) : undefined;
      const effort = node.effort ? monitorText(node.effort) : undefined;
      const glyphs = displayConfig().glyphs !== 'text' && classifyModelFamily(model) ? renderModelEffortToken(model,effort,{mode:'glyph'}) : '';
      const named = [model,effort].filter(Boolean).join(' · ');
      const token = glyphs ? `${glyphs}${named ? ` ${colors.dim(named)}` : ''}` : named;
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
      // The agent's whole log, newest first, less the update shown above. Started
      // and finished alone say no more than the status line and the turn's age.
      const kept = log.filter(entry=>!(entry.kind === 'report' && report && entry.at === report.at.getTime()));
      if (kept.some(entry=>entry.kind !== 'started' && entry.kind !== 'finished')) {
        rows.push({text:colors.dim(t('Log'))});
        for (const entry of [...kept].reverse()) rows.push(...logEntryLines(entry,width,now,0).map(text=>({text})));
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
    if (!state.selectedFile || state.selectedFile === UNTRACKED_ROW) return [];
    return [...fileHeading(state.selectedFile,input.git,Boolean(state.expanded),width),...fileBody(state.selectedFile,input.diff ?? [],width)];
  }
  return lines.flatMap(line => wrapped(line,width).map(text=>({text})));
}

/**
 * The Inspector's heading for a changed file: its name, and the lines it
 * adds and removes at the right end where they fit beside it ("+12 −3",
 * a side with none left out), then the directory it is in, dim; expanded,
 * the repository too. An untracked directory is named with its slash.
 */
function fileHeading(path: string, git: GitChanges | null | undefined, expanded: boolean, width: number): MonitorRow[] {
  const file = git?.files.find(entry=>entry.path===path);
  const counts = file?.binary ? colors.dim(t('binary')) : file ? lineCounts(file) : '';
  const name = monitorText(basename(path)+(path.endsWith('/') ? '/' : ''));
  const rows: MonitorRow[] = counts && visualLength(name)+1+visualLength(counts) <= width
    ? [{text:pair(theme.strong(name),counts,width)}]
    : [...wrapped(name,width).map(text=>({text:theme.strong(text)})),...(counts ? [{text:truncateAnsi(counts,width)}] : [])];
  const parts = path.replace(/[\\/]+$/,'').split(/[\\/]/);
  const folder = parts.length > 1 ? `${parts.slice(0,-1).join('/')}/` : '';
  for (const line of [folder,expanded ? git?.root ?? '' : ''].filter(Boolean)) rows.push(...pathRows(line,width).map(text=>({text:colors.dim(text)})));
  return rows;
}

/** The labels readGitDiff starts its sections with, in the reader's words. */
const SECTIONS: Record<string,string> = {Staged:'Staged',Unstaged:'Unstaged',Untracked:'Untracked'};

/**
 * The Inspector's body for a changed file: readGitDiff's sections, each
 * under its label in the reader's words on a dim rule. A section's label
 * starts it: the first line, and Unstaged after Staged, whose lines are a
 * diff's and never just that word. A file's git header repeats its path and
 * names its blobs by hash: the heading says which file it is, so only the
 * hunks are shown, each line wrapped where a word ends and painted for what
 * it does. An untracked directory says how many files it holds, then each
 * one's path inside it.
 */
function fileBody(path: string, diff: readonly string[], width: number): MonitorRow[] {
  const label = (title: string) => {
    const text = ` ${t(title)} `;
    return {text:colors.dim(truncateAnsi(`──${text}${'─'.repeat(Math.max(0,width-2-visualLength(text)))}`,width))};
  };
  const listing = path.endsWith('/') && diff[0] === 'Untracked' ? /^(\d+) files?$/.exec(diff[1] ?? '') : null;
  if (listing) {
    const n = Number(listing[1]);
    return [{text:colors.dim(truncateAnsi(`${t('Untracked')} · ${n === 1 ? t('1 file') : t('{n} files',{n})}`,width))},
      ...diff.slice(2).flatMap(line=>diffRows(line,width).map(text=>({text:theme.value(text)})))];
  }
  const rows: MonitorRow[] = [];
  let header = false;
  diff.forEach((line,i) => {
    if (SECTIONS[line] && (i === 0 || (line === 'Unstaged' && diff[0] === 'Staged'))) { header = false; rows.push(label(SECTIONS[line])); return; }
    if (line.startsWith('diff --git ')) { header = true; return; }
    if (line.startsWith('@@')) header = false;
    if (header && /^(index [0-9a-f]+\.\.[0-9a-f]+|--- |\+\+\+ )/.test(line)) return;
    const paint = line.startsWith('@@') ? theme.info : line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.error : theme.value;
    rows.push(...diffRows(line,width).map(text=>({text:paint(text)})));
  });
  return rows;
}

/** Entries a model wrote, marked as such wherever they are shown. */
export const MODEL_LOG_KINDS: ReadonlySet<AgentLogKind> = new Set(['note','digest','cause']);

/** Columns of the log's age column: a three-character age and a space. */
const LOG_GUTTER = 4;

/**
 * One log entry: its age in a column of its own, then what happened, its
 * lines hanging beside the age. Status changes are words in the tree's
 * colours; an update is the agent's own excerpt, its chat markdown taken
 * out; what a model wrote is marked with a muted "~".
 */
export function logEntryLines(entry: AgentLogEntry, width: number, now: number, indent: number): string[] {
  const when = age(new Date(entry.at),now);
  const status = entry.kind === 'started' ? theme.info : entry.kind === 'finished' ? theme.success : entry.kind === 'failed' ? theme.error : null;
  const model = MODEL_LOG_KINDS.has(entry.kind);
  const text = status ? t(entry.kind) : plainText(entry.text).replace(/\s+/g,' ').trim();
  const paint = status ?? (entry.attention ? theme.warning : (s: string) => s);
  const gutter = Math.max(LOG_GUTTER,visualLength(when)+1);
  const lead = model ? '~ ' : '';
  const pad = ' '.repeat(indent);
  return flowLines(monitorText(`${lead}${text}`),Math.max(1,width-indent-gutter)).map((line,i)=>
    pad+(i ? ' '.repeat(gutter) : colors.dim(when.padEnd(gutter)))+(i || !lead ? paint(line) : colors.dim(lead)+paint(line.slice(lead.length))));
}
