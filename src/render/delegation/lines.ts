/**
 * The delegation panel's text lines beyond the row (design §3.4, §3.5, §4.6):
 * the delegation line (who, where, since when), the focus line (what it waits
 * on, what it reported, how it ended) and the top parent row. Each is built
 * from the node projection alone (`projection.ts`), so what a line shows is
 * what the projection cache keys (rulings B10B-s2 Q2, Q3, Q9).
 *
 * A line holds elements, each only when its fact is known; short of room the
 * elements go in a fixed order and the line never wraps. Nothing is read from
 * the legacy panel data and nothing is invented: no brief, no action, no rate.
 */

import { colors, theme, visualLength } from '../colors.js';
import { age } from '../monitor-labels.js';
import { monitorText } from '../monitor-text.js';
import type { LinkRelationProjection } from '../../core/link/types.js';
import { shortRefOf } from './facts.js';
import type { GlyphSet } from './glyphs.js';
import type { DelegationProjection, NodeProjection, PNode } from './projection.js';
import { clip, type Ink } from './rows.js';
import { W, type Role, type Say } from './style.js';

/** One painted piece of a line, and its plain width. */
export interface Segment {
  text: string;
  role: Role;
  /**
   * Short of room, segments with a `shed` rank go before the line is cut, lowest rank first (§0.1 #3: drop a field,
   * then cut text): `exit unknown` 1, a timing note 2, the requested cause 3, a known exit 4, a missing item 5.
   * Absent: kept.
   */
  shed?: number;
}

const SHED_EXIT_UNKNOWN = 1;
const SHED_NOTE = 2;
const SHED_CAUSE = 3;
const SHED_EXIT = 4;
const SHED_MISSING = 5;

/** `pane 4`, or the label as given when it already says `pane`. */
export function paneText(label: string, say: Say): string {
  return /^pane\b/i.test(label) ? label : `${say(W.pane)} ${label}`;
}

/** `14m`, or null for no time or a time that has not happened yet (never an invented age, §3.4). */
export function ageOf(at: number | null, nowMs: number): string | null {
  return at === null || at > nowMs ? null : age(new Date(at), nowMs);
}

const ALIVE_RUN = new Set(['starting', 'running', 'cancelling', 'uncertain']);

/** A path compared as the design asks: normalised, never "same" when unknown. */
function normal(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}
function baseName(path: string): string {
  const parts = normal(path).split('/');
  return parts[parts.length - 1] || '/';
}

/**
 * `in fix-cjk` when the node works somewhere else than the viewpoint root: by the normalised worktree root, else
 * by the normalised working directory (only "a different directory"); `in ?` when neither can be compared (§1
 * "工作目录"; rulings B10B-s2 Q3). '' when they are the same.
 */
export function dirText(node: NodeProjection, root: NodeProjection | null): string {
  const d = node.detail;
  const r = root?.detail;
  if (d.worktreeRoot !== null && r && r.worktreeRoot !== null) {
    if (normal(d.worktreeRoot) === normal(r.worktreeRoot)) return '';
    return d.worktreeName ?? monitorText(baseName(d.worktreeRoot));
  }
  if (d.cwd !== null && r && r.cwd !== null) return normal(d.cwd) === normal(r.cwd) ? '' : monitorText(baseName(d.cwd));
  return '?';
}

/** The viewpoint root's projection, when the tree has one. */
export function rootOf(tree: DelegationProjection): NodeProjection | null {
  const root = tree.roots[0];
  return root && root.proj.isRoot ? root.proj : null;
}

/** A node drawn as a depth-0 intent: its parent caller is not yet a session (§3.1). */
export function isIntentRoot(pn: PNode): boolean {
  return pn.parent === null && !pn.proj.isRoot && pn.proj.unconfirmed;
}

/** The nodes whose card and micro card carry a delegation line: delegated workers, intents and jobs. */
export function hasDelegationLine(pn: PNode): boolean {
  return pn.node !== null && !pn.proj.isRoot && !pn.proj.isNative && pn.proj.detail.conflictCount === 0;
}

