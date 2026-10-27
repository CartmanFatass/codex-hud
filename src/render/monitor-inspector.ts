/** The Inspector: the selected agent in full, a worktree's details, or a changed file's diff. */
import type { SubagentTreeNode, TokenSpent } from '../types.js';
import type { GitChanges } from '../collectors/git-changes.js';
import { progressReason, type ProgressReason } from '../collectors/progress-summary.js';
import type { AgentLogEntry, AgentLogKind } from '../collectors/agent-log.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { isGuardian } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { renderModelEffortToken, classifyModelFamily } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { formatTokenCount } from './lines/activity-line.js';
import { t } from './i18n.js';
import { diagnosticLines, tokenRateDetails } from './hud-diagnostics.js';
import { shownName, labelled } from './agent-title.js';
import { monitorText, plainText, pair, wrapped, helpLines, flowLines, diffRows, pathRows } from './monitor-text.js';
import { newestIntent } from './cards.js';
import { age, nodeStatus, isQuiet, agentRate, rateText, finishedAt, agentPaint, writtenAge, worktreeLabel, worktreeLabelText, worktreeName, worktreePlace, ID_NAME,
  UNTRACKED_ROW, lineCounts } from './monitor-labels.js';

function basename(path: string): string { return path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1) || path; }

function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const found = findNode(node.children,id); if (found) return found; }
  return undefined;
}

const PROGRESS_REASONS: Record<ProgressReason,string> = {
  off:'model backend off', paused:'models paused', 'progress-disabled':'live progress disabled',
  'summary-hidden':'summary hidden', 'not-live':'agent not live', 'no-evidence':'no public progress evidence',
  cooldown:'refresh cooldown', retry:'retry wait', 'concurrency-cap':'progress concurrency cap', 'hourly-cap':'hourly model call cap',
};
function timestamp(at: number): string {
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : t('unknown');
}

/** Lines of the latest update the Inspector shows before "▾ More". */
const REPORT_LINES = 6;

/** A dim rule naming one block of the details page, the same shape as a diff's section. */
function sectionRule(title: string, width: number): string {
  const label = ` ${title} `;
  const rule = `──${label}${'─'.repeat(Math.max(0, width - 2 - visualLength(label)))}`;
  return colors.dim(truncateAnsi(rule, width));
}

/**
 * Prose under a section rule: two columns in, wrapped on that inner width,
 * and cut to `limit` lines with an ellipsis when the reader has not asked
 * for the rest.
 */
function proseLines(text: string, width: number, limit?: number): string[] {
  const inner = Math.max(1, width - 2);
  const lines = flowLines(text, inner);
  const shown = limit === undefined ? lines : lines.slice(0, limit);
  if (shown.length && shown.length < lines.length) {
    let last = [...shown[shown.length - 1]];
    while (last.length && visualLength(`${last.join('')} …`) > inner) last = last.slice(0, -1);
    shown[shown.length - 1] = `${last.join('').trimEnd()} …`;
  }
  return shown.map(line => `  ${line}`);
}

