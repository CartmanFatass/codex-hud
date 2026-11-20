// The invented world of the sample: one project ("harbor-api"), one machine, seven roles. Nothing here is real data.
// Copied from docs/design/control-tab/gen/world.mjs, plus what the model picker needs: imp's fourth preset `lab` (a pi place
// whose model is a bare id, so its provider is unknown) and the model table (`pi --list-models` columns).
// Pure functions over a small state: which switches are off, which places carry a live quota mark.

/** A place: harness `pi` (provider + model), a CLI agent (`agy`, `claude`, `codex`, `grok`) or a browser tool (`jev-ask`...). */
const pi = (prov, model, think) => ({ h: 'pi', prov, model, think });
const cli = (agent, model, think) => ({ h: 'cli', agent, model, think });
const bro = (tool, site, kind) => ({ h: 'bro', tool, site, kind });

export const ROLES = {
  imp: {
    group: 'roles', file: 'imp.json', src: 'yours', order: ['default', 'grok', 'daily', 'lab'],
    presets: {
      default: [pi('openai', 'gpt-6.1-sol', 'xhigh'), cli('agy', 'gemini-4-hydrogen-high')],
      grok: [cli('grok', 'grok-4.7', 'high')],
      daily: [pi('xai', 'grok-4.7', 'high'), cli('agy', 'gemini-4-hydrogen-high'), cli('claude', 'claude-opus-5-5', 'high')],
      lab: [pi('', 'grok-4.7', 'medium')],   // a bare model id in the file: arena and xai both list it, so the provider is unknown
    },
  },
  reviewer: {
    group: 'roles', file: 'reviewer.json', src: 'yours', order: ['default', 'pi'],
    presets: {
      default: [cli('claude', 'claude-opus-5-5', 'high')],
      pi: [pi('openai', 'gpt-6.1-sol', 'xhigh'), cli('claude', 'claude-opus-5-5', 'high')],
    },
  },
  sonic: {
    group: 'roles', file: 'sonic.json', src: 'default', order: ['default'],
    presets: { default: [pi('mistral', 'mistral-small-4', 'low'), cli('agy', 'gemini-4-flash')] },
  },
  oracle: {
    group: 'roles', file: 'oracle.json', src: 'default', order: ['fable', 'architect'],
    presets: {
      fable: [cli('claude', 'claude-fable-5-2', 'high'), pi('openai', 'gpt-6.1-sol', 'xhigh')],
      architect: [pi('openai', 'gpt-6.1-sol', 'xhigh')],
    },
  },
  'frontend-imp': {
    group: 'roles', file: 'frontend-imp.json', src: 'default', order: ['default'],
    presets: { default: [cli('agy', 'gemini-4-hydrogen-high')] },
  },
  notes: {
    group: 'project', file: '.hud/roles/notes.json', src: 'project', order: ['default'],
    presets: { default: [pi('mistral', 'mistral-small-4', 'low')] },
  },
  pro: {
    group: 'browser', file: 'pro.json', src: 'default', order: ['default'],
    presets: { default: [bro('jev-ask', 'chatgpt', 'pro')] },
  },
  flow: {
    group: 'browser', file: 'flow.json', src: 'default', order: ['default'],
    presets: { default: [bro('jev-flow', 'flow', 'image')] },
  },
};
export const GROUPS = ['roles', 'project', 'browser'];

/** The machine: what is installed, and the pi providers `pi --list-models` showed (with their model counts). */
export const MACHINE = {
  cli: [['agy', true], ['claude', true], ['codex', false], ['grok', true]],
  bro: [['jev-ask', ['chatgpt', 'gemini']], ['jev-aistudio', ['argon']], ['jev-flow', ['flow']]],
  providers: [['anthropic', 9], ['arena', 38], ['google', 12], ['mistral', 8], ['openai', 15], ['xai', 6]],
};

/** Base state: three switches off already (`deepseek` is stored off but not in today's list), one live quota mark. */
export const BASE = { off: ['cli:grok', 'bro:jev-flow', 'pi:deepseek'], marks: { 'reviewer:0': 42 }, active: { imp: 'daily', reviewer: 'pi', sonic: 'default', oracle: 'fable', 'frontend-imp': 'default', notes: 'default', pro: 'default', flow: 'default' } };

/** The switch id of a place. */
export const switchOf = (p) => (p.h === 'pi' ? `pi:${p.prov}` : p.h === 'cli' ? `cli:${p.agent}` : `bro:${p.tool}`);
export const targetOf = (p) => (p.h === 'pi' ? `pi/${p.prov}` : p.h === 'cli' ? p.agent : p.site);
const isMissing = (p) => p.h === 'cli' && MACHINE.cli.find(([a]) => a === p.agent)?.[1] === false;

