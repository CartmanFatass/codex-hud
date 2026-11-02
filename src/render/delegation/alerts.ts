/**
 * What lights the bar (design §4.1): the delegation alerts and the 60 second
 * notices, both derived from the projection and the clock, with no state of
 * their own.
 *
 * Alerts follow one precedence, the newest of a kind first:
 * node `⚑` (approval, question, needs human, blocked, stop in pane) > the
 * standing `⚑ slots` > `✗` failed > `⚠` conflict > `?` uncertain > stale. One
 * alert says itself in full; several say their counts (`⚑1 ?3 ⚠1`); the
 * narrowest form is a glyph and a number, and never nothing.
 */

import { truncateAnsi } from '../colors.js';
import { glyphSet, type GlyphSet } from './glyphs.js';
import type { DelegationProjection, PNode } from './projection.js';
import { PUT_AWAY_MS } from './rows.js';
import { W, type Say } from './style.js';

/** Notices stay in full colour for a minute (`NOTICE_FRESH_MS`). */
export const NOTICE_WINDOW_MS = 60_000;
const NAME_CAP = 24;

export type AlertClass = 'flag' | 'fail' | 'warn' | 'uncertain' | 'stale';

export interface NodeAlert {
  cls: AlertClass;
  key: string;
  name: string;
  word: string;
  /** When the state was entered; null sorts last, since an unknown time cannot be called newest. */
  at: number | null;
}

export interface SlotsAlert {
  /** `held/limit` of whichever limit is met: the global one, else this owner's. */
  held: number;
  limit: number;
  toClose: number;
  toReconcile: number;
}

export interface DelegationAlerts {
  nodes: NodeAlert[];
  slots: SlotsAlert | null;
}

const ORDER: Record<AlertClass, number> = { flag: 0, fail: 1, warn: 2, uncertain: 3, stale: 4 };

function nameOf(pn: PNode, say: Say, g: GlyphSet): string {
  const raw = pn.proj.name ?? say(W.main);
  return truncateAnsi(raw, NAME_CAP, g.ellipsis);
}

function classify(pn: PNode, nowMs: number): AlertClass | null {
  const m = pn.proj.marker;
  switch (m.glyph) {
    case 'flag':
      return 'flag';
    case 'warn':
      return 'warn';
    case 'unknown':
      return m.uncertain ? 'uncertain' : m.stale && !m.notLoaded && m.words[0] === W.stale ? 'stale' : null;
    case 'fail': {
      // Failure is a historical fact: `✗` lives exactly as long as its row is on the list, and the bar stops
      // lighting for it once the row is put away (§3.2, §9 #1; one constant for both, rulings Q8).
      const at = m.finishedAt ?? m.sinceMs;
      return at === null ? (m.rank === 3 ? null : 'fail') : nowMs - at < PUT_AWAY_MS ? 'fail' : null;
    }
    default:
      return null;
  }
}

/** The standing slots alert: only when the global limit or this owner's is met (§4.1). */
export function slotsAlert(proj: DelegationProjection): SlotsAlert | null {
  const capacity = proj.vm.capacity;
  if (!capacity?.full) return null;
  const globalFull = capacity.active >= capacity.limit;
  return {
    held: globalFull ? capacity.active : capacity.mine,
    limit: globalFull ? capacity.limit : capacity.mineLimit,
    toClose: proj.toClose,
    toReconcile: capacity.occupants.filter((o) => o.state === 'uncertain').length,
  };
}

/**
 * The projection's alert candidates, strongest class first and, within a class, newest first. `ascii` picks the
 * glyph set the names are cut with (the ellipsis), like everywhere else; omitted it follows the icon set.
 */