interface Element {
  id: 'role' | 'host' | 'time' | 'run' | 'heartbeat' | 'cost' | 'dir' | 'slot' | 'close';
  text: string;
  /** The time's form without its word (`14m`, `claimed`); null when it has none. */
  short?: string | null;
  role: Role;
}

/** The shedding steps of the delegation line, right to left (rulings B10B-s2 Q3). */
const LINE_STEPS: ReadonlyArray<{ drop: ReadonlyArray<Element['id']>; shortTime: boolean }> = [
  { drop: [], shortTime: false },
  { drop: ['dir'], shortTime: false },
  { drop: ['dir', 'cost'], shortTime: false },
  { drop: ['dir', 'cost', 'heartbeat'], shortTime: false },
  { drop: ['dir', 'cost', 'heartbeat'], shortTime: true },
  { drop: ['dir', 'cost', 'heartbeat', 'time'], shortTime: true },
  { drop: ['dir', 'cost', 'heartbeat', 'time', 'run'], shortTime: true },
  { drop: ['dir', 'cost', 'heartbeat', 'time', 'run', 'host'], shortTime: true },
];

/** The least a role is cut to before the line gives up the role's room. */
const ROLE_MIN = 4;

/** The elements of a node's delegation line, all of them, in order (rulings B10B-s2 Q3). */
export function delegationElements(
  pn: PNode,
  tree: DelegationProjection,
  width: number,
  nowMs: number,
  g: GlyphSet,
  say: Say
): Element[] {
  const p = pn.proj;
  const d = p.detail;
  if (isIntentRoot(pn)) return [{ id: 'role', text: say('parent unconfirmed'), role: 'muted' }];
  const out: Element[] = [];
  if (d.role) out.push({ id: 'role', text: d.role, role: 'text' });
  if (!d.terminal) {
    if (p.paneLabel) out.push({ id: 'host', text: paneText(p.paneLabel, say), role: 'muted' });
    else if (p.headless) out.push({ id: 'host', text: `${g.headless} ${say('headless')}`, role: 'muted' });
  }
  const intent = d.idKind === 'delegationIntent';
  if (!intent && d.reportStatus !== null && p.reportAt !== null) {
    const at = ageOf(p.reportAt, nowMs);
    out.push(
      at === null
        ? { id: 'time', text: say(W.reported), short: null, role: 'muted' }
        : { id: 'time', text: say('reported {age}', { age: at }), short: at, role: 'muted' }
    );
  } else if (d.linkState === 'pending') out.push({ id: 'time', text: say('handshake'), short: null, role: 'muted' });
  else if (d.linkState === 'claimed')
    out.push({ id: 'time', text: say('handshake claimed'), short: say('claimed'), role: 'muted' });
  else if (!intent && d.linkState !== null) {
    const at = ageOf(d.boundAt, nowMs);
    out.push(
      at === null
        ? { id: 'time', text: say('bound'), short: null, role: 'muted' }
        : { id: 'time', text: say('bound {age}', { age: at }), short: at, role: 'muted' }
    );
  }
  if (d.runSeq !== null && d.runSeq > 1) out.push({ id: 'run', text: say('run {n}', { n: d.runSeq }), role: 'muted' });
  if (width >= 80 && d.runState !== null && ALIVE_RUN.has(d.runState)) {
    const at = ageOf(d.heartbeatAt, nowMs);
    if (at !== null) out.push({ id: 'heartbeat', text: say('heartbeat {age}', { age: at }), role: 'muted' });
  }
  if (d.cost)
    out.push({ id: 'cost', text: `${d.cost.estimated ? '~' : ''}$${d.cost.value.toFixed(2)}`, role: 'muted' });
  if (d.managed && !intent) {
    const dir = dirText(p, rootOf(tree));
    if (dir) out.push({ id: 'dir', text: say('in {dir}', { dir }), role: 'muted' });
  }
  if (d.runState === 'uncertain') out.push({ id: 'slot', text: say('slot held'), role: 'warning' });
  if (p.marker.closePane) out.push({ id: 'close', text: say(W.closePane), role: 'text' });
  return out;
}

