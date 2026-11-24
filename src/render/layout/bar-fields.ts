/**
 * The bottom bar of all three clients (Claude's statusline, pi's footer, Codex's tmux bar), built in one place. A client
 * only collects its facts (`BarFacts`); this file words them, paints them in the chosen style and fits them to one line.
 *
 *   model effort │ context %/window │ repo branch │ quota │ ~N t/s │ notice zone ········ MCP n  skills n
 *
 * The notice zone includes native approvals, machine-wide HUD load, and the client's recent events.
 *
 * Fields a client cannot supply are left out, never shown as zero. The fields shown are `barFields`; the style is
 * `barStyle`: `│` separators (`line`), or powerline capsules (`p10k`: each segment padded by a space on its own
 * background, an arrow in its colour leading into the next; flat, without arrows, when icons are text). The line always fits: forms shorten and whole segments drop in the order of
 * `LADDER`: the vitals' numbers (model, context, project, quota, output rate) outrank the notice zone, which tells
 * events and gives up its titles, then its older item, before they give up more than their extras.
 */

import { colors, icons, METER_DANGER, METER_WARN, theme, truncateAnsi, visualLength } from '../colors.js';
import { formatTokenCount } from '../lines/activity-line.js';
import { activeBarStyle, displayConfig, iconSet, type BarField } from '../hud-config.js';
import { formatMachineWork } from '../work-summary.js';
import { localLoadForms } from '../local-load.js';
import type { LocalLoad } from '../../collectors/local-load.js';
import type { MachineWorkCounts } from '../../collectors/work-summary-snapshot.js';
import { providerMark } from '../providers.js';

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
  /** One fitted row. */
  line: string;
  /** Fields on the line, in display order. */
  kept: string[];
  levels: Record<string, VariantLevel>;
  segments: BarSegment[];
}

type Role =
  | 'alert'
  | 'dim'
  | 'quiet'
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
  | 'skill'
  | 'count'
  | 'lead';
/**
 * A piece of text and its role; `bar` pieces are a meter's cells, which the capsule look leaves out; a `lead` piece may
 * carry its own mark colour (256-colour index), else the segment's.
 */
export type Form = ReadonlyArray<readonly [text: string, role?: Role, bar?: true, ink?: number]>;

/** Something that happened: a subagent started, finished or failed, a skill was loaded. */
export interface BarEvent {
  kind: 'started' | 'done' | 'failed' | 'warn' | 'skill';
  /** The words: an agent's name and title, which is also what `×n` groups by. */
  text: string;
  at: number;
  /** An agent's type (`Explore`) in the agent colour: it stays whole while the zone shrinks. */
  name?: string;
  /** What it works on, in its own words: cut at a word when the zone is short of room, and the first thing to go. */
  title?: string;
  /** How long it ran (`12m`), fixed when it ended: done and failed only. */
  ran?: string;
  /** Who it is about: only its latest event shows, so `finished` replaces `started`. Defaults to the text. */
  key?: string;
}

export interface BarQuotaWindow {
  label: string;
  /** Percent used; absent when there is no reading to meter. */
  percent?: number;
  reset?: string;
  shown?: string;
  quiet?: boolean;
  /** A text-only watermark, without cells even on wide bars. */
  meter?: false;
}

export interface BarFacts {
  model?: { name: string; effort?: string; id?: string; provider?: string; baseUrl?: string };
  /** `shown` is the reading as words (`40%`, or `?` before pi's first reply); `window` is the model's or where it compacts. */
  context?: { percent: number; shown: string; window: number };
  /** `marks` follow the branch name (`*↑2`, ` +1 *1 ?1`). */
  project?: { name: string; branch: string | null; marks?: string; dirty?: boolean };
  /** Usage windows, or one reading of its own (`credits 31.8K`, pi's `$0.420`). */
  quota?: { windows: BarQuotaWindow[]; trailing?: boolean } | { label?: string; text: string; shortText?: string };
  /** Latest available output-rate estimate, in tokens per second. */
  tps?: number;
  /** What needs the owner now (an approval): pinned while it is open. */
  needs?: string[];
  events?: BarEvent[];
  /** Fresh machine-wide HUD load. */
  work?: MachineWorkCounts;
  localLoad?: LocalLoad;
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

/** `42s`, `12m`, `1h19m`: how long something ran. */
const runTime = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : span(Math.floor(ms / 60_000)));

