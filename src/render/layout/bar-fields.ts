/**
 * The bottom bar of all three clients (Claude's statusline, pi's footer, Codex's tmux bar), built in one place. A client
 * only collects its facts (`BarFacts`); this file words them, paints them in the chosen style and fits them to one line.
 *
 *   model effort │ context %/window │ repo branch │ quota │ notice zone ········ MCP n  skills n
 *
 * Fields a client cannot supply are left out, never shown as zero. The fields shown are `barFields`; the style is
 * `barStyle`: `│` separators (`line`), or flat capsules side by side (`p10k`: each segment padded by a space on its own
 * background, no separator glyph). The line always fits: forms shorten and whole segments drop in the order of
 * `LADDER`, and the notice zone, which only tells events, shows in full: the loaded cluster gives way for it first, the
 * other fields after, and only as a last resort is it cut at a word.
 */

import { colors, icons, METER_DANGER, METER_WARN, theme, truncateAnsi, visualLength } from '../colors.js';
import { formatTokenCount } from '../lines/activity-line.js';
import { displayConfig, iconSet, type BarField } from '../hud-config.js';
import { age } from '../monitor-labels.js';
import { providerMark } from '../providers.js';

/** How long an event stays in the notice zone; the items it cannot show together take turns every `ROTATE_MS`. */
export const NOTICE_MS = 180_000;
const ROTATE_MS = 5000;
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
  | 'tick'
  | 'track'
  | 'lead';
export type Form = ReadonlyArray<readonly [text: string, role?: Role]>;

/** Something that happened: a subagent or job started, finished or failed, a skill was loaded. */
export interface BarEvent {
  kind: 'started' | 'done' | 'failed' | 'warn' | 'skill';
  text: string;
  at: number;
  /** The words when the zone is short of room (no model, no detail). */
  short?: string;
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

/** A subagent's or job's event, in the words every client uses. */
export function agentEvent(
  kind: 'started' | 'done' | 'failed',
  who: { id?: string; name: string; model?: string; detail?: string },
  at: number
): BarEvent {
  const short = `${{ started: 'started', done: 'finished', failed: 'failed' }[kind]} ${who.name}`;
  return {
    kind,
    at,
    text: `${short}${who.model ? ` [${who.model}]` : ''}${who.detail ? `: ${who.detail}` : ''}`,
    short,
    key: who.id ?? who.name,
  };
}

// ─── Painting ──────────────────────────────────────────────────────────────────────────────────────────────────────

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
  tick: theme.tick,
  track: theme.track,
  lead: (text) => text,
  alert: theme.alert,
};

type Level = 'value' | 'warn' | 'bad';
const level = (percent: number): Level => (percent >= METER_DANGER ? 'bad' : percent >= METER_WARN ? 'warn' : 'value');

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

