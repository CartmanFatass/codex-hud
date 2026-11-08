// ChatGPT adapter: owner's jev_send.py facts/binding; v5 linked-menu selection and judgments.
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrowserPort } from '../agent.js';
import { StalePage } from '../browser.js';
import { JevFailure } from '../ask/error.js';
import { pySquash, squashedSha256, type OperationRecord } from '../ask/records.js';
import { choose, DecisionRefused, type DecisionProvider } from '../decide.js';
import { awaitState, type JudgmentProvider, type PageObservation } from '../judge.js';
import { actionSpace, type ObservedAction, type PageState } from '../model.js';
import { COMPOSER_LOOKUP, FOCUS_COMPOSER, NODE_FACTS, PAGE_FACTS, UPLOAD_LOOKUP } from './chatgpt-facts.js';
import { oracleDelay, type OracleFacts, type OraclePage, type OracleTarget, type OracleTurn } from './oracle.js';
import type { JevAskInput } from './types.js';

export interface OracleBrowser extends BrowserPort {
  readonly id: string | null;
  readonly mode?: 'headless' | 'headed';
  evaluate(expression: string, awaitPromise?: boolean, timeoutMs?: number): Promise<unknown>;
  command(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  detach(): Promise<void>;
}
export interface TargetBrowserOptions {
  open(url: string): Promise<OracleBrowser>;
  attach(id: string): Promise<OracleBrowser>;
  targets(): Promise<Array<{ targetId: string; url: string }>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  diagnostic?: (phase: string, verdict: string, calls: number, elapsedMs: number) => void;
}

// A menu is actionable only when explicitly linked to a composer menu trigger AND
// it contains the model/effort radio list or slider. Tools menus do not qualify.
export const MENU_STATE = `(() => {
 const composer=(${COMPOSER_LOOKUP})(); const form=composer?.closest('form');
 const triggers=[...(form?.querySelectorAll('[aria-haspopup="menu"]')||[])];
 const linked=[...document.querySelectorAll('[role="menu"]')].flatMap(menu=>triggers.filter(t=>
   (t.id && menu.getAttribute('aria-labelledby')===t.id) || (menu.id && t.getAttribute('aria-controls')===menu.id)
 ).map(trigger=>({menu,trigger}))).filter(x=>x.menu.querySelector('[role="menuitemradio"],[role="slider"]'));
 if(linked.length!==1) return {linked:false, count:linked.length};
 const {menu,trigger}=linked[0]; const sliders=[...menu.querySelectorAll('[role="slider"]')];
 const radios=[...menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map(e=>(e.innerText||'').trim());
 const slider=sliders.length===1?sliders[0]:null;
 const nodes=window.__jevFast?.nodes; const allowed=[];
 if(nodes) for(const [id,node] of nodes) if(menu.contains(node)) allowed.push(id);
 return {linked:true, allowed, radios, slider:slider?{now:Number(slider.getAttribute('aria-valuenow')),max:Number(slider.getAttribute('aria-valuemax')),
 effort:slider.getAttribute('aria-valuetext')||(menu.querySelector('[data-maximum="true"]')?.innerText||'').trim()}:null,
 pill:(trigger.innerText||'').trim(), trigger:trigger.id, menu:menu.id};
})()`;
interface MenuState {
  linked: boolean;
  allowed?: number[];
  radios?: string[];
  slider?: { now: number; max: number; effort: string } | null;
  pill?: string;
  trigger?: string;
  menu?: string;
}
interface RawFacts {
  url: string;
  title?: string;
  readyState: string;
  composer: string | null;
  send_button?: boolean;
  stop_button: boolean;
  login?: boolean;
  challenge?: boolean;
  auth_required?: boolean;
  approval?: string[];
  page_error?: boolean;
  sidebar_hrefs?: string[];
  turns?: OracleTurn[];
  attachment_cards?: string[] | null;
}

class ChatPage implements OraclePage {
  page?: PageState;
  send?: { action: ObservedAction; page: PageState };
  constructor(readonly browser: OracleBrowser) {}
  get id() {
    return this.browser.id;
  }
  async facts(): Promise<OracleFacts> {
    const raw = (await this.browser.evaluate(PAGE_FACTS, false, 10_000)) as RawFacts;
    if (!raw || typeof raw.url !== 'string' || !Array.isArray(raw.turns))
      throw new JevFailure('page_facts_invalid', 'page_facts_invalid');
    const sidebar = [...new Set((raw.sidebar_hrefs ?? []).map((href) => new URL(href, raw.url).href))];
    return {
      url: raw.url,
      // document.complete precedes React hydration. A stable shell is not a
      // ready composer and must not invite a premature negative page judgment.
      readyState:
        raw.readyState === 'complete' &&
        raw.composer === null &&
        !raw.login &&
        !raw.auth_required &&
        !raw.challenge &&
        !raw.approval?.length &&
        !raw.page_error
          ? 'interactive'
          : raw.readyState,
      marker: JSON.stringify([
        raw.url,
        raw.composer,
        raw.stop_button,
        raw.turns.filter((turn) => turn.role === 'user').length,
        raw.attachment_cards,
      ]),
      composer: raw.composer,
      send: raw.send_button === true,
      stop: raw.stop_button,
      human:
        raw.login || raw.auth_required
          ? 'login'
          : raw.challenge
            ? 'challenge'
            : raw.approval?.length
              ? 'approval'
              : undefined,
      error: raw.page_error,
      sidebar,
      turns: raw.turns,
      cards: raw.attachment_cards ?? null,
    };
  }
  async observation(facts: OracleFacts): Promise<PageObservation> {
    const observed = await this.browser.observe(false);
    return {
      page: { url: facts.url, title: observed.title ?? '', text: observed.text.slice(0, 6000) },
      elements: actionSpace(observed.actions, false)[0],
      facts: {
        ...facts,
        composer: undefined,
        turns: undefined,
        composer_sha256: squashedSha256(facts.composer ?? ''),
        user_turns: facts.turns.filter((t) => t.role === 'user').length,
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
export function chatgptTarget(
  options: TargetBrowserOptions & { root?: string; model?: string; effortWord?: string }
): OracleTarget {
  const root = options.root ?? 'https://chatgpt.com/';
  const target: OracleTarget = {
    provider: 'chatgpt',
    root,
    settled(url): url is string {
      if (typeof url !== 'string') return false;
      try {
        const value = new URL(url);
        return value.origin === new URL(root).origin && /^\/c\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value.pathname);
      } catch {
        return false;
      }
    },
    async open(url) {
      return new ChatPage(await options.open(url));
    },
    async attach(id) {
      return new ChatPage(await options.attach(id));
    },
    targets: options.targets,
    async prepare(oraclePage, input, provider, signal, committed) {
      const page = oraclePage as ChatPage;
      const digest = () =>
        input.attach ? createHash('sha256').update(readFileSync(input.attach)).digest('hex') : undefined;
      const expectedAttachment = committed?.attachment_sha256 ?? digest();
      const delay = options.sleep ?? ((ms: number) => oracleDelay(ms, signal));
      const model = input.model ?? options.model ?? 'GPT-6';
      const effort = input.effortWord ?? options.effortWord ?? 'Pro';
      const judgeProvider: JudgmentProvider = {
        judge:
          provider.judge?.bind(provider) ??
          (async () => {
            throw new Error('judge_unavailable');
          }),
      };
      const wait = async (
        name: string,
        statement: string,
        fast: (facts: OracleFacts) => boolean,
        maxMs: number,
        calls: number
      ) => {
        let facts: OracleFacts | undefined;
        const started = (options.now ?? Date.now)();
        const outcome = await awaitState(
          { name, statement },
          {
            async observe() {
              facts = await page.facts();
              signal.throwIfAborted();
              // maxLoadMs is a hydration bound, not permission to spend another
              // entire stable-page budget on a shell that never becomes usable.
              if (
                name === 'page_ready' &&
                facts.readyState !== 'complete' &&
                (options.now ?? Date.now)() - started >= 30_000
              ) {
                options.diagnostic?.(name, 'hydration_timeout', 0, (options.now ?? Date.now)() - started);
                throw new JevFailure('page_ready_timeout', 'page_ready_timeout');
              }
              return page.observation(facts);
            },
          },
          judgeProvider,
          {
            maxMs,
            maxLoadMs: 30_000,
            maxCalls: calls,
            signal,
            sleep: delay,
            now: options.now,
            fastPath: () => (facts && !facts.human && !facts.error && fast(facts) ? 'pass' : null),
          }
        );
        options.diagnostic?.(name, outcome.verdict, outcome.calls, (options.now ?? Date.now)() - started);
        if (facts?.human || outcome.verdict === 'needs_human')
          throw new JevFailure('needs_human', facts?.human ?? outcome.humanKind ?? 'approval');
        if (outcome.verdict === 'deny') throw new JevFailure(`${name}_denied`, `${name}_denied`);
        if (outcome.verdict !== 'pass' || !facts) throw new JevFailure(`${name}_timeout`, `${name}_timeout`);
        return facts;
      };
      let facts = await wait(
        'page_ready',
        'The composer is ready and idle.',
        (f) => f.composer !== null && !f.stop,
        60_000,
        4
      );
      if (target.binding(facts, input, {}).found) throw new JevFailure('already_submitted', 'already_submitted');
      if (facts.cards === null || facts.cards.length) throw new JevFailure('cards_present', 'cards_present');
      // Match the owner driver: restored drafts can put the composer's centre
      // outside the viewport. Clear them before Jev observes or fills the box.
      const draftHash = facts.composer ? createHash('sha256').update(facts.composer).digest('hex') : undefined;
      if (facts.composer) {
        await page.browser.evaluate(FOCUS_COMPOSER);
        for (const [key, code, virtual, extra] of [
          ['a', 'KeyA', 65, { modifiers: 2, commands: ['selectAll'] }],
          ['Backspace', 'Backspace', 8, {}],
        ] as const) {
          signal.throwIfAborted();
          await page.browser.command('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code,
            windowsVirtualKeyCode: virtual,
            ...extra,
          });
          await page.browser.command('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code,
            windowsVirtualKeyCode: virtual,
            ...('modifiers' in extra ? { modifiers: extra.modifiers } : {}),
          });
        }
        facts = await wait('draft_cleared', 'The restored draft is cleared.', (f) => f.composer === '', 10_000, 0);
        if (facts.composer !== '') throw new JevFailure('draft_clear_failed', 'draft_clear_failed');
      }
      const baseline = await chips(page.browser);
      // Mode: Jev chooses discrete controls; only code owns the continuous slider.
      const budget = { remaining: 14 };
      let modePill = await setMode(page, model, effort, provider, signal, judgeProvider, delay, budget, options.now);
      await predictAct(
        page,
        'Fill the prompt composer with the committed text. Do not send or upload.',
        'fill',
        input,
        provider,
        signal,
        3,
        budget
      );
      facts = await page.facts();
      if (!target.matchesDraft(facts, input)) throw new JevFailure('fill.text_mismatch', 'fill.text_mismatch');
      if (input.attach) {
        const id = await page.browser.evaluate(`(${UPLOAD_LOOKUP})()`);
        if (typeof id !== 'string') throw new JevFailure('attach.no_input', 'attach.no_input');
        const doc = (await page.browser.command('DOM.getDocument')) as { root: { nodeId: number } };
        const found = (await page.browser.command('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: `input[id="${id}"]`,
        })) as { nodeId: number };
        if (!found.nodeId) throw new JevFailure('attach.no_input', 'attach.no_input');
        // Owner attach(expected_sha256): asynchronous readiness/model selection must
        // not change the bytes bound in the operation record before upload.
        if (digest() !== expectedAttachment) throw new JevFailure('attach.changed', 'attach.changed');
        await page.browser.command('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [input.attach] });
        let enabled = 0;
        facts = await wait(
          'upload_finished',
          'The requested attachment is uploaded and Send is enabled.',
          (f) => {
            enabled = cardsMatch(f.cards, input.attach!) && f.send ? enabled + 1 : 0;
            return enabled >= 2;
          },
          120_000,
          2
        );
        if (!cardsMatch(facts.cards, input.attach)) throw new JevFailure('attach.card_wrong', 'attach.card_wrong');
      }
      // Gate: text/cards/busy are hard checks; model pill and tool chips must not drift.
      facts = await page.facts();
      if (
        !target.matchesDraft(facts, input) ||
        facts.stop ||
        facts.human ||
        !(input.attach ? cardsMatch(facts.cards, input.attach) : facts.cards?.length === 0)
      )
        throw new JevFailure('gate.changed', 'gate.changed');
      if ((await chips(page.browser)) !== baseline) {
        await wait(
          'composer_clean',
          'The composer contains only the committed prompt, requested attachment, and model pill; no extra tools.',
          () => false,
          10_000,
          1
        );
      }
      const pill = await page.browser.evaluate(
        `(() => {const f=(${COMPOSER_LOOKUP})()?.closest('form'); return [...(f?.querySelectorAll('[aria-haspopup="menu"]')||[])].map(e=>(e.innerText||'').trim()).filter(t=>t.includes(${JSON.stringify(effort)}));})()`
      );
      if (!Array.isArray(pill) || pill.length !== 1 || pill[0] !== modePill)
        modePill = await setMode(page, model, effort, provider, signal, judgeProvider, delay, budget, options.now);
      await predictAct(
        page,
        'Click Send once to submit the committed prompt. Do not type, upload or change models.',
        'send',
        input,
        provider,
        signal,
        3,
        budget
      );
      // A model decision is not a gate: re-read all hard facts immediately before persistence.
      facts = await page.facts();
      if (
        !target.matchesDraft(facts, input) ||
        facts.stop ||
        facts.human ||
        !facts.send ||
        !(input.attach ? cardsMatch(facts.cards, input.attach) : facts.cards?.length === 0)
      )
        throw new JevFailure('gate.changed', 'gate.changed');
      if (!page.send || !(await page.browser.fresh(page.send.page, page.send.action)))
        throw new JevFailure('gate.stale', 'gate.stale');
      if (input.attach && digest() !== expectedAttachment) throw new JevFailure('attach.changed', 'attach.changed');
      // Production opener supplies the real reused/started mode. Factories are synthetic.
      return {
        ...facts,
        recordFields: {
          ...facts.recordFields,
          mode: page.browser.mode ?? 'headless',
          ...(draftHash ? { draft_replaced_sha256: draftHash } : {}),
        },
      };
    },
    async click(oraclePage, signal) {
      signal.throwIfAborted();
      const page = oraclePage as ChatPage;
      if (!page.send) throw new JevFailure('send.not_chosen', 'send.not_chosen');
      const { action, page: observed } = page.send;
      page.send = undefined;
      await page.browser.act(action, observed);
    },
    binding(facts, input, record) {
      return bindChatgpt(facts, input, record);
    },
    matchesDraft(facts, input) {
      return pySquash(facts.composer) === pySquash(input.prompt);
    },
  };
  return target;
}
function cardsMatch(cards: string[] | null, path: string): boolean {
  if (!cards || cards.length !== 1) return false;
  const wanted = basename(path);
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dot = wanted.lastIndexOf('.');
  const stem = (dot > 0 ? wanted.slice(0, dot) : wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = (dot > 0 ? wanted.slice(dot) : '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:${escaped}|${stem} \\(\\d+\\)${suffix})$`).test(cards[0]!);
}
export function bindChatgpt(facts: OracleFacts, input: JevAskInput, record: OperationRecord) {
  const digest = typeof record.squashed_sha256 === 'string' ? record.squashed_sha256 : squashedSha256(input.prompt);
  const matches = facts.turns
    .map((turn, index) => ({ turn, index }))
    .filter(
      ({ turn }) =>
        turn.role === 'user' &&
        [turn.message_body ?? turn.text, turn.message_body_code_markdown].some(
          (body) => typeof body === 'string' && squashedSha256(body) === digest
        )
    );
  if (matches.length !== 1) return { found: false, answer: '', final: false };
  const match = matches[0]!;
  if (input.attach || record.attachment) {
    const name =
      typeof record.attachment_display_name === 'string'
        ? record.attachment_display_name
        : typeof record.attachment === 'string'
          ? record.attachment
          : basename(input.attach ?? '');
    if (JSON.stringify(match.turn.attachment_names) !== JSON.stringify([name]))
      return { found: false, answer: '', final: false };
  }
  let answer: OracleTurn | undefined;
  for (const turn of facts.turns.slice(match.index + 1)) {
    if (turn.role === 'user') break;
    if (turn.role === 'assistant' && turn.text) answer = turn;
  }
  return { found: true, answer: answer?.text ?? '', final: answer?.final_controls === true };
}
async function chips(browser: OracleBrowser): Promise<string> {
  return String(
    await browser.evaluate(
      `(() => { const c=(${COMPOSER_LOOKUP})(); const f=c?.closest('form'); if(!f)return null; const copy=f.cloneNode(true); copy.querySelectorAll('#prompt-textarea,[data-composer-markdown],[aria-haspopup="menu"],button,[class~="group/resource-card"]').forEach(e=>e.remove());return (copy.textContent||'').replace(/\\s+/g,' ').trim();})()`
    )
  );
}
async function predictAct(
  page: ChatPage,
  goal: string,
  phase: 'fill' | 'send',
  input: JevAskInput,
  provider: DecisionProvider,
  signal: AbortSignal,
  max: number,
  budget: { remaining: number }
): Promise<void> {
  for (let i = 0; i < max; i++) {
    signal.throwIfAborted();
    const observed = await page.browser.observe(false);
    if (budget.remaining-- <= 0) throw new JevFailure('send.budget', 'send.budget');
    const decision = await choose(observed, goal, [], provider, {
      signal,
      cacheKey: 'hud-jev:ask',
      includeFill: phase === 'fill',
    });
    if ('refused' in decision) {
      if (i === max - 1) throw new DecisionRefused(decision.question);
      continue;
    }
    const action = observed.actions.find((candidate) => candidate.id === decision.choice);
    if (!action) continue;
    const node = (await page.browser.evaluate(`${NODE_FACTS}(${JSON.stringify(action.node)})`)) as {
      is_composer?: boolean;
      is_send?: boolean;
    } | null;
    if (phase === 'send') {
      if (action.kind !== 'click' || !node?.is_send) throw new JevFailure('send.not_chosen', 'send.not_chosen');
      page.send = { action, page: observed };
      return;
    }
    if ((action.kind !== 'fill' && action.kind !== 'click') || !node?.is_composer)
      throw new JevFailure('fill.target_not_composer', 'fill.target_not_composer');
    try {
      await page.browser.act(action, observed, input.prompt);
    } catch (error) {
      if (error instanceof StalePage) continue;
      throw error;
    }
    if (action.kind === 'fill') return;
  }
  throw new JevFailure(`${phase}.budget`, `${phase}.budget`);
}
async function setMode(
  page: ChatPage,
  model: string,
  effort: string,
  provider: DecisionProvider,
  signal: AbortSignal,
  judge: JudgmentProvider,
  sleep: (ms: number) => Promise<void>,
  budget: { remaining: number },
  now?: () => number
): Promise<string> {
  const excluded = new Set<number>();
  for (let i = 0; i < 8; i++) {
    signal.throwIfAborted();
    const observed = await page.browser.observe(false);
    let menu = (await page.browser.evaluate(MENU_STATE)) as MenuState;
    if (menu.linked && menu.slider && menu.slider.now < menu.slider.max) {
      await page.browser.evaluate(
        `(() => {const m=document.getElementById(${JSON.stringify(menu.menu)}); const s=m?.querySelector('[role="slider"]'); s?.focus();})()`
      );
      await key(page.browser, 'End');
      menu = (await page.browser.evaluate(MENU_STATE)) as MenuState;
      if (menu.slider && menu.slider.now < menu.slider.max) {
        const n = Math.min(10, Math.max(0, menu.slider.max - menu.slider.now));
        for (let j = 0; j < n; j++) await key(page.browser, 'ArrowRight');
        menu = (await page.browser.evaluate(MENU_STATE)) as MenuState;
      }
    }
    const proven =
      menu.linked &&
      menu.radios?.includes(model) &&
      (menu.slider
        ? Number.isFinite(menu.slider.max) &&
          menu.slider.max > 0 &&
          menu.slider.now === menu.slider.max &&
          menu.slider.effort === effort
        : menu.radios?.includes(effort));
    if (proven) {
      await key(page.browser, 'Escape');
      await sleep(500);
      return menu.pill ?? '';
    }
    if (menu.linked && i >= 6) {
      const facts = await page.facts();
      const observation = await page.observation(facts);
      observation.facts.menu = menu;
      const outcome = await awaitState(
        {
          name: 'mode_set',
          statement: `The selected model is ${model}, and its maximum reasoning effort is ${effort}.`,
        },
        {
          async observe() {
            return observation;
          },
        },
        judge,
        { maxMs: 10_000, maxCalls: 2, maxLoadMs: 0, now, sleep, signal }
      );
      if (outcome.verdict === 'pass') {
        await key(page.browser, 'Escape');
        return menu.pill ?? '';
      }
    }
    if (budget.remaining-- <= 0) throw new JevFailure('mode.budget', 'mode.budget');
    const decision = await choose(
      observed,
      `Open the composer model menu, choose model ${model} and effort ${effort}. Do not type, send or upload. When selected, finish.`,
      [],
      provider,
      { signal, cacheKey: 'hud-jev:mode', includeFill: false }
    );
    if ('refused' in decision) continue;
    const action = observed.actions.find((a) => a.id === decision.choice);
    if (!action || action.kind !== 'click' || action.node === undefined || excluded.has(action.node)) continue;
    const node = (await page.browser.evaluate(`${NODE_FACTS}(${action.node})`)) as {
      inside_composer_form?: boolean;
      haspopup?: string;
    } | null;
    if (
      !(menu.linked && menu.allowed?.includes(action.node)) &&
      !(node?.inside_composer_form && node.haspopup === 'menu')
    )
      throw new JevFailure('mode.wrong_menu', 'mode.wrong_menu');
    try {
      await page.browser.act(action, observed);
    } catch (error) {
      if (error instanceof StalePage) continue;
      throw error;
    }
    menu = (await page.browser.evaluate(MENU_STATE)) as MenuState;
    if (!menu.linked) {
      excluded.add(action.node);
      await key(page.browser, 'Escape');
    }
  }
  throw new JevFailure('mode.budget', 'mode.budget');
}
async function key(browser: OracleBrowser, key: string): Promise<void> {
  for (const type of ['keyDown', 'keyUp']) await browser.command('Input.dispatchKeyEvent', { type, key });
}
