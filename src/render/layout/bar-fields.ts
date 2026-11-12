/**
 * The bottom bar of all three clients (Claude's statusline, pi's footer, Codex's tmux bar), built in one place. A client
 * only collects its facts (`BarFacts`); this file words them, paints them in the chosen style and fits them to one line.
 *
 *   model effort │ context %/window │ repo branch │ quota │ notice zone ········ MCP n  skills n
 *
 * Fields a client cannot supply are left out, never shown as zero. The fields shown are `barFields`; the style is
 * `barStyle`: `│` separators (`line`), or powerline capsules (`p10k`: each segment padded by a space on its own
 * background, an arrow in its colour leading into the next; flat, without arrows, when icons are text). The line always fits: forms shorten and whole segments drop in the order of
 * `LADDER`, and the notice zone, which only tells events, shows in full: the loaded cluster gives way for it first, the
 * other fields after, and only as a last resort is it cut at a word.
 */

import { colors, icons, METER_DANGER, METER_WARN, theme, truncateAnsi, visualLength } from '../colors.js';
import { formatTokenCount } from '../lines/activity-line.js';
import { displayConfig, iconSet, type BarField } from '../hud-config.js';
import { providerMark, shortModel } from '../providers.js';

/**
 * How long an event stays in the notice zone. Nothing rotates and nothing ticks (owner, 2026-11-11: a bar that keeps
 * changing is a flicker): the newest events that fit are shown, and an item's text does not change while it stays.
 */
export const NOTICE_MS = 180_000;
const CELLS = 10;

export type VariantLevel = 'full' | 'short' | 'min';
export interface BarSegment {
  id: string;
  level: VariantLevel;
  /** First column of the field, counting from 0. */
  x: number;
  width: number;
}
export interface FitResult {
  line: string;
  /** Fields on the line, in display order. */
  kept: string[];
  levels: Record<string, VariantLevel>;
  segments: BarSegment[];
}

type Role =
  | 'alert'
  | 'dim'
  | 'value'
  | 'name'
  | 'project'
  | 'branch'
  | 'ok'
  | 'warn'
  | 'bad'
  | 'info'
  | 'agent'
  | 'usage'
  | 'usageHigh'
  | 'lead';
/** A piece of text and its role; `bar` pieces are a meter's cells, which the capsule look leaves out. */
export type Form = ReadonlyArray<readonly [text: string, role?: Role, bar?: true]>;

/** Something that happened: a subagent or job started, finished or failed, a skill was loaded. */
export interface BarEvent {
  kind: 'started' | 'done' | 'failed' | 'warn' | 'skill';
  text: string;
  at: number;
  /** The words when the zone is short of room (no model, no detail). */
  short?: string;
  /** An agent's name, the start of `text`: such an item is the name in the agent colour and the rest dim, with no age. */
  name?: string;
  /** Who it is about: only its latest event shows, so `finished` replaces `started`. Defaults to the text. */
  key?: string;
}

export interface BarFacts {
  model?: { name: string; effort?: string; id?: string; provider?: string; baseUrl?: string };
  /** `shown` is the reading as words (`40%`, or `?` before pi's first reply); `window` is the model's or where it compacts. */
  context?: { percent: number; shown: string; window: number };
  /** `marks` follow the branch name (`*↑2`, ` +1 *1 ?1`). */
  project?: { name: string; branch: string | null; marks?: string; dirty?: boolean };
  /** Usage windows, or one reading of its own (`credits 31.8K`, pi's `$0.420`). */
  quota?: { windows: Array<{ label: string; percent: number; reset?: string }> } | { label?: string; text: string };
  /** What needs the owner now (an approval, a job's question): pinned while it is open. */
  needs?: string[];
  events?: BarEvent[];
  loaded?: { counts: ReadonlyArray<readonly [string, number | null | undefined]>; words?: Form[] };
}