function modelSeg(model: NonNullable<BarFacts['model']>, p10k: boolean, ascii: boolean): Seg {
  const mark = p10k ? providerMark(model, ascii) : null;
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
  const role = level(c.percent);
  const numbers: Form = [
    [c.shown, role],
    ...(c.window > 0 ? ([[`/${formatTokenCount(c.window)}`, 'dim']] as Form) : []),
  ];
  const halves = c.percent > 0 ? Math.max(1, Math.round((c.percent / 100) * CELLS * 2)) : 0;
  const fill = '━'.repeat(Math.floor(halves / 2)) + (halves % 2 ? '╸' : '');
  const meter: Form = [
    [fill, role === 'value' ? 'tick' : role],
    ['─'.repeat(Math.max(0, CELLS - visualLength(fill))), 'track'],
    [' ', 'track'],
  ];
  const ink = role === 'value' ? P10K.context : P10K[role];
  return { id: 'context', forms: [[...meter, ...numbers], numbers], ink, at: 0 };
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
    return { id: 'quota', forms: [form, form], ink: P10K.quota, at: 0 };
  }
  const reading = (reset: boolean): Form =>
    q.windows.flatMap((w, i) => [
      ...(i ? ([['  ']] as Form) : []),
      ...(w.label ? ([[w.label, 'dim'], [' ']] as Form) : []),
      [`${w.percent}%`, level(w.percent)] as const,
      ...(reset && w.reset
        ? ([
            [' reset ', 'dim'],
            [w.reset, 'value'],
          ] as Form)
        : []),
    ]);
  const worst = level(Math.max(...q.windows.map((w) => w.percent)));
  return {
    id: 'quota',
    forms: [reading(true), reading(false)],
    ink: worst === 'value' ? P10K.quota : P10K[worst],
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

function noticeOf(event: BarEvent, now: number): Notice {
  const [mark, tone] = MARKS[event.kind];
  return {
    mark,
    tone,
    words: clean(event.text),
    short: clean(event.short ?? event.text),
    tail: ` · ${age(new Date(event.at), now)} ago`,
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
    .map((event) => noticeOf(event, now));
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
  const words = cutWords(form ? notice.short : notice.words, room - visualLength(`${notice.mark} ${tail}${pad}${pad}`));
  if (!words) return null;
  const alert = notice.tone === 'alert';
  const parts: Form = alert
    ? [[`${pad}${notice.mark} ${words}${pad}`, pad ? 'alert' : 'warn']]
    : [
        [`${notice.mark} `, notice.tone],
        [words, 'value'],
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

/** Who gives up the next form when the line is too wide, cheapest loss first; the model alone is never dropped. */
const LADDER: BarField[] = [
  'loaded',
  'context',
  'model',
  'quota',
  'project',
  'loaded',
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
  const on = new Set<BarField>(barFields);
  const zone = on.has('notice') ? zoneOf(facts, now) : null;
  const tick = Math.floor(now / ROTATE_MS);
  // The item shown when there is room for one: all the current ones take turns. A pinned item stays.
  const lone = zone && !zone.alert ? zone.events[tick % zone.events.length] : null;
  // An alert is a badge on its own colour, with a space inside it; capsules and plain text have none.
  const pad = p10k || themeName === 'none' ? '' : ' ';
  const left = [
    on.has('model') && facts.model ? modelSeg(facts.model, p10k, ascii) : null,
    on.has('context') && facts.context ? contextSeg(facts.context) : null,
    on.has('project') && facts.project?.name ? projectSeg(facts.project) : null,
    on.has('quota') && facts.quota ? quotaSeg(facts.quota) : null,
    zone?.alert ? noticeSeg(zone.alert, Infinity, pad) : null,
  ].filter((seg): seg is Seg => seg !== null);
  const right = on.has('loaded') && facts.loaded ? loadedSeg(facts.loaded) : null;
  const all = right ? [...left, right] : left;
  // The capsule look draws a segment's text between two spaces, on its own background, and nothing between capsules.
  const form = (seg: Seg): Form =>
    p10k
      ? (seg.forms[seg.at] ?? []).filter(([, role]) => role !== 'tick' && role !== 'track')
      : (seg.forms[seg.at] ?? []);
  const alive = (seg: Seg) => text(form(seg)).length > 0;
  const size = (seg: Seg) => visualLength(text(form(seg)));
  const leftWidth = (sizes: number[]) =>
    sizes.reduce((a, b) => a + b, 0) + (p10k ? 2 * sizes.length : 3 * Math.max(0, sizes.length - 1));
  const rightWidth = () => (right && alive(right) ? size(right) + (p10k ? 2 : 0) : 0);
  const gap = () => (rightWidth() ? (leftWidth(left.filter(alive).map(size)) ? (p10k ? 1 : 3) : 0) : 0);
  const fields = () => left.filter(alive);
  const room = (count: number) =>
    width - leftWidth([...fields().map(size), ...Array<number>(count).fill(0)]) - gap() - rightWidth();
  // Two events at once need room for the two widest at their shortest; then the fields stay as they are.
  const smallest = (zone?.events ?? [])
    .map((event) => textWidth(noticeSeg(event, Infinity, pad, 2)))
    .sort((a, b) => b - a);
  const wide = () => !zone?.alert && smallest.length > 1 && smallest[0] + smallest[1] <= room(2);
  // A notice shows in full: the loaded cluster goes first when it is in the way, the other fields shorten after it.
  const wanted = lone ? [textWidth(noticeSeg(lone, Infinity, pad))] : [];
  const total = () => leftWidth([...fields().map(size), ...wanted]) + gap() + rightWidth();
  for (const id of LADDER) {
    if (total() <= width || wide()) break;
    const seg = all.find((candidate) => candidate.id === id);
    if (seg && seg.at < seg.forms.length) seg.at = zone && id === 'loaded' ? seg.forms.length : seg.at + 1;
  }

  const shown = fields();
  if (zone) {
    const events = zone.events;
    if (zone.alert) {
      // Pinned first, and the second slot takes the events in turn, when one fits at least in its short form.
      if (events.length) shown.push(...(fitItems([events[tick % events.length]], room(1), pad) ?? []));
    } else if (wide()) {
      // Two at once: items 2k and 2k+1.
      const k = tick % Math.ceil(events.length / 2);
      shown.push(...(fitItems(events.slice(2 * k, 2 * k + 2), room(2), pad) ?? []));
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
      before = back;
      line += `${bg(back)}${fg(seg.ink[1])} ${paint(seg)} ${RESET}`;
      mark(seg, x + 1);
      x += size(seg) + 2;
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
  if (tail) {
    const room = Math.max(width - x - rightWidth(), 0);
    const [bgc, fgc] = tail.ink;
    line += ' '.repeat(room);
    x += room;
    mark(tail, x + (p10k ? 1 : 0));
    line += p10k ? `${bg(bgc)}${fg(fgc)} ${paint(tail)} ${RESET}` : paint(tail);
  }
  return {
    line: visualLength(line) > width ? truncateAnsi(line, width) + RESET : line,
    kept: segments.map((segment) => segment.id),
    levels: Object.fromEntries(segments.map((segment) => [segment.id, segment.level])),
    segments,
  };
}
