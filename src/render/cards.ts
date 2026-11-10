import type { SubagentTreeNode } from '../types.js';
import { buildWorkboard } from '../collectors/workboard.js';
import { nativeWorker, projectWorkCard } from '../collectors/work-card.js';
import { renderWorkCard, workCardName } from './work-card.js';
import { boardCursor } from './workboard-rows.js';
import { defaultCardVisibility, type CardVisibility } from '../card-visibility.js';
import { summarySentence } from '../utils/summary-sentence.js';
import type { Brief } from '../collectors/briefing.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import type { PanelRow } from './panel-state.js';
import { theme, colors, visualLength, stripAnsi } from './colors.js';
import { t } from './i18n.js';
import type { AgentTitle } from './agent-title.js';
import {
  type MonitorData,
  type MonitorState,
  type MonitorRow,
  monitorText,
  plainText,
  flowLines,
  iconic,
  briefSaid,
  isLive,
  finishedAt,
  summaryRow,
  emptyAgentsRows,
  listedAgents,
  paneShown,
  MODEL_LOG_KINDS,
} from './monitor.js';
import { facadeOnly, effectiveStatus, jobFlagged } from './job-details.js';
import { subtasks, reviewsUnder, isImportant } from './directions.js';

type Paint = (s: string) => string;
const plain: Paint = (s) => s;

/** `lines` cut to `max`, the last one ending in " …" within `width`, when there were more. */
export function clipLines(lines: string[], max: number, width: number): { lines: string[]; clipped: boolean } {
  if (lines.length <= max) return { lines, clipped: false };
  const shown = lines.slice(0, max);
  let last = [...shown[max - 1]];
  while (last.length && visualLength(`${last.join('')} …`) > width) last = last.slice(0, -1);
  shown[max - 1] = `${last.join('').trimEnd()} …`;
  return { lines: shown, clipped: true };
}

/**
 * Wrap with a hanging indent: the first line `first` wide, the others `rest`
 * wide, so a lead mark or label keeps its column and the text hangs under
 * the text. Takes sanitized text; returns the lines unindented.
 */
export function hangLines(text: string, first: number, rest: number): string[] {
  const head = flowLines(text, Math.max(1, first))[0];
  if (head === undefined) return [];
  // The first line holds the text's first characters, spaces aside: skip as
  // many and wrap what is left at the other width.
  let need = [...head].filter((ch) => !/\s/.test(ch)).length;
  let at = 0;
  const chars = [...text];
  while (at < chars.length && need > 0) {
    if (!/\s/.test(chars[at])) need--;
    at++;
  }
  const remainder = chars.slice(at).join('').trim();
  return [head, ...(remainder ? flowLines(remainder, Math.max(1, rest)) : [])];
}

/**
 * What an agent is for, under the name that identifies it: the model's name
 * for it, or else the task it was given, cut to `max` lines.
 */
export function taskLines(title: AgentTitle, width: number, max = 2): { lines: string[]; clipped: boolean } {
  if (!title.task) return { lines: [], clipped: false };
  return clipLines(flowLines(title.task, width), max, width);
}

/** Which part of the brief a block of lines is. */
export type BriefFieldId = 'approval' | 'needs' | 'goal' | 'now' | 'done' | 'said';
export interface BriefField {
  id: BriefFieldId;
  lines: string[];
}
/**
 * How much of the brief is drawn: the lines one value gets before it is cut,
 * and how many done items show, the newest (the rest are counted).
 */
export interface BriefShape {
  fieldLines: number;
  doneShown: number;
}
/** The brief as it usually is: two lines a value, the newest two done items. */
const BRIEF_SHAPE: BriefShape = { fieldLines: 2, doneShown: 2 };
/**
 * The brief's labels: an icon each where icons stand in for words, else the
 * word. The words share one column, padded to the widest, so 已完成 and 目标
 * line up; an icon is a column already.
 */
const FIELD_WORDS: Record<Exclude<BriefFieldId, 'said'>, string> = {
  approval: 'Approve',
  needs: 'Needs',
  goal: 'Goal',
  now: 'Now',
  done: 'Done',
};
const FIELD_ICONS: Record<Exclude<BriefFieldId, 'said'>, string> = {
  approval: '⚑',
  needs: '!',
  goal: '◎',
  now: '▸',
  done: '✓',
};
/** The label column for the fields shown: the widest of their words, so a card without an approval is not padded for one. */
function labelColumn(ids: ReadonlyArray<Exclude<BriefFieldId, 'said'>>): number {
  return iconic() ? 1 : Math.max(1, ...ids.map((id) => visualLength(t(FIELD_WORDS[id]))));
}
function fieldLabel(id: Exclude<BriefFieldId, 'said'>, column: number): string {
  const text = iconic() ? FIELD_ICONS[id] : t(FIELD_WORDS[id]);
  const paint =
    id === 'needs' || id === 'approval'
      ? theme.warning
      : id === 'done' && iconic()
        ? theme.success
        : id === 'now' && iconic()
          ? theme.info
          : colors.dim;
  return paint(text) + ' '.repeat(Math.max(0, column - visualLength(text)));
}