function plainOf(elements: readonly Element[], g: GlyphSet): string {
  return elements.map((e) => e.text).join(` ${g.sep} `);
}

/**
 * The delegation line in at most `width` columns, painted by `ink`: the elements that fit, shed in the fixed order,
 * then the role cut to what is left (never under 4 cells while the line has room for it). '' when it has nothing.
 */
export function delegationLine(
  pn: PNode,
  tree: DelegationProjection,
  width: number,
  nowMs: number,
  g: GlyphSet,
  say: Say,
  ink: Ink,
  /** The width the 80-column elements are judged by (the panel's), when it differs from the line's room. */
  panelWidth = width
): string {
  const all = delegationElements(pn, tree, panelWidth, nowMs, g, say);
  if (all.length === 0 || width <= 0) return '';
  let chosen: Element[] = all;
  for (const step of LINE_STEPS) {
    chosen = all
      .filter((e) => !step.drop.includes(e.id))
      .flatMap((e) => (e.id === 'time' && step.shortTime ? (e.short ? [{ ...e, text: e.short }] : []) : [e]));
    if (visualLength(plainOf(chosen, g)) <= width) break;
  }
  if (visualLength(plainOf(chosen, g)) > width) {
    // Still too long: the role is cut, never `slot held` or `close pane`.
    const role = chosen.find((e) => e.id === 'role');
    if (role) {
      const rest = chosen.filter((e) => e !== role);
      const restWidth = rest.length ? visualLength(plainOf(rest, g)) + 3 : 0;
      const room = Math.max(ROLE_MIN, width - restWidth);
      chosen = [{ ...role, text: clip(role.text, room, g) }, ...rest];
    }
  }
  const sep = ` ${ink.muted(g.sep)} `;
  const painted = chosen.map((e) => (e.role === 'muted' ? ink.muted(e.text) : ink.paint(e.role, e.text))).join(sep);
  return visualLength(painted) > width ? clip(painted, width, g) : painted;
}

/** The plain delegation line, for tests and keys. */
export function delegationLinePlain(
  pn: PNode,
  tree: DelegationProjection,
  width: number,
  nowMs: number,
  g: GlyphSet,
  say: Say
): string {
  const ink: Ink = { muted: (t) => t, accent: (t) => t, paint: (_r, t) => t, badge: () => undefined };
  return delegationLine(pn, tree, width, nowMs, g, say, ink);
}

// ---------------------------------------------------------------------------
// The focus line

const CAUSE_WORD: Record<string, string> = { supervisor_dead: W.supervisorLost };
/** A reconciliation cause or a missing item in words: underscores to spaces, through `t()` (rulings B10B-s2 Q2). */
function causeWord(cause: string, say: Say): string {
  return say(CAUSE_WORD[cause] ?? cause.replace(/_/g, ' '));
}

const REPORT_GLYPH: Record<string, { glyph: 'done' | 'fail' | 'stop' | 'flag'; role: Role }> = {
  completed: { glyph: 'done', role: 'success' },
  failed: { glyph: 'fail', role: 'danger' },
  interrupted: { glyph: 'stop', role: 'warning' },
  blocked: { glyph: 'flag', role: 'alert' },
};

const LONG_SENTENCE =
  'Still running — automatic cancellation is unavailable. Stop this run in its terminal pane.' as const;
const SHORT_SENTENCE = 'Still running — stop this run in its pane' as const;
const TINY_SENTENCE = 'running · stop in pane' as const;

/** The contract sentence's dash is Ambiguous width and has no place in ASCII (§5.4). */
function asciiDash(text: string, g: GlyphSet): string {
  return g.marker.flag === '@' ? text.replace(/—/g, '-').replace(/·/g, g.sep) : text;
}

export interface FocusLine {
  /** The leading glyph and its role; null for the terminal facts, which have none. */
  glyph: { text: string; role: Role } | null;
  segments: Segment[];
  /** The stop-in-pane sentence: a card wraps it, a micro card picks its short forms. */
  sentence?: { long: string; short: string; tiny: string };
}

