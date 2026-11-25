import type { PrewalkScoutKind } from './job-contracts.js';

export const PREWALK_SCOUT_KINDS: readonly PrewalkScoutKind[] = ['code', 'docs', 'web'];
export const MAX_PREWALK_SCOUTS = 3;
export const PREWALK_ASK_MAX = 200;

export type PrewalkScoutRequest = {
  kind: PrewalkScoutKind;
  ask: string;
};

const BRIEF_SLICE = 16_000;
const CHECKOUT_ONLY = 'Search only inside this checkout (never `/`, `$HOME` or other drives). If the brief names a file without a path and it is not in this checkout, report it as "not found in checkout" instead of searching elsewhere.';

export function truncateScoutAsk(ask: string): string {
  const trimmed = ask.trim();
  const chars = [...trimmed];
  return chars.length > PREWALK_ASK_MAX ? chars.slice(0, PREWALK_ASK_MAX).join('') : trimmed;
}

export function prewalkScoutTask(kind: PrewalkScoutKind, ask: string, task: string): string {
  const brief = task.length > BRIEF_SLICE ? `${task.slice(0, BRIEF_SLICE)}\n[truncated]` : task;
  const prompt = kind === 'code'
    ? `Prewalk scout (code). Gather facts from this checkout for the question below, using the target brief as context: the files, symbols, commands and tests needed, with path:line citations. ${CHECKOUT_ONLY} Facts only: no design, diagnosis, recommendations or judgement. Do not edit files.`
    : kind === 'docs'
      ? `Prewalk scout (docs). Gather facts from this project's own documentation for the question below, using the target brief as context: the spec, design docs, tickets and decisions that bear on it, with path:line citations. ${CHECKOUT_ONLY} Facts only: no design, diagnosis, recommendations or judgement. Do not edit files.`
      : 'Prewalk scout (web). Gather primary external sources (official docs, specs, source repositories, release notes) for the question below, using the target brief as context, citing every claim with its URL. Search queries MUST name only public technologies, libraries, APIs or tools — NEVER include local file paths, repository names, internal symbols, private names or other private content from the question or brief. Facts only: no design, diagnosis, recommendations or judgement. Do not edit files.';
  const question = ask.trim();
  return question
    ? `${prompt}\n\n## Question\n\n${question}\n\n## Target Brief\n\n${brief}`
    : `${prompt}\n\n## Target Brief\n\n${brief}`;
}
