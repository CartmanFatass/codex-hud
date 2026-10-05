/**
 * The rich panel: a card per agent, and the main recap as a card above them,
 * all in the one scrolling view under the agents' summary line.
 *
 * A card is open on the right: a top rule, a bar down the left, a bottom
 * rule, so its text gets the column a closed box spends on its right side,
 * and it never reads as the status card at the foot, which is closed and
 * rounded. The border identifies the agent; the inside says what it is
 * doing:
 *
 *   ┌ ▸ ⌕ ablation_no_reranker ─ ★◐ Sol
 *   │ 去重排消融召回对比
 *   │
 *   │ ~ 召回下降，结果待核对
 *   │   6s
 *   └ ◷ 4m07s ─────────── ━━╸ 56% ▾
 *
 * The rules and the bar take the status colour; a selected card's take the
 * accent and its top rule starts with "›". A card carries everything its tree
 * row did: status, name, model badge, context meter, turn clock, quiet or
 * failed, dimming once old news, the selection, its parent (by indent) and a
 * collapsed parent's count. Pure: no I/O.
 */
import type { SubagentTreeNode } from '../types.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import { visibleRows, isGuardian, type PanelRow } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi, getContextColor } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, type AgentTitle } from './agent-title.js';
import {
  type MonitorData, type MonitorState, type MonitorRow, type RowControl,
  monitorText, plainText, flowLines, balancedLines, age, agoText, nodeStatus, iconic, briefSaid, isLive, isQuiet, turnClock, squeeze, finishedAt,
  summaryRow, emptyAgentsText, guardianChip, meterGap, edgeLine, type EdgeMeter,
  MODEL_LOG_KINDS, FRESH_FINISH_MS,
} from './monitor.js';

/** Lines of one entry in a closed card. */
const ENTRY_LINES = 2;
/** Lines of an expanded card's timeline; the rest is the Inspector's. */
const TIMELINE_LINES = 20;
/** Lines of the task text an expanded card ends with. */
const TASK_TEXT_LINES = 8;
/** Columns a child card is indented per level, and the most levels that indent. */
const MAX_INDENT = 2;
/** Narrower than this, a card gives up its model badge; narrower still, its meter. */
const BADGE_MIN = 24;
const METER_MIN = 20;

type Paint = (s: string) => string;
const plain: Paint = s => s;

/** `lines` cut to `max`, the last one ending in " …" within `width`, when there were more. */
export function clipLines(lines: string[], max: number, width: number): {lines: string[]; clipped: boolean} {
  if (lines.length <= max) return {lines,clipped:false};
  const shown = lines.slice(0,max);
  let last = [...shown[max-1]];
  while (last.length && visualLength(`${last.join('')} …`) > width) last = last.slice(0,-1);
  shown[max-1] = `${last.join('').trimEnd()} …`;
  return {lines:shown,clipped:true};
}

/**
 * Wrap with a hanging indent: the first line `first` wide, the others `rest`
 * wide, so a lead mark or label keeps its column and the text hangs under
 * the text. Takes sanitized text; returns the lines unindented.
 */
export function hangLines(text: string, first: number, rest: number): string[] {
  const head = flowLines(text,Math.max(1,first))[0];
  if (head === undefined) return [];
  // The first line holds the text's first characters, spaces aside: skip as
  // many and wrap what is left at the other width.
  let need = [...head].filter(ch => !/\s/.test(ch)).length;
  let at = 0;
  const chars = [...text];
  while (at < chars.length && need > 0) { if (!/\s/.test(chars[at])) need--; at++; }
  const remainder = chars.slice(at).join('').trim();
  return [head,...(remainder ? flowLines(remainder,Math.max(1,rest)) : [])];
}

/**
 * What an agent is for, under the name that identifies it: the model's name
 * for it, evened out, or else the task it was given, cut to `max` lines.
 */
export function taskLines(title: AgentTitle, width: number, max = 2): {lines: string[]; clipped: boolean} {
  if (!title.task) return {lines:[],clipped:false};
  if (title.renamed) return clipLines(balancedLines(title.task,width),max,width);
  return clipLines(flowLines(title.task,width),max,width);
}

