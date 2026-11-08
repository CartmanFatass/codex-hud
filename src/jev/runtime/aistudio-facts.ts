/**
 * AI Studio page facts: the read-only page JavaScript and selectors the owned Jev runtime
 * uses to read a conversation's rendered Markdown, scroll a model turn into view and read
 * the run settings, plus the prompt-box and Run selectors.
 *
 * Ported verbatim (behaviour unchanged) from the owner's driver
 * `jev-ask/src/jev_ask/aistudio.py` (`REPLY_JS`, `SCROLL_JS`) and
 * `jev-ask/src/jev_ask/aistudio_cdp.py` (`SETTINGS_JS`, `SEL_PROMPT`, `SEL_RUN`).
 * Each exported string is the driver's constant value exactly, escapes included: the
 * driver's raw Python strings carry literal `\u0000`, `\d`, `\n` and backtick
 * sequences that the page's JavaScript parses, so they are written here with the extra
 * backslash a template literal needs and the values compare equal to the Python literals.
 * The driver injects them as `"(%s)(%d, %d)" % (REPLY_JS, nth, only)`; `makeReplyScript`
 * is that wrapper, and `SCROLL_JS` takes the same `(nth, j)` wrapper at its call site.
 *
 * Selectors here are reads only: no click and no typed text ever comes from them.
 */

/**
 * The reply to the n-th user turn (1-based; 0 = the last): the model turns between it and
 * the next user turn; with `modelTurn` >= 0, the text of that one model turn of the
 * exchange. Only rendered Markdown (`ms-text-chunk` outside `ms-thought-chunk`) is read and
 * turned back into Markdown. Returns `{users, model_turns, final, text, error}`.
 */
export const REPLY_JS = `((nth, only) => {
  const turns = [...document.querySelectorAll('ms-chat-turn')];
  const role = t => (t.querySelector('[data-turn-role]') || {getAttribute: () => null}).getAttribute('data-turn-role');
  const ui = turns.map((t, i) => role(t) === 'User' ? i : -1).filter(i => i >= 0);
  const users = ui.length;
  const k = nth > 0 ? nth : users;
  if (k < 1 || k > users) return {users, model_turns: 0, final: false, text: '', error: null};
  const after = turns.slice(ui[k - 1] + 1, k < users ? ui[k] : turns.length);
  const run = s => Math.max(0, ...(s.match(/\`+/g) || []).map(m => m.length));
  const pres = [];  // code blocks, kept out of whitespace and prefix handling until the end
  const restore = (s, prefix) => s.replace(/\\u0000PRE(\\d+)\\u0000/g, (_, i) => pres[+i].split('\\n').join('\\n' + prefix));
  const md = (node, ctx) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'ms-thought-chunk' || tag === 'button' || tag === 'mat-icon') return '';
    const inner = c => [...node.childNodes].map(n => md(n, c || ctx)).join('');
    const h = /^h([1-6])$/.exec(tag);
    if (h) return '\\n\\n' + '#'.repeat(+h[1]) + ' ' + inner().trim() + '\\n\\n';
    switch (tag) {
      case 'p': return '\\n\\n' + inner().trim() + '\\n\\n';
      case 'br': return '\\n';
      case 'hr': return '\\n\\n---\\n\\n';
      case 'strong': case 'b': return '**' + inner() + '**';
      case 'em': case 'i': return '*' + inner() + '*';
      case 'code': {
        if (ctx === 'pre') return node.textContent;
        const s = node.textContent, f = '\`'.repeat(run(s) + 1), pad = /^\`|\`$/.test(s) ? ' ' : '';
        return f + pad + s + pad + f;
      }
      case 'pre': {
        const s = node.textContent.replace(/\\n$/, ''), f = '\`'.repeat(Math.max(3, run(s) + 1));
        pres.push(f + '\\n' + s + '\\n' + f);
        return '\\n\\n\\u0000PRE' + (pres.length - 1) + '\\u0000\\n\\n';
      }
      case 'blockquote':
        return '\\n\\n' + restore(inner().trim().split('\\n').map(l => '> ' + l).join('\\n'), '> ') + '\\n\\n';
      case 'table': {
        const rows = [...node.querySelectorAll('tr')].filter(tr => tr.closest('table') === node).map(tr =>
          [...tr.querySelectorAll('th, td')].filter(c => c.closest('tr') === tr).map(c =>
            [...c.childNodes].map(n => md(n, ctx)).join('').replace(/\\s*\\n+\\s*/g, ' ').trim().replace(/\\|/g, '\\\\|')));
        if (!rows.length) return '';
        const line = r => '| ' + r.join(' | ') + ' |';
        return '\\n\\n' + [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\\n') + '\\n\\n';
      }
      case 'ul': case 'ol': {
        const items = [...node.querySelectorAll('li')].filter(li => li.parentElement.closest('ol, ul') === node);
        const start = +(node.getAttribute('start') || 1);
        return '\\n\\n' + items.map((li, i) => (tag === 'ol' ? (start + i) + '. ' : '- ') +
          restore([...li.childNodes].map(n => md(n, ctx)).join('').trim().replace(/\\n+/g, '\\n   '), '   ')).join('\\n')
          + '\\n\\n';
      }
      default: return inner();
    }
  };
  const chunks = t => [...t.querySelectorAll('ms-text-chunk')].filter(c => !c.closest('ms-thought-chunk'));
  const models = after.filter(t => role(t) !== 'User');
  const read = only >= 0 ? models.slice(only, only + 1) : after;
  const text = restore(read.map(t => chunks(t).map(c => md(c, '')).join('\\n')).join('\\n')
    .replace(/\\n{3,}/g, '\\n\\n').trim(), '');
  const last = models[models.length - 1];
  // the feedback bar marks a finished reply; a saved chat shows it on the latest one only, and an exchange with a
  // later user turn is finished by construction (AI Studio does not accept a prompt while a reply is running)
  const final = !!last && (k < users || !!last.querySelector('button.response-feedback-button[aria-label="Good response"]'));
  const err = after.flatMap(t => [...t.querySelectorAll('.model-error, [class*=error]')])
    .map(e => (e.innerText || '').trim()).filter(Boolean).slice(-1)[0] || null;
  return {users, model_turns: models.length, final, text, error: err};
})`;

