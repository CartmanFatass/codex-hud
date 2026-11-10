// Decision backend interface extracted from Jev Ultrafast model.py choose() (github.com/browser-use/jev-ultrafast @ 1231850a).
// Wire formats live in providers/. validateChoice stays in model.ts and is unchanged for TypeSafe.

import type { JudgmentRequest } from './judge.js';
import {
  buildDecisionRequest,
  DecisionInvalid,
  OPENAI_NONE_CHOICE,
  renormalizeOpenAIChoice,
  validateChoice,
  type BuiltDecision,
  type ChoiceAnswer,
  type DecisionRequest,
  type PageState,
  type RecentAction,
} from './model.js';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cached_tokens?: number;
}

export type Answer =
  | { name: string; kind: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { name: string; kind: 'predicate'; probability: number }
  | { name: string; kind: 'refusal' };

export type DecisionProviderId = 'typesafe' | 'openai';

export interface DecisionResult {
  /** Actual responder, including per-call failover. */
  provider?: DecisionProviderId;
  model?: string;
  answers: Answer[];
  usage: Usage;
  latencyMs: number;
  raw: unknown;
}

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  readonly model: string;
  decide(request: DecisionRequest, options: { signal?: AbortSignal; cacheKey: string }): Promise<DecisionResult>;
  /**
   * Read-only page judgments. Both built-in providers implement this.
   * A decide-only test double may omit it; judgment callers must not.
   */
  judge?(request: JudgmentRequest, options: { signal?: AbortSignal; cacheKey: string }): Promise<DecisionResult>;
}

/**
 * Explicit provider wins. With none set, TypeSafe wins when its key is present,
 * including when both keys are present. The result names a variable, never a key value.
 */
export function decideProviderId(
  explicit: DecisionProviderId | undefined,
  present: { typesafe: boolean; openai: boolean }
): { ok: true; provider: DecisionProviderId } | { ok: false; provider: DecisionProviderId; variable: string } {
  if (explicit === 'typesafe' || !explicit) {
    return present.typesafe
      ? { ok: true, provider: 'typesafe' }
      : { ok: false, provider: 'typesafe', variable: 'TYPESAFE_API_KEY' };
  }
  if (explicit === 'openai') {
    return present.openai
      ? { ok: true, provider: 'openai' }
      : { ok: false, provider: 'openai', variable: 'OPENAI_API_KEY' };
  }
  return { ok: false, provider: 'typesafe', variable: 'TYPESAFE_API_KEY' };
}

export interface ResolvedDecision {
  choice: string;
  operation: string;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  operation_probabilities: Record<string, number>;
  target_probabilities: Record<string, number>;
  target_confidence: number | null;
  raw_answers: Answer[];
  model: string;
  usage: Usage;
  latency_ms: number;
  request: DecisionRequest;
}

export interface RefusedDecision {
  refused: true;
  question: string;
  operation?: string;
}

export class DecisionRefused extends Error {
  readonly code = 'decision_refused';
  constructor(readonly question = 'operation') {
    super('decision_refused');
    this.name = 'DecisionRefused';
  }
}

export class JevCredentialsMissing extends Error {
  readonly code = 'jev_credentials_missing';
  constructor(
    readonly provider: 'openai' | 'typesafe',
    readonly variable: string
  ) {
    super('jev_credentials_missing');
    this.name = 'JevCredentialsMissing';
  }
}

function checked(answer: Answer, ids: string[], providerId: DecisionProvider['id']): ChoiceAnswer {
  if (answer.kind !== 'choice') throw new DecisionInvalid();
  return providerId === 'openai' ? renormalizeOpenAIChoice(answer, ids) : validateChoice(answer, ids);
}

