// Ported from Jev Ultrafast model.py (github.com/browser-use/jev-ultrafast @ 1231850a), MIT License, Copyright (c) 2026 Browser Use. Deviations: fetch instead of httpx; each attempt times out at 25s; DecisionProvider replaces the hardcoded TypeSafe choose(); fill candidates are omitted when no text model is configured.

import { NEXT_ACTION, TARGET, TEXT_VALUE } from './questions.js';

export class DecisionInvalid extends Error {
  readonly code = 'decision_invalid';
  constructor(message = 'Invalid TypeSafe response; no action executed.') {
    super(message);
    this.name = 'DecisionInvalid';
  }
}

/** HTTP failure or a network failure. No action is executed. */
export class DecisionProviderError extends Error {
  readonly code = 'decision_provider_error';
  constructor(
    readonly providerCause: 'network' | 'http' | 'timeout',
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(
      providerCause !== 'http'
        ? `decision_provider_error:${providerCause}`
        : `decision_provider_error:${status ?? 'unknown'}`
    );
    this.name = 'DecisionProviderError';
  }
}

export interface ObservedAction {
  id: string;
  kind: string;
  label: string;
  role?: string;
  value?: string;
  node?: number;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string;
  current_value?: string;
  delta?: number;
}

export interface ElementRecord {
  index: string;
  label: string;
  operations: string[];
  role?: string;
  value?: string;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string;
  options?: Array<{ index: string; label: string; value?: string }>;
}

export interface ChoiceDescription {
  element: string;
  current_value: string;
  role?: string;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string;
}

export interface Choice {
  value: string;
  description: string | ChoiceDescription;
}

export type DecisionQuestion =
  | { name: 'operation'; choices: Choice[]; rules: string }
  | { name: `${string}_target`; operation: string; choices: Choice[]; rules: string[] };

export interface RecentAction {
  action: string | null;
  kind: string | null;
  text: string | null;
  page_changed: boolean | null;
}

export interface DecisionRequest {
  page: { url: string; title: string; text: string };
  elements: ElementRecord[];
  recentActions: RecentAction[];
  goal: string;
  questions: DecisionQuestion[];
}

export interface PageState {
  url: string;
  title?: string;
  text: string;
  scroll?: { y?: number; height?: number };
  actions: ObservedAction[];
  fingerprint?: string;
  marker?: unknown;
  page_key?: unknown;
  guards?: Record<string, unknown>;
  screenshot?: string;
}

export interface BuiltDecision {
  request: DecisionRequest;
  elements: ElementRecord[];
  targets: Record<string, Record<string, ObservedAction>>;
  controls: Record<string, ObservedAction>;
}

export interface FieldContext {
  goal: string;
  field: { label: string | null; role: string | null; value: string | null };
  page: { title: string | null; text: string };
  recent_actions: Array<{ action: string | null; text: string | null }>;
}

export interface TextHelper {
  model: string;
  latency_ms: number;
  usage: Record<string, unknown>;
}

/** OpenAI Decisions rejects a choices array shorter than 2. A one-candidate target gains this choice. */
export const OPENAI_NONE_CHOICE = 'NONE';
export const OPENAI_NONE_DESCRIPTION = 'No observed element fits this operation.';

/** One HTTP attempt. Upstream httpx used 25 seconds. A caller abort is not this timer. */
export const DECISION_ATTEMPT_TIMEOUT_MS = 25_000;

const OPERATION_NAMES: Record<string, string> = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' };
const LABELS: Record<string, string> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Python json.dumps(..., sort_keys=True) with default separators and ensure_ascii. */
export function pythonJson(value: unknown): string {
  return dump(value);
}

function pythonString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const rest = code - 0x10000;
        const high = 0xd800 + (rest >> 10);
        const low = 0xdc00 + (rest & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      } else out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out + '"';
}