/** `19m`, `1h19m`, `2d1h`. */
export function span(mins: number): string {
  const days = Math.floor(mins / 1440),
    hours = Math.floor(mins / 60) % 24,
    rest = mins % 60;
  return days ? `${days}d${hours ? hours + 'h' : ''}` : mins >= 60 ? `${hours}h${rest ? rest + 'm' : ''}` : `${mins}m`;
}

/** `↑2↓1`: what the branch is ahead of and behind its upstream. */
export function gitSync(ahead: number, behind: number): string {
  return [ahead > 0 ? `${icons.ahead}${ahead}` : '', behind > 0 ? `${icons.behind}${behind}` : ''].join('');
}

/** A subagent's or job's event, as claude-hud's agents line has it: `frontend-implementer [sonnet-5.5 · xhigh]`. */
export function agentEvent(
  kind: 'started' | 'done' | 'failed',
  who: { id?: string; name: string; model?: string; effort?: string },
  at: number
): BarEvent {
  const meta = [shortModel(who.model), who.effort].filter(Boolean).join(' · ');
  return {
    kind,
    at,
    text: `${who.name}${meta ? ` [${meta}]` : ''}`,
    short: who.name,
    name: who.name,
    key: who.id ?? who.name,
  };
}

// ─── Painting ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** claude-hud's own inks, plain ANSI so they follow the terminal's colours; no colour at all with theme `none`. */
const plain = (code: number) => (text: string) =>
  displayConfig().theme === 'none' ? text : `\x1b[${code}m${text}\x1b[0m`;

const INK: Record<Role, (text: string) => string> = {
  dim: colors.dim,
  value: theme.value,
  name: theme.model,
  project: theme.projectName,
  branch: theme.gitBranch,
  ok: theme.success,
  warn: theme.warning,
  bad: theme.error,
  info: theme.info,
  agent: plain(35),
  usage: plain(94),
  usageHigh: plain(95),
  lead: (text) => text,
  alert: theme.alert,
};

/** claude-hud's colours: the context is green, yellow from 70 and red from 85; the quota blue, magenta from 75, red from 90. */
const contextRole = (percent: number): Role =>
  percent >= METER_DANGER ? 'bad' : percent >= METER_WARN ? 'warn' : 'ok';
const quotaRole = (percent: number): Role => (percent >= 90 ? 'bad' : percent >= 75 ? 'usageHigh' : 'usage');

/** claude-hud's bar: `█` for the filled share in the reading's colour, `░` for the rest, dim; then a space. */
const cells = (percent: number, role: Role): Form => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * CELLS);
  return [
    ['█'.repeat(filled), role, true],
    ['░'.repeat(CELLS - filled), 'dim', true],
    [' ', undefined, true],
  ];
};

/** p10k: ANSI indices from the old pi footer, light backgrounds with dark text; (background, text). */
type Ink = readonly [bg: number, fg: number];
const P10K = {
  model: [7, 232],
  context: [116, 235],
  project: [110, 235],
  dirty: [179, 235],
  quota: [152, 235],
  loaded: [250, 235],
  warn: [179, 235],
  bad: [204, 235],
  ok: [108, 235],
  info: [110, 235],
  alert: [209, 235],
} as const satisfies Record<string, Ink>;
const fg = (index: number) => `\x1b[38;5;${index}m`;
const bg = (index: number) => `\x1b[48;5;${index}m`;
const RESET = '\x1b[0m';

interface Seg {
  id: BarField;
  /** Longest first. A segment gives up form by form, then goes. */
  forms: Form[];
  ink: Ink;
  /** The provider's mark colour, p10k only. */
  lead?: number;
  at: number;
}

const text = (form: Form | undefined): string => (form ?? []).map(([part]) => part).join('');