/** Consume only the target head selected by the operation. An unselected head cannot cause an action. */
export function resolveDecision(
  built: BuiltDecision,
  answers: Answer[],
  providerId: DecisionProvider['id']
): Omit<ResolvedDecision, 'model' | 'usage' | 'latency_ms'> | RefusedDecision {
  const operationAnswer = answers.find((answer) => answer.name === 'operation');
  if (!operationAnswer) throw new DecisionInvalid();
  if (operationAnswer.kind === 'refusal') return { refused: true, question: 'operation' };
  const operationIds = built.request.questions[0]?.choices.map((choice) => choice.value) ?? [];
  const operation = checked(operationAnswer, operationIds, providerId);
  const selected = operation.choice;
  const base = { raw_answers: answers, request: built.request };
  if (Object.prototype.hasOwnProperty.call(built.targets, selected)) {
    const question = `${selected.toLowerCase()}_target`;
    const targetAnswer = answers.find((answer) => answer.name === question);
    if (!targetAnswer) throw new DecisionInvalid();
    if (targetAnswer.kind === 'refusal') return { refused: true, question, operation: selected };
    const ids = Object.keys(built.targets[selected]);
    const checkIds = providerId === 'openai' && ids.length === 1 ? [...ids, OPENAI_NONE_CHOICE] : ids;
    const target = checked(targetAnswer, checkIds, providerId);
    if (target.choice === OPENAI_NONE_CHOICE) return { refused: true, question, operation: selected };
    const probabilities: Record<string, number> = {};
    for (const [index, action] of Object.entries(built.targets[selected])) {
      probabilities[action.id] = target.probabilities[index];
    }
    return {
      ...base,
      choice: built.targets[selected][target.choice].id,
      operation: selected,
      target: target.choice,
      confidence: operation.confidence,
      probabilities,
      operation_probabilities: operation.probabilities,
      target_probabilities: target.probabilities,
      target_confidence: target.confidence,
    };
  }
  const choice = built.controls[selected]?.id ?? selected;
  return {
    ...base,
    choice,
    operation: selected,
    target: null,
    confidence: operation.confidence,
    probabilities: { [choice]: operation.probabilities[selected] },
    operation_probabilities: operation.probabilities,
    target_probabilities: {},
    target_confidence: null,
  };
}

export async function choose(
  state: PageState,
  goal: string,
  history: RecentAction[],
  provider: DecisionProvider,
  options: { signal?: AbortSignal; cacheKey: string; includeFill?: boolean }
): Promise<ResolvedDecision | RefusedDecision> {
  const built = buildDecisionRequest(state, goal, history, options.includeFill !== false);
  const result = await provider.decide(built.request, options);
  const resolved = resolveDecision(built, result.answers, result.provider ?? provider.id);
  if ('refused' in resolved) return resolved;
  const reported =
    result.raw && typeof result.raw === 'object' && typeof (result.raw as { model?: unknown }).model === 'string'
      ? (result.raw as { model: string }).model
      : (result.model ?? provider.model);
  return { ...resolved, model: reported, usage: result.usage, latency_ms: result.latencyMs };
}

/** HUD primary/fallback, with an optional per-call primary override. */
export async function selectDecisionProvider(
  explicit?: DecisionProviderId,
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch
): Promise<DecisionProvider> {
  const { readHudCredentials, readHudConfig, resolveDecisions } = await import('./ask/config.js');
  const { getHudHome } = await import('../hud-home.js');
  const { join } = await import('node:path');
  const { FailoverDecisionProvider } = await import('./failover.js');
  const { OpenAIDecisionProvider } = await import('./providers/openai.js');
  const { TypeSafeDecisionProvider } = await import('./providers/typesafe.js');
  const creds = readHudCredentials(env);
  const config = resolveDecisions(readHudConfig(join(getHudHome(env), 'config.json')));
  const primary = explicit ?? config.primary;
  const make = (id: DecisionProviderId): DecisionProvider | undefined => {
    if (id === 'openai')
      return creds.openaiApiKey
        ? new OpenAIDecisionProvider({
            apiKey: creds.openaiApiKey,
            baseUrl: config.openai.baseUrl || creds.openaiBaseUrl,
            fetcher,
          })
        : undefined;
    return creds.typesafeApiKey
      ? new TypeSafeDecisionProvider({
          apiKey: creds.typesafeApiKey,
          model: config.typesafe.model || creds.typesafeModel,
          fetcher,
        })
      : undefined;
  };
  const first = make(primary);
  const fallback = config.fallback !== primary ? make(config.fallback) : undefined;
  if (!first && !fallback)
    throw new JevCredentialsMissing(primary, primary === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY');
  return new FailoverDecisionProvider(primary, first, fallback);
}
