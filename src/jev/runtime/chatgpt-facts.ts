/**
 * ChatGPT page facts: the read-only page JavaScript the owned Jev runtime uses to
 * recognise the composer, Send, the file input, attachment cards, the model node and
 * the conversation itself.
 *
 * Ported verbatim (behaviour unchanged) from the owner's driver
 * `jev-ask/src/jev_ask/jev_send.py` (`COMPOSER_LOOKUP`, `SEND_LOOKUP`, `UPLOAD_LOOKUP`,
 * `ATTACHMENT_CARDS`, `PAGE_FACTS`, `NODE_FACTS`, `FOCUS_COMPOSER`). The strings are
 * injected into the page as-is; the `__X__` placeholders and their `.replace` chains
 * are kept exactly as in the driver so each exported value is the same final JS text.
 *
 * Selectors here are reads only: no click and no typed text ever comes from them.
 */

export const COMPOSER_LOOKUP = `() => {
  const candidates = [...document.querySelectorAll('#prompt-textarea, [data-composer-markdown]')];
  if (candidates.length !== 1) return null;
  const e = candidates[0];
  if (!e.closest('form')) return null;
  const legacy = e.id === 'prompt-textarea';
  const role = e.getAttribute('role');
  if (e.tagName === 'TEXTAREA') return legacy && (!role || role === 'textbox') ? e : null;
  if (e.getAttribute('contenteditable') !== 'true') return null;
  return (e.hasAttribute('data-composer-markdown') ? role === 'textbox'
    : legacy && (!role || role === 'textbox')) ? e : null;
}`;

export const SEND_LOOKUP = `() => {
  const form = (__COMPOSER_LOOKUP__)()?.closest('form');
  if (!form) return null;
  const candidates = [...form.querySelectorAll('button[data-testid="send-button"], button[type="submit"]')]
    .filter(e => !e.disabled && (e.getAttribute('data-testid') === 'send-button' ||
      (e.type === 'submit' && /^(发送|Send)$/.test(e.getAttribute('aria-label') || ''))));
  return candidates.length === 1 ? candidates[0] : null;
}`.replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP);

export const UPLOAD_LOOKUP = `() => {
  const form = (__COMPOSER_LOOKUP__)()?.closest('form');
  if (!form) return null;
  const candidates = [...form.querySelectorAll('input[type="file"]')].filter(e =>
    !(e.getAttribute('accept') || '').trim() &&
    (e.id === 'upload-files' || /^(附加文件|Attach files|Attach file)$/.test(e.getAttribute('aria-label') || '')));
  if (candidates.length !== 1) return null;
  const input = candidates[0];
  if (!/^[A-Za-z0-9_-]+$/.test(input.id)) return null;
  return document.querySelectorAll('input[id="' + input.id + '"]').length === 1 ? input.id : null;
}`.replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP);

export const ATTACHMENT_CARDS = `() => {
  const form = (__COMPOSER_LOOKUP__)()?.closest('form');
  if (!form) return null;
  const labels = [...form.querySelectorAll('button[aria-label]')]
    .map(button => button.getAttribute('aria-label'));
  const removals = labels.filter(label => /^(移除 |Remove )/.test(label));
  const names = [];
  for (const removal of removals) {
    const name = removal.replace(/^(移除 |Remove )/, '');
    if (!name || labels.filter(label => label === name).length !== 1 ||
        labels.filter(label => label === removal).length !== 1) return null;
    names.push(name);
  }
  return new Set(names).size === names.length ? names : null;
}`.replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP);