/**
 * One field: its label in the label column, the value after it, wrapped
 * with its lines hanging under the value and cut after `max`.
 */
function inlineField(
  id: Exclude<BriefFieldId, 'said'>,
  value: string,
  width: number,
  column: number,
  paint: Paint = plain,
  max = BRIEF_SHAPE.fieldLines
): BriefField {
  const room = Math.max(1, width - column - 1);
  const lines = clipLines(flowLines(monitorText(value), room), max, room).lines;
  return {
    id,
    lines: lines.map((line, i) => (i ? ' '.repeat(column + 1) : fieldLabel(id, column) + ' ') + paint(line)),
  };
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
  const more = done.length - items.length;
  const suffix = more ? ` +${more}` : '';
  const mark = iconic() ? '' : `${theme.success('✓')} `;
  const lead = visualLength(stripAnsi(mark));
  const room = Math.max(1, width - column - 1 - lead);
  const lines: string[] = [];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    // The last item's last line leaves room for the count, so it never wraps
    // alone; the lines before it are filled to the full width.
    let flowed = flowLines(monitorText(item), room);
    const tail = flowed.at(-1) ?? '';
    if (last && suffix && visualLength(tail) + suffix.length > room)
      flowed = [...flowed.slice(0, -1), ...flowLines(tail, Math.max(1, room - suffix.length))];
    const wrapped = clipLines(flowed, shape.fieldLines, room - (last ? suffix.length : 0)).lines;
    wrapped.forEach((line, i) => {
      const label = !index && !i ? fieldLabel('done', column) + ' ' : ' '.repeat(column + 1);
      lines.push(
        label +
          (i ? ' '.repeat(lead) : mark) +
          line +
          (last && i === wrapped.length - 1 && suffix ? colors.dim(suffix) : '')
      );
    });
  });
  return { id: 'done', lines };
}

function recapIds(recap: NonNullable<Brief['recap']>): Array<Exclude<BriefFieldId, 'said'>> {
  return [...(recap.needs ? ['needs' as const] : []), 'goal', 'now', ...(recap.done.length ? ['done' as const] : [])];
}

/**
 * The recap's fields, each on its own lines with its label inline: what it
 * needs from the person (in the warning colour, absent when empty), the goal
 * (strong), where it stands, and what is done. No blank lines between them:
 * the label column is what sets one field off from the next.
 */
export function recapFields(
  recap: NonNullable<Brief['recap']>,
  width: number,
  column = labelColumn(recapIds(recap)),
  shape = BRIEF_SHAPE
): BriefField[] {
  const fields: BriefField[] = [];
  if (recap.needs) fields.push(inlineField('needs', recap.needs, width, column, theme.warning, shape.fieldLines));
  fields.push(inlineField('goal', recap.goal, width, column, theme.strong, shape.fieldLines));
  fields.push(inlineField('now', recap.now, width, column, plain, shape.fieldLines));
  const done = doneField(recap.done, width, column, shape);
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
  const ids = [
    ...(input.notes?.approval ? ['approval' as const] : []),
    ...(brief?.recap ? recapIds(brief.recap) : brief?.overall ? ['now' as const] : []),
  ];
  const column = labelColumn(ids);
  if (input.notes?.approval)
    fields.push(inlineField('approval', `~ ${input.notes.approval}`, width, column, theme.warning, shape.fieldLines));
  if (brief?.recap) fields.push(...recapFields(brief.recap, width, column, shape));
  else if (brief?.overall) fields.push(inlineField('now', brief.overall, width, column, colors.dim, shape.fieldLines));
  const said = briefSaid(input, width);
  if (said.length) fields.push({ id: 'said', lines: said });
  return fields;
}

/** The order fields give way in when the brief is taller than its room: the last goes first. */
export const BRIEF_KEEP: readonly BriefFieldId[] = ['approval', 'needs', 'said', 'now', 'goal', 'done'];

/** A running turn's length, counting seconds: 42s, 4m07s, 1h04m. */
export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
}

/** The model's notes about an agent (its notes, result digests and failure causes), newest first. */
export function modelNotes(log: readonly AgentLogEntry[]): AgentLogEntry[] {
  return log.filter((entry) => MODEL_LOG_KINDS.has(entry.kind) && entry.text.trim()).reverse();
}

/**
 * The one line under a resting agent's row: the newest note the model wrote
 * about it, plain text, uncut; empty when there is none. Its updates and its
 * task are the Inspector's.
 */
export function briefLine(log: readonly AgentLogEntry[]): string {
  const note = modelNotes(log)[0];
  return note ? monitorText(plainText(note.text).replace(/\s+/g, ' ').trim()) : '';
}

/** Defaults remain useful to callers constructing state without settings. */
function visibility(state: MonitorState): CardVisibility {
  return { ...defaultCardVisibility(), ...state.cardVisibility };
}

const flat = (text: string) => monitorText(plainText(text).replace(/\s+/g, ' ').trim());

/**
 * What an agent said it would do in its newest stage that said so: the
 * stand-in for a task the rollout keeps sealed.
 */