/** A subagent's event: its type, what it works on (when known) and, for an end, how long it ran. */
export function agentEvent(
  kind: 'started' | 'done' | 'failed',
  who: { id?: string; name: string; title?: string },
  at: number,
  ranMs?: number
): BarEvent {
  const title = who.title?.trim() || undefined;
  return {
    kind,
    at,
    text: title ? `${who.name} ${title}` : who.name,
    name: who.name,
    title,
    ran: kind !== 'started' && ranMs !== undefined && ranMs >= 0 ? runTime(ranMs) : undefined,
    key: who.id ?? who.name,
  };
}

// ─── Painting ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** claude-hud's own inks, plain ANSI so they follow the terminal's colours; no colour at all with theme `none`. */
const plain = (code: number) => (text: string) =>
  displayConfig().theme === 'none' ? text : `\x1b[${code}m${text}\x1b[0m`;

const INK: Record<Role, (text: string) => string> = {
  dim: colors.dim,
  quiet: colors.dim,
  value: theme.value,
  name: theme.model,
  project: theme.projectName,
  branch: theme.gitBranch,
  ok: theme.success,
  warn: theme.warning,
  bad: theme.error,
  info: theme.info,
  skill: theme.info,
  agent: plain(35),
  usage: plain(94),
  usageHigh: plain(95),
  count: theme.bold,
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
  skill: [110, 235],
  alert: [209, 235],
} as const satisfies Record<string, Ink>;
const fg = (index: number) => `\x1b[38;5;${index}m`;
const bg = (index: number) => `\x1b[48;5;${index}m`;
const RESET = '\x1b[0m';

interface Seg {
  id: BarField | 'localLoad';
  /** Longest first. A segment gives up form by form, then goes. */
  forms: Form[];
  ink: Ink;
  /** The provider's mark colour. */
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
  // The window goes after the cells: `41%` alone is still the reading.
  return { id: 'context', forms: [[...cells(c.percent, role), ...numbers], numbers, [[c.shown, role]]], ink, at: 0 };
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
    const reading = (text: string): Form => [...(q.label ? ([[q.label, 'dim'], [' ']] as Form) : []), [text, 'value']];
    const form = reading(q.text);
    return { id: 'quota', forms: [form, form, q.shortText ? reading(q.shortText) : form], ink: P10K.quota, at: 0 };
  }
  // Tightest first, with pending windows behind any reading; the first wins a tie.
  const lead = q.windows.reduce<BarQuotaWindow | undefined>(
    (a, b) => (!a || (b.percent ?? -Infinity) > (a.percent ?? -Infinity) ? b : a),
    undefined
  );
  const roleOf = (w: BarQuotaWindow): Role =>
    w.quiet ? 'quiet' : w.percent === undefined ? 'value' : quotaRole(w.percent);
  const reading = (w: BarQuotaWindow, bars = false, reset = false): Form => [
    ...(w.label ? ([[w.label, 'dim'], [' ']] as Form) : []),
    ...(bars && w.meter !== false && w.percent !== undefined ? cells(w.percent, roleOf(w)) : []),
    [w.shown ?? (w.percent === undefined ? '' : `${w.percent}%`), roleOf(w)],
    ...(reset && w.reset ? ([[` (${w.reset})`, 'value']] as Form) : []),
  ];
  const tail: Form = q.trailing ? q.windows.filter((w) => w !== lead).flatMap((w) => [['  '], ...reading(w)]) : [];
  const role = lead ? roleOf(lead) : 'usage';
  return {
    id: 'quota',
    // The bar goes first (with the context's), then the reset and trailing windows.
    forms: lead
      ? [[...reading(lead, true, true), ...tail], [...reading(lead, false, true), ...tail], reading(lead)]
      : [],
    ink: role === 'quiet' ? P10K.loaded : role === 'usageHigh' ? P10K.warn : role === 'bad' ? P10K.bad : P10K.quota,
    at: 0,
  };
}