/**
 * What the selected node is waiting on, what it reported or how it ended, by §3.4's priority: the stop-in-pane
 * sentence, a pending or fault reason, the report or the terminal facts. Null when the view model has none of them
 * (no placeholder, no brief, no action: rulings B10B-s2 Q2).
 */
export function focusLine(pn: PNode, nowMs: number, g: GlyphSet, say: Say): FocusLine | null {
  const p = pn.proj;
  const m = p.marker;
  const d = p.detail;
  const flag = { text: g.marker.flag, role: 'alert' as Role };
  if (m.stopInPane) {
    const fix = (s: string) => asciiDash(say(s), g);
    return {
      glyph: flag,
      segments: [{ text: fix(SHORT_SENTENCE), role: 'text' }],
      sentence: { long: fix(LONG_SENTENCE), short: fix(SHORT_SENTENCE), tiny: fix(TINY_SENTENCE) },
    };
  }
  if (m.glyph === 'warn') {
    const since = ageOf(m.sinceMs, nowMs);
    const segments: Segment[] = [
      { text: `${say(W.conflict)}: ${say('{n} records', { n: d.conflictCount })}`, role: 'warning' },
    ];
    if (since !== null) segments.push({ text: say('since {age}', { age: `~${since}` }), role: 'warning' });
    return { glyph: { text: g.marker.warn, role: 'warning' }, segments };
  }
  if (m.glyph === 'flag' && !(d.reportStatus === 'blocked' && p.summary))
    return { glyph: flag, segments: [{ text: say(m.words[0] ?? W.needsHuman), role: 'alert' }] };
  if (m.glyph === 'unknown') {
    const word = m.words[0] ?? W.unknown;
    let head = say(word);
    const cause = d.reconciliationCause;
    const role: Role = m.role === 'warning' ? 'warning' : 'muted';
    if ((m.uncertain || m.supervisorLost) && cause && CAUSE_WORD[cause] !== word && cause !== 'unknown')
      head += `: ${causeWord(cause, say)}`;
    const segments: Segment[] = [{ text: head, role }];
    for (const missing of d.missing)
      if (missing !== cause) segments.push({ text: causeWord(missing, say), role: 'muted', shed: SHED_MISSING });
    return { glyph: { text: g.marker.unknown, role }, segments };
  }
  const exitSegments = (unknownWhenNone: boolean): Segment[] => {
    const e = d.exit;
    if (e?.signal)
      return [{ text: say('signal {name}', { name: monitorText(e.signal) }), role: 'muted', shed: SHED_EXIT }];
    if (e && e.code !== null && e.code !== 0)
      return [{ text: say('exit {code}', { code: e.code }), role: 'muted', shed: SHED_EXIT }];
    return unknownWhenNone && (!e || e.code === null)
      ? [{ text: say('exit unknown'), role: 'muted', shed: SHED_EXIT_UNKNOWN }]
      : [];
  };
  const noteSegments = (): Segment[] =>
    d.terminal && d.terminalNote
      ? [{ text: say(d.terminalNote.replace(/_/g, ' ')), role: 'muted', shed: SHED_NOTE }]
      : [];
  if (d.reportStatus !== null && p.summary) {
    const r = REPORT_GLYPH[d.reportStatus] ?? REPORT_GLYPH.completed;
    return {
      glyph: { text: g.marker[r.glyph], role: r.role },
      segments: [{ text: p.summary, role: 'text' }, ...exitSegments(false), ...noteSegments()],
    };
  }
  if (m.glyph === 'fail')
    return {
      glyph: { text: g.marker.fail, role: 'danger' },
      segments: [{ text: say(m.words[0] ?? W.failed), role: 'danger' }, ...exitSegments(false), ...noteSegments()],
    };
  if (d.terminal && d.reportStatus === null) {
    const segments: Segment[] = [
      { text: say(m.words[0] ?? W.ended), role: 'muted' },
      { text: say(W.noReport), role: 'muted' },
    ];
    for (const word of m.words.slice(1)) segments.push({ text: say(word), role: 'muted', shed: SHED_CAUSE });
    segments.push(...exitSegments(true), ...noteSegments());
    return { glyph: null, segments };
  }
  return null;
}

