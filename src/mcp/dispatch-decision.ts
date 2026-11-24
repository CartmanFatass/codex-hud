import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ModelRuntimeStore } from '../collectors/model-runtime-store.js';
import { selectDecisionProvider, type DecisionResult } from '../jev/decide.js';
import type { JudgmentRequest } from '../jev/judge.js';
import { OPENAI_NONE_CHOICE, renormalizeOpenAIChoice, validateChoice } from '../jev/model.js';
import type { HudSettings } from '../settings.js';

export async function dispatchDecision(
  hudHome: string,
  settings: HudSettings,
  key: string,
  request: JudgmentRequest,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  try {
    const store = new ModelRuntimeStore(join(hudHome, 'display', 'model-cache', 'decision-api'));
    const cappedFetch: typeof fetch = async (url, init) => {
      const reservation = await store.reserve(null, randomUUID(), settings.decisionCallsPerHour,
        Date.now, () => signal.aborted, undefined, key);
      signal.throwIfAborted();
      if (reservation.kind !== 'reserved') throw new Error('decision_cap_reached');
      return fetch(url, init);
    };
    const judge = async () => {
      const provider = await selectDecisionProvider(settings.decisionApi, { ...(options.env ?? process.env), HUD_HOME: hudHome }, cappedFetch);
      return provider.judge!(request, { signal, cacheKey: key });
    };
    // Bound provider selection, budget coordination and response parsing as well as the HTTP request.
    const result = await Promise.race([judge(), new Promise<undefined>((done) =>
      signal.addEventListener('abort', () => done(undefined), { once: true }))]);
    return result ? { result } : { failure: 'timeout' as const };
  } catch {
    return { failure: signal.aborted ? 'timeout' as const : 'unavailable' as const };
  }
}

export function dispatchChoice<T extends string>(result: DecisionResult, name: string, choices: readonly T[]): T | undefined {
  const answer = result.answers.find((item) => item.name === name);
  if (answer?.kind !== 'choice' || !choices.some(value => value === answer.choice)) return;
  const ids: string[] = [...choices];
  if (ids.length === 1 && result.provider !== 'typesafe') ids.push(OPENAI_NONE_CHOICE);
  try {
    const { choice } = result.provider === 'openai' ? renormalizeOpenAIChoice(answer, ids) : validateChoice(answer, ids);
    return choices.find(value => value === choice);
  } catch { /* Unavailable or invalid decision: retain the role's launch default. */ }
}
