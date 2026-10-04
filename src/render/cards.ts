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
import { visibleRows, type PanelRow } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, type AgentTitle } from './agent-title.js';
import {
  type MonitorData, type MonitorState, type MonitorRow, type RowControl,
  monitorText, flowLines, balancedLines, age, nodeStatus, isLive, isQuiet, turnClock, contextLine, squeeze, finishedAt,
  writtenAge, summaryRow, emptyAgentsText, briefParts, briefRuleRow,
  MODEL_LOG_KINDS, FRESH_FINISH_MS, CONTEXT_METER_WIDTH,
} from './monitor.js';

/** Lines of one entry in a collapsed card. */
const ENTRY_LINES = 3;
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

/**
 * The recap's fields, each a dim label on its own line with its text
 * indented two columns beneath it: the goal (strong), what is done (each
 * item with its ✓, wrapped under its own text), where it stands, and, when
 * the session waits on the person, what it needs, in the warning colour and
 * absent when empty. Folded, the goal alone. Lines are evened out so none
 * ends in a stranded word. `spaced` puts a blank line between fields.
 */
export function recapFields(recap: NonNullable<Brief['recap']>, folded: boolean, width: number, spaced: boolean): string[] {
  const text = (value: string, indent: number, paint: Paint = plain) =>
    balancedLines(monitorText(value),Math.max(1,width-indent)).map(line=>' '.repeat(indent)+paint(line));
  const fields: string[][] = [[colors.dim(t('Goal')),...text(recap.goal,2,theme.strong)]];
  if (!folded) {
    if (recap.done.length) fields.push([colors.dim(t('Done')),...recap.done.flatMap(item =>
      balancedLines(monitorText(item),Math.max(1,width-4)).map((line,i)=>(i ? '    ' : `  ${theme.success('✓')} `)+line))]);
    fields.push([colors.dim(t('Now')),...text(recap.now,2)]);
    if (recap.needs) fields.push([theme.warning(t('Needs')),...text(recap.needs,2,theme.warning)]);
  }
  return fields.flatMap((field,i)=>[...(i && spaced ? [''] : []),...field]);
}

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
 * finished or failed, how long ago. Nothing when nothing says.
 */
function cardTime(node: SubagentTreeNode, now: number): string {
  if (isLive(node)) {
    const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
    if (start === undefined || !Number.isFinite(start)) return colors.dim(t('starting'));
    const paint = isQuiet(node,now) ? theme.warning : theme.info;
    return `${turnClock(node,now)} ${paint(clockText(now-start))}`;
  }
  const at = node.status === 'unknown' ? node.lastEventAt : finishedAt(node);
  if (!at || !Number.isFinite(at.getTime())) return '';
  return colors.dim(t('{age} ago',{age:age(at,now)}));
}

/**
 * One entry inside a card: a model's words after a muted "~", a status
 * change as a word in the tree's colours, an update as the agent's own
 * words. Wrapped lines hang under the text, and the age sits at the right
 * end of the last line, or on a line of its own when that one is full.
 */
