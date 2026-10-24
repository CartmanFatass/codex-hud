/** Pure rich-card rendering: every listed L1 uses the same layout, at work or at rest.
 * Cards hold model-written summaries, never raw tasks, reports or history.
 */
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { defaultCardVisibility, type CardVisibility } from '../card-visibility.js';
import { summarySentence } from '../utils/summary-sentence.js';
import type { Brief } from '../collectors/briefing.js';
import { progressReason } from '../collectors/progress-summary.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import { isGuardian, type PanelRow } from './panel-state.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { displayConfig, iconSet } from './hud-config.js';
import { t, language } from './i18n.js';
import { palette } from './palette.js';
import { agentTitle, type AgentTitle } from './agent-title.js';
import {
  type MonitorData, type MonitorState, type MonitorRow, type RowControl,
  monitorText, plainText, flowLines, pair, age, agoText, nodeStatus, iconic, briefSaid, isLive, isQuiet, turnClock, squeeze, finishedAt,
  summaryRow, guardianChip, meterRow, listedAgents, paneShown, type EdgeMeter,
  MODEL_LOG_KINDS, FRESH_FINISH_MS, agentRate, rateText,
} from './monitor.js';
import { directions, subtasks, reviewsUnder, talk, isImportant, rolePrefix, TALK_MIN } from './directions.js';

/** The fewest columns a subtask's digest or cause starts with beside its name; less, it starts on the next line. */
const KID_SAID_BESIDE = 8;
/** Narrower than this, a card gives up its model badge; narrower still, its meter. */
const BADGE_MIN = 24;


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

/** The model's notes about an agent (its notes, result digests and failure causes), newest first. */
export function modelNotes(log: readonly AgentLogEntry[]): AgentLogEntry[] {
  return log.filter(entry => MODEL_LOG_KINDS.has(entry.kind) && entry.text.trim()).reverse();
}

/**
 * The one line under a resting agent's row: the newest note the model wrote
 * about it, plain text, uncut; empty when there is none. Its updates and its
 * task are the Inspector's.
 */
