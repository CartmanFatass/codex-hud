/**
 * The bar's delegation parts (design §4.1): the `agents` count over the whole
 * tree, the attention alert, the backend counts and the notice sentence. Each
 * returns the same kind of `BarModule` the legacy fields do, so the layout
 * engine's shortening and hiding apply unchanged. The bar is English-only.
 */

import { colors, theme } from '../colors.js';
import { age } from '../monitor-labels.js';
import type { BarModule } from '../layout/engine.js';
import type { DelegationViewModel } from '../../core/link/view-model.js';
import { alertForms, delegationAlerts, delegationNotice, type AlertForms, type DelegationNotice } from './alerts.js';
import { glyphSet, type GlyphSet } from './glyphs.js';
import { projectDelegation, type GlyphCounts } from './projection.js';
import { paint, plainSay } from './style.js';

/**
 * The agents' shrink steps on the engine's scale (see `SHRINK` in bar-modules):
 * the backend counts go first, before the right cluster's first step (10); the
 * `Agents` label keeps its legacy turn.
 */
export const BACKENDS_SHRINK = 9;

/** `3▸ 1· 1⚑ 1? 1⚠ 1✗ 9✓`, only the non-zero kinds (§3.3 "计数"). */
export function countParts(counts: GlyphCounts, g: GlyphSet): string[] {
  const parts: string[] = [];
  const add = (n: number, glyph: string, role: Parameters<typeof paint>[0]) => {
    if (n > 0) parts.push(paint(role, `${n}${glyph}`));
  };
  add(counts.working, g.marker.working, 'info');
  add(counts.starting, g.marker.starting, 'muted');
  add(counts.flag, g.marker.flag, 'alert');
  add(counts.unknown, g.marker.unknown, 'warning');
  add(counts.warn, g.marker.warn, 'warning');
  add(counts.fail, g.barFail, 'danger');
  // Done is `✓` and `■` together: counted by marker, not by fact (§3.2).
  add(counts.done + counts.stop, g.marker.done, 'success');
  return parts;
}

export interface DelegationBarOptions {
  ascii?: boolean;
  /** Backend counts only at the `full` density (§0.2); narrower, the engine drops them first anyway. */
  showBackends: boolean;
  /** The focus density: the counts and nothing else, at every width (§4.1, no `Agents` label). */
  countsOnly?: boolean;
}

export function delegationAgentsModule(
  vm: DelegationViewModel,
  base: Pick<BarModule, 'id' | 'priority' | 'shrink' | 'group'>,
  options: DelegationBarOptions
): BarModule {
  const proj = projectDelegation(vm);
  const g = glyphSet(options.ascii);
  const parts = countParts(proj.counts, g);
  if (parts.length === 0) return { ...base, variants: {} };
  const counts = parts.join(' ');
  if (options.countsOnly) return { ...base, variants: { full: counts } };
  const label = `${colors.dim('Agents')} ${counts}`;
  const b = proj.backends;
  const backends = [
    b.codex ? `${g.harness.codex}${b.codex}` : '',
    b.pi ? `${g.harness.pi}${b.pi}` : '',
    b.jev ? `${g.harness.jev}${b.jev}` : '',
    b.claude ? `${g.harness.claude}${b.claude}` : '',
  ].filter(Boolean);
  if (options.showBackends && backends.length > 0)
    return {
      ...base,
      shrinkByLevel: { full: BACKENDS_SHRINK, short: base.shrink ?? 0 },
      variants: { full: `${label} ${colors.dim(g.sep)} ${colors.dim(backends.join(' '))}`, short: label, min: counts },
    };
  return { ...base, variants: { full: label, short: counts } };
}

/**
 * The attention badge's text for the delegation alerts, merged with the bar's
 * own alerts (`legacy`, counted when several are lit); null when the
 * delegation tree lights nothing, and the bar's own alert then says itself.
 */
export function attentionForms(
  vm: DelegationViewModel,
  nowMs: number,
  ascii: boolean | undefined,
  legacy: { flag: number; fail: number }
): AlertForms | null {
  const alerts = delegationAlerts(projectDelegation(vm), nowMs, plainSay, ascii);
  if (alerts.nodes.length === 0 && !alerts.slots) return null;
  return alertForms(alerts, plainSay, ascii, legacy);
}

/** The notice sentence, painted like the legacy ones: glyph in its colour, words plain, age dim. */
export function noticeSentence(
  vm: DelegationViewModel,
  nowMs: number,
  ascii: boolean | undefined,
  legacy: { flag: number; fail: number } = { flag: 0, fail: 0 }
): { text: string; at: number } | null {
  const proj = projectDelegation(vm);
  // The badge in its full form already names its one node; the notice zone does not say it twice (Q9).
  const alerts = delegationAlerts(proj, nowMs, plainSay, ascii);
  const named = alerts.nodes.length === 1 && legacy.flag + legacy.fail === 0 ? alerts.nodes[0].key : null;
  const notice = delegationNotice(proj, nowMs, plainSay, named, ascii);
  if (!notice) return null;
  return { text: paintNotice(notice, nowMs, glyphSet(ascii)), at: notice.at };
}

function paintNotice(notice: DelegationNotice, nowMs: number, g: GlyphSet): string {
  const role = { done: 'success', fail: 'danger', unknown: 'warning', flag: 'alert', stop: 'warning' } as const;
  const mark = notice.glyph === 'fail' ? g.marker.fail : g.marker[notice.glyph];
  return `${paint(role[notice.glyph], mark)} ${theme.value(notice.text)}${colors.dim(` ${g.sep} ${age(new Date(notice.at), nowMs)} ago`)}`;
}