/**
 * Bring the `j`-th model turn of the `nth` user turn's exchange into view (the chat list is
 * virtualised, so a turn off screen is an empty placeholder). Returns whether the turn
 * exists.
 */
export const SCROLL_JS = `((nth, j) => {
  const turns = [...document.querySelectorAll('ms-chat-turn')];
  const ui = turns.map((t, i) => (t.querySelector('[data-turn-role]') || {getAttribute: () => null})
    .getAttribute('data-turn-role') === 'User' ? i : -1).filter(i => i >= 0);
  const k = nth > 0 ? nth : ui.length;
  if (k < 1 || k > ui.length) return false;
  const t = turns.slice(ui[k - 1] + 1, k < ui.length ? ui[k] : turns.length)[j];
  if (t) t.scrollIntoView({block: 'start'});
  return !!t;
})`;

/**
 * The run settings as shown: model name, the `mat-select` labels and values (the thinking
 * level among them), the switches, the paid-API-key button, and the Run button's tooltip
 * and disabled state.
 */
export const SETTINGS_JS = `(() => ({
  model: (document.querySelector('ms-model-selector [data-test-id=model-name]') || {}).innerText || null,
  selects: Object.fromEntries([...document.querySelectorAll('ms-run-settings mat-select')]
              .map(e => [e.getAttribute('aria-label'), (e.innerText || '').trim()])),
  switches: Object.fromEntries([...document.querySelectorAll('ms-run-settings [role=switch]')]
              .map(e => [e.getAttribute('aria-label'), e.getAttribute('aria-checked')])),
  key_icon: ((document.querySelector('ms-paid-api-key-button button') || {}).innerText || '').trim(),
  key_label: (document.querySelector('ms-paid-api-key-button button') || {getAttribute: () => null}).getAttribute('aria-label'),
  run_tip: (() => { const b = document.querySelector('ms-run-button button'); const id = b && b.getAttribute('aria-describedby');
                    return id ? (document.getElementById(id) || {}).textContent || null : null; })(),
  run_disabled: (() => { const b = document.querySelector('ms-run-button button'); return !b || b.disabled || b.getAttribute('aria-disabled') === 'true'; })(),
}))()`;

/**
 * The prompt box, in the driver's order: the first one that is on the page is used.
 */
export const SEL_PROMPT: readonly string[] = [
  'textarea[formcontrolname="promptText"]',
  'ms-prompt-box textarea',
  'textarea[aria-label="Enter a prompt"]',
];

/** The Run button. */
export const SEL_RUN = 'ms-run-button button';

/**
 * `REPLY_JS` applied to one user turn, exactly as the driver evaluates it
 * (`page.eval("(%s)(%d, %d)" % (REPLY_JS, nth, only))`). `userTurn` 0 means the last user
 * turn; `modelTurn` -1 (the driver's default) means the whole exchange, >= 0 one model
 * turn of it. Both are truncated to integers, as Python's `%d` does.
 */
// Numeric position alone is not identity. Read only the public user prompt,
// excluding the author label and turn controls. Missing/virtualised text fails closed.
export function makeUserPromptScrollScript(userTurn: number): string {
  return `(() => {
    const users = [...document.querySelectorAll('ms-chat-turn')].filter(t =>
      t.querySelector('[data-turn-role="User"]'));
    const turn = users[${Math.trunc(userTurn)} - 1];
    if (turn) turn.scrollIntoView({block: 'start'});
    return !!turn;
  })()`;
}

export function makeUserPromptScript(userTurn: number): string {
  return `(() => {
    const users = [...document.querySelectorAll('ms-chat-turn')].filter(t =>
      t.querySelector('[data-turn-role="User"]'));
    const turn = users[${Math.trunc(userTurn)} - 1];
    const chunks = [...(turn?.querySelectorAll('ms-text-chunk') || [])]
      .filter(c => !c.closest('ms-thought-chunk'));
    return chunks.length ? chunks.map(c => c.innerText ?? c.textContent ?? '').join('\\n') : null;
  })()`;
}

export function makeReplyScript(userTurn: number, modelTurn = -1): string {
  return `(${REPLY_JS})(${Math.trunc(userTurn)}, ${Math.trunc(modelTurn)})`;
}
