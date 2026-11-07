// Ported from Jev Ultrafast agent.py (github.com/browser-use/jev-ultrafast @ 1231850a), MIT License, Copyright (c) 2026 Browser Use. Deviations: async command/run/close; DecisionProvider argument; optional text model; setGoal keeps history and restarts per-phase budgets; one refusal re-ask per predict, then DecisionRefused.

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Browser, StalePage, type Browser as BrowserInstance } from './browser.js';
import {
  choose,
  DecisionRefused,
  type DecisionProvider,
  type RefusedDecision,
  type ResolvedDecision,
} from './decide.js';
import {
  actionSpace,
  fieldContext,
  fieldText,
  pythonJson,
  type ElementRecord,
  type ObservedAction,
  type PageState,
  type RecentAction,
  type TextHelper,
} from './model.js';
import { MAX_STEPS } from './questions.js';

export interface TextProvider {
  readonly model?: string;
  fieldText(
    context: ReturnType<typeof fieldContext>,
    options?: { signal?: AbortSignal }
  ): Promise<{ text: string; helper: TextHelper }>;
}

export interface HistoryEntry extends RecentAction {
  step: number;
  choice: string;
  probability: number;
  confidence: number;
  latency_ms: number;
  text_helper: string | null;
  text_latency_ms: number;
  operation: string;
  target: string | null;
  url: string;
  usage: Record<string, unknown>;
  executed_ms: number;
  elapsed_ms: number;
}

export interface AgentState {
  browser: BrowserPort;
  goal: string;
  page: PageState;
  decision: ResolvedDecision | null;
  history: HistoryEntry[];
  status: string;
  plan: string[];
  plan_index: number;
  decisions: unknown[];
  text_calls: unknown[];
  elapsed_ms: number;
  started_at: number | null;
  record: boolean;
}

export interface BrowserPort {
  fresh(page: PageState, action?: ObservedAction | null): boolean | Promise<boolean>;
  observe(screenshot?: boolean): PageState | Promise<PageState>;
  act(action: ObservedAction, page: PageState, text?: string | null): unknown;
  close(): void | Promise<void>;
}

export interface AgentSnapshot extends Omit<AgentState, 'browser'> {
  elements: ElementRecord[];
  text_model: string;
}

export interface AgentOptions {
  browser: BrowserPort;
  provider: DecisionProvider;
  text?: TextProvider | null;
  screenshots?: boolean;
  recordDir?: string | null;
  cacheKey?: string;
  goal?: string;
  page?: PageState;
  state?: Partial<AgentState>;
}

function taskText(goals: string | string[]): string {
  const task = (typeof goals === 'string' ? goals : goals.join('\n')).trim();
  if (!task) throw new Error('Supply a task');
  return task;
}

/** Optional text model. Without TEXT_MODEL_API_KEY the provider is absent and fill is not offered. */
export function textProviderFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch): TextProvider | null {
  if (!env.TEXT_MODEL_API_KEY) return null;
  return {
    model: env.TEXT_MODEL || 'deepseek-chat',
    async fieldText(context, options) {
      const [text, helper] = await fieldText(context, env, fetcher, options?.signal);
      return { text, helper };
    },
  };
}

export class Agent {
  readonly state: AgentState;
  readonly screenshots: boolean;
  pendingText: { key: string; text: string; helper: TextHelper } | null = null;
  private phaseOrigin = 0;
  private phaseDecisions = 0;
  private readonly recordDir: string | null;
  private readonly cacheKey: string;
  private readonly controller = new AbortController();

  constructor(
    private readonly provider: DecisionProvider,
    private readonly text: TextProvider | null,
    state: AgentState,
    options: { screenshots?: boolean; recordDir?: string | null; cacheKey?: string } = {}
  ) {
    this.state = state;
    this.screenshots = options.screenshots ?? false;
    this.recordDir = options.recordDir ?? null;
    this.cacheKey = options.cacheKey ?? `hud-jev:${randomUUID()}`;
  }