/** The focus line as one painted line of at most `width` columns; the sentence picks its form by the width. */
export function focusText(line: FocusLine, width: number, panelWidth: number, g: GlyphSet, ink: Ink): string {
  let segments: Segment[] = line.sentence
    ? [{ text: panelWidth < 40 ? line.sentence.tiny : line.sentence.short, role: 'text' as Role }]
    : line.segments;
  const head = line.glyph ? `${ink.paint(line.glyph.role, line.glyph.text)} ` : '';
  // Drop the sheddable segments, lowest rank first, while the line does not fit; only then cut what is left.
  const plainWidth = (list: readonly Segment[]) =>
    (line.glyph ? visualLength(line.glyph.text) + 1 : 0) + visualLength(list.map((x) => x.text).join(` ${g.sep} `));
  while (plainWidth(segments) > width) {
    let drop = -1;
    segments.forEach((x, i) => {
      if (x.shed !== undefined && (drop < 0 || x.shed < segments[drop].shed!)) drop = i;
    });
    if (drop < 0) break;
    segments = segments.filter((_, i) => i !== drop);
  }
  const body = segments
    .map((s) => (s.role === 'muted' ? ink.muted(s.text) : ink.paint(s.role, s.text)))
    .join(` ${ink.muted(g.sep)} `);
  const text = head + body;
  return visualLength(text) > width ? clip(text, width, g) : text;
}

// ---------------------------------------------------------------------------
// The top parent row

const RELATION_ORDER: Record<LinkRelationProjection['attribution'], number> = {
  confirmed: 0,
  intent: 1,
  history: 2,
  conflict: 3,
};

/** The viewpoint root's own link as a child: confirmed first, then an intent, else the newest (rulings Q9). */
export function asChildRelation(tree: DelegationProjection, rootKey: string): LinkRelationProjection | null {
  const cached = asChild.get(tree.vm.tree);
  if (cached && cached.rootKey === rootKey) return cached.relation;
  const relation = findAsChild(tree, rootKey);
  asChild.set(tree.vm.tree, { rootKey, relation });
  return relation;
}
const asChild = new WeakMap<object, { rootKey: string; relation: LinkRelationProjection | null }>();

function findAsChild(tree: DelegationProjection, rootKey: string): LinkRelationProjection | null {
  const mine = tree.vm.tree.relations.filter((r) => r.childKey === rootKey);
  if (mine.length === 0) return null;
  return [...mine].sort(
    (a, b) => RELATION_ORDER[a.attribution] - RELATION_ORDER[b.attribution] || b.link.createdAt - a.link.createdAt
  )[0];
}

interface ParentPart {
  id: 'name' | 'pane' | 'state' | 'stop' | 'bound' | 'caller';
  text: string;
  role: Role;
}

// The caller's head is the unconfirmed form's only detail: it goes first, before the word is cut.
const PARENT_STEPS: ReadonlyArray<ReadonlyArray<ParentPart['id']>> = [
  [],
  ['bound', 'caller'],
  ['bound', 'caller', 'stop'],
  ['bound', 'caller', 'stop', 'pane'],
  ['bound', 'caller', 'stop', 'pane', 'state'],
];

/**
 * `↑ parent ✳ main · pane 2 · offline 3m · continue · bound 12m` (design §4.6; rulings B10B-s2 Q9): only when the
 * viewpoint root is someone's child. Null otherwise. The row is exactly `width` columns.
 */