/** Which part of the brief a block of lines is. */
export type BriefFieldId = 'approval' | 'needs' | 'goal' | 'now' | 'done' | 'said';
export interface BriefField { id: BriefFieldId; lines: string[] }
/** Lines one value of the brief gets before it is cut. */
const FIELD_LINES = 2;
/** Done items the brief shows: the newest; the rest are counted. */
const DONE_SHOWN = 2;
/**
 * The brief's labels: an icon each where icons stand in for words, else the
 * word. The words share one column, padded to the widest, so 已完成 and 目标
 * line up; an icon is a column already.
 */
const FIELD_WORDS: Record<Exclude<BriefFieldId,'said'>, string> = {approval:'Approve',needs:'Needs',goal:'Goal',now:'Now',done:'Done'};
const FIELD_ICONS: Record<Exclude<BriefFieldId,'said'>, string> = {approval:'⚑',needs:'!',goal:'◎',now:'▸',done:'✓'};
/** The label column for the fields shown: the widest of their words, so a card without an approval is not padded for one. */
function labelColumn(ids: ReadonlyArray<Exclude<BriefFieldId,'said'>>): number {
  return iconic() ? 1 : Math.max(1,...ids.map(id=>visualLength(t(FIELD_WORDS[id]))));
}
function fieldLabel(id: Exclude<BriefFieldId,'said'>, column: number): string {
  const text = iconic() ? FIELD_ICONS[id] : t(FIELD_WORDS[id]);
  const paint = id === 'needs' || id === 'approval' ? theme.warning : id === 'done' && iconic() ? theme.success : colors.dim;
  return paint(text)+' '.repeat(Math.max(0,column-visualLength(text)));
}

/**
 * One field: its label in the label column, the value after it, wrapped
 * with its lines hanging under the value and cut after two.
 */
function inlineField(id: Exclude<BriefFieldId,'said'>, value: string, width: number, column: number, paint: Paint = plain): BriefField {
  const room = Math.max(1,width-column-1);
  const lines = clipLines(balancedLines(monitorText(value),room),FIELD_LINES,room).lines;
  return {id,lines:lines.map((line,i)=>(i ? ' '.repeat(column+1) : fieldLabel(id,column)+' ')+paint(line))};
}

/**
 * Done: the newest two items, a dim "+N" closing the last when there were
 * more. With icons each item has the ✓ in the label column; with words the
 * label heads the first and each item keeps its own ✓.
 */
function doneField(done: readonly string[], width: number, column: number): BriefField | null {
  if (!done.length) return null;
  const items = done.slice(-DONE_SHOWN);
  const more = done.length-items.length;
  const suffix = more ? ` +${more}` : '';
  const mark = iconic() ? '' : `${theme.success('✓')} `;
  const lead = visualLength(stripAnsi(mark));
  const room = Math.max(1,width-column-1-lead);
  const lines: string[] = [];
  items.forEach((item,index) => {
    const last = index === items.length-1;
    // The last item leaves room for the count, so it never wraps alone.
    const wrapped = clipLines(balancedLines(monitorText(item),Math.max(1,room-(last ? suffix.length : 0))),FIELD_LINES,room-(last ? suffix.length : 0)).lines;
    wrapped.forEach((line,i) => {
      const label = i ? ' '.repeat(column+1) : iconic() || (!index && !i) ? fieldLabel('done',column)+' ' : ' '.repeat(column+1);
      lines.push(label+(i ? ' '.repeat(lead) : mark)+line+(last && i === wrapped.length-1 && suffix ? colors.dim(suffix) : ''));
    });
  });
  return {id:'done',lines};
}

function recapIds(recap: NonNullable<Brief['recap']>): Array<Exclude<BriefFieldId,'said'>> {
  return [...(recap.needs ? ['needs' as const] : []),'goal','now',...(recap.done.length ? ['done' as const] : [])];
}

/**
 * The recap's fields, each on its own lines with its label inline: what it
 * needs from the person (in the warning colour, absent when empty), the goal
 * (strong), where it stands, and what is done. No blank lines between them:
 * the label column is what sets one field off from the next.
 */