function modelSeg(model: NonNullable<BarFacts['model']>, ascii: boolean): Seg {
  // The vendor's mark leads the short name in both looks (owner, 2026-11-11): `✻ opus-5.5 high`.
  const mark = providerMark(model, ascii);
  const lead: Form = mark ? [[`${mark.glyph} `, 'lead']] : [];
  const name: Form = [...lead, [model.name, 'name']];
  return {
    id: 'model',
    forms: [model.effort ? [...name, [' '], [model.effort, 'dim']] : name, name],
    ink: P10K.model,
    lead: mark?.color,
    at: 0,
  };
}

function contextSeg(c: NonNullable<BarFacts['context']>): Seg {
  const role = contextRole(c.percent);
  const numbers: Form = [
    [c.shown, role],
    ...(c.window > 0 ? ([[`/${formatTokenCount(c.window)}`, 'dim']] as Form) : []),
  ];
  const ink = role === 'ok' ? P10K.context : P10K[role as 'warn' | 'bad'];
  return { id: 'context', forms: [[...cells(c.percent, role), ...numbers], numbers], ink, at: 0 };
}

function projectSeg(p: NonNullable<BarFacts['project']>): Seg {
  const name: Form = [[p.name, 'project']];
  const branch = (marks: string): Form => (p.branch ? [...name, [' '], [`${p.branch}${marks}`, 'branch']] : name);
  return {
    id: 'project',
    forms: [branch(p.marks ?? ''), branch(p.dirty ? icons.dirty : ''), name],
    ink: p.dirty ? P10K.dirty : P10K.project,
    at: 0,
  };
}

function quotaSeg(q: NonNullable<BarFacts['quota']>): Seg {
  if ('text' in q) {
    const form: Form = [...(q.label ? ([[q.label, 'dim'], [' ']] as Form) : []), [q.text, 'value']];
    // The same three times: the segment goes only at the ladder's last quota step, as the windows' does.
    return { id: 'quota', forms: [form, form, form], ink: P10K.quota, at: 0 };
  }
  // One window only, the one with the least left (owner, 2026-11-11); the first wins a tie.
  const shown = q.windows.length ? [q.windows.reduce((a, b) => (b.percent > a.percent ? b : a))] : [];
  const reading = (bars: boolean, reset: boolean): Form =>
    shown.flatMap((w, i) => [
      ...(i ? ([['  ']] as Form) : []),
      ...(w.label ? ([[w.label, 'dim'], [' ']] as Form) : []),
      ...(bars ? cells(w.percent, quotaRole(w.percent)) : []),
      [`${w.percent}%`, quotaRole(w.percent)] as const,
      ...(reset && w.reset ? ([[` (${w.reset})`, 'value']] as Form) : []),
    ]);
  const worst = quotaRole(Math.max(...shown.map((w) => w.percent)));
  return {
    id: 'quota',
    // The reset goes first, then the bar.
    forms: [reading(true, true), reading(true, false), reading(false, false)],
    ink: worst === 'usage' ? P10K.quota : P10K[worst === 'usageHigh' ? 'warn' : (worst as 'bad')],
    at: 0,
  };
}

/** What the client loaded; pi's extension words go first, before the counts. */
function loadedSeg(l: NonNullable<BarFacts['loaded']>): Seg {
  const list = (items: Form[]): Form => items.flatMap((item, i) => (i ? [['  '] as const, ...item] : item));
  const counts = list(
    l.counts
      .filter(([, n]) => typeof n === 'number' && n > 0)
      .map(([label, n]) => [[label, 'dim'], [' '], [String(n), 'value']])
  );
  const words = list(l.words ?? []);
  return {
    id: 'loaded',
    forms: [words.length && counts.length ? [...words, ['  '], ...counts] : [...words, ...counts], counts],
    ink: P10K.loaded,
    at: 0,
  };
}

// ─── The notice zone ───────────────────────────────────────────────────────────────────────────────────────────────

interface Notice {
  mark: string;
  tone: 'alert' | 'ok' | 'bad' | 'info';
  words: string;
  /** The words with no model and no detail. */
  short: string;
  /** An agent's name, the start of `words`. */
  name?: string;
  tail: string;
}

