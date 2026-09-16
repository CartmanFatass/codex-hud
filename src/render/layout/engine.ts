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

function availableLevels(module: BarModule): VariantLevel[] {
  return VARIANT_ORDER.filter((level) => {
    const text = module.variants[level];
    return typeof text === 'string' && text.length > 0;
  });
}

function currentText(candidate: Candidate): string {
  return candidate.module.variants[candidate.levels[candidate.levelIndex]] ?? '';
}

function totalWidth(candidates: Candidate[], separatorWidth: number): number {
  const live = candidates.filter((candidate) => !candidate.dropped);
  if (live.length === 0) {
    return 0;
  }
  const content = live.reduce((sum, candidate) => sum + visualLength(currentText(candidate)), 0);
  return content + separatorWidth * (live.length - 1);
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
  options: { width: number; separator: string }
): FitResult {
  const separatorWidth = visualLength(options.separator);
  const candidates: Candidate[] = modules
    .map((module) => ({ module, levels: availableLevels(module), levelIndex: 0, dropped: false }))
    .filter((candidate) => candidate.levels.length > 0);

  if (options.width <= 0 || candidates.length === 0) {
    return { line: '', kept: [], levels: {}, clipped: false };
  }

  // Shorten everything that can be shortened before hiding anything, then hide
  // from the bottom of the priority order upwards.
  while (totalWidth(candidates, separatorWidth) > options.width) {
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
  const line = live.map(currentText).join(options.separator);
  const clipped = visualLength(line) > options.width;

  return {
    line: clipped ? truncateAnsi(line, options.width) : line,
    kept: live.map((candidate) => candidate.module.id),
    levels: Object.fromEntries(
      live.map((candidate) => [candidate.module.id, candidate.levels[candidate.levelIndex]])
    ),
    clipped,
  };
}
