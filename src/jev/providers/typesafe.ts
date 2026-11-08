// TypeSafe wire format, verbatim from Jev Ultrafast model.py choose() (github.com/browser-use/jev-ultrafast @ 1231850a).

import type { Answer, DecisionProvider, DecisionResult } from '../decide.js';
import { JUDGE_NO, JUDGE_RULES, JUDGE_YES, type JudgmentRequest } from '../judge.js';
import { postJson, type DecisionQuestion, type DecisionRequest } from '../model.js';

export function buildTypeSafeBody(request: DecisionRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const question of request.questions) questions[question.name] = typeSafeQuestion(question, request.goal);
  return {
    model,
    state: { page: request.page, elements: request.elements, recent_actions: request.recentActions },
    questions,
  };
}

function typeSafeQuestion(question: DecisionQuestion, goal: string): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  for (const choice of question.choices) criteria[choice.value] = choice.description;
  if (question.name === 'operation') {
    return { type: 'choice', criteria, instructions: { goal, rules: question.rules } };
  }
  return { type: 'choice', criteria, instructions: { goal, operation: question.operation, rules: question.rules } };
}

export function buildTypeSafeJudgmentBody(request: JudgmentRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const statement of request.statements) {
    questions[statement.name] = {
      type: 'choice',
      criteria: { yes: JUDGE_YES, no: JUDGE_NO },
      instructions: { goal: statement.statement, rules: JUDGE_RULES },
    };
  }
  for (const choice of request.choices ?? []) {
    const criteria: Record<string, unknown> = {};
    for (const item of choice.choices) criteria[item.value] = item.description;
    questions[choice.name] = {
      type: 'choice',
      criteria,
      instructions: { goal: choice.statement, rules: JUDGE_RULES },
    };
  }
  return {
    model,
    state: { page: request.page, elements: request.elements, facts: request.facts, deltas: request.deltas },
    questions,
  };
}

export function parseTypeSafeJudgment(payload: unknown): Answer[] {
  return parseTypeSafeAnswers(payload).map((answer) => {
    if (answer.kind !== 'choice') return answer;
    if (!Object.prototype.hasOwnProperty.call(answer.probabilities, 'yes')) return answer;
    const yes = answer.probabilities.yes;
    return { name: answer.name, kind: 'predicate', probability: typeof yes === 'number' ? yes : Number.NaN };
  });
}

export function parseTypeSafeAnswers(payload: unknown): Answer[] {
  const answers = (payload as { answers?: Record<string, unknown> } | null)?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  return Object.entries(answers).map(([name, value]) => {
    const answer = (value ?? {}) as { choice?: unknown; probabilities?: unknown; confidence?: unknown };
    const probabilities: Record<string, number> = {};
    if (answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)) {
      for (const [key, probability] of Object.entries(answer.probabilities)) {
        probabilities[key] = typeof probability === 'number' ? probability : Number.NaN;
      }
    }
    return {
      name,
      kind: 'choice' as const,
      choice: typeof answer.choice === 'string' ? answer.choice : '',
      probabilities,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : Number.NaN,
    };
  });
}

export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly id = 'typesafe' as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetcher?: typeof fetch;
  readonly #url?: string;

  constructor(options: { apiKey: string; model?: string; fetcher?: typeof fetch; url?: string }) {
    this.model = options.model || 'jev-latest';
    this.#apiKey = options.apiKey;
    this.#fetcher = options.fetcher;
    this.#url = options.url;
  }

  async decide(request: DecisionRequest, options: { signal?: AbortSignal; cacheKey: string }): Promise<DecisionResult> {
    const started = performance.now();
    const body = buildTypeSafeBody(request, this.model);
    const raw = await postJson(
      this.#url ?? 'https://api.typesafe.ai/v1/systemone',
      this.#apiKey,
      body,
      options.signal,
      this.#fetcher
    );
    const usage = (raw as { usage?: DecisionResult['usage'] } | null)?.usage ?? {};
    return { answers: parseTypeSafeAnswers(raw), usage, latencyMs: Math.round(performance.now() - started), raw };
  }

  async judge(request: JudgmentRequest, options: { signal?: AbortSignal; cacheKey: string }): Promise<DecisionResult> {
    const started = performance.now();
    const raw = await postJson(
      this.#url ?? 'https://api.typesafe.ai/v1/systemone',
      this.#apiKey,
      buildTypeSafeJudgmentBody(request, this.model),
      options.signal,
      this.#fetcher
    );
    const usage = (raw as { usage?: DecisionResult['usage'] } | null)?.usage ?? {};
    return { answers: parseTypeSafeJudgment(raw), usage, latencyMs: Math.round(performance.now() - started), raw };
  }
}