function tpsSeg(rate: number | undefined): Seg | null {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  const reading = rate >= 0.05 ? rate.toFixed(1) : rate.toPrecision(1);
  return { id: 'tps', forms: [[[`~${reading} t/s`, 'value']]], ink: P10K.info, at: 0 };
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
  tone: 'alert' | 'ok' | 'bad' | 'info' | 'skill';
  /** The text; an agent's name, to which its title is added. */
  words: string;
  /** An agent's name: it stays whole or the item goes. */
  name?: string;
  title: string;
  /** ` ×3`, or an alert's ` +2` (more needs): always shown. */
  count: string;
  /** An alert of several needs: what it says when `words` and `count` do not fit (`3 needs`). */
  short?: string;
  /** ` 12m`: the run time, the first to go. */
  tail: string;
}

/** The widest a subagent's title gets, so a long Agent-call description cannot push the vitals off the bar. */
const TITLE_COLS = 36;
/** What the vitals leave a title before it goes altogether: a few words, enough to tell two subagents of one type apart. */
const TITLE_SHORT = 14;

const MARKS = {
  started: ['◐', 'info'],
  done: [icons.check, 'ok'],
  failed: [icons.cross, 'bad'],
  warn: ['◆', 'alert'],
  skill: ['✦', 'skill'],
} as const;

const clean = (words: string) => words.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();