export function delegationAlerts(
  proj: DelegationProjection,
  nowMs: number,
  say: Say,
  ascii?: boolean
): DelegationAlerts {
  const g = glyphSet(ascii);
  const nodes: NodeAlert[] = [];
  const seen = new Set<string>();
  for (const pn of proj.nodes) {
    if (pn.proj.isRoot) continue;
    const cls = classify(pn, nowMs);
    if (!cls) continue;
    // A conflicting child is one alert however many parents claim it.
    const identity = cls === 'warn' ? (pn.relation?.childKey ?? pn.key) : pn.key;
    if (cls === 'warn') {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    nodes.push({
      cls,
      key: pn.key,
      name: nameOf(pn, say, g),
      word: say(pn.proj.marker.words[0] ?? ''),
      at: pn.proj.marker.sinceMs,
    });
  }
  nodes.sort((a, b) => ORDER[a.cls] - ORDER[b.cls] || (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const slots = slotsAlert(proj);
  return { nodes, slots };
}

export function alertGlyph(cls: AlertClass, g: GlyphSet): string {
  return cls === 'flag'
    ? g.marker.flag
    : cls === 'fail'
      ? g.barFail
      : cls === 'warn'
        ? g.marker.warn
        : g.marker.unknown;
}

export interface AlertForms {
  full: string;
  short: string;
  min: string;
}

/**
 * The plain-text forms of the standing slots alert (§4.1): full, `⚑ slots 6/6`, `⚑ 6/6`. Beside a node alert
 * the badge already leads with its own `⚑`, so the slots part drops its leading mark: `slots 6/6 · 1 to
 * reconcile`, `slots 6/6`, `6/6` (rulings B10b s1 round 2, Q3).
 */
export function slotsForms(slots: SlotsAlert, g: GlyphSet, say: Say, beside = false): AlertForms {
  const lead = beside ? '' : `${g.marker.flag} `;
  const base = `${lead}${say(W.slots)} ${slots.held}/${slots.limit}`;
  const extra = [
    slots.toClose > 0 ? `${slots.toClose} ${say(W.toClose)}` : '',
    slots.toReconcile > 0 ? `${slots.toReconcile} ${say(W.toReconcile)}` : '',
  ].filter(Boolean);
  return {
    full: [base, ...extra].join(` ${g.sep} `),
    short: base,
    min: `${lead}${slots.held}/${slots.limit}`,
  };
}

/** Counts per class, each already written (`⚑1`), in no order: callers pick the display order and the narrowest. */
function alertCountParts(
  nodes: readonly NodeAlert[],
  g: GlyphSet,
  extraFlag = 0,
  extraFail = 0
): Record<'flag' | 'uncertain' | 'warn' | 'fail', string> {
  const n = { flag: extraFlag, uncertain: 0, warn: 0, fail: extraFail };
  for (const a of nodes) {
    if (a.cls === 'flag') n.flag++;
    else if (a.cls === 'fail') n.fail++;
    else if (a.cls === 'warn') n.warn++;
    else n.uncertain++;
  }
  return {
    flag: n.flag ? `${g.marker.flag}${n.flag}` : '',
    uncertain: n.uncertain ? `${g.marker.unknown}${n.uncertain}` : '',
    warn: n.warn ? `${g.marker.warn}${n.warn}` : '',
    fail: n.fail ? `${g.barFail}${n.fail}` : '',
  };
}

/** `⚑1 ?3 ⚠1 ✗1`: counts per kind in the order every surface uses; zero kinds are not written. */
export function alertCounts(nodes: readonly NodeAlert[], g: GlyphSet, extraFlag = 0, extraFail = 0): string {
  const p = alertCountParts(nodes, g, extraFlag, extraFail);
  return [p.flag, p.uncertain, p.warn, p.fail].filter(Boolean).join(' ');
}

/**
 * The counts form's narrowest: the class that matters most, `⚑ > ✗ > ⚠ > ?` (so `?3 ⚠1 ✗1` narrows to `✗1`),
 * though the display order of the full form is unchanged (rulings B10b s1 round 2, Q4).
 */
function alertCountsMin(nodes: readonly NodeAlert[], g: GlyphSet, extraFlag = 0, extraFail = 0): string {
  const p = alertCountParts(nodes, g, extraFlag, extraFail);
  return p.flag || p.fail || p.warn || p.uncertain;
}

/**
 * The delegation alerts' three forms, or null with nothing to say. `legacy`
 * is how many of the bar's own alerts (an approval waiting, a failed tool)
 * are also lit: they count with the rest when there are several.
 *
 * The node alerts come first: one says itself in full (`⚑ review-tests
 * approval`, then `⚑ 1 approval`, then `⚑1`), several say their counts per
 * kind (`⚑1 ?3 ⚠1`). The standing slots alert follows them without its own
 * mark (`⚑1 ?1 · slots 6/6 · 1 to reconcile`) and is not a node, so it never
 * counts in `1⚑`.
 */
export function alertForms(
  alerts: DelegationAlerts,
  say: Say,
  ascii: boolean | undefined,
  legacy: { flag: number; fail: number } = { flag: 0, fail: 0 }
): AlertForms | null {
  const g = glyphSet(ascii);
  const nodeCount = alerts.nodes.length + legacy.flag + legacy.fail;
  let node: AlertForms | null = null;
  if (nodeCount === 1 && alerts.nodes.length === 1) {
    const a = alerts.nodes[0];
    const glyph = alertGlyph(a.cls, g);
    node = { full: `${glyph} ${a.name} ${a.word}`, short: `${glyph} 1 ${a.word}`, min: `${glyph}1` };
  } else if (nodeCount > 0) {
    const counts = alertCounts(alerts.nodes, g, legacy.flag, legacy.fail);
    node = { full: counts, short: counts, min: alertCountsMin(alerts.nodes, g, legacy.flag, legacy.fail) };
  }
  if (!node) return alerts.slots ? slotsForms(alerts.slots, g, say) : null;
  if (!alerts.slots) return node;
  const slots = slotsForms(alerts.slots, g, say, true);
  return {
    full: `${node.full} ${g.sep} ${slots.full}`,
    short: `${node.short} ${g.sep} ${slots.short}`,
    min: `${node.min} ${slots.min}`,
  };
}

export type NoticeKind =
  'reported' | 'closePane' | 'failed' | 'uncertain' | 'pending' | 'stopRequested' | 'endedNoReport';

export interface DelegationNotice {
  kind: NoticeKind;
  /** Which glyph leads the sentence: `✓`, `!`, `?`, `⚑`, `■`. */
  glyph: 'done' | 'fail' | 'unknown' | 'flag' | 'stop';
  /** What follows the glyph, as written. */
  text: string;
  at: number;
}

/**
 * The newest delegation event of the last minute, from what the view model
 * already holds: a report's time, the entering time of a state. Nothing is
 * remembered between ticks, so a restart inside the minute tells it again and
 * a missing time tells nothing (an unknown time is not "just now", §3.4). This is a window over the
 * projection rather than a tracker because the bar's own notice tracker is not part of this view (rulings
 * Q9); a tracker would replace this function and keep the rule below.
 *
 * `skipKey` is the one node the attention badge names in its full form: every notice about it (approval, stop
 * in its pane, failed, uncertain) is left out, so the same node is not printed twice on one line. With the
 * badge in counts form nothing is skipped, since the notice then adds the name (rulings B10b s1 round 2, Q2).
 */
export function delegationNotice(
  proj: DelegationProjection,
  nowMs: number,
  say: Say,
  skipKey: string | null = null,
  ascii?: boolean
): DelegationNotice | null {
  const sep = glyphSet(ascii).sep;
  let best: DelegationNotice | null = null;
  const offer = (n: DelegationNotice) => {
    if (nowMs - n.at < 0 || nowMs - n.at >= NOTICE_WINDOW_MS) return;
    if (!best || n.at > best.at) best = n;
  };
  for (const pn of proj.nodes) {
    if (pn.proj.isRoot || !pn.node) continue;
    const p = pn.proj;
    const m = p.marker;
    const name = p.name ?? say(W.main);
    if (pn.key === skipKey) continue;
    if (m.stopInPane) {
      const at = p.cancelRequestedAt ?? m.sinceMs;
      if (at !== null)
        offer({
          kind: 'stopRequested',
          glyph: 'flag',
          text: `${name} ${say(W.stillRunning)} ${sep} ${say(W.stopInItsPane)}`,
          at,
        });
    } else if (m.glyph === 'flag' && m.sinceMs !== null) {
      offer({ kind: 'pending', glyph: 'flag', text: `${name} ${say(m.words[0] ?? '')}`, at: m.sinceMs });
    } else if (m.uncertain && m.sinceMs !== null) {
      offer({ kind: 'uncertain', glyph: 'unknown', text: `${name} ${say(m.words[0] ?? '')}`, at: m.sinceMs });
    } else if (m.glyph === 'fail') {
      const at = m.finishedAt ?? m.sinceMs;
      if (at !== null) offer({ kind: 'failed', glyph: 'fail', text: `${name} ${say(W.failed)}`, at });
    } else if (m.glyph === 'done' && p.reportAt !== null && m.words.length > 0) {
      // The report that arrived; a visible agent still holding its pane is asked to close it instead.
      offer(
        m.closePane
          ? {
              kind: 'closePane',
              glyph: 'done',
              text: `${name} ${say(W.reported)} ${sep} ${say(W.closeItsPane)}`,
              at: p.reportAt,
            }
          : { kind: 'reported', glyph: 'done', text: `${name} ${say(W.reported)}`, at: p.reportAt }
      );
    } else if (
      m.glyph === 'stop' &&
      m.rank === 3 &&
      m.finishedAt !== null &&
      m.words[0] === W.ended &&
      p.reportAt === null
    ) {
      offer({
        kind: 'endedNoReport',
        glyph: 'stop',
        text: `${name} ${say(W.ended)} ${sep} ${say(W.noReport)}`,
        at: m.finishedAt,
      });
    }
  }
  return best;
}