export function briefLine(log: readonly AgentLogEntry[]): string {
  const note = modelNotes(log)[0];
  return note ? monitorText(plainText(note.text).replace(/\s+/g,' ').trim()) : '';
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
 * The agent's context as a meter. It keeps its zone colour once the card is
 * old news: a grey meter on a grey row could not be told from its track,
 * and the name dimming says the news is old.
 */
function contextMeter(node: SubagentTreeNode): EdgeMeter | undefined {
  const ctx = node.contextUsage;
  return ctx ? {percent:ctx.percent} : undefined;
}

/** The selected header's own surface. */
function banded(text: string, width: number): string {
  return theme.selectedBand(text+' '.repeat(Math.max(0,width-visualLength(text))));
}

/** Defaults remain useful to callers constructing state without settings. */
function visibility(state: MonitorState): CardVisibility {
  return {...defaultCardVisibility(), ...state.cardVisibility};
}

/** Request state is collected elsewhere; keep the previous words visible while it changes. */
function progressLines(node: SubagentTreeNode, input: MonitorData, width: number): string[] {
  const request = input.progress?.get(node.id);
  if (!request || input.progressContext && progressReason(node,input.progressContext)) return [];
  const text = request.reason === 'hourly-cap' ? t('Progress summary hourly cap')
    : request.reason === 'concurrency-cap' ? t('Progress summary concurrency cap')
    : request.phase === 'queued' ? t('Progress summary queued…')
    : request.running ? t('Writing progress summary…')
    : request.error ? t('Progress summary failed') : '';
  const warning = request.error || request.reason === 'hourly-cap' || request.reason === 'concurrency-cap';
  return text ? clipLines(flowLines(text,width),2,width).lines.map(line => (warning ? theme.warning : colors.dim)(line)) : [];
}

const flat = (text: string) => monitorText(plainText(text).replace(/\s+/g,' ').trim());

/**
 * What an agent said it would do in its newest stage that said so: the
 * stand-in for a task the rollout keeps sealed.
 */
export function newestIntent(node: SubagentTreeNode): string | undefined {
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
  const name = (other: SubagentTreeNode) => agentTitle(other,visibility(state).cardLabel && state.labelAsName).name;
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

/** The same descendant selection drives both rendering and progress requests. */
function shownKids(node: SubagentTreeNode, input: Pick<MonitorData,'agentLog'>, state: MonitorState): SubagentTreeNode[] {
  const v = visibility(state);
  if (!v.cardSubagents) return [];
  const roles = state.importantRoles ?? new Set<string>();
  const at = (kid: SubagentTreeNode) => isLive(kid) ? Infinity : finishedAt(kid)?.getTime() ?? 0;
  return [...subtasks(node),...reviewsUnder(node)]
    .filter(kid => v.cardSubagentScope === 'all' || isLive(kid)
      || v.cardSubagentScope === 'important' && isImportant(kid,input.agentLog?.get(kid.id),roles))
    .sort((a,b) => Number(b.status === 'error')-Number(a.status === 'error') || at(b)-at(a));
}

/** IDs whose summaries can appear; collection owns the running/model/privacy gates. */
export function cardSummaryTargets(input: Pick<MonitorData,'tree'|'agentLog'>, state: MonitorState, now: number): Set<string> {
  const targets = new Set<string>();
  if (state.style !== 'rich' || state.help || !paneShown(state,'agents')
    || state.zoom && !state.tabbed && state.focus !== 'agents') return targets;
  const v = visibility(state);
  for (const row of listedAgents(input.tree.nodes,state,now)) {
    if (v.cardSummary) targets.add(row.node.id);
    if (v.cardSubagentSummary) for (const kid of shownKids(row.node,input,state)) targets.add(kid.id);
  }
  return targets;
}

/**
 * One meaningful model sentence, bounded defensively, not a digest's basis or
 * caveats. A digest is written on one line, its conclusion and the model's
 * evidence joined by " · " (digestText); its basis and caveats are the
 * Inspector's. Drop labelled evidence segments while preserving a middle dot
 * used inside ordinary prose, just as for labelled lines in a multi-line note.
 */
export function cardSentence(text: string): string {
  const plain = plainText(text);
  const lines = plain.split(/\r?\n/).map(line => line.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/,''));
  const line = lines.find(line => line && !/^(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)(?:\s*[:：]|$)/i.test(line));
  if (!line) return '';
  const meaningful = line.replace(/^(?:summary|digest|result|摘要|总结|结果)\s*[:：]\s*/i,'');
  return monitorText(summarySentence(meaningful.split(/\s+·\s+(?=(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)\s*[:：])/i)[0].trim() || meaningful));
}

/** Child identity/status always stay; its one model sentence wraps beside/under the name. */
function kidLines(kid: SubagentTreeNode, input: MonitorData, state: MonitorState, width: number, now: number): string[] {
  const v = visibility(state);
  const st = nodeStatus(kid,now);
  const live = isLive(kid);
  const start = (kid.turnStartedAt ?? kid.startedAt)?.getTime();
  const at = settledAt(kid);
  const clock = live ? start !== undefined && Number.isFinite(start) ? `${stripAnsi(turnClock(kid,now))}${clockText(now-start)}` : '' : at ? age(at,now) : '';
  const when = v.cardClock ? clock : '';
  const right = when ? (live ? theme.info(when) : colors.dim(when)) : '';
  const head = `${kid.id === state.tree.selectedId ? theme.accent('›') : ''}${st.paint(st.icon)} `;
  const log = input.agentLog?.get(kid.id) ?? [];
  const newest = (kind: AgentLogEntry['kind']) => [...log].reverse().find(entry => entry.kind === kind && entry.text.trim())?.text;
  // Active work must never fall back to a stale digest or failure cause.
  const raw = live ? newest('note') : kid.status === 'error' ? newest('cause') ?? newest('note')
    : kid.digest ?? newest('digest') ?? newest('note');
  const said = v.cardSubagentSummary && raw ? cardSentence(raw) : '';
  const room = Math.max(1,width-visualLength(head)-(when ? visualLength(when)+1 : 0));
  const name = squeeze(agentTitle(kid,v.cardLabel && state.labelAsName).name,room);
  const named = directions(input.tree).paint(kid.id)(name);
  const indent = visualLength(head);
  const beside = room-visualLength(name)-1;
  const rest = Math.max(1,width-indent);
  const words = !said ? [] : beside >= KID_SAID_BESIDE ? hangLines(said,beside,rest) : ['',...flowLines(said,rest)];
  const one = words[0] ? ` ${colors.dim(words[0])}` : '';
  return [pair(`${head}${named}${one}`,right,width),...words.slice(1).map(line => ' '.repeat(indent)+colors.dim(line)),
    ...(v.cardSubagentSummary ? progressLines(kid,input,rest).map(line => ' '.repeat(indent)+line) : [])];
}

/**
 * An L1's subtasks, at any depth, counted by role, the most first: "5
 * implementer · 3 reviewer · 1 general" (Codex's default agent is
 * "general"). A count is in the running colour while one of its subtasks
 * runs. As many roles as fit, then "+N" for the subtasks of the rest.
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

/** Every L1 uses this layout, with independently composable contents. */
export function agentCard(row: PanelRow, input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  const node = row.node;
  const v = visibility(state);
  const w = width;
  const selected = node.id === state.tree.selectedId;
  const old = isOld(node,now);
  const paint = cardPaint(node,old,Boolean(row.context),now);
  const st = nodeStatus(node,now);
  const title = agentTitle(node,v.cardLabel && state.labelAsName);
  const key = `card:${node.id}`;
  const rows: MonitorRow[] = [];
  const control: RowControl = {kind:'log',item:node.id,x:0,width:w};
  const [topCorner,bottomCorner] = state.cardCorners === 'round' ? ['╭','╰'] : ['┌','└'];

  const corner = selected ? theme.accent('›') : paint(topCorner);
  const token = !v.cardModel || w < BADGE_MIN ? '' : renderModelEffortToken(node.model ? monitorText(node.model) : undefined, node.effort ? monitorText(node.effort) : undefined, {
    mode: w < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs,
  });
  const badge = token ? truncateAnsi(token,Math.max(2,Math.floor(w/4))) : '';
  const head = `${corner} ${st.paint(st.icon)} ${v.cardLabel && title.icon ? colors.dim(title.icon)+' ' : ''}`;
  const chip = v.cardReviews ? guardianChip(reviewsUnder(node)) : '';
  // Identity survives: optional fields give way before squeezing the name.
  let tails = [chip,badge].filter(Boolean);
  while (tails.length && w-visualLength(head)-visualLength(tails.join(' '))-3 < Math.min(8,visualLength(title.name))) tails.pop();
  const tail = tails.map(part=>' '+part).join('');
  const room = Math.max(1,w-visualLength(head)-visualLength(tail)-2);
  const name = squeeze(title.name,room);
  const dashes = Math.max(0,w-visualLength(head)-visualLength(name)-1-visualLength(tail));
  const link = input.linkNames !== false;
  const shownName = link ? colors.underline(name) : name;
  const named = (old || row.context) && !selected ? colors.dim(shownName) : theme.bold(directions(input.tree).paint(node.id)(shownName));
  const top = truncateAnsi(`${head}${named} ${paint('─'.repeat(dashes))}${tail}`,w);
  const nameAt = Math.min(w,visualLength(head));
  const nameControl: RowControl[] = link ? [{kind:'switch',item:node.id,x:nameAt,width:Math.max(0,Math.min(visualLength(name),w-nameAt))}] : [];
  rows.push({text:selected ? banded(top,w) : top,item:node.id,key,controls:[...nameControl,control]});

  const inner = Math.max(1,w-2);
  const body: BodyLine[] = [];
  const push = (text: string, pick?: string) => { body.push(pick ? {text,pick} : {text}); };
  if (v.cardLabel && title.renamed && title.task) for (const line of flowLines(title.task,inner)) push(theme.strong(line));
  if (v.cardOriginalName && title.original) for (const line of flowLines(t('name {name}',{name:title.original}),inner)) push(colors.dim(line));
  if (v.cardRelations) {
    const relation = relationLine(node,input,state,inner);
    if (relation) push(relation);
  }
  if (v.cardSummary) {
    const line = briefLine(input.agentLog?.get(node.id) ?? []);
    if (line) for (const text of flowLines(line,inner)) push(colors.dim(text));
    for (const text of progressLines(node,input,inner)) push(text);
  }
  if (v.cardAction) {
    const action = actionLine(node,inner);
    if (action) push(action);
  }
  for (const kid of shownKids(node,input,state)) for (const line of kidLines(kid,input,state,inner,now)) push(line,kid.id);
  if (v.cardRoleCounts) {
    const roles = roleLine(node,input.tree,inner);
    if (roles) push(roles);
  }
  for (const line of body) {
    const text = old ? colors.dim(stripAnsi(line.text)) : line.text;
    const controls: RowControl[] = [{kind:'log',item:line.pick ?? node.id,x:0,width:w}];
    rows.push({text:text ? `${paint('│')} ${truncateAnsi(text,inner)}` : paint('│'),item:node.id,key,controls});
  }

  const left = v.cardClock ? cardTime(node,now) : '';
  const meter = v.cardContext ? contextMeter(node) : undefined;
  const rate = v.cardRate ? agentRate(node,now) : undefined;
  const speed = rate === undefined ? '' : colors.dim(`${left ? '· ' : ''}${rateText(rate)}`);
  const footerPaint = !v.cardClock && !v.cardRate && !v.cardContext ? colors.dim : paint;
  const footOf = (extra: string) => `${footerPaint(bottomCorner)} ${left ? left+' ' : ''}${extra ? extra+' ' : ''}`;
  const foot = speed && visualLength(footOf(speed))+(meter ? RATE_BAR : 0) <= w ? footOf(speed) : footOf('');
  const rule = truncateAnsi(foot,w)+footerPaint('─'.repeat(Math.max(0,w-visualLength(foot))));
  const bottom = meter ? meterRow(w,foot,'',meter) ?? rule : rule;
  rows.push({text:truncateAnsi(bottom,w),item:node.id,key,controls:[control]});
  return rows;
}

/** Columns of meter the bottom rule keeps before the rate beside the clock gives way. */
const RATE_BAR = 12;

/**
 * Rich: the agents view, a list of cards and nothing else, one for each L1
 * agent: an L1's subtasks, at any depth, are its card's to count and, the
 * ones that matter, to name. The summary line heads it and stays put; under it
 * scroll the cards, in the tree's order, under its filter and linger window.
 * The main session's brief is the status card's, at the foot. `spaced` puts
 * a blank line between cards.
 */
/** A second under a minute, else the coarser bucket `age()` prints. Live text includes the wall second. */
function textBucket(at: number | undefined, now: number): string | null {
  if (at === undefined || !Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `s${Math.floor(now / 1000)}`;
  if (seconds < 3600) return `m${Math.floor(seconds / 60)}`;
  if (seconds < 2 * 86_400) return `h${Math.floor(seconds / 3600)}`;
  return `d${Math.floor(seconds / 86_400)}`;
}

/**
 * The card's own share of `now`: the whole second while its clock counts
 * seconds (the running clock's digits, a rate crossing its freshness window,
 * quiet turning yellow), else nothing — a resting card's ages step at the
 * buckets `textBucket` already keeps, so its cache entry survives the second.
 */
function cardNow(node: SubagentTreeNode, state: MonitorState, now: number): number | null {
  if (!visibility(state).cardClock) return null;
  // Any live thread under the card, itself or a child, keeps a clock counting.
  const live = (current: SubagentTreeNode): boolean => isLive(current) || current.children.some(live);
  return live(node) ? Math.floor(now / 1000) : null;
}

/** What a card says, without the wall second of a clock that is not on it. */
function nodeStamp(node: SubagentTreeNode, now: number): unknown {
  return [
    node.id, node.status, node.name, node.nickname, node.agentPath, node.role, node.kind,
    node.model, node.effort, node.label, node.taskKind, node.digest, node.task, node.charge ?? null,
    node.action?.text ?? null, node.contextUsage ?? null, node.outputRate ?? null, agentRate(node, now) ?? null,
    node.peers ?? null, node.stageCount ?? null, node.lastReport ?? null,
    textBucket(node.startedAt?.getTime(), now), textBucket(node.turnStartedAt?.getTime(), now),
    textBucket(node.statusAt?.getTime(), now), textBucket(node.lastEventAt?.getTime(), now),
    node.children.map(child => nodeStamp(child, now)),
  ];
}

/** Names, colours and who talks to whom. Absolute times: a ticking clock does not change them. */
function treeIdentity(nodes: readonly SubagentTreeNode[]): unknown {
  const walk = (node: SubagentTreeNode): unknown => [
    node.id, node.status, node.name, node.label, node.nickname, node.agentPath, node.role, node.kind,
    node.startedAt?.getTime() ?? null, finishedAt(node)?.getTime() ?? null, node.peers ?? null,
    node.children.map(walk),
  ];
  return nodes.map(walk);
}

/** A log as the card reads it: the lead's own, and each subtask's flag and cause. */
function logStamp(id: string, input: MonitorData, now: number): unknown {
  return (input.agentLog?.get(id) ?? []).map(entry => [entry.kind, entry.text, entry.attention ?? false, entry.lang ?? '', entry.label ?? '', entry.taskKind ?? '', textBucket(entry.at, now)]);
}

function subtreeLogs(node: SubagentTreeNode, input: MonitorData, now: number): unknown {
  return [logStamp(node.id, input, now), input.progress?.get(node.id) ?? null, node.children.map(child => subtreeLogs(child, input, now))];
}

/** This card, or a subtask named on it. Another card's selection leaves the key alone. */
function selectedHere(node: SubagentTreeNode, selectedId: string | null | undefined): string | null {
  if (!selectedId) return null;
  const holds = (current: SubagentTreeNode): boolean => current.id === selectedId || current.children.some(holds);
  return holds(node) ? selectedId : null;
}

const CARD_CACHE_LIMIT = 500;
const cardCache = new Map<string, {rows: MonitorRow[]}>();
let cardCacheContext: string | undefined;

export function richRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const {row:head} = summaryRow(input,now);
  const rows: MonitorRow[] = [head];
  const shown = listedAgents(input.tree.nodes,state,now);
  const shared = JSON.stringify([
    language(), palette().name, iconSet(), displayConfig(), input.linkNames !== false,
    treeIdentity(input.tree.nodes), width, spaced,
    input.progressContext ? [input.progressContext.backendOn,input.progressContext.paused,input.progressContext.enabled,[...input.progressContext.targets].sort()] : null,
    visibility(state), state.cardCorners ?? null, state.labelAsName ?? null,
    state.importantRoles ? [...state.importantRoles].sort() : [],
  ]);
  // Keep session-wide identity outside every per-card map key. Prefixing
  // hundreds of keys with the same large tree description makes V8's string
  // map operations dominate rendering (and duplicates that text in memory).
  // All previous shared inputs still invalidate the cache as one context.
  if (shared !== cardCacheContext) {
    cardCache.clear();
    cardCacheContext = shared;
  }
  for (const row of shown) {
    if (spaced && rows.at(-1)?.text !== '') rows.push({text:''});
    const node = row.node;
    const key = JSON.stringify([
      nodeStamp(node, now), cardNow(node, state, now), Boolean(row.context),
      selectedHere(node, state.tree.selectedId), subtreeLogs(node, input, now),
    ]);
    let drawn = cardCache.get(key);
    if (!drawn) {
      drawn = {rows: agentCard(row, input, state, width, now)};
      if (cardCache.size >= CARD_CACHE_LIMIT) cardCache.delete(cardCache.keys().next().value!);
      cardCache.set(key, drawn);
    }
    rows.push(...drawn.rows);
  }
  // No agent to show: no line saying so. The counts above, the bar's +N and
  // the status card already do.
  return rows;
}