export function recapFields(recap: NonNullable<Brief['recap']>, width: number, column = labelColumn(recapIds(recap))): BriefField[] {
  const fields: BriefField[] = [];
  if (recap.needs) fields.push(inlineField('needs',recap.needs,width,column,theme.warning));
  fields.push(inlineField('goal',recap.goal,width,column,theme.strong));
  fields.push(inlineField('now',recap.now,width,column));
  const done = doneField(recap.done,width,column);
  if (done) fields.push(done);
  return fields;
}

/**
 * The main session's brief as fields, in the order they are read: the
 * pending approval in the model's words (it leads: the session cannot go on
 * without it), the recap, and what else the brief said. The whole-picture
 * sentence repeats Now when a recap is there, so it shows only without one,
 * in Now's place. A failed call and a reply in another shape are rows of
 * their own, as written.
 */
export function briefFields(input: MonitorData, width: number): BriefField[] {
  const brief = input.brief;
  const fields: BriefField[] = [];
  const ids = [...(input.notes?.approval ? ['approval' as const] : []),...(brief?.recap ? recapIds(brief.recap) : brief?.overall ? ['now' as const] : [])];
  const column = labelColumn(ids);
  if (input.notes?.approval) fields.push(inlineField('approval',`~ ${input.notes.approval}`,width,column,theme.warning));
  if (brief?.recap) fields.push(...recapFields(brief.recap,width,column));
  else if (brief?.overall) fields.push(inlineField('now',brief.overall,width,column,colors.dim));
  const said = briefSaid(input,width);
  if (said.length) fields.push({id:'said',lines:said});
  return fields;
}

/** The order fields give way in when the brief is taller than its room: the last goes first. */
export const BRIEF_KEEP: readonly BriefFieldId[] = ['approval','needs','said','now','goal','done'];