export function newestIntent(node: SubagentTreeNode): string | undefined {
  const intent = [...(node.stages ?? [])].reverse().find((stage) => stage.intent)?.intent;
  return intent ? flat(intent) : undefined;
}

/** Native summary eligibility only: persisted privacy/target gates survive removal of child rendering. */
function shownKids(
  node: SubagentTreeNode,
  input: Pick<MonitorData, 'agentLog'>,
  state: MonitorState
): SubagentTreeNode[] {
  const v = visibility(state);
  if (!v.cardSubagents) return [];
  const roles = state.importantRoles ?? new Set<string>();
  const at = (kid: SubagentTreeNode) => (isLive(kid) ? Infinity : (finishedAt(kid)?.getTime() ?? 0));
  return [...subtasks(node), ...reviewsUnder(node)]
    .filter(
      (kid) =>
        v.cardSubagentScope === 'all' ||
        isLive(kid) ||
        (v.cardSubagentScope === 'important' &&
          (jobFlagged(kid) || isImportant(kid, input.agentLog?.get(kid.id), roles)))
    )
    .sort((a, b) => Number(effectiveStatus(b) === 'error') - Number(effectiveStatus(a) === 'error') || at(b) - at(a));
}

/** IDs whose summaries can appear; collection owns the running/model/privacy gates. */
export function cardSummaryTargets(
  input: Pick<MonitorData, 'tree' | 'agentLog'>,
  state: MonitorState,
  now: number
): Set<string> {
  const targets = new Set<string>();
  if (
    state.style !== 'rich' ||
    state.help ||
    !paneShown(state, 'agents') ||
    (state.zoom && !state.tabbed && state.focus !== 'agents')
  )
    return targets;
  const v = visibility(state);
  for (const row of listedAgents(input.tree.nodes, state, now)) {
    if (v.cardSummary) targets.add(row.node.id);
    if (v.cardSubagentSummary) for (const kid of shownKids(row.node, input, state)) targets.add(kid.id);
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
  const lines = plain.split(/\r?\n/).map((line) => line.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, ''));
  const line = lines.find(
    (line) => line && !/^(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)(?:\s*[:：]|$)/i.test(line)
  );
  if (!line) return '';
  const meaningful = line.replace(/^(?:summary|digest|result|摘要|总结|结果)\s*[:：]\s*/i, '');
  return monitorText(
    summarySentence(
      meaningful.split(/\s+·\s+(?=(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)\s*[:：])/i)[0].trim() ||
        meaningful
    )
  );
}

/** Every L1 uses this layout, with independently composable contents. */
export function agentCard(
  row: PanelRow,
  input: MonitorData,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const worker = row.node.job
    ? buildWorkboard(
        '',
        {
          revision: 0,
          lanes: [],
          coverage: { incomplete: false, diagnostics: [], workspace: null },
          cost: { entries: 0, files: 0, bytes: 0, probes: 0, enumerations: 0, parses: 0, elapsedMs: 0 },
        },
        {
          generation: 0,
          root: null,
          jobs: [row.node.job],
          coverage: { entries: 0, files: 0, bytes: 0, incomplete: false, omitted: 0, diagnostics: [] },
        },
        { ...input.tree, nodes: [row.node] }
      ).workers[0]
    : nativeWorker(row.node);
  const card = projectWorkCard(
    (state.cardVisibility?.cardLabel === false || state.labelAsName === false) && !row.node.job
      ? { ...worker, task: row.node.name }
      : worker,
    now,
    state.cardStallMinutes
  );
  const sentence =
    !facadeOnly(row.node) && visibility(state).cardSummary ? briefLine(input.agentLog?.get(row.node.id) ?? []) : '';
  const link = input.linkNames !== false && !facadeOnly(row.node);
  const rows = renderWorkCard(card, state, width, sentence, false, link);
  const name = workCardName(card, state, width);
  return rows.map((text, i) => ({
    text: i === 0 && state.tree.selectedId === row.node.id ? boardCursor(text) : text,
    item: row.node.id,
    key: `card:${row.node.id}`,
    controls:
      i === 0 && link && name.text
        ? [{ kind: 'switch', item: row.node.id, x: name.x, width: visualLength(name.text) }]
        : [],
  }));
}

/**
 * Fixture-only stacked control layout: one shared compact card per L1.
 * Descendant totals remain in the aggregate heading, not a second rich body. The summary line heads it and stays put; under it
 * scroll the cards, in the tree's order, under its filter and linger window.
 * The main session's brief is the status card's, at the foot. `spaced` puts
 * a blank line between cards.
 */
export function richRows(
  input: MonitorData,
  state: MonitorState,
  width: number,
  now: number,
  spaced: boolean
): MonitorRow[] {
  const rows: MonitorRow[] = [summaryRow(input, now).row];
  for (const row of listedAgents(input.tree.nodes, state, now)) {
    if (spaced && input.height >= 20 && rows.length > 1) rows.push({ text: '' });
    rows.push(...agentCard(row, input, state, width, now));
  }
  rows.push(...emptyAgentsRows(input, width));
  return rows;
}