/** The Inspector's rows: the agent, worktree or file it was opened on. */
export function inspectorRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  // Inspector is explicitly opened (Enter/v/4), never follows agent clicks into a transcript.
  let lines: string[] = [];
  if (state.preview === 'diagnostics') {
    const label = truncateAnsi(t('[Sources · Calls · Export]'), width);
    return [{text:theme.accent(label),controls:[{kind:'observability',x:0,width:visualLength(label)}]},
      ...diagnosticLines(input.hud, width, now,
        {tree:input.tree,selectedId:state.tree.selectedId ?? undefined}).map(text => ({ text }))];
  }
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
      // A path of two or more segments locates the agent (`/root/<task>`).
      // One segment says nothing the name did not.
      if (node.agentPath && node.agentPath.split('/').filter(Boolean).length > 1)
        rows.push(...wrapped(node.agentPath,width).map(text=>({text:colors.dim(text)})));
      if (token) rows.push({text:truncateAnsi(token,width)});
      const finished = node.status === 'completed' ? colors.dim(` · ${t('{age} ago',{age:age(finishedAt(node),now)})}`) : '';
      rows.push({text:truncateAnsi(`${status.paint(status.icon)} ${t(node.status)}${finished}`,width)});
      const ctx = node.contextUsage;
      if (ctx) rows.push({text:truncateAnsi(
        `${colors.dim(t('Ctx'))} ${ctx.percent}% (${formatTokenCount(ctx.used)}/${formatTokenCount(ctx.total)})`,width)});
      const rate = agentRate(node,now);
      if (rate !== undefined) rows.push({text:truncateAnsi(`${colors.dim(t('Out'))} ${rateText(rate)}`,width)});
      if (node.tokensSpent) rows.push({text:spentLine(node.tokensSpent,width)});
      if (state.expanded) rows.push(...tokenRateDetails(node.outputRate, node.turnStartedAt, node.status === 'running', now)
        .flatMap(line => helpLines(monitorText(line), width).map(text => ({ text }))));
      // Short facts sit with the heading. The long text is a section each,
      // under a rule, so a charge, an update and the log do not run together.
      const facts = [t('Turn age: {age}',{age:age(node.turnStartedAt,now)}),t('Last activity: {age}',{age:age(node.lastEventAt,now)})+(isQuiet(node,now) ? t(' (quiet)') : '')];
      if (node.nickname && node.nickname !== node.name) facts.push(t('Nickname: {name}',{name:node.nickname}));
      if (node.role) facts.push(t('Role: {role}',{role:node.role}));
      if (state.expanded) facts.push(t('Turn start: {at}',{at:node.turnStartedAt && Number.isFinite(node.turnStartedAt.getTime()) ? node.turnStartedAt.toISOString() : t('unknown')}),`UUID: ${node.id}`);
      rows.push(...facts.flatMap(line=>helpLines(monitorText(line),width).map(text=>({text}))));
      const section = (title: string, body: string[]) => {
        if (!body.length) return;
        rows.push({text:''},{text:sectionRule(title,width)},...body.map(text=>({text})));
      };
      // The parent's own words from before this agent was created. A sealed
      // payload is not shown; the card keeps only a short name made from this.
      const given = node.charge?.replace(/\s+/g,' ').trim();
      if (given && !given.includes('gAAAAA')) section(t('What it was given'), proseLines(monitorText(given), width));
      // A task the rollout keeps sealed: what the agent said it would do, in
      // its own words, as it opened its newest stage. The card leaves it here.
      const intent = node.task || isGuardian(node) ? undefined : newestIntent(node);
      if (intent) section(t('Took on'), proseLines(monitorText(intent), width));
      // What the agent last said about its work. It is the agent's own words,
      // not a checked result, so it is labelled as such and kept to a few
      // lines until asked for in full.
      const report = node.lastReport;
      if (report) {
        const prior = node.turnStartedAt && report.at < node.turnStartedAt;
        const title = `${t(prior ? 'Previous turn' : 'Latest update')} · ${t('{age} ago',{age:age(report.at,now)})}`;
        section(title, proseLines(monitorText(plainText(report.text).replace(/\s+/g,' ').trim()), width, state.expanded ? undefined : REPORT_LINES));
      }
      // What a model read from the final answer and from the failure, marked as such.
      const log = input.agentLog?.get(node.id) ?? [];
      const latest = (kind: AgentLogKind) => [...log].reverse().find(entry=>entry.kind===kind);
      const written = (kind: AgentLogKind, heading: string) => {
        const entry = latest(kind);
        if (!entry || (kind === 'digest' && node.status !== 'completed') || (kind === 'cause' && node.status !== 'error')) return;
        const parts = entry.text.split(' · ').map(part => part.trim()).filter(Boolean);
        section(`~ ${t(heading)} · ${writtenAge(entry.at,now)}`, parts.flatMap(part => proseLines(monitorText(part), width)));
      };
      const note = latest('note');
      const request = input.progress?.get(node.id);
      const gate = input.progressContext ? progressReason(node,input.progressContext) : undefined;
      const reason = gate ?? request?.reason;
      const progress = reason ? t(PROGRESS_REASONS[reason])
        : request?.phase === 'queued' ? t('queued')
        : request?.running ? t('writing')
        : request?.error ? t('Progress summary failed')
        : request?.phase === 'idle' ? t('up to date') : '';
      const details: string[] = [];
      if (note) {
        details.push(...proseLines(monitorText(plainText(note.text).replace(/\s+/g,' ').trim()),width,state.expanded ? undefined : REPORT_LINES));
        // Legacy and periodic notes don't establish a coverage boundary.
        // Only explicit metadata may claim which public snapshot was covered.
        details.push(...proseLines(t(note.coverageAt !== undefined ? 'Coverage: {at}' : 'Recorded: {at}',
          {at:timestamp(note.coverageAt ?? note.at)}),width,2));
        if (note.generatedAt !== undefined) details.push(...proseLines(t('Generated: {at}',{at:timestamp(note.generatedAt)}),width,2));
      }
      if (progress) details.push(...proseLines(t('Progress: {status}',{status:progress}),width,2));
      if (!gate && request?.retryAt !== undefined && request.retryAt > now)
        details.push(...proseLines(t('Retry: {age}',{age:age(new Date(now-(request.retryAt-now)),now)}),width,2));
      section(`~ ${t('Model summary')}`,details);
      written('digest','Result digest');
      written('cause','Failure cause');
      // A guardian's task is Codex's review prompt, the same every time. The
      // cards leave the task here, so it is always shown.
      const task = node.task?.replace(/\s+/g,' ').trim();
      if (task && !task.includes('gAAAAA') && !isGuardian(node)) section(t('Task'), proseLines(monitorText(task), width));
      // The agent's whole log, newest first, less the update shown above. Started
      // and finished alone say no more than the status line and the turn's age.
      const kept = log.filter(entry=>entry !== note && !(entry.kind === 'report' && report && entry.at === report.at.getTime()));
      if (kept.some(entry=>entry.kind !== 'started' && entry.kind !== 'finished')) {
        rows.push({text:''},{text:sectionRule(t('Log'),width)});
        for (const entry of [...kept].reverse()) rows.push(...logEntryLines(entry,width,now,2).map(text=>({text})));
      }
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
      // Its counts, and how far it is from its upstream, each left out at zero (or unknown).
      if (entry.status) {
        const status = entry.status;
        const counts = (['conflicts','staged','unstaged','untracked'] as const).filter(key=>status[key]).map(key=>t(`{n} ${key}`,{n:status[key]}));
        const drift = [status.ahead ? t('{n} ahead',{n:status.ahead}) : '',status.behind ? t('{n} behind',{n:status.behind}) : ''].filter(Boolean);
        for (const parts of [counts,drift]) if (parts.length) lines.push(parts.join(' · '));
      }
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

/**
 * What an agent spent over its life, as the bar's Tokens field says the
 * main session's: input with its cached share, then output. Too narrow, the
 * cached share goes, then the output; the words are never cut.
 */
export function spentLine(spent: TokenSpent, width: number): string {
  const cache = spent.input > 0 ? colors.dim(` (${t('cache {n}%',{n:Math.round(spent.cached/spent.input*100)})})`) : '';
  const head = `${colors.dim(t('Tokens'))} ${theme.tokenCount(formatTokenCount(spent.input))} ${colors.dim(t('in'))}`;
  const out = ` · ${theme.tokenCount(formatTokenCount(spent.output))} ${colors.dim(t('out'))}`;
  for (const text of [head+cache+out, head+out, head]) if (visualLength(text) <= width) return text;
  return truncateAnsi(head,width);
}