/** One evaluation per chain, in order: off (owner switch, also the runner), exhausted (live mark), missing, else standby; the first that can run is `next`. */
export function evaluate(role, name, state) {
  const places = ROLES[role].presets[name], off = new Set(state.off);
  const st = places.map((p, i) => {
    if (off.has(switchOf(p)) || (p.h === 'pi' && off.has('pi'))) return 'off';
    if (state.marks[`${role}:${i}`] !== undefined && name === state.active[role]) return 'exhausted';
    if (isMissing(p)) return 'missing';
    return 'standby';
  });
  const next = st.findIndex((s) => s === 'standby');
  if (next >= 0) st[next] = 'next';
  return { places, st, next };
}
/** The role as the list shows it: its selected preset and where the next job runs. */
export function roleView(role, state, name = state.active[role]) {
  const ev = evaluate(role, name, state);
  const attention = ev.next < 0 || ev.st.includes('exhausted');
  return { role, name, ...ev, attention, def: ROLES[role] };
}
export const roleNames = (state) => Object.keys(ROLES).sort();
/** The next preset name in effective order (`dir` 1 or -1), wrapping. */
export const cycle = (role, from, dir) => {
  const order = ROLES[role].order, at = order.indexOf(from);
  return order[(at + dir + order.length) % order.length];
};

// ------------------------------------------------------------------------------------------------ the model table
/** `pi --list-models` for this machine: provider -> [model, context, max-out, thinking, images]. Only the providers a frame opens are
 *  spelled out; the others contribute their count (`PROVIDER_COUNT`). Context and max-out are the command's own strings. */
const m = (id, ctx, out, think, img) => ({ id, ctx, out, think, img });
export const PROVIDER_COUNT = { anthropic: 9, arena: 38, google: 12, mistral: 8, openai: 15, xai: 6 };
export const TOTAL = Object.values(PROVIDER_COUNT).reduce((a, b) => a + b, 0);   // 88
export const LISTED = {
  openai: [
    m('gpt-5.5', '272K', '64K', 1, 1), m('gpt-5.5-codex', '272K', '64K', 1, 0), m('gpt-5.5-mini', '128K', '32K', 1, 1),
    m('gpt-6', '400K', '128K', 1, 1), m('gpt-6-mini', '200K', '64K', 1, 1), m('gpt-6-nano', '128K', '32K', 0, 1),
    m('gpt-6.1', '400K', '128K', 1, 1), m('gpt-6.1-codex', '400K', '128K', 1, 0), m('gpt-6.1-mini', '200K', '64K', 1, 1),
    m('gpt-6.1-sol', '1M', '128K', 1, 1), m('gpt-6.1-sol-mini', '400K', '64K', 1, 1), m('gpt-oss-240b', '128K', '32K', 1, 0),
    m('o5', '200K', '100K', 1, 1), m('o5-mini', '200K', '100K', 1, 0), m('o5-pro', '200K', '100K', 1, 1),
  ],
  xai: [
    m('grok-4.5', '256K', '64K', 1, 1), m('grok-4.6', '256K', '64K', 1, 1), m('grok-4.7', '256K', '64K', 1, 1),
    m('grok-4.7-code', '256K', '64K', 1, 0), m('grok-4.7-fast', '2M', '30K', 0, 1), m('grok-4.7-mini', '128K', '32K', 1, 0),
  ],
  arena: [   // 38 models; the ones a frame needs
    m('grok-4.6', '256K', '64K', 1, 1), m('grok-4.7', '256K', '64K', 1, 1),
    m('meta-llama/llama-4-maverick-17b-128e-instruct', '1M', '16K', 0, 1),
    m('meta-llama/llama-4-maverick-17b-128e-instruct-fp8', '1M', '16K', 0, 1),
  ],
  anthropic: [m('claude-opus-5-5', '500K', '64K', 1, 1)],
  mistral: [m('mistral-small-4', '128K', '16K', 1, 0)],
};
export const infoOf = (full) => {
  const [prov, ...rest] = full.split('/'), id = rest.join('/');
  const hit = LISTED[prov]?.find((x) => x.id === id);
  if (!hit) throw new Error(`no model info for ${full}`);
  return hit;
};

/** Where a model is used: the pi places of every role's presets, `provider/model` (or the bare id when the file gives no provider). */
export function usedBy(full) {
  const out = [];
  for (const [role, def] of Object.entries(ROLES)) for (const name of def.order) def.presets[name].forEach((p, i) => {
    if (p.h !== 'pi') return;
    const key = p.prov ? `${p.prov}/${p.model}` : p.model;
    if (key === full) out.push({ role, preset: name, place: i + 1, bare: !p.prov, src: def.src });
  });
  return out;
}