export function parentRow(
  tree: DelegationProjection,
  width: number,
  nowMs: number,
  g: GlyphSet,
  say: Say
): string | null {
  const root = tree.roots[0];
  if (!root || !root.proj.isRoot || !root.node) return null;
  const relation = asChildRelation(tree, root.key);
  const parent = root.node.parent;
  if (!relation && !parent) return null;
  const lead = `${colors.dim(`${g.parent} ${say('parent')}`)} `;
  const leadWidth = visualLength(`${g.parent} ${say('parent')}`) + 1;
  const parts: ParentPart[] = [];
  let mark = '';
  const link = relation?.link ?? null;
  if (link && link.parentRef === null) {
    // Unconfirmed: the caller's head only, never a guessed name.
    mark = `${g.marker.unknown} `;
    parts.push({ id: 'name', text: say('unconfirmed'), role: 'muted' });
    parts.push({
      id: 'caller',
      text: say('caller {id}', { id: monitorText(link.parentCaller.slice(0, 8)) }),
      role: 'muted',
    });
  } else {
    const ref = link?.parentRef ?? null;
    const harness = ref?.harness ?? parent?.harness ?? null;
    if (harness) mark = `${g.harness[harness]} `;
    const name =
      parent?.name ??
      (ref ? shortRefOf({ kind: 'session', ref }) : parent ? shortRefOf(parent.identity) : say('parent'));
    parts.push({ id: 'name', text: monitorText(name), role: 'text' });
    if (parent?.paneLabel)
      parts.push({ id: 'pane', text: paneText(monitorText(parent.paneLabel), say), role: 'muted' });
    const run = root.node.currentRun ?? relation?.currentRun ?? null;
    const offline = relation?.parentOffline ?? tree.vm.details[root.key]?.parentOffline ?? null;
    if (run && run.mode === 'visible' && run.state === 'cancelling') {
      const at = ageOf(run.cancelRequestedAt, nowMs);
      parts.push({
        id: 'state',
        text:
          at === null ? say('asked to cancel {age}', { age: '' }).trim() : say('asked to cancel {age}', { age: at }),
        role: 'alert',
      });
      parts.push({ id: 'stop', text: say('stop here'), role: 'text' });
    } else if (offline) {
      const at = ageOf(offline.since, nowMs);
      const words = [at === null ? say('offline {age}', { age: '' }).trim() : say('offline {age}', { age: at })];
      words.push(say(offline.orphanPolicy));
      parts.push({ id: 'state', text: words.join(` ${g.sep} `), role: 'warning' });
    } else if (parent?.liveness === 'gone') parts.push({ id: 'state', text: say(W.exited), role: 'warning' });
    const bound = link ? ageOf(link.boundAt, nowMs) : null;
    if (bound !== null) parts.push({ id: 'bound', text: say('bound {age}', { age: bound }), role: 'muted' });
  }
  const markWidth = visualLength(mark);
  const room = width - leadWidth - markWidth;
  const plain = (list: ParentPart[]) => list.map((p) => p.text).join(` ${g.sep} `);
  let chosen = parts;
  for (const drop of PARENT_STEPS) {
    chosen = parts.filter((p) => !drop.includes(p.id));
    if (visualLength(plain(chosen)) <= room) break;
  }
  if (visualLength(plain(chosen)) > room) {
    const name = chosen.find((p) => p.id === 'name');
    const rest = chosen.filter((p) => p !== name);
    const restWidth = rest.length ? visualLength(plain(rest)) + 3 : 0;
    if (name) chosen = [{ ...name, text: clip(name.text, Math.max(8, room - restWidth), g) }, ...rest];
  }
  const paintPart = (p: ParentPart) =>
    p.role === 'muted'
      ? colors.dim(p.text)
      : p.role === 'alert'
        ? colors.bold(theme.error(p.text))
        : p.role === 'warning'
          ? theme.warning(p.text)
          : theme.value(p.text);
  const text = lead + colors.dim(mark) + chosen.map(paintPart).join(` ${colors.dim(g.sep)} `);
  return clipExact(text, width, g);
}

function clipExact(text: string, width: number, g: GlyphSet): string {
  const cut = visualLength(text) > width ? clip(text, width, g) : text;
  return cut + ' '.repeat(Math.max(0, width - visualLength(cut)));
}