function noticeOf(event: BarEvent, count = 1): Notice {
  const [mark, tone] = MARKS[event.kind];
  const name = event.name && clean(event.name);
  return {
    mark,
    tone,
    words: name || clean(event.text),
    name: name || undefined,
    title: cutWords(clean(event.title ?? ''), TITLE_COLS),
    count: count > 1 ? ` ×${count}` : '',
    // Fixed at the end, never a clock; a group of several ran for no one time.
    tail: count > 1 || !event.ran ? '' : ` ${event.ran}`,
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
  // The same kind of event with the same words (three `Explore ‹title›` started) is one item with `×3`.
  const groups = new Map<string, BarEvent[]>();
  for (const event of [...latest.values()].sort((a, b) => b.at - a.at || a.text.localeCompare(b.text))) {
    const group = `${event.kind}\u0000${event.text}`;
    groups.set(group, [...(groups.get(group) ?? []), event]);
  }
  const events = [...groups.values()].map(([newest, ...rest]) => noticeOf(newest, rest.length + 1));
  // The first need, `+N` for the others; when that does not fit, `N needs`.
  const needs = (facts.needs ?? []).map(clean).filter(Boolean);
  const alert: Notice | null = needs.length
    ? {
        mark: '!',
        tone: 'alert',
        words: needs[0]!,
        title: '',
        count: needs.length > 1 ? ` +${needs.length - 1}` : '',
        short: needs.length > 1 ? `${needs.length} needs` : undefined,
        tail: '',
      }
    : null;
  return alert || events.length ? { alert, events } : null;
}

/** Whole words up to `room` columns, then `…`; nothing when not even the first fits. Unspaced text (CJK) is cut by column. */
function cutWords(words: string, room: number): string {
  if (visualLength(words) <= room) return words;
  if (!/\s/.test(words) && /[^\x00-\x7f…]/.test(words)) {
    const cut = truncateAnsi(words, room);
    return cut === '…' ? '' : cut;
  }
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
 * An item as a segment, longest form first (`form` 0: its name, its title and how long it ran, 1: its name and the run
 * time, 2: its name alone), the title cut at a word to `room` columns; null when not even the name fits.
 */
function noticeSeg(notice: Notice, room: number, pad: string, form = 0): Seg | null {
  // Several needs: `first +2`, and `3 needs` (whole or not at all) when that does not fit.
  if (
    notice.short !== undefined &&
    (form > 0 || visualLength(`${notice.mark} ${notice.words}${notice.count}`) + 2 * pad.length > room)
  )
    notice = { ...notice, words: notice.short, name: notice.short, count: '' };
  // Only an alert's badge has the padding inside it.
  const left = (tail: string) =>
    room - visualLength(`${notice.mark} ${notice.count}${tail}`) - (notice.tone === 'alert' ? 2 * pad.length : 0);
  // The run time goes before the name does.
  let tail = form > 1 ? '' : notice.tail;
  if (notice.name !== undefined && visualLength(notice.words) > left(tail)) tail = '';
  const space = left(tail);
  const named = notice.name !== undefined;
  const words = named ? (visualLength(notice.words) <= space ? notice.words : '') : cutWords(notice.words, space);
  if (!words) return null;
  const title = named && !form ? cutWords(notice.title, space - visualLength(words) - 1) : '';
  const parts: Form =
    notice.tone === 'alert'
      ? [[`${pad}${notice.mark} ${words}${notice.count}${pad}`, pad ? 'alert' : 'warn']]
      : [
          [`${notice.mark} `, notice.tone],
          [words, named ? 'agent' : 'value'],
          ...(title ? ([[` ${title}`, 'value']] as Form) : []),
          [`${notice.count}${tail}`, 'dim'],
        ];
  return { id: 'notice', forms: [parts], ink: P10K[notice.tone], at: 0 };
}

/**
 * An item as the vitals plan for it, one form per stage of giving way: whole, a few words of its title, its name alone.
 * Whatever room is left afterwards goes back to the titles.
 */
function noticeStages(notice: Notice, pad: string): Form[] {
  const whole = noticeSeg(notice, Infinity, pad)?.forms[0] ?? [];
  const few = noticeSeg({ ...notice, title: cutWords(notice.title, TITLE_SHORT) }, Infinity, pad)?.forms[0] ?? whole;
  return [whole, few, noticeSeg(notice, Infinity, pad, 2)?.forms[0] ?? few];
}

const textWidth = (seg: Seg | null) => (seg ? visualLength(text(seg.forms[0])) : 0);

/**
 * The items side by side in `room` columns: the widest title loses words until the items fit, down to each one's name and
 * run time; then the run times and names go form by form; null if they cannot.
 */
function fitItems(items: Notice[], room: number, pad: string): Seg[] | null {
  const form = items.map(() => 0),
    cap = items.map(() => Infinity);
  // What an item keeps while another still has a title to give: its name and how long it ran.
  const floor = items.map((item) => textWidth(noticeSeg(item, Infinity, pad, 1)));
  for (;;) {
    const segs = items.map((item, i) => noticeSeg(item, cap[i]!, pad, form[i]));
    const widths = segs.map(textWidth);
    const over = widths.reduce((a, b) => a + b, 0) - room;
    if (over <= 0) return segs.filter((seg): seg is Seg => seg !== null);
    const open = items.map((_, i) => i).filter((i) => form[i]! < 2);
    if (!open.length) return null;
    const titled = open.filter((i) => form[i] === 0 && widths[i]! > floor[i]!);
    const pick = titled.length ? titled : open;
    const i = pick.reduce((a, b) => (widths[b]! >= widths[a]! ? b : a));
    // The widest gives up words down to the next widest (half the overflow when level), so each keeps some of its title.
    const next = Math.max(0, ...pick.filter((j) => j !== i).map((j) => widths[j]!));
    const target = Math.max(
      widths[i]! > next ? Math.max(widths[i]! - over, next) : widths[i]! - Math.ceil(over / 2),
      titled.length ? floor[i]! : 0
    );
    const cut = form[i] === 0 && items[i]!.title ? noticeSeg(items[i]!, target, pad) : null;
    if (cut && textWidth(cut) < widths[i]!) cap[i] = target;
    else form[i]!++;
  }
}

// ─── Fit and layout ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who gives up the next form when the line is too wide, cheapest loss first. The vitals' numbers outrank everything
 * round them, so the order is: the loaded counts; both gauges'
 * cells (`meters`: the two go together); the quota's reset; the branch's marks; a subagent's title (`title`, twice: a few
 * words, then altogether); the output rate; swap, then the local CPU/RAM segment; the older of two subagent items
 * (`notice`, which also cuts the newest at a word, and shortens a pinned need to `N needs`); the effort; the context's
 * window; the branch; the quota; the project; the context. The model alone
 * is never dropped. The load is omitted whole if it still cannot fit.
 */
const LADDER: Array<Seg['id'] | 'meters' | 'title'> = [
  'loaded',
  'loaded',
  'meters',
  'quota',
  'project',
  'title',
  'title',
  'tps',
  'localLoad',
  'localLoad',
  'notice',
  'model',
  'context',
  'project',
  'quota',
  'project',
  'context',
];

/** One fitted row, `width` columns at most, from the client's facts. */
export function renderBar(facts: BarFacts, width: number, now = Date.now(), style = activeBarStyle()): FitResult {
  const { barFields, theme: themeName } = displayConfig();
  // No colour asked for means no capsules: a capsule is a background.
  const p10k = style === 'p10k' && themeName !== 'none';
  const ascii = iconSet() === 'text';
  // The powerline arrows: one column after each left segment, one before the right cluster.
  const arrow = p10k && !ascii ? 1 : 0;
  const on = new Set<BarField>(barFields);
  const zone = on.has('notice') ? zoneOf(facts, now) : null;
  // The item shown when there is room for one: the newest. A pinned item stays.
  const lone = zone && !zone.alert ? (zone.events[0] ?? null) : null;
  // An alert is a badge on its own colour, with a space inside it; capsules and plain text have none.
  const pad = p10k || themeName === 'none' ? '' : ' ';
  const alertSeg = zone?.alert ? noticeSeg(zone.alert, Infinity, pad) : null;
  // Several needs: `first +2`, then `N needs` when the notice has to give way.
  if (alertSeg && zone?.alert?.short) alertSeg.forms.push(noticeSeg(zone.alert, Infinity, pad, 1)!.forms[0]!);
  const load: Seg | null = on.has('notice') && facts.work
    ? { id: 'notice', forms: [[[formatMachineWork(facts.work), 'value']]], ink: P10K.info, at: 0 }
    : null;
  const localLoad: Seg | null = on.has('notice') && facts.localLoad
    ? { id: 'localLoad', forms: localLoadForms(facts.localLoad).map((text) => [[text, 'value']]), ink: P10K.info, at: 0 }
    : null;
  const left = [
    on.has('model') && facts.model ? modelSeg(facts.model, ascii) : null,
    on.has('context') && facts.context ? contextSeg(facts.context) : null,
    on.has('project') && facts.project?.name ? projectSeg(facts.project) : null,
    on.has('quota') && facts.quota ? quotaSeg(facts.quota) : null,
    on.has('tps') ? tpsSeg(facts.tps) : null,
    alertSeg,
    load,
    localLoad,
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
  // A notice keeps its name and gives up its title before the vitals give up anything but their extras: the loaded
  // cluster goes first when it is in the way, then the gauges, the reset and the marks, then a title down to a few words.
  // The second item is wanted too, at its shortest, so that two jobs show as two items when the vitals can give way.
  const second = lone && zone?.events[1];
  const stages = lone ? noticeStages(lone, pad) : [];
  let stage = 0;
  const wanted = () => [
    ...(lone ? [visualLength(text(stages[stage]))] : []),
    ...(second ? [textWidth(noticeSeg(second, Infinity, pad, 2))] : []),
  ];
  const total = () => leftWidth([...fields().map(size), ...wanted()]) + gap() + rightWidth();
  for (const id of LADDER) {
    if (total() <= width) break;
    if (id === 'title') {
      stage = Math.min(stage + 1, 2);
      continue;
    }
    if (id === 'meters') {
      for (const seg of all) if ((seg.id === 'context' || seg.id === 'quota') && seg.at < 1) seg.at = 1;
      continue;
    }
    // The older of two items gives way here, before the effort does: the newest alone, cut at a word to what room is
    // left, if its name fits.
    if (id === 'notice') {
      if (alertSeg && alertSeg.forms.length > 1) alertSeg.at = 1;
      if (wide() || (lone && noticeSeg(lone, room(1), pad))) break;
      continue;
    }
    const seg = all.find((candidate) => candidate.id === id);
    if (seg && seg.at < seg.forms.length) seg.at = (zone || load) && id === 'loaded' ? seg.forms.length : seg.at + 1;
  }
  if (load && room(0) < 0) load.at = load.forms.length;
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
      .map(([part, role, , own]) => {
        const lead = own ?? seg.lead;
        if (p10k) {
          if (role === 'quiet') return `\x1b[2m${part}\x1b[22m`;
          return role === 'lead' && lead !== undefined ? `${fg(lead)}${part}${fg(seg.ink[1])}` : part;
        }
        if (role === 'lead' && lead !== undefined && themeName !== 'none') return `${fg(lead)}${part}${RESET}`;
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
