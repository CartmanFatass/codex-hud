/**
 * The rich panel: a card for each L1 agent (one the main session started),
 * all in the one scrolling view under the agents' summary line. The agents
 * an L1 started are its card's to count by role and, those that matter, to
 * name; they get no card of their own.
 *
 * A card is open on the right: a top rule, a bar down the left, a bottom
 * rule, so its text gets the column a closed box spends on its right side,
 * and it never reads as the status card at the foot. The border identifies
 * the agent, its name in its direction's colour; the inside says, a line
 * each, what it is for, who it works with, what it is doing this moment, the
 * newest note a model wrote about it and its newest update, the subtasks
 * that matter, and the rest counted by role:
 *
 *   ┌ ▸ ⌕ ablation_lead ─────────────────── ★◐
 *   │ 去重排消融召回对比
 *   │ ⇄ critic
 *   │ ▸ python eval.py --k 10
 *   │ ~ 召回下降，结果待核对
 *   │ ✗ scout_streams ~ hit the rate limit  41m
 *   │ 5 implementer · 3 reviewer · 1 general
 *   └ ◷4m07s ─────────56%──────────────── ▾
 *
 * A finished agent a minute old is two lines instead: its row, and under it
 * how far it got:
 *
 *  ✓ db_index_service      ☀◆ ✓4 ────49%───── 19h
 *    ~ 发布说明与文档已更新，无遗留
 *
 * The rules and the bar take the status colour; the selected card or row is
 * marked "›" and its first line sits on the selected surface. A card carries
 * everything its tree row did: status, name, model badge, context meter,
 * turn clock, quiet or failed, dimming once old news, and the selection.
 * Pure: no I/O.
 */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import { isGuardian, type PanelRow } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, type AgentTitle } from './agent-title.js';
import {
  type MonitorData, type MonitorState, type MonitorRow, type RowControl,
  monitorText, plainText, flowLines, pair, age, agoText, nodeStatus, iconic, briefSaid, isLive, isQuiet, turnClock, squeeze, finishedAt,
  summaryRow, guardianChip, meterText, meterRow, listedAgents, type EdgeMeter,
  MODEL_LOG_KINDS, FRESH_FINISH_MS,
} from './monitor.js';
import { directions, subtasks, tally, talk, isImportant, rolePrefix, TALK_MIN } from './directions.js';

/** Lines of an expanded card's timeline; the rest is the Inspector's. */
const TIMELINE_LINES = 20;
/** Lines of the task text an expanded card ends with. */
const TASK_TEXT_LINES = 8;
/** The important subtasks a closed card names; opened, it names them all. */
const KIDS_SHOWN = 3;
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
 * for it, or else the task it was given, cut to `max` lines.
 */
export function taskLines(title: AgentTitle, width: number, max = 2): {lines: string[]; clipped: boolean} {
  if (!title.task) return {lines:[],clipped:false};
  return clipLines(flowLines(title.task,width),max,width);
}

/** Which part of the brief a block of lines is. */
export type BriefFieldId = 'approval' | 'needs' | 'goal' | 'now' | 'done' | 'said';
export interface BriefField { id: BriefFieldId; lines: string[] }
/**
 * How much of the brief is drawn: the lines one value gets before it is cut,
 * and how many done items show, the newest (the rest are counted).
 */
export interface BriefShape { fieldLines: number; doneShown: number }
/** The brief as it usually is: two lines a value, the newest two done items. */
const BRIEF_SHAPE: BriefShape = {fieldLines:2,doneShown:2};
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
  const paint = id === 'needs' || id === 'approval' ? theme.warning : id === 'done' && iconic() ? theme.success : id === 'now' && iconic() ? theme.info : colors.dim;
  return paint(text)+' '.repeat(Math.max(0,column-visualLength(text)));
}

/**
 * One field: its label in the label column, the value after it, wrapped
 * with its lines hanging under the value and cut after `max`.
 */