export function cardEntryLines(entry: AgentLogEntry, width: number, now: number, max = Infinity): string[] {
  const status = entry.kind === 'started' ? theme.info : entry.kind === 'finished' ? theme.success : entry.kind === 'failed' ? theme.error : null;
  const model = MODEL_LOG_KINDS.has(entry.kind);
  const paint = status ?? (entry.attention ? theme.warning : plain);
  const lead = model ? '~ ' : '';
  const text = status ? t(entry.kind) : monitorText(entry.text);
  let lines = hangLines(text,width-lead.length,width-2);
  if (!lines.length) return [];
  lines = clipLines(lines,max,width-2).lines;
  const when = age(new Date(entry.at),now);
  const painted = lines.map((line,i)=>i ? '  '+paint(line) : colors.dim(lead)+paint(line));
  const last = visualLength(stripAnsi(painted.at(-1)!));
  if (last+1+visualLength(when) <= width) painted[painted.length-1] += ' '.repeat(width-last-visualLength(when))+colors.dim(when);
  else painted.push(' '.repeat(Math.max(0,width-visualLength(when)))+colors.dim(when));
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
 * An agent's card. Collapsed: what it is for, then its newest news. Opened:
 * its whole timeline as well, newest first, then the task in full when the
 * line at the top did not show all of it.
 */
export function agentCard(row: PanelRow, input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const node = row.node;
  const indent = Math.min(MAX_INDENT,row.depth,Math.max(0,width-8));
  const w = width-indent;
  const lead = ' '.repeat(indent);
  const selected = node.id === state.tree.selectedId;
  const open = state.cards?.has(node.id) ?? false;
  // A finished agent recedes once the news of it finishing is a minute old,
  // as its tree row does; so does an ancestor shown only for its descendants.
  const old = node.status === 'completed' && now-(finishedAt(node)?.getTime() ?? 0) > FRESH_FINISH_MS;
  const paint: Paint = selected ? theme.accent : node.status === 'error' ? theme.error : isQuiet(node,now) ? theme.warning
    : isLive(node) ? theme.info : node.status === 'completed' && !old && !row.context ? theme.success : colors.dim;
  const st = nodeStatus(node,now);
  const title = agentTitle(node);
  const key = `card:${node.id}`;
  const rows: MonitorRow[] = [];
  const control = (x: number, width_: number): RowControl => ({kind:'expand',item:node.id,x:indent+x,width:width_});

  // Top rule: who the agent is.
  const corner = selected ? '›' : '┌';
  const token = w < BADGE_MIN ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
    mode: w < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
  });
  const badge = token ? truncateAnsi(token,Math.max(2,Math.floor(w/4))) : '';
  const head = `${paint(corner)} ${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
  const tail = badge ? ' '+badge : '';
  const room = Math.max(1,w-visualLength(head)-visualLength(tail)-2);
  const name = squeeze(title.name,room);
  const dashes = Math.max(0,w-visualLength(head)-visualLength(name)-1-visualLength(tail));
  // The name is the one thing on the rule to click to go to the agent's
  // session, so it alone is underlined; the rest of the rule opens the card.
  const shownName = colors.underline(name);
  const top = truncateAnsi(`${head}${old || row.context ? colors.dim(shownName) : shownName} ${paint('─'.repeat(dashes))}${tail}`,w);
  const nameAt = Math.min(w,visualLength(head));
  rows.push({text:lead+top,item:node.id,key,controls:[
    {kind:'switch',item:node.id,x:indent+nameAt,width:Math.max(0,Math.min(visualLength(name),w-nameAt))},control(0,w)]});

  // Inside: what the agent is doing.
  const inner = Math.max(1,w-2);
  const body: string[] = [];
  const gap = () => { if (spaced && body.length) body.push(''); };
  const task = taskLines(title,inner);
  body.push(...task.lines.map(line=>title.renamed ? theme.strong(line) : line));
  // The log only when it is asked for (a backend, or the log switch): the
  // panel is not a transcript unless the reader chose one.
  const log = input.agentLog?.get(node.id) ?? [];
  const news = briefEntries(log);
  // Opened, the whole timeline stands in for the newest news.
  if (!open && news.length) { gap(); for (const entry of news) body.push(...cardEntryLines(entry,inner,now,ENTRY_LINES)); }
  if (open) {
    const timeline: string[] = [];
    let shown = 0;
    for (const entry of [...log].reverse()) {
      const lines = cardEntryLines(entry,inner,now);
      if (timeline.length+lines.length > TIMELINE_LINES) break;
      timeline.push(...lines); shown++;
    }
    if (timeline.length || log.length) { gap(); body.push(...timeline); }
    if (shown < log.length) body.push(colors.dim(truncateAnsi(t('… {n} earlier — Inspector',{n:log.length-shown}),inner)));
    // The task in full, when the line at the top was the model's name for it or a cut.
    const full = node.task?.replace(/\s+/g,' ').trim();
    if (full && (title.renamed || task.clipped)) {
      gap();
      body.push(colors.dim(t('Task')));
      body.push(...clipLines(flowLines(monitorText(full),inner),TASK_TEXT_LINES,inner).lines);
    }
  }
  for (const line of body) rows.push({text:lead+(line ? `${paint('│')} ${truncateAnsi(line,inner)}` : paint('│')),item:node.id,key});

  // Bottom rule: how long, how full, and the switch that opens the card.
  const folded = row.collapsed && row.hasChildren ? visibleRows(node.children,{...state.tree,collapsed:new Set()},now).length : 0;
  const left = [cardTime(node,now),folded ? colors.dim(t('+{n} folded',{n:folded})) : ''].filter(Boolean).join(colors.dim(' · '));
  const ctx = node.contextUsage;
  const toggle = theme.accent(open ? '▴' : '▾');
  const opening = `${paint('└')} `;
  // The meter goes before the time does, and its line before its percent:
  // the first right side that leaves the left whole and one dash wins.
  const rights = [...(ctx && w >= METER_MIN ? [`${contextLine(ctx.percent,CONTEXT_METER_WIDTH)} ${colors.dim(`${ctx.percent}%`)} ${toggle}`] : []),
    ...(ctx ? [`${colors.dim(`${ctx.percent}%`)} ${toggle}`] : []),toggle];
  const fits = (right: string) => visualLength(opening)+(left ? visualLength(left)+1 : 0)+1+1+visualLength(right) <= w;
  const right = rights.find(fits) ?? toggle;
  const leftRoom = Math.max(0,w-visualLength(opening)-visualLength(right)-2);
  const shownLeft = visualLength(left) > leftRoom ? truncateAnsi(left,leftRoom) : left;
  const fill = Math.max(1,w-visualLength(opening)-visualLength(shownLeft)-(shownLeft ? 1 : 0)-visualLength(right)-1);
  const bottom = truncateAnsi(`${opening}${shownLeft}${shownLeft ? ' ' : ''}${paint('─'.repeat(fill))} ${right}`,w);
  rows.push({text:lead+bottom,item:node.id,key,controls:[control(visualLength(stripAnsi(bottom))-1,1)]});
  return rows;
}

/**
 * The main recap as a card of the same family, told apart by its title and
 * its accent bar (the warning colour while it needs the person). The fold
 * switch rides on the top rule, which is all one click target; what it
 * needs is repeated on the bottom rule, cut to fit, beside the copy switch.
 */
export function recapCard(recap: NonNullable<Brief['recap']>, folded: boolean, width: number, now: number, spaced: boolean): MonitorRow[] {
  const paint: Paint = recap.needs ? theme.warning : theme.accent;
  const key = 'recap';
  const title = `${paint('┌')} ${theme.strong(t('Main recap'))} `;
  const when = colors.dim(writtenAge(recap.at,now));
  const fold = colors.dim(t(folded ? 'r more' : 'r fold'));
  // The age and the switch, the switch alone, or neither: the first that leaves a dash.
  const right = [`${when}${colors.dim(' · ')}${fold}`,fold,''].find(text => visualLength(title)+1+(text ? visualLength(text)+1 : 0) <= width) ?? '';
  const dashes = Math.max(0,width-visualLength(title)-(right ? visualLength(right)+1 : 0));
  const top = truncateAnsi(`${title}${paint('─'.repeat(dashes))}${right ? ' '+right : ''}`,width);
  const rows: MonitorRow[] = [{text:top,key,controls:[{kind:'recap',x:0,width:visualLength(stripAnsi(top))}]}];
  for (const line of recapFields(recap,folded,Math.max(1,width-2),spaced)) rows.push({text:line ? `${paint('│')} ${line}` : paint('│'),key});
  const copy = colors.dim(t('y copy'));
  const opening = `${paint('└')} `;
  const room = width-visualLength(opening)-visualLength(copy)-3;
  const needs = recap.needs && room >= 4 ? theme.warning(truncateAnsi(monitorText(`${t('Needs')} ${recap.needs}`),room)) : '';
  const fill = Math.max(1,width-visualLength(opening)-visualLength(needs)-(needs ? 1 : 0)-visualLength(copy)-1);
  const bottom = truncateAnsi(`${opening}${needs}${needs ? ' ' : ''}${paint('─'.repeat(fill))} ${copy}`,width);
  rows.push({text:bottom,key,controls:[{kind:'copy',x:Math.max(0,visualLength(stripAnsi(bottom))-visualLength(copy)),width:visualLength(copy)}]});
  return rows;
}

/**
 * Rich: the agents view. The summary line heads it and stays put; under it
 * scroll the recap card, the brief (its rule and switch, the approval in
 * plain words, the whole-picture sentence), then a card per agent the tree
 * would show, in the tree's order, under its filter and linger window.
 * `spaced` puts a blank line between the parts and between cards.
 */
export function richRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const {row:head,total,expired} = summaryRow(input,state,width,now);
  const rows: MonitorRow[] = [head];
  const gap = () => { if (spaced && rows.at(-1)?.text !== '') rows.push({text:''}); };
  const brief = input.brief;
  const step = (list: MonitorRow[]) => brief?.paused ? list.map(row=>({...row,text:colors.dim(stripAnsi(row.text))})) : list;
  if (brief?.recap) { gap(); rows.push(...step(recapCard(brief.recap,Boolean(brief.recapFolded),width,now,spaced))); }
  const {approval,said} = briefParts(input,width);
  if (brief) {
    gap();
    rows.push(briefRuleRow(brief,width),...step([...approval.map(text=>({text,key:'approval'})),...said.map(text=>({text,key:'said'}))]));
  } else if (approval.length) { gap(); rows.push(...approval.map(text=>({text,key:'approval'}))); }
  const shown = visibleRows(input.tree.nodes,state.tree,now);
  for (const row of shown) { gap(); rows.push(...agentCard(row,input,state,width,now,spaced)); }
  if (!shown.length) { gap(); rows.push({text:colors.dim(truncateAnsi(emptyAgentsText(input,state,total,expired),width))}); }
  return rows;
}