/** A running turn's length, counting seconds: 42s, 4m07s, 1h04m. */
export function clockText(ms: number): string {
  const seconds = Math.max(0,Math.floor(ms/1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m${String(seconds%60).padStart(2,'0')}s`;
  return `${Math.floor(seconds/3600)}h${String(Math.floor(seconds/60)%60).padStart(2,'0')}m`;
}

/**
 * The time a card's bottom rule carries: while the turn runs, the tree's
 * clock face and the turn's length (in the warning colour when quiet); once
 * finished or failed, how long ago. Nothing when nothing says. A turn not
 * started yet is its clock glyph alone, the word only with glyphs off.
 */
function cardTime(node: SubagentTreeNode, now: number): string {
  if (isLive(node)) {
    const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
    if (start === undefined || !Number.isFinite(start)) return iconic() ? theme.info('◌') : colors.dim(t('starting'));
    const paint = isQuiet(node,now) ? theme.warning : theme.info;
    return `${turnClock(node,now)} ${paint(clockText(now-start))}`;
  }
  const at = settledAt(node);
  return at ? colors.dim(agoText(at,now)) : '';
}
/** When a card's agent last settled: finished, failed, or last heard from. */
function settledAt(node: SubagentTreeNode): Date | undefined {
  const at = node.status === 'unknown' ? node.lastEventAt : finishedAt(node);
  return at && Number.isFinite(at.getTime()) ? at : undefined;
}

/**
 * One entry inside a card: a model's words after a muted "~", a status
 * change as a word in the tree's colours, an update as the agent's own
 * words, its chat markdown taken out. Wrapped lines hang under the text, and
 * the age sits at the right end of the last line; when it does not fit
 * there, or says what the bottom rule says already (`ruleAge`), it is left
 * out rather than given a line of its own.
 */
export function cardEntryLines(entry: AgentLogEntry, width: number, now: number, max = Infinity, ruleAge?: string): string[] {
  const status = entry.kind === 'started' ? theme.info : entry.kind === 'finished' ? theme.success : entry.kind === 'failed' ? theme.error : null;
  const model = MODEL_LOG_KINDS.has(entry.kind);
  const paint = status ?? (entry.attention ? theme.warning : plain);
  const lead = model ? '~ ' : '';
  const text = status ? t(entry.kind) : monitorText(plainText(entry.text));
  let lines = hangLines(text,width-lead.length,width-2);
  if (!lines.length) return [];
  lines = clipLines(lines,max,width-2).lines;
  const when = age(new Date(entry.at),now);
  const painted = lines.map((line,i)=>i ? '  '+paint(line) : colors.dim(lead)+paint(line));
  const last = visualLength(stripAnsi(painted.at(-1)!));
  if (when !== ruleAge && last+1+visualLength(when) <= width) painted[painted.length-1] += ' '.repeat(width-last-visualLength(when))+colors.dim(when);
  return painted;
}

/**
 * The newest model-written entry, then the newest observed one; or the newest
 * observed alone. A status change is the bottom rule's to say ("◷ 4m07s",
 * "2m ago"), so it is not said twice here; the opened card lists it.
 */
function briefEntries(log: readonly AgentLogEntry[]): AgentLogEntry[] {
  const status = new Set(['started','finished','failed']);
  const newest = (model: boolean) => [...log].reverse().find(entry=>MODEL_LOG_KINDS.has(entry.kind) === model && (model || !status.has(entry.kind)));
  const note = newest(true);
  const seen = newest(false);
  return [note,seen].filter((entry): entry is AgentLogEntry => Boolean(entry));
}

/**
 * The card's colour, by state alone: live info, quiet warning, failed
 * error, just finished success, old news (and an ancestor kept only for its
 * descendants) dim. The selection is the "›" and the name, not the colour.
 */
function cardPaint(node: SubagentTreeNode, old: boolean, context: boolean, now: number): Paint {
  return node.status === 'error' ? theme.error : isQuiet(node,now) ? theme.warning : isLive(node) ? theme.info
    : node.status === 'completed' && !old && !context ? theme.success : colors.dim;
}

/** A finished agent recedes once the news of it finishing is a minute old, as its tree row does. */
function isOld(node: SubagentTreeNode, now: number): boolean {
  return node.status === 'completed' && now-(finishedAt(node)?.getTime() ?? 0) > FRESH_FINISH_MS;
}

/**
 * Whether a card draws as one line: finished a minute ago or more, not
 * opened, and nothing about it needs a look. A running, failed, quiet or
 * opened agent keeps its card, and so does one just finished, so its final
 * report shows for a minute.
 */
export function isOneLine(node: SubagentTreeNode, input: MonitorData, state: MonitorState, now: number): boolean {
  if (!isOld(node,now) || state.cards?.has(node.id)) return false;
  return !input.agentLog?.get(node.id)?.at(-1)?.attention;
}

/** The agent's context as a meter for a rule's gap; dim once the card is old news. */
function contextMeter(node: SubagentTreeNode, old: boolean): EdgeMeter | undefined {
  const ctx = node.contextUsage;
  if (!ctx) return undefined;
  return {percent:ctx.percent,paint:old ? colors.dim : getContextColor(ctx.percent),label:colors.dim(`${ctx.percent}%`)};
}

/** Columns of a one-line row's meter, so the meters line up down the list. */
const ROW_METER = 12;

/**
 * An age right-aligned in the column one-line rows share, as wide as a
 * three-character age in the reader's words ("12m", "12m ago", "12m前"),
 * by display width so that CJK lines up.
 */
function ageColumn(when: string): string {
  const column = iconic() ? 3 : visualLength(t('{age} ago',{age:'59m'}));
  return ' '.repeat(Math.max(0,column-visualLength(when)))+when;
}

/**
 * A finished agent as one line, in tree-row style: its name, a rule, its
 * guardian chip and model badge, then its context meter and how long ago, in
 * columns that line up down the list. Selecting it only marks it "›"; `e`,
 * Space or a click opens it into its card.
 */
function oneLineCard(row: PanelRow, state: MonitorState, width: number, now: number): MonitorRow {
  const node = row.node;
  const indent = Math.min(MAX_INDENT,row.depth,Math.max(0,width-8));
  const w = width-indent;
  const selected = node.id === state.tree.selectedId;
  const st = nodeStatus(node,now);
  const title = agentTitle(node);
  const head = `${selected ? theme.accent('›') : ' '} ${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
  const token = w < BADGE_MIN ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
    mode: w < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
  });
  const badge = token ? colors.dim(stripAnsi(truncateAnsi(token,Math.max(2,Math.floor(w/4))))) : '';
  const at = settledAt(node);
  const when = at ? agoText(at,now) : '';
  const meter = contextMeter(node,true);
  const meterCols = meter && w >= METER_MIN+ROW_METER ? ROW_METER : 0;
  const right = [guardianChip(node.children),badge].filter(Boolean).join(' ');
  const tail = `${right ? ' '+right : ''}${meterCols ? ' '+meterGap(meterCols,meter).text : ''}${when ? ' '+colors.dim(ageColumn(when)) : ''}`;
  const room = Math.max(1,w-visualLength(head)-visualLength(tail)-2);
  const name = squeeze(title.name,room);
  const dashes = Math.max(1,w-visualLength(head)-visualLength(name)-1-visualLength(tail));
  const shownName = selected ? theme.accent(name) : colors.dim(name);
  const text = truncateAnsi(`${head}${shownName} ${colors.dim('─'.repeat(dashes))}${tail}`,w);
  return {text:' '.repeat(indent)+text,item:node.id,key:`card:${node.id}`,controls:[{kind:'expand',item:node.id,x:indent,width:w}]};
}

/**
 * An agent's card. Collapsed: what it is for, then its newest news. Opened:
 * its whole timeline as well, newest first (or, with no log, its last
 * report), then the task in full when the line at the top did not show all
 * of it.
 */
export function agentCard(row: PanelRow, input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const node = row.node;
  if (isOneLine(node,input,state,now)) return [oneLineCard(row,state,width,now)];
  const indent = Math.min(MAX_INDENT,row.depth,Math.max(0,width-8));
  const w = width-indent;
  const lead = ' '.repeat(indent);
  const selected = node.id === state.tree.selectedId;
  const open = state.cards?.has(node.id) ?? false;
  const old = isOld(node,now);
  const paint = cardPaint(node,old,Boolean(row.context),now);
  const st = nodeStatus(node,now);
  const title = agentTitle(node);
  const key = `card:${node.id}`;
  const rows: MonitorRow[] = [];
  const control = (x: number, width_: number): RowControl => ({kind:'expand',item:node.id,x:indent+x,width:width_});

  // Top rule: who the agent is.
  const corner = selected ? theme.accent('›') : paint('┌');
  const token = w < BADGE_MIN ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
    mode: w < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
  });
  const badge = token ? truncateAnsi(token,Math.max(2,Math.floor(w/4))) : '';
  const head = `${corner} ${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
  const chip = guardianChip(node.children);
  const tail = [chip,badge].filter(Boolean).map(part=>' '+part).join('');
  const room = Math.max(1,w-visualLength(head)-visualLength(tail)-2);
  const name = squeeze(title.name,room);
  const dashes = Math.max(0,w-visualLength(head)-visualLength(name)-1-visualLength(tail));
  // The name is the one thing on the rule to click to go to the agent's
  // session, so it alone is underlined; the rest of the rule opens the card.
  const shownName = colors.underline(name);
  const named = selected ? theme.accent(shownName) : old || row.context ? colors.dim(shownName) : shownName;
  const top = truncateAnsi(`${head}${named} ${paint('─'.repeat(dashes))}${tail}`,w);
  const nameAt = Math.min(w,visualLength(head));
  rows.push({text:lead+top,item:node.id,key,controls:[
    {kind:'switch',item:node.id,x:indent+nameAt,width:Math.max(0,Math.min(visualLength(name),w-nameAt))},control(0,w)]});

  // Inside: what the agent is doing.
  const inner = Math.max(1,w-2);
  const body: string[] = [];
  const gap = () => { if (spaced && body.length) body.push(''); };
  // A guardian's task is Codex's review prompt, the same boilerplate every
  // time: never shown as what the agent is for.
  const task = isGuardian(node) ? {lines:[],clipped:false} : taskLines(title,inner);
  body.push(...task.lines.map(line=>title.renamed ? theme.strong(line) : line));
  // The log only when it is asked for (a backend, or the log switch): the
  // panel is not a transcript unless the reader chose one.
  const log = input.agentLog?.get(node.id) ?? [];
  const news = briefEntries(log);
  const settled = settledAt(node);
  const ruleAge = settled && !isLive(node) ? age(settled,now) : undefined;
  // Opened, the whole timeline stands in for the newest news.
  if (!open && news.length) { gap(); for (const entry of news) body.push(...cardEntryLines(entry,inner,now,ENTRY_LINES,ruleAge)); }
  if (open) {
    const timeline: string[] = [];
    let shown = 0;
    for (const entry of [...log].reverse()) {
      const lines = cardEntryLines(entry,inner,now,Infinity,ruleAge);
      if (timeline.length+lines.length > TIMELINE_LINES) break;
      timeline.push(...lines); shown++;
    }
    if (timeline.length || log.length) { gap(); body.push(...timeline); }
    else if (node.lastReport?.text.trim()) {
      // No log kept: what the Inspector calls the latest update, cut like an entry.
      gap();
      body.push(...clipLines(hangLines(monitorText(plainText(node.lastReport.text.replace(/\s+/g,' ').trim())),inner,inner),REPORT_LINES,inner).lines);
    }
    if (shown < log.length) body.push(colors.dim(truncateAnsi(t('… {n} earlier — Inspector',{n:log.length-shown}),inner)));
    // The task in full, when the line at the top was the model's name for it or a cut.
    const full = node.task?.replace(/\s+/g,' ').trim();
    if (full && !isGuardian(node) && (title.renamed || task.clipped)) {
      gap();
      body.push(colors.dim(t('Task')));
      body.push(...clipLines(flowLines(monitorText(full),inner),TASK_TEXT_LINES,inner).lines);
    }
  }
  // Old news reads as old news: its words step back with its name.
  const shownBody = old ? body.map(line=>colors.dim(stripAnsi(line))) : body;
  for (const line of shownBody) rows.push({text:lead+(line ? `${paint('│')} ${truncateAnsi(line,inner)}` : paint('│')),item:node.id,key});

  // Bottom rule: how long, how full, and the switch that opens the card.
  const folded = row.collapsed && row.hasChildren ? visibleRows(node.children,{...state.tree,collapsed:new Set()},now).length : 0;
  const left = [cardTime(node,now),folded ? colors.dim(iconic() ? `+${folded}` : t('+{n} folded',{n:folded})) : ''].filter(Boolean).join(colors.dim(' · '));
  const toggle = theme.accent(open ? '▴' : '▾');
  // The rule's gap is the agent's context meter; short of room the meter
  // gives way to its label, then the time is cut.
  const meter = contextMeter(node,old);
  const edge = edgeLine(w-2,'└','',left,'',meter,false,paint)
    ?? edgeLine(w-2,'└','',truncateAnsi(left,Math.max(0,w-7)),'',undefined,false,paint);
  const bottom = edge ? `${edge.line} ${toggle}` : truncateAnsi(`${paint('└')} ${toggle}`,w);
  rows.push({text:lead+bottom,item:node.id,key,controls:[control(visualLength(stripAnsi(bottom))-1,1)]});
  return rows;
}

/** Lines of an opened card's last report, when it has no log to show. */
const REPORT_LINES = 8;

/**
 * Rich: the agents view, a list of agent cards and nothing else. The summary
 * line heads it and stays put; under it scroll a card per agent the tree
 * would show, in the tree's order, under its filter and linger window. The
 * main session's brief is the status card's, at the foot. `spaced` puts a
 * blank line between cards; the one-line rows of finished agents sit
 * together, as a list.
 */
export function richRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const {row:head,total,expired} = summaryRow(input,state,width,now);
  const rows: MonitorRow[] = [head];
  let lastOneLine = false;
  const shown = visibleRows(input.tree.nodes,state.tree,now);
  for (const row of shown) {
    const oneLine = isOneLine(row.node,input,state,now);
    if (spaced && rows.at(-1)?.text !== '' && !(oneLine && lastOneLine)) rows.push({text:''});
    rows.push(...agentCard(row,input,state,width,now,spaced));
    lastOneLine = oneLine;
  }
  if (!shown.length) { if (spaced) rows.push({text:''}); rows.push({text:colors.dim(truncateAnsi(emptyAgentsText(input,state,total,expired),width))}); }
  return rows;
}