function inlineField(id: Exclude<BriefFieldId,'said'>, value: string, width: number, column: number, paint: Paint = plain, max = BRIEF_SHAPE.fieldLines): BriefField {
  const room = Math.max(1,width-column-1);
  const lines = clipLines(flowLines(monitorText(value),room),max,room).lines;
  return {id,lines:lines.map((line,i)=>(i ? ' '.repeat(column+1) : fieldLabel(id,column)+' ')+paint(line))};
}

/**
 * Done: the newest items, two as a rule, a dim "+N" closing the last when
 * there were more. With icons the ✓ in the label column heads the first item
 * and the rest hang under it; with words the label heads the first and each
 * item keeps its own ✓.
 */
function doneField(done: readonly string[], width: number, column: number, shape = BRIEF_SHAPE): BriefField | null {
  if (!done.length) return null;
  const items = done.slice(-shape.doneShown);
  const more = done.length-items.length;
  const suffix = more ? ` +${more}` : '';
  const mark = iconic() ? '' : `${theme.success('✓')} `;
  const lead = visualLength(stripAnsi(mark));
  const room = Math.max(1,width-column-1-lead);
  const lines: string[] = [];
  items.forEach((item,index) => {
    const last = index === items.length-1;
    // The last item's last line leaves room for the count, so it never wraps
    // alone; the lines before it are filled to the full width.
    let flowed = flowLines(monitorText(item),room);
    const tail = flowed.at(-1) ?? '';
    if (last && suffix && visualLength(tail)+suffix.length > room)
      flowed = [...flowed.slice(0,-1),...flowLines(tail,Math.max(1,room-suffix.length))];
    const wrapped = clipLines(flowed,shape.fieldLines,room-(last ? suffix.length : 0)).lines;
    wrapped.forEach((line,i) => {
      const label = !index && !i ? fieldLabel('done',column)+' ' : ' '.repeat(column+1);
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
export function recapFields(recap: NonNullable<Brief['recap']>, width: number, column = labelColumn(recapIds(recap)), shape = BRIEF_SHAPE): BriefField[] {
  const fields: BriefField[] = [];
  if (recap.needs) fields.push(inlineField('needs',recap.needs,width,column,theme.warning,shape.fieldLines));
  fields.push(inlineField('goal',recap.goal,width,column,theme.strong,shape.fieldLines));
  fields.push(inlineField('now',recap.now,width,column,plain,shape.fieldLines));
  const done = doneField(recap.done,width,column,shape);
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
export function briefFields(input: MonitorData, width: number, shape = BRIEF_SHAPE): BriefField[] {
  const brief = input.brief;
  const fields: BriefField[] = [];
  const ids = [...(input.notes?.approval ? ['approval' as const] : []),...(brief?.recap ? recapIds(brief.recap) : brief?.overall ? ['now' as const] : [])];
  const column = labelColumn(ids);
  if (input.notes?.approval) fields.push(inlineField('approval',`~ ${input.notes.approval}`,width,column,theme.warning,shape.fieldLines));
  if (brief?.recap) fields.push(...recapFields(brief.recap,width,column,shape));
  else if (brief?.overall) fields.push(inlineField('now',brief.overall,width,column,colors.dim,shape.fieldLines));
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
 * started yet is its clock glyph and the word.
 */
function cardTime(node: SubagentTreeNode, now: number): string {
  if (isLive(node)) {
    const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
    if (start === undefined || !Number.isFinite(start)) return `${iconic() ? theme.info('◌')+' ' : ''}${colors.dim(t('starting'))}`;
    const quiet = isQuiet(node,now);
    // The clock face is the time's scale, in the tick colour; quiet, it is the warning.
    const face = stripAnsi(turnClock(node,now));
    return `${quiet ? theme.warning(face) : theme.tick(face)}${(quiet ? theme.warning : theme.info)(clockText(now-start))}`;
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
 * What an agent last said, in brief, from its log: the newest note a model
 * wrote about it, and the newest update in its own words, each as one line
 * of sanitized text. A status change is the bottom rule's or the status
 * icon's to say, so it is not news here. With no log there is no news: the
 * panel is not a transcript unless the reader chose one (a backend, or the
 * log switch); an opened card still shows the last report.
 */
export function agentNews(log: readonly AgentLogEntry[]): {note?: string; update?: string} {
  const flat = (text: string) => monitorText(plainText(text).replace(/\s+/g,' ').trim());
  const note = [...log].reverse().find(entry=>MODEL_LOG_KINDS.has(entry.kind) && entry.text.trim());
  const update = [...log].reverse().find(entry=>entry.kind === 'report' && entry.text.trim());
  return {...(note ? {note:flat(note.text)} : {}),...(update ? {update:flat(update.text)} : {})};
}

/**
 * The one line under a finished agent's row, saying how far it got:
 * whichever there is first of the newest model note ("~ …"), its newest
 * update in its own words, and what it was for. Plain text, uncut; empty
 * when there is none of these.
 */
export function briefLine(node: SubagentTreeNode, log: readonly AgentLogEntry[], title: AgentTitle): string {
  const news = agentNews(log);
  if (news.note) return `~ ${news.note}`;
  if (news.update) return news.update;
  return isGuardian(node) ? '' : title.task ?? '';
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

/**
 * A finished agent recedes once the news of it finishing is a minute old, as
 * its tree row does; one with a subtask still at work is not news yet.
 */
function isOld(node: SubagentTreeNode, now: number): boolean {
  return node.status === 'completed' && now-(finishedAt(node)?.getTime() ?? 0) > FRESH_FINISH_MS && !subtasks(node).some(isLive);
}

/**
 * Whether a card draws as one line: finished a minute ago or more, no
 * subtask at work, not opened, and nothing about it needs a look. A running,
 * failed, quiet or opened agent keeps its card, and so does one just
 * finished, so its final report shows for a minute.
 */
export function isOneLine(node: SubagentTreeNode, input: MonitorData, state: MonitorState, now: number): boolean {
  if (!isOld(node,now) || state.cards?.has(node.id)) return false;
  return !input.agentLog?.get(node.id)?.at(-1)?.attention;
}

/**
 * The agent's context as a meter. It keeps its zone colour once the card is
 * old news: a grey meter on a grey row could not be told from its track,
 * and the name dimming says the news is old.
 */
function contextMeter(node: SubagentTreeNode): EdgeMeter | undefined {
  const ctx = node.contextUsage;
  return ctx ? {percent:ctx.percent} : undefined;
}

/**
 * Columns of a one-line row's meter, so the meters line up down the list:
 * 12 in a narrow panel, 16 from 56 columns, and 8 under 36, where the name
 * needs the room more than the meter does.
 */
const ROW_METER = 12;
const ROW_METER_WIDE = 16;
const ROW_METER_WIDE_AT = 56;
const ROW_METER_NARROW = 8;
const ROW_METER_NARROW_BELOW = 36;
/** Columns the brief line under a row is indented: under the name. */
const BRIEF_INDENT = 3;

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
 * How a list draws its one-line rows: whether their meters are drawn, and
 * the age of the one-line row above, so that a run of rows of the same age
 * says it once, at the top of the run.
 */
interface OneLineRun { meters: boolean; previousAge?: string }

/** The selected row's first line on its own surface, as wide as the row. */
function banded(text: string, width: number): string {
  return theme.selectedBand(text+' '.repeat(Math.max(0,width-visualLength(text))));
}

/** "✓12 ✗1 ▸2": an L1's subtasks by state, a failed guardian review among the failed; empty with none. */
function tallyText(node: SubagentTreeNode): string {
  const n = tally(subtasks(node));
  const failed = n.failed+node.children.filter(kid => isGuardian(kid) && kid.status === 'error').length;
  return [n.done ? colors.dim(`✓${n.done}`) : '',failed ? theme.error(`✗${failed}`) : '',n.running ? theme.info(`▸${n.running}`) : ''].filter(Boolean).join(' ');
}

/**
 * A one-line row's first line in parts: its lead, its name squeezed into the
 * room left, and what follows the name: its guardian chip and model badge,
 * its subtasks by state, its meter if drawn, and how long ago.
 */
function oneLineParts(row: PanelRow, state: MonitorState, width: number, now: number, run: OneLineRun) {
  const node = row.node;
  const w = width;
  const selected = node.id === state.tree.selectedId;
  const st = nodeStatus(node,now);
  const title = agentTitle(node,state.labelAsName);
  const head = `${selected ? theme.accent('›') : ' '}${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon)+' ' : ''}`;
  const token = w < BADGE_MIN ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
    mode: w < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
  });
  // The badge keeps its colours: only the name steps back with old news.
  const badge = token ? truncateAnsi(token,Math.max(2,Math.floor(w/4))) : '';
  const at = settledAt(node);
  const when = at ? agoText(at,now) : '';
  const meter = run.meters ? contextMeter(node) : undefined;
  const cells = w >= ROW_METER_WIDE_AT ? ROW_METER_WIDE : w < ROW_METER_NARROW_BELOW ? ROW_METER_NARROW : ROW_METER;
  const meterCols = meter && w >= METER_MIN+cells ? cells : 0;
  const right = [guardianChip(node.children),badge,tallyText(node)].filter(Boolean).join(' ');
  // An age the row above said already leaves its column blank, so the columns still line up.
  const shown = when === run.previousAge ? '' : when;
  const tail = `${right ? ' '+right : ''}${meter && meterCols ? ' '+meterText(meter,meterCols).text : ''}${when ? ' '+colors.dim(ageColumn(shown)) : ''}`;
  const room = Math.max(1,w-visualLength(head)-visualLength(tail)-1);
  return {w,selected,title,head,tail,room,when,hasMeter:Boolean(meter && meterCols)};
}

/**
 * Whether a list's one-line rows draw their meters: where the meter would cut
 * most of their names, they all go without, so the names stay whole. A
 * row with no context reading has no meter either way and does not count.
 */
function oneLineMeters(rows: readonly PanelRow[], state: MonitorState, width: number, now: number): boolean {
  const metered = rows.map(row=>oneLineParts(row,state,width,now,{meters:true})).filter(parts=>parts.hasMeter);
  if (!metered.length) return true;
  const whole = metered.filter(parts=>visualLength(parts.title.name) <= parts.room).length;
  return whole*2 >= metered.length;
}

/**
 * A finished agent in two lines. The first in tree-row style: its status,
 * its name in its direction's colour, then its guardian chip, model badge
 * and subtasks by state, its context meter and how long ago, in columns
 * that line up down the list. The meter is there when the list has room for
 * it beside most names (`oneLineMeters`), and the age only where it differs
 * from the row above. The second, dim and indented under the name, says how
 * far it got (`briefLine`), cut to one line; without anything to say there
 * is no second line. Selecting it marks it "›" and puts its first line on
 * the selected surface; `e`, Space or a click opens it into its card.
 * Returns the rows and the row's age, for the next row to compare with.
 */
function oneLineCard(row: PanelRow, input: MonitorData, state: MonitorState, width: number, now: number, run: OneLineRun): {rows: MonitorRow[]; age: string} {
  const node = row.node;
  const {w,selected,title,head,tail,room,when} = oneLineParts(row,state,width,now,run);
  const name = squeeze(title.name,room);
  const gap = Math.max(1,w-visualLength(head)-visualLength(name)-visualLength(tail));
  const own = directions(input.tree).paint(node.id);
  const shownName = selected ? theme.bold(own(name)) : colors.dim(own(name));
  const first = truncateAnsi(`${head}${shownName}${' '.repeat(gap)}${tail}`,w);
  const key = `card:${node.id}`;
  const control: RowControl[] = [{kind:'expand',item:node.id,x:0,width:w}];
  const rows: MonitorRow[] = [{text:selected ? banded(first,w) : first,item:node.id,key,controls:control}];
  const brief = briefLine(node,input.agentLog?.get(node.id) ?? [],title);
  if (brief && w > BRIEF_INDENT+2) rows.push({text:' '.repeat(BRIEF_INDENT)+colors.dim(truncateAnsi(brief,w-BRIEF_INDENT)),item:node.id,key,controls:control});
  return {rows,age:when};
}

const flat = (text: string) => monitorText(plainText(text).replace(/\s+/g,' ').trim());

/**
 * What an agent said it would do in its newest stage that said so: the
 * stand-in for a task the rollout keeps sealed.
 */
function newestIntent(node: SubagentTreeNode): string | undefined {
  const intent = [...node.stages ?? []].reverse().find(stage => stage.intent)?.intent;
  return intent ? flat(intent) : undefined;
}

/**
 * Who an L1 works with, by the messages they exchanged, three or more: a
 * helper, the leads it worked for, the most messages first ("→ a · b"), each
 * in its direction's colour; a lead, the helpers that worked for it
 * ("⇄ x · y"). Two named, the rest counted.
 */
function relationLine(node: SubagentTreeNode, input: MonitorData, state: MonitorState, width: number): string {
  const dirs = directions(input.tree);
  const name = (other: SubagentTreeNode) => monitorText(agentTitle(other,state.labelAsName).name);
  const leads = (other: SubagentTreeNode) => subtasks(other).length > 0;
  const ranked = (pick: (other: SubagentTreeNode) => boolean) => input.tree.nodes
    .filter(other => other.id !== node.id && !isGuardian(other) && pick(other))
    .map(other => [other,talk(node,other)] as const).filter(([,count]) => count >= TALK_MIN)
    .sort((a,b) => b[1]-a[1]).map(([other]) => other);
  const list = (items: SubagentTreeNode[], lead: string, paint: (other: SubagentTreeNode) => string) => {
    for (let shown = Math.min(2,items.length); shown >= 1; shown--) {
      const more = items.length-shown;
      const text = colors.dim(lead)+items.slice(0,shown).map(paint).join(colors.dim(' · '))+(more ? colors.dim(` +${more}`) : '');
      if (visualLength(text) <= width || shown === 1) return truncateAnsi(text,width);
    }
    return '';
  };
  return leads(node) ? list(ranked(other => !leads(other)),'⇄ ',other => colors.dim(name(other)))
    : list(ranked(leads),'→ ',other => dirs.paint(other.id)(name(other)));
}

/** What a running agent is doing this moment, its open tool call, labelled as the brief labels "now". */
function actionLine(node: SubagentTreeNode, width: number): string {
  if (!isLive(node) || !node.action?.text.trim()) return '';
  const column = labelColumn(['now']);
  return `${fieldLabel('now',column)} ${truncateAnsi(monitorText(node.action.text.replace(/\s+/g,' ').trim()),Math.max(1,width-column-1))}`;
}

/**
 * An L1's subtasks that get a line on its card: failed, in a role the reader
 * named, or flagged, and a guardian review that failed; failures first, then
 * the newest.
 */
function importantKids(node: SubagentTreeNode, input: MonitorData, state: MonitorState): SubagentTreeNode[] {
  const roles = state.importantRoles ?? new Set<string>();
  const at = (kid: SubagentTreeNode) => isLive(kid) ? Infinity : finishedAt(kid)?.getTime() ?? 0;
  return node.children.filter(kid => isGuardian(kid) ? kid.status === 'error' : isImportant(kid,input.agentLog?.get(kid.id),roles))
    .sort((a,b) => Number(b.status === 'error')-Number(a.status === 'error') || at(b)-at(a));
}

/**
 * A subtask's line on its lead's card: its status, its name, what it
 * returned or, failed, why (a model's reading, marked), and its time at the
 * right: its clock while it runs, else how long ago it finished. A click
 * selects it, for the Inspector.
 */
function kidLine(kid: SubagentTreeNode, input: MonitorData, state: MonitorState, width: number, now: number): string {
  const st = nodeStatus(kid,now);
  const live = isLive(kid);
  const start = (kid.turnStartedAt ?? kid.startedAt)?.getTime();
  const at = settledAt(kid);
  const when = live ? start !== undefined && Number.isFinite(start) ? `${stripAnsi(turnClock(kid,now))}${clockText(now-start)}` : '' : at ? age(at,now) : '';
  const right = live ? theme.info(when) : colors.dim(when);
  const head = `${kid.id === state.tree.selectedId ? theme.accent('›') : ''}${st.paint(st.icon)} `;
  const log = input.agentLog?.get(kid.id) ?? [];
  const cause = kid.status === 'error' ? [...log].reverse().find(entry => entry.kind === 'cause' && entry.text.trim())?.text : undefined;
  const result = [...kid.stages ?? []].reverse().find(stage => stage.status !== 'running' && stage.result)?.result;
  const said = cause ? `~ ${flat(cause)}` : flat(result ?? kid.digest ?? kid.lastReport?.text ?? '');
  const room = Math.max(1,width-visualLength(head)-(when ? visualLength(when)+1 : 0));
  const name = squeeze(monitorText(agentTitle(kid,state.labelAsName).name),room);
  const named = directions(input.tree).paint(kid.id)(name);
  const left = `${head}${named}${said && visualLength(name)+2 < room ? ` ${colors.dim(said)}` : ''}`;
  return pair(left,right,width);
}

/**
 * The agents an L1 started, counted by role, the most first: "5 implementer
 * · 3 reviewer · 1 general" (Codex's default agent is "general"). A count is
 * in the running colour while one of its agents runs. As many roles as fit,
 * then "+N" for the agents of the rest.
 */
function roleLine(node: SubagentTreeNode, tree: SubagentTree, width: number): string {
  const kids = subtasks(node);
  if (!kids.length) return '';
  const prefix = rolePrefix(tree);
  const roles = new Map<string, {count: number; live: boolean}>();
  for (const kid of kids) {
    const role = !kid.role || kid.role === 'default' ? t('general')
      : monitorText(prefix && kid.role.startsWith(prefix) && kid.role.length > prefix.length ? kid.role.slice(prefix.length) : kid.role);
    const known = roles.get(role) ?? {count:0,live:false};
    roles.set(role,{count:known.count+1,live:known.live || isLive(kid)});
  }
  const ranked = [...roles].sort((a,b) => b[1].count-a[1].count || a[0].localeCompare(b[0]));
  const parts = ranked.map(([role,{count,live}]) => `${(live ? theme.info : colors.dim)(String(count))} ${colors.dim(role)}`);
  for (let shown = parts.length; shown >= 1; shown--) {
    const left = ranked.slice(shown).reduce((sum,[,role]) => sum+role.count,0);
    const text = parts.slice(0,shown).join(colors.dim(' · '))+(left ? colors.dim(` +${left}`) : '');
    if (visualLength(text) <= width || shown === 1) return truncateAnsi(text,width);
  }
  return '';
}

/** A line inside a card, and the agent a click on it selects, where that is not the card's. */
interface BodyLine { text: string; pick?: string }

/**
 * An L1 agent's card. Its top rule names it, in its direction's colour.
 * Closed, the inside says, a line each and each only when there is
 * something to say: what it is for (its task, or what it said it would do),
 * who it works with, what it is doing this moment, the newest note a model
 * wrote about it and its newest update, the subtasks that matter, and the
 * rest of its subtasks counted by role. Opened: the task in two lines, the
 * same lines but every subtask that matters, then its whole timeline, newest
 * first (or, with no log, its last report), then the task in full when the
 * lines at the top did not show all of it.
 */
export function agentCard(row: PanelRow, input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const node = row.node;
  if (isOneLine(node,input,state,now)) return oneLineCard(row,input,state,width,now,{meters:true}).rows;
  const w = width;
  const selected = node.id === state.tree.selectedId;
  const open = state.cards?.has(node.id) ?? false;
  const old = isOld(node,now);
  const paint = cardPaint(node,old,Boolean(row.context),now);
  const st = nodeStatus(node,now);
  const title = agentTitle(node,state.labelAsName);
  const key = `card:${node.id}`;
  const rows: MonitorRow[] = [];
  const control = (x: number, width_: number): RowControl => ({kind:'expand',item:node.id,x,width:width_});
  const [topCorner,bottomCorner] = state.cardCorners === 'round' ? ['╭','╰'] : ['┌','└'];

  // Top rule: who the agent is.
  const corner = selected ? theme.accent('›') : paint(topCorner);
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
  // It is in its direction's colour, the timeline's for the same agents.
  const shownName = colors.underline(name);
  const named = (old || row.context) && !selected ? colors.dim(shownName) : theme.bold(directions(input.tree).paint(node.id)(shownName));
  const top = truncateAnsi(`${head}${named} ${paint('─'.repeat(dashes))}${tail}`,w);
  const nameAt = Math.min(w,visualLength(head));
  rows.push({text:selected ? banded(top,w) : top,item:node.id,key,controls:[
    {kind:'switch',item:node.id,x:nameAt,width:Math.max(0,Math.min(visualLength(name),w-nameAt))},control(0,w)]});

  const inner = Math.max(1,w-2);
  const body: BodyLine[] = [];
  const push = (text: string, pick?: string) => { body.push(pick ? {text,pick} : {text}); };
  const gap = () => { if (spaced && body.length) push(''); };
  // What it is for: a guardian's task is Codex's review prompt, the same
  // boilerplate every time, never shown; an agent whose task the rollout
  // keeps sealed says what it would do, in its newest stage.
  const purpose = isGuardian(node) ? undefined : title.task ?? newestIntent(node);
  // Bold when it is the model's name for the agent, or the task under a label that took the name's place.
  const strong = (line: string) => title.task && (title.renamed || title.original) ? theme.strong(line) : line;
  // The log only when it is asked for (a backend, or the log switch): the
  // panel is not a transcript unless the reader chose one.
  const log = input.agentLog?.get(node.id) ?? [];
  const task = !open || !purpose ? {lines:[],clipped:Boolean(purpose)} : title.task ? taskLines(title,inner) : clipLines(flowLines(purpose,inner),2,inner);
  // Who it works with and what it is doing this moment.
  const doing = () => {
    const relation = relationLine(node,input,state,inner);
    if (relation) push(relation);
    const action = actionLine(node,inner);
    if (action) push(action);
  };
  // The subtasks that matter, a line each, and the rest counted by role.
  const kids = (all: boolean) => {
    const important = importantKids(node,input,state);
    const named = all ? important : important.slice(0,KIDS_SHOWN);
    for (const kid of named) push(kidLine(kid,input,state,inner,now),kid.id);
    if (named.length < important.length) push(colors.dim(t('+{n} more',{n:important.length-named.length})));
    const roles = state.roleCounts === false ? '' : roleLine(node,input.tree,inner);
    if (roles) push(roles);
  };
  if (!open) {
    const news = agentNews(log);
    if (purpose) push(strong(truncateAnsi(purpose,inner)));
    doing();
    if (news.note) push(colors.dim('~ ')+truncateAnsi(news.note,inner-2));
    if (news.update) push(truncateAnsi(news.update,inner));
    kids(false);
  } else {
    for (const line of task.lines) push(strong(line));
    // The label took the name's place: Codex's own name stays in view here.
    if (title.original) push(colors.dim(truncateAnsi(t('name {name}',{name:title.original}),inner)));
    doing();
    kids(true);
    const settled = settledAt(node);
    const ruleAge = settled && !isLive(node) ? age(settled,now) : undefined;
    // Opened, the whole timeline stands in for the newest news.
    const timeline: string[] = [];
    let shown = 0;
    for (const entry of [...log].reverse()) {
      const lines = cardEntryLines(entry,inner,now,Infinity,ruleAge);
      if (timeline.length+lines.length > TIMELINE_LINES) break;
      timeline.push(...lines); shown++;
    }
    if (timeline.length || log.length) { gap(); for (const line of timeline) push(line); }
    else if (node.lastReport?.text.trim()) {
      // No log kept: what the Inspector calls the latest update, cut like an entry.
      gap();
      for (const line of clipLines(hangLines(monitorText(plainText(node.lastReport.text.replace(/\s+/g,' ').trim())),inner,inner),REPORT_LINES,inner).lines) push(line);
    }
    if (shown < log.length) push(colors.dim(truncateAnsi(t('… {n} earlier — Inspector',{n:log.length-shown}),inner)));
    // The task in full, when the line at the top was the model's name for it or a cut.
    const full = node.task?.replace(/\s+/g,' ').trim();
    if (full && !isGuardian(node) && (title.renamed || task.clipped)) {
      gap();
      push(colors.dim(t('Task')));
      for (const line of clipLines(flowLines(monitorText(full),inner),TASK_TEXT_LINES,inner).lines) push(line);
    }
  }
  // Old news reads as old news: its words step back with its name.
  for (const line of body) {
    const text = old ? colors.dim(stripAnsi(line.text)) : line.text;
    rows.push({text:text ? `${paint('│')} ${truncateAnsi(text,inner)}` : paint('│'),item:node.id,key,
      ...(line.pick ? {controls:[{kind:'log' as const,item:line.pick,x:0,width:w}]} : {})});
  }

  // Bottom rule: how long, how full, and the switch that opens the card.
  const left = cardTime(node,now);
  const toggle = colors.dim(open ? '▴' : '▾');
  // The rule's gap is the agent's context meter; short of room the meter
  // gives way to its reading, then the time is cut. Without context data the
  // gap is plain rule.
  const meter = contextMeter(node);
  const foot = `${paint(bottomCorner)} ${left ? left+' ' : ''}`;
  const rest = Math.max(0,w-2-visualLength(foot));
  const rule = meter ? meterRow(w-2,foot,'',meter) : foot+paint('─'.repeat(rest));
  const bottom = rule && visualLength(foot) < w-2 ? `${rule} ${toggle}`
    : truncateAnsi(`${paint(bottomCorner)} ${truncateAnsi(left,Math.max(0,w-5))} ${toggle}`,w);
  rows.push({text:bottom,item:node.id,key,controls:[control(visualLength(stripAnsi(bottom))-1,1)]});
  return rows;
}

/** Lines of an opened card's last report, when it has no log to show. */
const REPORT_LINES = 8;

/**
 * Rich: the agents view, a list of cards and nothing else, one for each L1
 * agent: the subtasks an L1 started are its card's to count and, the ones
 * that matter, to name. The summary line heads it and stays put; under it
 * scroll the cards, in the tree's order, under its filter and linger window.
 * The main session's brief is the status card's, at the foot. `spaced` puts
 * a blank line between cards; the one-line rows of finished agents sit
 * together, as a list.
 */
export function richRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const {row:head} = summaryRow(input,state,width,now);
  const rows: MonitorRow[] = [head];
  let lastOneLine = false;
  const shown = listedAgents(input.tree.nodes,state,now);
  const oneLine = new Set(shown.filter(row=>isOneLine(row.node,input,state,now)));
  const meters = oneLineMeters([...oneLine],state,width,now);
  // The age of the one-line row above; a card between two runs ends the first.
  let previousAge: string | undefined;
  for (const row of shown) {
    const single = oneLine.has(row);
    if (spaced && rows.at(-1)?.text !== '' && !(single && lastOneLine)) rows.push({text:''});
    if (single) {
      const drawn = oneLineCard(row,input,state,width,now,{meters,previousAge});
      rows.push(...drawn.rows);
      previousAge = drawn.age;
    } else {
      rows.push(...agentCard(row,input,state,width,now,spaced));
      previousAge = undefined;
    }
    lastOneLine = single;
  }
  // No agent to show: no line saying so. The counts above, the bar's +N and
  // the status card already do.
  return rows;
}