export const PAGE_FACTS = `(() => {
  const text = e => (e?.innerText || '').trim();
  const composer = (__COMPOSER_LOOKUP__)();
  const send = (__SEND_LOOKUP__)();
  const attachmentCards = (__ATTACHMENT_CARDS__)();
  const legacyMessages = [...document.querySelectorAll('[data-message-author-role]')];
  const modernUnits = [...document.querySelectorAll('[data-chatgpt-search-unit-key]')]
    .filter(unit => /:(user|assistant)$/.test(unit.getAttribute('data-chatgpt-search-unit-key') || ''));
  const legacyTurns = legacyMessages.map(message => {
    const container = message.closest('article,[data-testid^="conversation-turn"]') || message;
    const messageBody = message.getAttribute('data-message-author-role') === 'user'
      ? message.querySelector('.whitespace-pre-wrap') : null;
    return {role: message.getAttribute('data-message-author-role'), text: text(message),
      message_body: messageBody ? text(messageBody) : null, turn_text: text(container),
      attachment_names: [],
      // Tool work can continue after an opening assistant message with no Stop
      // button. The completed response's feedback control belongs to this turn.
      final_controls: message.getAttribute('data-message-author-role') === 'assistant'
        && !!container.querySelector('[data-testid="feedback-turn-action-button"]')};
  });
  const modernTurns = modernUnits.map(unit => {
    const key = unit.getAttribute('data-chatgpt-search-unit-key') || '';
    const match = key.match(/^(.*):([0-9]+):(user|assistant)$/);
    const container = unit.closest('[data-content-search-turn-key]');
    if (!match || !container || container.getAttribute('data-content-search-turn-key') !== match[1])
      return null;
    if (match[3] === 'user') {
      const bubbles = [...unit.querySelectorAll('[data-user-message-bubble="true"]')];
      const bodies = bubbles.length === 1 ? [...bubbles[0].querySelectorAll('.whitespace-pre-wrap')] : [];
      if (bodies.length !== 1) return null;
      // The current UI renders inline backticks as CODE children even inside
      // whitespace-pre-wrap. Keep visible text and one conservative, reversible
      // Markdown candidate; binding below still requires exact committed text.
      const children = [...(bodies[0].childNodes || [])];
      const codeMarkdown = children.some(node => node.nodeType === 1 && node.tagName === 'CODE') &&
        children.every(node => node.nodeType === 3 || (node.nodeType === 1 &&
          node.tagName === 'CODE' && [...node.childNodes].every(child => child.nodeType === 3) &&
          !node.textContent.includes('\`') && !/[\\r\\n]/.test(node.textContent)))
        ? children.map(node => node.nodeType === 3 ? node.textContent : '\`' + node.textContent + '\`').join('')
        : null;
      const cards = [...unit.querySelectorAll('[class~="group/resource-card"]')].filter(card =>
        card.closest('[data-chatgpt-search-unit-key]') === unit && !bubbles[0].contains(card));
      const names = cards.map(card => {
        const spans = [...card.querySelectorAll('span[title].truncate.text-default.text-sm.font-semibold')];
        if (spans.length !== 1) return null;
        const name = text(spans[0]);
        return name && spans[0].getAttribute('title')?.trim() === name ? name : null;
      });
      if (names.some(name => !name)) return null;
      return {role: 'user', text: text(unit), message_body: text(bodies[0]),
        turn_text: text(unit), attachment_names: names, final_controls: false,
        message_body_code_markdown: codeMarkdown};
    }
    const bodies = [...unit.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
    const siblings = modernUnits.filter(other =>
      other.closest('[data-content-search-turn-key]') === container &&
      /:assistant$/.test(other.getAttribute('data-chatgpt-search-unit-key') || ''));
    const footers = [...container.querySelectorAll('.turn-action-controls')].filter(footer => {
      if (footer.closest('[data-content-search-turn-key]') !== container) return false;
      // Current UI: Copy is the only final action. Its explicit complete state
      // must own this response and footer, not another response in the same turn.
      const state = unit.closest('[data-talvt-turn-state]');
      if (state && state.getAttribute('data-talvt-turn-state') === 'complete' &&
          footer.closest('[data-talvt-turn-state]') === state &&
          state.closest('[data-content-search-turn-key]') === container &&
          modernUnits.filter(other => /:assistant$/.test(
            other.getAttribute('data-chatgpt-search-unit-key') || '') && state.contains(other)).length === 1 &&
          footer.querySelectorAll('button[aria-label="复制"], button[aria-label="Copy"]').length === 1)
        return true;
      const regenerate = footer.querySelectorAll('button[aria-label="重新生成回复"], button[aria-label="Regenerate response"]');
      const bad = footer.querySelectorAll('button[aria-label="回复不佳"], button[aria-label="Bad response"]');
      // Observed current Chinese UI replaces Bad response with a reaction
      // popover, and can omit Regenerate after reopening the completed turn.
      const reactions = footer.querySelectorAll('button[aria-label="回应"][aria-haspopup="dialog"][data-slot="popover-trigger"]');
      return (regenerate.length === 1 && bad.length === 1 && reactions.length === 0) ||
        (regenerate.length <= 1 && bad.length === 0 && reactions.length === 1 &&
          footer.querySelectorAll('button[aria-label="复制"]').length === 1 &&
          footer.querySelectorAll('button[aria-label="更多操作"][aria-haspopup="menu"]').length === 1);
    });
    const footer = footers.length === 1 ? footers[0] : null;
    const finalControls = !!footer && siblings[siblings.length - 1] === unit && bodies.length === 1;
    return {role: 'assistant', text: bodies.length === 1 ? text(bodies[0]) : '',
      message_body: null, turn_text: text(unit), final_controls: finalControls};
  });
  const turns = legacyMessages.length && modernUnits.length ? [] :
    legacyMessages.length ? legacyTurns : modernTurns.every(Boolean) ? modernTurns : [];
  const users = turns.filter(turn => turn.role === 'user').map(turn => turn.text);
  const assistants = turns.filter(turn => turn.role === 'assistant').map(turn => turn.text);
  const userTurns = legacyMessages.length ?
    [...document.querySelectorAll('article,[data-testid^="conversation-turn"]')]
      .filter(e => e.querySelector('[data-message-author-role="user"]')).map(text) :
    turns.filter(turn => turn.role === 'user').map(turn => turn.turn_text);
  const pageText = text(document.body).slice(0, 800);
  return {
    url: location.href,
    title: document.title,
    // Additions over the driver, per docs/design/jev-in-hud.md 2.4 and 3.2: the
    // document load state, and the conversation links the sidebar currently shows
    // (the sent/reconcile evidence compares them against the recorded sidebar_before).
    readyState: document.readyState,
    sidebar_hrefs: [...document.querySelectorAll('a[href^="/c/"]')].map(a => a.getAttribute('href')),
    composer: composer ? (composer.tagName === 'TEXTAREA' ? composer.value.trim() : text(composer)) : null,
    send_button: !!send,
    form_text: text(composer?.closest('form')),
    attachment_cards: attachmentCards,
    user_turns: users.length ? userTurns : [],
    stop_button: !!document.querySelector('[data-testid="stop-button"]'),
    login: !!document.querySelector('[data-testid="login-button"]'),
    approval: [...document.querySelectorAll('main button')].map(text)
      .filter(t => /^(允许一次|始终允许|拒绝|Allow once|Always allow|Deny)$/.test(t)),
    // The words of the prompt those buttons belong to: the largest enclosing block that is still short.
    approval_text: (() => {
      let e = [...document.querySelectorAll('main button')].find(b => /^(始终允许|Always allow)$/.test(text(b)));
      let words = '';
      for (let i = 0; e && i < 7; i++, e = e.parentElement) if (text(e).length < 500) words = text(e);
      return words;
    })(),
    challenge: /just a moment|verify you are human/i.test(document.title + ' ' + text(document.body).slice(0, 400)),
    auth_required: !composer && /log in|sign in|sign up|登录|登入|注册/i.test(document.title + ' ' + pageText),
    page_error: location.protocol === 'chrome-error:' || /aw, snap|page unresponsive|页面崩溃/i.test(document.title),
    users, assistants, turns,
  };
})()`
  .replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP)
  .replace('__SEND_LOOKUP__', SEND_LOOKUP)
  .replace('__ATTACHMENT_CARDS__', ATTACHMENT_CARDS);