  static async open(
    url: string,
    goals: string | string[],
    options: {
      provider: DecisionProvider;
      text?: TextProvider | null;
      cdpUrl?: string;
      timeoutMs?: number;
      screenshots?: boolean;
      recordDir?: string | null;
      cacheKey?: string;
    }
  ): Promise<Agent> {
    const task = taskText(goals);
    const screenshots = options.screenshots || Boolean(options.recordDir);
    const browser = await Browser.open(url, { cdpUrl: options.cdpUrl, timeoutMs: options.timeoutMs });
    try {
      const page = await browser.observe(screenshots);
      const agent = new Agent(
        options.provider,
        options.text === undefined ? textProviderFromEnv() : options.text,
        initialState(browser, task, page, Boolean(options.recordDir)),
        {
          screenshots,
          recordDir: options.recordDir,
          cacheKey: options.cacheKey,
        }
      );
      if (options.recordDir) {
        mkdirSync(options.recordDir, { recursive: true });
        if (page.screenshot) writeFileSync(`${options.recordDir}/000000.jpg`, Buffer.from(page.screenshot, 'base64'));
      }
      return agent;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  /** Clear the current decision and count the next phase on its own. History stays. */
  setGoal(goal: string): void {
    const task = taskText(goal);
    this.state.decision = null;
    this.state.status = 'ready';
    this.state.plan_index = 0;
    this.state.goal = task;
    this.state.plan = [task];
    this.phaseOrigin = this.state.history.length;
    this.phaseDecisions = 0;
    this.pendingText = null;
  }

  snapshot(): AgentSnapshot {
    const { browser: _browser, ...rest } = this.state;
    return {
      ...rest,
      elements: actionSpace(this.state.page.actions, this.text != null)[0],
      text_model: this.text ? (this.text.model ?? 'configured') : 'unconfigured',
    };
  }

  async command(name: string, body: { fingerprint?: string } = {}): Promise<AgentSnapshot> {
    if (name === 'tick') {
      try {
        await this.command('predict');
        return await this.command('act', { fingerprint: this.state.page.fingerprint });
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        this.state.decision = null;
        this.state.status = 'ready';
        this.state.page = await Promise.resolve(this.state.browser.observe(this.screenshots));
        this.touchElapsed();
        return this.snapshot();
      }
    }
    if (name === 'predict') {
      await this.predict();
      return this.snapshot();
    }
    if (name === 'act') {
      await this.act(body);
      return this.snapshot();
    }
    throw new Error('Unknown command');
  }

  async *run(): AsyncGenerator<AgentSnapshot> {
    while (this.state.status !== 'done' && this.state.status !== 'blocked') yield this.command('tick');
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.state.browser.close();
  }

  private touchElapsed(): void {
    if (this.state.started_at != null) this.state.elapsed_ms = Math.round(performance.now() - this.state.started_at);
  }

  private async predict(reasked = false): Promise<void> {
    if (!this.state.browser) throw new Error('Start a demo first');
    if (this.state.started_at == null) this.state.started_at = performance.now();
    if (!(await Promise.resolve(this.state.browser.fresh(this.state.page)))) {
      this.state.page = await Promise.resolve(this.state.browser.observe(this.screenshots));
    }
    this.state.decision = null;
    if (this.state.status === 'done' || this.state.status === 'blocked') {
      throw new Error('This run has stopped. Start a fresh demo.');
    }
    if (this.phaseDecisions >= MAX_STEPS * 2) throw new Error("Reached the demo's model-call budget");
    this.phaseDecisions += 1;
    const outcome = await choose(this.state.page, this.state.goal, this.state.history, this.provider, {
      signal: this.controller.signal,
      cacheKey: this.cacheKey,
      includeFill: this.text != null,
    });
    if ('refused' in outcome && outcome.refused) {
      await this.noteRefusal(outcome, reasked);
      return;
    }
    const decision = outcome as ResolvedDecision;
    this.state.decision = decision;
    this.state.decisions.push({ ...decision, fingerprint: this.state.page.fingerprint, elapsed_ms: this.elapsed() });
    this.state.status = 'predicted';
  }

  /** One re-ask per predict. A changing fingerprint must not start another paid loop. */
  private async noteRefusal(outcome: RefusedDecision, reasked: boolean): Promise<void> {
    const fingerprint = this.state.page.fingerprint ?? '';
    this.state.decision = null;
    this.state.decisions.push({ refused: true, question: outcome.question, fingerprint, elapsed_ms: this.elapsed() });
    if (reasked) {
      this.state.status = 'blocked';
      throw new DecisionRefused(outcome.question);
    }
    this.state.page = await Promise.resolve(this.state.browser.observe(this.screenshots));
    await this.predict(true);
  }

  private elapsed(): number {
    return this.state.started_at == null ? 0 : Math.round(performance.now() - this.state.started_at);
  }

  private async act(body: { fingerprint?: string }): Promise<void> {
    const decision = this.state.decision;
    const page = this.state.page;
    if (!decision || body.fingerprint !== page.fingerprint) throw new Error('Observe and choose before acting');
    // Consume once, before any mutation or model call. A retry cannot double-click.
    this.state.decision = null;
    const selected = decision.choice;
    if (selected === 'DONE' || selected === 'BLOCKED') {
      if (!(await Promise.resolve(this.state.browser.fresh(page)))) {
        this.state.status = 'ready';
        throw new StalePage('Page changed since the decision. Choose again.');
      }
      this.state.status = selected === 'DONE' ? 'done' : 'blocked';
      this.state.plan_index = selected === 'DONE' ? 1 : 0;
      this.touchElapsed();
      return;
    }
    const action = page.actions.find((item) => item.id === selected);
    if (!action) throw new Error('Chosen action is not on the observed page');
    if (this.state.history.length - this.phaseOrigin >= MAX_STEPS) {
      this.state.status = 'blocked';
      throw new Error(`Stopped at the ${MAX_STEPS}-action demo budget`);
    }
    let text: string | null = null;
    let helper: TextHelper | null = null;
    if (action.kind === 'fill') {
      if (!(await Promise.resolve(this.state.browser.fresh(page)))) {
        throw new StalePage('Page changed before text generation. Choose again.');
      }
      const context = fieldContext(this.state.goal, action, page, this.state.history);
      const key = pythonJson(context);
      if (this.pendingText && this.pendingText.key === key) {
        text = this.pendingText.text;
        helper = this.pendingText.helper;
      } else if (!this.text) {
        throw new Error('TYPE_TEXT needs TEXT_MODEL_API_KEY; no text is hardcoded or guessed by the executor.');
      } else {
        const generated = await this.text.fieldText(context, { signal: this.controller.signal });
        text = generated.text;
        helper = generated.helper;
        this.pendingText = { key, text, helper };
        this.state.text_calls.push({ ...helper, field: action.label, value: text });
      }
    }
    await Promise.resolve(this.state.browser.act(action, page, text));
    this.pendingText = null;
    this.touchElapsed();
    this.state.history.push({
      step: this.state.history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: selected,
      probability: decision.probabilities[selected],
      confidence: decision.confidence,
      latency_ms: decision.latency_ms,
      text,
      text_helper: helper?.model ?? null,
      text_latency_ms: helper?.latency_ms ?? 0,
      operation: decision.operation,
      target: decision.target,
      page_changed: null,
      url: page.url,
      usage: decision.usage as Record<string, unknown>,
      executed_ms: this.elapsed(),
      elapsed_ms: this.state.elapsed_ms,
    });
    this.state.page = await Promise.resolve(this.state.browser.observe(this.screenshots));
    this.touchElapsed();
    const current = this.state.history[this.state.history.length - 1];
    current.page_changed = this.state.page.fingerprint !== page.fingerprint;
    current.url = this.state.page.url;
    current.elapsed_ms = this.state.elapsed_ms;
    if (this.recordDir && this.state.page.screenshot) {
      writeFileSync(
        `${this.recordDir}/${String(this.state.elapsed_ms).padStart(6, '0')}.jpg`,
        Buffer.from(this.state.page.screenshot, 'base64')
      );
    }
    const repeated = this.state.history.slice(this.phaseOrigin).slice(-3);
    this.state.status =
      repeated.length === 3 && repeated.every((entry) => entry.page_changed === false && entry.kind !== 'wait')
        ? 'blocked'
        : 'ready';
  }
}

function initialState(browser: BrowserInstance, task: string, page: PageState, record: boolean): AgentState {
  return {
    browser,
    goal: task,
    page,
    decision: null,
    history: [],
    status: 'ready',
    plan: [task],
    plan_index: 0,
    decisions: [],
    text_calls: [],
    elapsed_ms: 0,
    started_at: null,
    record,
  };
}