const MARKS = {
  started: ['◐', 'info'],
  done: [icons.check, 'ok'],
  failed: [icons.cross, 'bad'],
  warn: ['◆', 'alert'],
  skill: ['✦', 'info'],
} as const;

const clean = (words: string) => words.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();

function noticeOf(event: BarEvent): Notice {
  const [mark, tone] = MARKS[event.kind];
  return {
    mark,
    tone,
    words: clean(event.text),
    short: clean(event.short ?? event.text),
    name: event.name && clean(event.name),
    // No age: a counting clock would change the bar every refresh.
    tail: '',
  };
}

/**
 * What the zone has to tell: what needs the owner while it is open (pinned), and the events of the last `NOTICE_MS`,
 * the latest one per subject (`finished` replaces `started`), newest first. Nothing else: an idle session has an empty
 * zone, and so does one whose events are all older.
 */
function zoneOf(
  facts: Pick<BarFacts, 'needs' | 'events'>,
  now: number
): { alert: Notice | null; events: Notice[] } | null {
  const latest = new Map<string, BarEvent>();
  for (const event of [...(facts.events ?? [])].sort((a, b) => a.at - b.at))
    if (now - event.at < NOTICE_MS) latest.set(event.key ?? event.text, event);
  const events = [...latest.values()]
    .sort((a, b) => b.at - a.at || a.text.localeCompare(b.text))
    .map((event) => noticeOf(event));
  const words = facts.needs?.length ? clean(facts.needs.join(' · ')) : '';
  const alert: Notice | null = words ? { mark: '!', tone: 'alert', words, short: words, tail: '' } : null;
  return alert || events.length ? { alert, events } : null;
}

/** Whole words up to `room` columns, then `…`; nothing when not even the first fits. Unspaced text (CJK) is cut by column. */
function cutWords(words: string, room: number): string {
  if (visualLength(words) <= room) return words;
  if (!/\s/.test(words) && /[^\x00-\x7f]/.test(words)) return truncateAnsi(words, room);
  let out = '';
  for (const word of words.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (visualLength(next) > room - 1) break;
    out = next;
  }
  out = out.replace(/[:,;]$/, '');
  return out ? `${out}…` : '';
}

/**
 * An item as a segment, longest form first (`form` 0: its words and how long ago, 1: its short words and the age, 2:
 * its short words alone), the words cut at a word to `room` columns; null when not even the first word fits.
 */
function noticeSeg(notice: Notice, room: number, pad: string, form = 0): Seg | null {
  const tail = form > 1 ? '' : notice.tail;
  const space = room - visualLength(`${notice.mark} ${tail}${pad}${pad}`);
  // An agent's `[model · effort]` stays whole or goes: it is never cut.
  const whole = !form && (!notice.name || visualLength(notice.words) <= space);
  const words = cutWords(whole ? notice.words : notice.short, space);
  if (!words) return null;
  const alert = notice.tone === 'alert';
  const named = Math.min(words.length, notice.name?.length ?? 0);
  const parts: Form = alert
    ? [[`${pad}${notice.mark} ${words}${pad}`, pad ? 'alert' : 'warn']]
    : [
        [`${notice.mark} `, notice.tone],
        ...(notice.name
          ? ([
              [words.slice(0, named), 'agent'],
              [words.slice(named), 'dim'],
            ] as Form)
          : ([[words, 'value']] as Form)),
        [tail, 'dim'],
      ];
  return { id: 'notice', forms: [parts], ink: P10K[notice.tone], at: 0 };
}

const textWidth = (seg: Seg | null) => (seg ? visualLength(text(seg.forms[0])) : 0);