export const NODE_FACTS = `(node => {
  const e = window.__jevFast?.nodes.get(node);
  const composer = (__COMPOSER_LOOKUP__)();
  const send = (__SEND_LOOKUP__)();
  return e ? {testid: e.getAttribute('data-testid'), id: e.id, inside_composer_form:
    !!composer && e.closest('form') === composer.closest('form'), role: e.getAttribute('role'),
    haspopup: e.getAttribute('aria-haspopup'),
    model_trigger: !!e.id && /^(选择 ChatGPT 模型|Choose ChatGPT model)$/.test(
      e.getAttribute('aria-label') || '') && e.getAttribute('aria-haspopup') === 'menu',
    expanded: e.getAttribute('aria-expanded'),
    is_composer: !!composer && (e === composer || composer.contains(e)),
    is_send: !!send && (e === send || send.contains(e)),
    text: (e.innerText || '').trim()} : null;
})`
  .replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP)
  .replace('__SEND_LOOKUP__', SEND_LOOKUP);

export const FOCUS_COMPOSER = `(() => {
  const composer = (__COMPOSER_LOOKUP__)();
  if (!composer) throw new Error('composer unavailable');
  composer.focus();
})()`.replace('__COMPOSER_LOOKUP__', COMPOSER_LOOKUP);
