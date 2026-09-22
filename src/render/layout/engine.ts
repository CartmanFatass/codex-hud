/**
 * Width allocation for the status bar.
 *
 * The bar used to be one concatenated string clipped to the pane width, so a
 * narrow pane lost whatever happened to sit on the right. Here each field is a
 * module that knows its own importance and carries shorter ways to say itself.
 * When the pane is too narrow the engine shortens before it hides, hides the
 * least important thing first, and clips text only as a last resort.
 *
 * A pinned module is never hidden. That is what keeps an alert on screen at 40
 * columns, where the session id and the timer have long since gone.
 *
 * Fields that belong together carry the same `group`, and neighbours inside a
 * group are joined by a narrower separator than the one between groups, so the
 * bar reads as a few clusters rather than a uniform list. A module marked
 * `align: 'right'` joins the trailing cluster, which is pushed to the last
 * column whenever the fitted content leaves room for it.
 */

import { truncateAnsi, visualLength } from '../colors.js';

export type VariantLevel = 'full' | 'short' | 'min';

export const VARIANT_ORDER: VariantLevel[] = ['full', 'short', 'min'];

export interface BarModule {
  id: string;
  /** Higher survives longer. Shortening and hiding both start at the bottom. */
  priority: number;
  /** Pinned modules are shortened but never hidden. */
  pinned?: boolean;
  /** Neighbours sharing a group are joined by the tighter group separator. */
  group?: string;
  /** Right-aligned modules form the trailing cluster pinned to the last column. */
  align?: 'left' | 'right';
  /** Ways to say the same thing, longest first. Empty entries are skipped. */
  variants: Partial<Record<VariantLevel, string>>;
}

export interface FitResult {
  line: string;
  /** Module ids that survived, in display order. */
  kept: string[];
  /** The variant each surviving module settled on. */
  levels: Record<string, VariantLevel>;
  /** True when even the pinned minimum had to be clipped. */
  clipped: boolean;
}

interface Candidate {
  module: BarModule;
  levels: VariantLevel[];
  levelIndex: number;
  dropped: boolean;
}

const DEFAULT_GROUP_SEPARATOR = '  ';

function availableLevels(module: BarModule): VariantLevel[] {
  return VARIANT_ORDER.filter((level) => {
    const text = module.variants[level];
    return typeof text === 'string' && text.length > 0;
  });
}

function currentText(candidate: Candidate): string {
  return candidate.module.variants[candidate.levels[candidate.levelIndex]] ?? '';
}

/** Neighbours in the same named group sit closer together than groups do. */
function sameGroup(left: Candidate, right: Candidate): boolean {
  const group = left.module.group;
  return Boolean(group) && group === right.module.group;
}

function joinCandidates(items: Candidate[], separator: string, groupSeparator: string): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      out += sameGroup(items[i - 1], items[i]) ? groupSeparator : separator;
    }
    out += currentText(items[i]);
  }
  return out;
}

function totalWidth(candidates: Candidate[], separatorWidth: number, groupSeparatorWidth: number): number {
  const live = candidates.filter((candidate) => !candidate.dropped);
  if (live.length === 0) {
    return 0;
  }
  let total = visualLength(currentText(live[0]));
  for (let i = 1; i < live.length; i++) {
    total += sameGroup(live[i - 1], live[i]) ? groupSeparatorWidth : separatorWidth;
    total += visualLength(currentText(live[i]));
  }
  return total;
}

/**
 * Where the right-aligned cluster starts: the longest run of trailing modules
 * that all asked to be right-aligned. A stray right-aligned module in the
 * middle of the bar stays where it is rather than reordering the line.
 */
function rightClusterStart(live: Candidate[]): number {
  let start = live.length;
  while (start > 0 && live[start - 1].module.align === 'right') {
    start -= 1;
  }
  return start;
}

/**
 * Pick the least important module that still has room to give, preferring the
 * lowest priority. Returns undefined when every live module is already at its
 * shortest form.
 */
function nextToShorten(candidates: Candidate[]): Candidate | undefined {
  let chosen: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate.dropped || candidate.levelIndex >= candidate.levels.length - 1) {
      continue;
    }
    if (!chosen || candidate.module.priority < chosen.module.priority) {
      chosen = candidate;
    }
  }
  return chosen;
}

function nextToHide(candidates: Candidate[]): Candidate | undefined {
  let chosen: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate.dropped || candidate.module.pinned) {
      continue;
    }
    if (!chosen || candidate.module.priority < chosen.module.priority) {
      chosen = candidate;
    }
  }
  return chosen;
}

export function fitModules(
  modules: BarModule[],
  options: { width: number; separator: string; groupSeparator?: string }
): FitResult {
  const groupSeparator = options.groupSeparator ?? DEFAULT_GROUP_SEPARATOR;
  const separatorWidth = visualLength(options.separator);
  const groupSeparatorWidth = visualLength(groupSeparator);
  const candidates: Candidate[] = modules
    .map((module) => ({ module, levels: availableLevels(module), levelIndex: 0, dropped: false }))
    .filter((candidate) => candidate.levels.length > 0);

  if (options.width <= 0 || candidates.length === 0) {
    return { line: '', kept: [], levels: {}, clipped: false };
  }

  // Shorten everything that can be shortened before hiding anything, then hide
  // from the bottom of the priority order upwards.
  while (totalWidth(candidates, separatorWidth, groupSeparatorWidth) > options.width) {
    const shorten = nextToShorten(candidates);
    if (shorten) {
      shorten.levelIndex += 1;
      continue;
    }
    const hide = nextToHide(candidates);
    if (hide) {
      hide.dropped = true;
      continue;
    }
    break;
  }

  const live = candidates.filter((candidate) => !candidate.dropped);
  const joined = joinCandidates(live, options.separator, groupSeparator);
  const clipped = visualLength(joined) > options.width;

  let line = joined;
  if (clipped) {
    line = truncateAnsi(joined, options.width);
  } else {
    // The trailing cluster is pushed to the last column with plain spaces.
    // Only slack is spent on this, so the line never grows past the pane.
    const start = rightClusterStart(live);
    if (start < live.length) {
      const left = joinCandidates(live.slice(0, start), options.separator, groupSeparator);
      const right = joinCandidates(live.slice(start), options.separator, groupSeparator);
      const gap = options.width - visualLength(left) - visualLength(right);
      if (gap > 0) {
        line = left + ' '.repeat(gap) + right;
      }
    }
  }

  return {
    line,
    kept: live.map((candidate) => candidate.module.id),
    levels: Object.fromEntries(
      live.map((candidate) => [candidate.module.id, candidate.levels[candidate.levelIndex]])
    ),
    clipped,
  };
}