function dump(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid number');
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'string') return pythonString(value);
  if (Array.isArray(value)) return `[${value.map((item) => dump(item)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${pythonString(key)}: ${dump(item)}`).join(', ')}}`;
  }
  throw new Error('Unsupported JSON value');
}

export async function postJson(
  url: string,
  key: string,
  body: unknown,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  timeoutMs = DECISION_ATTEMPT_TIMEOUT_MS,
  maxAttempts = 3,
  wire?: { headers?: Record<string, string>; onHttpError?: (response: Response) => Promise<unknown> }
): Promise<unknown> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { ...(wire?.headers ?? { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: attemptSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DecisionProviderError(
        attemptSignal.aborted && attemptSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'network'
      );
    }
    if ((response.status === 429 || response.status === 503 || response.status === 529) && attempt < maxAttempts - 1) {
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    try {
      if (!response.ok) {
        if (wire?.onHttpError) return await wire.onHttpError(response);
        throw new DecisionProviderError('http', response.status);
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attemptSignal.aborted && attemptSignal.reason?.name === 'TimeoutError')
        throw new DecisionProviderError('timeout');
      // Malformed JSON and other body errors are not transport-timeout failover triggers.
      throw error;
    }
  }
  throw new DecisionProviderError('http', 529);
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Upstream validate_choice: full coverage, sum within 0.02, and choice is a maximum. */
export function validateChoice(answer: Partial<ChoiceAnswer> | null | undefined, ids: Iterable<string>): ChoiceAnswer {
  const idList = [...ids];
  const probabilities = answer?.probabilities;
  const choice = answer?.choice;
  const confidence = answer?.confidence;
  let valid = false;
  if (probabilities && typeof choice === 'string' && finiteUnit(confidence)) {
    const keys = Object.keys(probabilities);
    const values = Object.values(probabilities);
    const covered =
      keys.length === idList.length && idList.every((id) => Object.prototype.hasOwnProperty.call(probabilities, id));
    const sum = values.reduce((total, value) => total + value, 0);
    const max = values.length ? Math.max(...values) : Number.NEGATIVE_INFINITY;
    valid =
      idList.includes(choice) &&
      covered &&
      values.every((value) => finiteUnit(value)) &&
      Math.abs(sum - 1) < 0.02 &&
      probabilities[choice] >= max - 1e-6;
  }
  if (!valid) throw new DecisionInvalid();
  return answer as ChoiceAnswer;
}

/**
 * OpenAI may omit probabilities. If the returned mass is in [0.95, 1.02] and the choice is a maximum,
 * missing choices are filled with 0 and the distribution is renormalised. Mass above 1.02 is not a
 * missing-mass case. Otherwise DecisionInvalid. A distribution that already passes validateChoice is unchanged.
 */
export function renormalizeOpenAIChoice(
  answer: Partial<ChoiceAnswer> | null | undefined,
  ids: readonly string[]
): ChoiceAnswer {
  try {
    return validateChoice(answer, ids);
  } catch (error) {
    if (!(error instanceof DecisionInvalid)) throw error;
  }
  const probabilities = answer?.probabilities ?? {};
  const idSet = new Set(ids);
  if (Object.keys(probabilities).some((key) => !idSet.has(key))) throw new DecisionInvalid();
  if (!finiteUnit(answer?.confidence) || typeof answer?.choice !== 'string' || !idSet.has(answer.choice)) {
    throw new DecisionInvalid();
  }
  let mass = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(probabilities, id)) continue;
    const value = probabilities[id];
    if (!finiteUnit(value)) throw new DecisionInvalid();
    mass += value;
    if (value > max) max = value;
  }
  const chosen = probabilities[answer.choice];
  if (mass < 0.95 || mass > 1 + 0.02 || chosen === undefined || chosen < max - 1e-6) throw new DecisionInvalid();
  const filled: Record<string, number> = {};
  for (const id of ids) filled[id] = (probabilities[id] ?? 0) / mass;
  return { choice: answer.choice, probabilities: filled, confidence: answer.confidence };
}

/** One index per observed element; each operation has its own valid target choices. */
export function actionSpace(
  actions: ObservedAction[],
  includeFill = true
): [ElementRecord[], Record<string, Record<string, ObservedAction>>, Record<string, ObservedAction>] {
  const elements: ElementRecord[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, ObservedAction>> = {};
  const controls: Record<string, ObservedAction> = {};
  for (const action of actions) {
    const operation = OPERATION_NAMES[action.kind];
    if (!operation || (action.kind === 'fill' && !includeFill)) {
      if (!operation) controls[action.id.toUpperCase()] = action;
      continue;
    }
    const node = action.node;
    if (typeof node !== 'number') continue;
    let index = indices.get(node);
    if (!index) {
      index = String(elements.length + 1);
      indices.set(node, index);
      // Key order matches model.py: state fields, then index, label, operations, then select options.
      const element = {} as ElementRecord;
      if ('role' in action) element.role = action.role;
      if ('value' in action) element.value = action.value;
      if ('checked' in action) element.checked = action.checked;
      if ('selected' in action) element.selected = action.selected;
      if ('expanded' in action) element.expanded = action.expanded;
      element.index = index;
      element.label = action.label.split(' → ')[0];
      element.operations = [];
      if (action.kind === 'select') {
        element.value = action.current_value ?? '';
        element.options = [];
      }
      elements.push(element);
    }
    const element = elements[Number(index) - 1];
    const group = (targets[operation] ??= {});
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (action.kind === 'select') {
      const options = element.options ?? (element.options = []);
      target = `${index}:${options.length + 1}`;
      options.push({ index: target, label: action.label, value: action.value });
    }
    group[target] = action;
  }
  return [elements, targets, controls];
}

function criterion(action: ObservedAction, index: string): ChoiceDescription {
  const description: ChoiceDescription = {
    element: `[${index}] ${action.label}`,
    current_value: action.current_value ?? action.value ?? '',
  };
  for (const key of ['role', 'checked', 'selected', 'expanded'] as const) {
    if (key in action) description[key] = action[key] as never;
  }
  return description;
}

/** Backend-independent request. Operation first, then one speculative target question per operation. */
export function buildDecisionRequest(
  state: PageState,
  goal: string,
  history: RecentAction[],
  includeFill = true
): BuiltDecision {
  const [elements, targets, controls] = actionSpace(state.actions, includeFill);
  const operationChoices: Choice[] = [];
  for (const key of Object.keys(targets)) operationChoices.push({ value: key, description: LABELS[key] });
  for (const [key, action] of Object.entries(controls))
    operationChoices.push({ value: key, description: action.label });
  operationChoices.push(
    { value: 'DONE', description: 'Every requirement is visibly satisfied.' },
    { value: 'BLOCKED', description: 'No supported operation can progress.' }
  );
  const questions: DecisionQuestion[] = [{ name: 'operation', choices: operationChoices, rules: NEXT_ACTION }];
  for (const [operation, group] of Object.entries(targets)) {
    questions.push({
      name: `${operation.toLowerCase()}_target`,
      operation,
      choices: Object.entries(group).map(([index, action]) => ({
        value: index,
        description: criterion(action, index),
      })),
      rules: [NEXT_ACTION, TARGET],
    });
  }
  return {
    request: {
      page: { url: state.url, title: state.title ?? '', text: state.text.slice(0, 6000) },
      elements,
      recentActions: history.slice(-10).map((entry) => ({
        action: entry.action ?? null,
        kind: entry.kind ?? null,
        text: entry.text ?? null,
        page_changed: entry.page_changed ?? null,
      })),
      goal,
      questions,
    },
    elements,
    targets,
    controls,
  };
}

export function fieldContext(
  goal: string,
  action: ObservedAction,
  page: PageState,
  history: RecentAction[]
): FieldContext {
  return {
    goal,
    field: { label: action.label ?? null, role: action.role ?? null, value: action.value ?? null },
    page: { title: page.title ?? null, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((entry) => ({ action: entry.action ?? null, text: entry.text ?? null })),
  };
}

export async function fieldText(
  context: FieldContext,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<[string, TextHelper]> {
  const key = env.TEXT_MODEL_API_KEY;
  if (!key) {
    throw new Error('TYPE_TEXT needs TEXT_MODEL_API_KEY; no text is hardcoded or guessed by the executor.');
  }
  const base = (env.TEXT_MODEL_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = env.TEXT_MODEL || 'deepseek-chat';
  const reasoning =
    env.TEXT_MODEL_REASONING === 'none'
      ? { reasoning: { enabled: false } }
      : base.includes('api.deepseek.com/')
        ? { thinking: { type: 'disabled' } }
        : { reasoning: { effort: 'low' } };
  const started = performance.now();
  const result = (await postJson(
    `${base}/chat/completions`,
    key,
    {
      model,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      ...reasoning,
      messages: [
        { role: 'system', content: TEXT_VALUE },
        { role: 'user', content: pythonJson(context) },
      ],
    },
    signal,
    fetcher
  )) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
  try {
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('invalid');
    const output = JSON.parse(content) as { text?: unknown };
    const value = output.text;
    if (Object.keys(output).length !== 1 || !Object.prototype.hasOwnProperty.call(output, 'text'))
      throw new Error('invalid');
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('invalid');
    return [value, { model, latency_ms: Math.round(performance.now() - started), usage: result.usage ?? {} }];
  } catch (error) {
    if (error instanceof DecisionProviderError) throw error;
    throw new Error('Text helper returned no valid field value; nothing typed.');
  }
}
