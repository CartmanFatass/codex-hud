// Distinct AI Studio adapter, ported from owner's aistudio.py/aistudio_cdp.py.
// Model selection is a read/refuse gate. No paid API key, consent or approval is ever clicked.
import { JevFailure } from '../ask/error.js';
import type { OperationRecord } from '../ask/records.js';
import { awaitState, type PageObservation } from '../judge.js';
import type { ObservedAction, PageState } from '../model.js';
import { makeReplyScript, SCROLL_JS, SEL_PROMPT, SEL_RUN, SETTINGS_JS } from './aistudio-facts.js';
import { normalizeStudioPrompt, type StudioConfig } from './aistudio-state.js';
import type { OracleBrowser, TargetBrowserOptions } from './chatgpt.js';
import { oracleDelay, type OracleFacts, type OraclePage, type OracleTarget } from './oracle.js';

export const STUDIO_PAGE_STATE = `(() => {
 const visible=e=>!!e&&e.getClientRects().length&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const sel=${JSON.stringify(SEL_PROMPT)}.find(s=>visible(document.querySelector(s)));
 const account=document.querySelector('ms-account-switcher button');
 const label=(account?.innerText||'')+' '+(account?.getAttribute('aria-label')||'');
 const dialogs=[...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(visible);
 return {url:location.href, readyState:document.readyState, selector:sel||null, composer:sel?document.querySelector(sel).value:null,
 authenticated:/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i.test(label),
 login:location.hostname==='accounts.google.com'||!![...document.querySelectorAll('a[href*="accounts.google.com/ServiceLogin"],button[aria-label="Sign in"]')].find(visible),
 dialog:dialogs.length>0, stop:!![...document.querySelectorAll('ms-run-button button')].find(e=>/stop/i.test(e.getAttribute('aria-label')||e.innerText||'')),
 page_error:location.protocol==='chrome-error:'};
})()`;
interface StudioState {
  url: string;
  readyState: string;
  selector: string | null;
  composer: string | null;
  login: boolean;
  authenticated?: boolean;
  dialog: boolean;
  stop: boolean;
  page_error: boolean;
}
interface Settings {
  model: string | null;
  selects: Record<string, string>;
  key_icon: string;
  run_disabled: boolean;
}
interface Reply {
  users: number;
  model_turns: number;
  final: boolean;
  text: string;
  error: string | null;
}
class StudioPage implements OraclePage {
  userTurn = 0;
  outputLimit?: number;
  send?: { action: ObservedAction; page: PageState };
  signal = new AbortController().signal;
  constructor(
    readonly browser: OracleBrowser,
    readonly sleep?: (ms: number) => Promise<void>
  ) {}
  get id() {
    return this.browser.id;
  }
  private async pause(ms: number): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.sleep) return oracleDelay(ms, this.signal);
    await new Promise<void>((resolve, reject) => {
      const signal = this.signal;
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void this.sleep!(ms).then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
    this.signal.throwIfAborted();
  }
  async facts(): Promise<OracleFacts> {
    this.signal.throwIfAborted();
    // Background tabs are virtualised; force a render before reading each exchange.
    await this.browser.command('Page.captureScreenshot', { format: 'jpeg', quality: 20 });
    this.signal.throwIfAborted();
    const state = (await this.browser.evaluate(STUDIO_PAGE_STATE)) as StudioState;
    this.signal.throwIfAborted();
    if (!state || typeof state.url !== 'string') throw new JevFailure('page_facts_invalid', 'page_facts_invalid');
    let reply = (await this.browser.evaluate(makeReplyScript(this.userTurn))) as Reply;
    if (!reply || !Number.isInteger(reply.users) || !Number.isInteger(reply.model_turns))
      throw new JevFailure('page_facts_invalid', 'page_facts_invalid');
    if (this.userTurn > 0 && reply.model_turns > 0) {
      const texts: string[] = [];
      let final = reply.final;
      let error = reply.error;
      // Exact owner-driver read_exchange: make every virtual model turn render, never
      // call a missing placeholder final, and join only public ms-text-chunk Markdown.
      for (let j = 0; j < reply.model_turns; j++) {
        this.signal.throwIfAborted();
        if (j >= 100) throw new JevFailure('exchange_too_large', 'exchange_too_large');
        const visible = await this.browser.evaluate(`(${SCROLL_JS})(${this.userTurn}, ${j})`);
        if (!visible) {
          final = false;
          texts.length = 0;
          break;
        }
        await this.pause(1500);
        await this.browser.command('Page.captureScreenshot', { format: 'jpeg', quality: 20 });
        this.signal.throwIfAborted();
        const one = (await this.browser.evaluate(makeReplyScript(this.userTurn, j))) as Reply;
        if (!one || !one.model_turns) {
          final = false;
          texts.length = 0;
          break;
        }
        final ||= one.final;
        error ||= one.error;
        texts.push(one.text);
      }
      reply = { ...reply, final, error, text: texts.join('\n\n') };
    }
    return {
      url: state.url,
      // An absent account/composer is hydration, not affirmative login evidence.
      readyState:
        state.readyState === 'complete' && state.authenticated === false && !state.login
          ? 'interactive'
          : state.readyState,
      composer: state.composer,
      stop: state.stop,
      marker: JSON.stringify([state.url, state.selector, state.authenticated, state.stop, reply.users]),
      sidebar: [],
      cards: [],
      human: state.login ? 'login' : state.dialog ? 'approval' : undefined,
      error: state.page_error || Boolean(reply.error),
      turns: Array.from({ length: reply.users }, () => ({ role: 'user', text: '' })),
      exchange: { users: reply.users, text: reply.text, final: reply.final, error: reply.error ?? undefined },
      ...(this.userTurn ? { recordFields: { user_turn: this.userTurn, output_limit: this.outputLimit } } : {}),
    };
  }
  async observation(facts: OracleFacts): Promise<PageObservation> {
    return {
      page: { url: facts.url, title: 'AI Studio', text: '' },
      elements: [],
      facts: {
        ...facts,
        composer: undefined,
        turns: undefined,
        exchange: undefined,
        user_turns: facts.exchange?.users,
      },
      deltas: {},
    };
  }
  close() {
    return Promise.resolve(this.browser.close());
  }
  detach() {
    return this.browser.detach();
  }
}
export function aistudioTarget(
  options: TargetBrowserOptions & { config: StudioConfig; model: string; thinking: string }
): OracleTarget {
  if (!options.config.models.includes(options.model) || !['Low', 'Medium', 'High'].includes(options.thinking))
    throw new JevFailure('aistudio_model_not_allowed', 'aistudio_model_not_allowed');
  const root = `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(options.model.replace(/^models\//, ''))}`;
  return {
    provider: 'aistudio',
    root,
    settled(url): url is string {
      if (typeof url !== 'string') return false;
      try {
        const value = new URL(url);
        return (
          value.origin === 'https://aistudio.google.com' &&
          /^\/prompts\/[A-Za-z0-9_-]{20,}$/.test(value.pathname) &&
          !value.pathname.endsWith('/new_chat')
        );
      } catch {
        return false;
      }
    },
    async open(url) {
      return new StudioPage(await options.open(url), options.sleep);
    },
    async attach(id) {
      return new StudioPage(await options.attach(id), options.sleep);
    },
    targets: options.targets,
    bindPage(page, record, signal) {
      (page as StudioPage).userTurn = typeof record.user_turn === 'number' ? record.user_turn : 0;
      (page as StudioPage).signal = signal;
    },
    async prepare(oraclePage, input, provider, signal) {
      if (input.attach) throw new JevFailure('unsupported_attachment', 'unsupported_attachment');
      const page = oraclePage as StudioPage;
      page.signal = signal;
      const sleep = options.sleep ?? ((ms: number) => oracleDelay(ms, signal));
      let facts: OracleFacts | undefined;
      const ready = await awaitState(
        { name: 'page_ready', statement: 'The logged-in AI Studio composer is ready and idle.' },
        {
          async observe() {
            facts = await page.facts();
            return page.observation(facts);
          },
        },
        {
          judge:
            provider.judge?.bind(provider) ??
            (async () => {
              throw new Error('judge_unavailable');
            }),
        },
        {
          maxMs: 45_000,
          maxLoadMs: 45_000,
          maxCalls: 4,
          now: options.now,
          sleep,
          signal,
          fastPath: () =>
            facts &&
            facts.readyState === 'complete' &&
            facts.composer !== null &&
            !facts.stop &&
            !facts.human &&
            !facts.error
              ? 'pass'
              : null,
        }
      );
      if (facts?.human || ready.verdict === 'needs_human')
        throw new JevFailure('needs_human', facts?.human ?? ready.humanKind ?? 'approval');
      if (ready.verdict !== 'pass' || !facts || facts.composer === null || facts.stop || facts.error)
        throw new JevFailure('aistudio_not_ready', 'aistudio_not_ready');
      await gateSettings(page.browser, options.model, undefined);
      let settings = (await page.browser.evaluate(SETTINGS_JS)) as Settings;
      if (shownThinking(settings) !== options.thinking) {
        await page.browser.evaluate(
          `(() => {const es=[...document.querySelectorAll('ms-run-settings mat-select[aria-label="Thinking Level"]')];if(es.length!==1)throw new Error('thinking_unavailable');es[0].click();})()`
        );
        await sleep(1200);
        await page.browser.evaluate(
          `(() => {const es=[...document.querySelectorAll('mat-option')].filter(e=>(e.innerText||'').trim()===${JSON.stringify(options.thinking)});if(es.length!==1)throw new Error('thinking_ambiguous');es[0].click();})()`
        );
        await sleep(1000);
      }
      settings = (await page.browser.evaluate(SETTINGS_JS)) as Settings;
      if (shownThinking(settings) !== options.thinking)
        throw new JevFailure('aistudio_thinking_mismatch', 'aistudio_thinking_mismatch');
      const prior = facts.exchange?.users ?? 0;
      if (input.conversation && input.conversation !== 'new' && !prior)
        throw new JevFailure('empty_conversation', 'empty_conversation');
      page.userTurn = prior + 1;
      const state = (await page.browser.evaluate(STUDIO_PAGE_STATE)) as StudioState;
      if (!state.selector) throw new JevFailure('fill.no_composer', 'fill.no_composer');
      await page.browser.evaluate(
        `(() => {const e=document.querySelector(${JSON.stringify(state.selector)});e.focus();e.select();})()`
      );
      await page.browser.command('Input.insertText', { text: input.prompt });
      const after = (await page.browser.evaluate(STUDIO_PAGE_STATE)) as StudioState;
      if (normalizeStudioPrompt(after.composer ?? '') !== normalizeStudioPrompt(input.prompt))
        throw new JevFailure('fill.text_mismatch', 'fill.text_mismatch');
      await gateSettings(page.browser, options.model, options.thinking);
      const observed = await page.browser.observe(false);
      const send: ObservedAction[] = [];
      for (const action of observed.actions.filter((a) => a.kind === 'click' && a.node !== undefined)) {
        const match = await page.browser.evaluate(
          `(() => {const e=window.__jevFast?.nodes.get(${action.node});return !!e && e.matches(${JSON.stringify(SEL_RUN)}) && !e.disabled && e.getAttribute('aria-disabled')!=='true';})()`
        );
        if (match === true) send.push(action);
      }
      if (send.length !== 1) throw new JevFailure('send.not_chosen', 'send.not_chosen');
      page.send = { action: send[0]!, page: observed };
      // The final gate follows prompt typing and action lookup, immediately before reservation.
      await gateSettings(page.browser, options.model, options.thinking);
      const gate = (await page.browser.evaluate(STUDIO_PAGE_STATE)) as StudioState;
      if (
        normalizeStudioPrompt(gate.composer ?? '') !== normalizeStudioPrompt(input.prompt) ||
        !(await page.browser.fresh(observed, send[0]))
      )
        throw new JevFailure('gate.changed', 'gate.changed');
      return page.facts();
    },
    async click(oraclePage, signal) {
      signal.throwIfAborted();
      const page = oraclePage as StudioPage;
      const send = page.send;
      page.send = undefined;
      if (!send) throw new JevFailure('send.not_chosen', 'send.not_chosen');
      await page.browser.act(send.action, send.page);
    },
    binding(facts, _input, record) {
      const nth = typeof record.user_turn === 'number' ? record.user_turn : 0;
      const reply = facts.exchange;
      return {
        found: nth >= 1 && Boolean(reply && reply.users >= nth),
        answer: nth >= 1 ? (reply?.text ?? '') : '',
        final: nth >= 1 && reply?.final === true && !reply.error,
      };
    },
    matchesDraft(facts, input) {
      return normalizeStudioPrompt(facts.composer ?? '') === normalizeStudioPrompt(input.prompt);
    },
  };
}
function shownThinking(settings: Settings): string {
  return settings.selects?.['Thinking Level']?.split('\n')[0]?.trim() ?? '';
}
async function gateSettings(browser: OracleBrowser, model: string, thinking?: string): Promise<void> {
  const state = (await browser.evaluate(STUDIO_PAGE_STATE)) as StudioState;
  if (state.login || state.dialog) throw new JevFailure('needs_human', 'needs_human');
  const settings = (await browser.evaluate(SETTINGS_JS)) as Settings;
  if (settings.key_icon !== 'key_off') throw new JevFailure('aistudio_paid_key_selected', 'aistudio_paid_key_selected');
  if (settings.model !== model) throw new JevFailure('aistudio_model_mismatch', 'aistudio_model_mismatch');
  if (thinking !== undefined && shownThinking(settings) !== thinking)
    throw new JevFailure('aistudio_thinking_mismatch', 'aistudio_thinking_mismatch');
}