/** The items side by side in `room` columns: the widest gives up a form at a time until they fit; null if they cannot. */
function fitItems(items: Notice[], room: number, pad: string): Seg[] | null {
  const form = items.map(() => 0);
  for (;;) {
    const segs = items.map((item, i) => noticeSeg(item, Infinity, pad, form[i]));
    const widths = segs.map(textWidth);
    if (widths.reduce((a, b) => a + b, 0) <= room) return segs.filter((seg): seg is Seg => seg !== null);
    const open = items.map((_, i) => i).filter((i) => form[i] < 2);
    if (!open.length) return null;
    form[open.reduce((a, b) => (widths[b] >= widths[a] ? b : a))]++;
  }
}

// ─── Fit and layout ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who gives up the next form when the line is too wide, cheapest loss first. The effort goes after the context bar, the
 * quota's reset and bar and the project's short form, and a notice is cut at a word (`notice`) before it goes; the
 * model alone is never dropped.
 */
const LADDER: BarField[] = [
  'loaded',
  'context',
  'quota',
  'quota',
  'project',
  'loaded',
  'notice',
  'model',
  'project',
  'quota',
  'project',
  'context',
];

/** One line, `width` columns at most, from the client's facts. */
export function renderBar(facts: BarFacts, width: number, now = Date.now()): FitResult {
  const { barStyle, barFields, theme: themeName } = displayConfig();
  // No colour asked for means no capsules: a capsule is a background.
  const p10k = barStyle === 'p10k' && themeName !== 'none';
  const ascii = iconSet() === 'text';
  // The powerline arrows: one column after each left segment, one before the right cluster.
  const arrow = p10k && !ascii ? 1 : 0;
  const on = new Set<BarField>(barFields);
  const zone = on.has('notice') ? zoneOf(facts, now) : null;
  // The item shown when there is room for one: the newest. A pinned item stays.
  const lone = zone && !zone.alert ? (zone.events[0] ?? null) : null;
  // An alert is a badge on its own colour, with a space inside it; capsules and plain text have none.
  const pad = p10k || themeName === 'none' ? '' : ' ';
  const left = [
    on.has('model') && facts.model ? modelSeg(facts.model, ascii) : null,
    on.has('context') && facts.context ? contextSeg(facts.context) : null,
    on.has('project') && facts.project?.name ? projectSeg(facts.project) : null,
    on.has('quota') && facts.quota ? quotaSeg(facts.quota) : null,
    zone?.alert ? noticeSeg(zone.alert, Infinity, pad) : null,
  ].filter((seg): seg is Seg => seg !== null);
  const right = on.has('loaded') && facts.loaded ? loadedSeg(facts.loaded) : null;
  const all = right ? [...left, right] : left;
  // The capsule look draws a segment's text between two spaces, on its own background, and nothing between capsules.
  const form = (seg: Seg): Form =>
    p10k ? (seg.forms[seg.at] ?? []).filter(([, , bar]) => !bar) : (seg.forms[seg.at] ?? []);
  const alive = (seg: Seg) => text(form(seg)).length > 0;
  const size = (seg: Seg) => visualLength(text(form(seg)));
  const leftWidth = (sizes: number[]) =>
    sizes.reduce((a, b) => a + b, 0) + (p10k ? (2 + arrow) * sizes.length : 3 * Math.max(0, sizes.length - 1));
  const rightWidth = () => (right && alive(right) ? size(right) + (p10k ? 2 + arrow : 0) : 0);
  const gap = () => (rightWidth() ? (leftWidth(left.filter(alive).map(size)) ? (p10k ? 1 : 3) : 0) : 0);
  const fields = () => left.filter(alive);
  const room = (count: number) =>
    width - leftWidth([...fields().map(size), ...Array<number>(count).fill(0)]) - gap() - rightWidth();
  // The two newest at once need room for both at their shortest; then the fields stay as they are.
  const smallest = (zone?.events ?? [])
    .slice(0, 2)
    .map((event) => textWidth(noticeSeg(event, Infinity, pad, 2)))
    .sort((a, b) => b - a);
  const wide = () => !zone?.alert && smallest.length > 1 && smallest[0] + smallest[1] <= room(2);
  // A notice shows in full: the loaded cluster goes first when it is in the way, the other fields shorten after it.
  const wanted = lone ? [textWidth(noticeSeg(lone, Infinity, pad))] : [];
  const total = () => leftWidth([...fields().map(size), ...wanted]) + gap() + rightWidth();
  for (const id of LADDER) {
    if (total() <= width || wide()) break;
    // The notice gives way here, before the effort: cut at a word to what room is left, if a word fits.
    if (id === 'notice') {
      if (lone && noticeSeg(lone, room(1), pad)) break;
      continue;
    }
    const seg = all.find((candidate) => candidate.id === id);
    if (seg && seg.at < seg.forms.length) seg.at = zone && id === 'loaded' ? seg.forms.length : seg.at + 1;
  }

  const shown = fields();
  if (zone) {
    const events = zone.events;
    if (zone.alert) {
      // Pinned first, and the newest event beside it when it fits at least in its short form.
      if (events.length) shown.push(...(fitItems([events[0]], room(1), pad) ?? []));
    } else if (wide()) {
      // The two newest at once.
      shown.push(...(fitItems(events.slice(0, 2), room(2), pad) ?? []));
    } else {
      const seg = lone && noticeSeg(lone, room(1), pad);
      if (seg) shown.push(seg);
    }
  }
  const tail = right && alive(right) ? right : null;

  const paint = (seg: Seg): string =>
    form(seg)
      .map(([part, role]) => {
        if (p10k) return role === 'lead' && seg.lead !== undefined ? `${fg(seg.lead)}${part}${fg(seg.ink[1])}` : part;
        if (role === 'lead' && seg.lead !== undefined && themeName !== 'none') return `${fg(seg.lead)}${part}${RESET}`;
        return role ? INK[role](part) : part;
      })
      .join('');
  let line = '';
  let x = 0;
  const segments: BarSegment[] = [];
  const mark = (seg: Seg, at: number) =>
    segments.push({
      id: seg.id,
      level: (['full', 'short', 'min'] as const)[Math.min(seg.at, 2)],
      x: at,
      width: size(seg),
    });
  let before = -1;
  shown.forEach((seg, i) => {
    if (p10k) {
      // Neighbours on one colour would run together: the later one takes the next shade.
      const back = seg.ink[0] === before ? seg.ink[0] + 1 : seg.ink[0];
      // The previous capsule's arrow points into this one: its colour on this background.
      if (arrow && i) line += `${bg(back)}${fg(before)}\ue0b0`;
      before = back;
      line += `${bg(back)}${fg(seg.ink[1])} ${paint(seg)} ${RESET}`;
      mark(seg, x + 1);
      x += size(seg) + 2 + arrow;
    } else {
      if (i) {
        line += theme.separator(' │ ');
        x += 3;
      }
      mark(seg, x);
      line += paint(seg);
      x += size(seg);
    }
  });
  // The last left capsule's arrow fades into the terminal background.
  if (arrow && before >= 0) line += `${fg(before)}\ue0b0${RESET}`;
  if (tail) {
    const room = Math.max(width - x - rightWidth(), 0);
    const [bgc, fgc] = tail.ink;
    line += ' '.repeat(room);
    x += room;
    mark(tail, x + (p10k ? 1 + arrow : 0));
    line += p10k ? `${arrow ? `${fg(bgc)}\ue0b2` : ''}${bg(bgc)}${fg(fgc)} ${paint(tail)} ${RESET}` : paint(tail);
  }
  return {
    line: visualLength(line) > width ? truncateAnsi(line, width) + RESET : line,
    kept: segments.map((segment) => segment.id),
    levels: Object.fromEntries(segments.map((segment) => [segment.id, segment.level])),
    segments,
  };
}
