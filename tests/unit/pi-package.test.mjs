import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFooterHost } from '../fakes/pi.mjs';
import { expProxyPath, readExpConfig, readExpGrantBalance, saveExpEdit } from '../../dist/collectors/exp-store.js';
const root = process.env.R6A_PI_EMITTED_ROOT ?? path.resolve('dist');
const { displayTarget } = await import(pathToFileURL(path.join(root, 'integrations/panel/receipt.js')));
const { visualWidth, truncateAnsi, stripAnsi } = await import(pathToFileURL(path.join(root, 'render/colors.js')));
const footerHost = createFooterHost({ visibleWidth: visualWidth, truncateToWidth: truncateAnsi });
const node = fs.realpathSync(process.execPath);
const readOpenAiBalance = (home, at) => readExpGrantBalance(home, 'openai-api', at);
const anthropicModel = { provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' };
const anthropicKeyStatus = { configured: true, source: 'environment', label: 'ANTHROPIC_API_KEY' };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'hud-pi-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'),
    cwd = path.join(dir, 'workspace'),
    release = path.join(dir, 'checkout with spaces'),
    packageDir = path.join(dir, 'pi-package'),
    displayDir = path.join(dir, 'pi-display'),
    hudHome = path.join(dir, 'hud');
  for (const p of [home, cwd, hudHome, path.join(packageDir, 'extensions'), path.join(release, 'dist/harness/pi')])
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  // Inject only process/transport/clock ports into the REAL implementation.
  fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(release, 'dist/harness/pi/package-entry.js'),
    `import { installPiPackage as real } from ${JSON.stringify(pathToFileURL(path.join(root, 'harness/pi/package-entry.js')).href)}; export function installPiPackage(pi,b,deps,mode) { return real(pi,b,globalThis[Symbol.for('hud-a5-test-ports')] ?? deps,mode); }`
  );
  for (const entry of ['bin/hud', 'packages/hud-mcp/bin/hud-mcp.mjs']) {
    fs.mkdirSync(path.dirname(path.join(release, entry)), { recursive: true });
    fs.symlinkSync(path.resolve(entry), path.join(release, entry));
  }
  const binding = { release, hudHome, node };
  for (const [from, to] of [
    ['package.template.json', 'package.json'],
    ['binding.mjs', 'binding.mjs'],
    ['extensions/hud.mjs', 'extensions/hud.mjs'],
  ])
    fs.copyFileSync(path.join('integrations/pi/package', from), path.join(packageDir, to));
  fs.writeFileSync(path.join(packageDir, 'binding.json'), JSON.stringify(binding));
  // The display package (footer, Work segment, /hud) is a second, unregistered dir.
  fs.mkdirSync(path.join(displayDir, 'extensions'), { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    ['display.template.json', 'package.json'],
    ['binding.mjs', 'binding.mjs'],
    ['extensions/hud-display.mjs', 'extensions/hud-display.mjs'],
  ])
    fs.copyFileSync(path.join('integrations/pi/package', from), path.join(displayDir, to));
  fs.writeFileSync(path.join(displayDir, 'binding.json'), JSON.stringify(binding));
  // Native-node package-host tests supply host peers outside the release bundle.
  // Real pi loader alias resolution is separately probed; these modules never ship.
  // Only the display entry imports the host; the delegation entry needs no peers.
  for (const [name, body] of [
    [
      'pi-coding-agent',
      `import {createFooterHost} from ${JSON.stringify(pathToFileURL(path.resolve('tests/fakes/pi.mjs')).href)}; const {CustomEditor}=createFooterHost({}); export {CustomEditor};`,
    ],
    [
      'pi-tui',
      `export {visualWidth as visibleWidth, truncateAnsi as truncateToWidth} from ${JSON.stringify(pathToFileURL(path.join(root, 'render/colors.js')).href)};`,
    ],
  ]) {
    const peer = path.join(displayDir, 'node_modules/@earendil-works', name);
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(peer, 'index.js'), body);
  }
  const env = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: hudHome,
    CODEX_HOME: path.join(dir, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    PI_CODING_AGENT_DIR: path.join(dir, 'agent'),
  };
  return { home, cwd, packageDir, displayDir, binding, env };
}
function host() {
  const handlers = new Map(),
    commands = new Map(),
    tools = new Map(),
    statuses = new Map([['other', 'other-status']]);
  const calls = { footer: 0, messages: 0, status: [], notices: [], command: 0 };
  let editor, footer;
  const tui = { requestRender() {} };
  const theme = { fg: (_token, text) => text };
  const pi = {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    registerCommand(name, c) {
      calls.command++;
      assert.equal(commands.has(name), false);
      commands.set(name, c);
    },
    registerTool(t) {
      assert.equal(tools.has(t.name), false);
      tools.set(t.name, t);
    },
    sendUserMessage() {
      calls.messages++;
      throw Error('provider_path_forbidden');
    },
    registerMcpServer() {
      throw Error('duplicate_server_forbidden');
    },
  };
  const ui = {
    setStatus(key, value) {
      calls.status.push([key, value]);
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
    theme,
    setEditorComponent(factory) {
      editor = factory?.(tui, theme, {});
    },
    setWidget() {},
    setFooter(factory) {
      calls.footer++;
      footer?.dispose?.();
      footer = factory?.(tui, theme, { getExtensionStatuses: () => statuses });
    },
    notify(msg) {
      calls.notices.push(msg);
    },
  };
  const emit = async (name, ctx, e = {}) => {
    for (const fn of [...(handlers.get(name) ?? [])]) await fn(e, ctx);
  };
  return {
    pi,
    ui,
    calls,
    handlers,
    commands,
    tools,
    statuses,
    emit,
    footer: () => {
      footer?.render(400);
      return editor?.render(400).join('\n') ?? ['pi-default', ...statuses.values()].join('|');
    },
    components: () => ({ editor, footer }),
  };
}
function context(f, h, id = 'session-a', mode = 'tui') {
  const source = path.join(f.home, 'sessions');
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  let file = path.join(source, `${id}.jsonl`),
    selected = id;
  const header = () => ({ type: 'session', version: 3, id: selected, cwd: f.cwd });
  fs.writeFileSync(file, JSON.stringify(header()) + '\n', { mode: 0o600 });
  const ctx = {
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: f.cwd,
    ui: h.ui,
    model: { id: 'synthetic-model', name: 'Synthetic Model', reasoning: true },
    getContextUsage: () => ({ contextWindow: 200000, percent: 42 }),
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => 'leaf',
      getCwd: () => f.cwd,
      getSessionId: () => selected,
      getSessionDir: () => source,
      getSessionFile: () => file,
      getHeader: header,
    },
  };
  return {
    ctx,
    source,
    root: displayTarget('pi', id, source).root,
    setFile: (v) => (file = v),
    setId: (v) => (selected = v),
  };
}
function ports(f) {
  let time = Date.now();
  const timers = new Set();
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'herdr'),
    `#!${node}\nimport(${JSON.stringify(pathToFileURL(path.resolve('tests/fakes/panel-herdr.mjs')).href)});\n`,
    { mode: 0o700 }
  );
  const log = path.join(f.home, 'herdr.jsonl');
  fs.writeFileSync(log, '');
  Object.assign(f.env, { PATH: `${bin}:${path.dirname(node)}`, HERDR_PANE_ID: 'w4E:p1', PANEL_FAKE_LOG: log });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const options = {
    env: f.env,
    footerHost: async () => footerHost,
    segment: {
      now: () => time,
      schedule: (cb, ms) => {
        assert.equal(ms, 5000);
        const item = { cb };
        timers.add(item);
        return () => timers.delete(item);
      },
    },
  };
  return {
    options,
    calls,
    timers,
    advance(ms) {
      time += ms;
      const todo = [...timers];
      timers.clear();
      for (const x of todo) x.cb();
    },
    counts: () => ({
      splits: calls().filter((argv) => argv[1] === 'split').length,
      closes: calls().filter((argv) => argv[1] === 'close').length,
    }),
    now: () => time,
  };
}
async function load(f, h, p, extension = 'hud.mjs') {
  const key = Symbol.for('hud-a5-test-ports');
  globalThis[key] = p?.options;
  try {
    const dir = extension === 'hud.mjs' ? f.packageDir : f.displayDir;
    const entry = await import(pathToFileURL(path.join(dir, 'extensions', extension)));
    await entry.default(h.pi);
  } finally {
    delete globalThis[key];
  }
}

test('pi on/off/toggle/status uses the caller pane without native ancestry and reopens a missing pane', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  await load(f, h, p, 'hud-display.mjs');
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 0, 'session_start opens no panel');
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 1);
  const run = p.calls().find((argv) => argv[1] === 'run');
  const pane = run[2];
  assert.deepEqual(p.calls()[0], ['pane', 'layout', '--pane', 'w4E:p1']);
  assert.equal(
    p.calls()[1].join('|'),
    `pane|split|w4E:p1|--direction|right|--ratio|${1 - 56 / 120}|--no-focus|--cwd|${f.cwd}|--env|HUD_PANEL_CALLER_PANE=w4E:p1|--env|HUD_PANEL_WIDTH=56`
  );
  assert.ok(run[3].includes(`'${f.binding.release}/bin/hud' 'panel' '--here' '--harness' 'pi'`));
  assert.ok(run[3].endsWith(`'--session' 'session-a' '--source' '${c.source}'`));
  await h.commands.get('hud').handler('status', c.ctx);
  assert.equal(h.calls.notices.at(-1), `HUD: open (${pane})`);
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 1, 'on reuses the remembered live pane');
  const stateFile = f.env.PANEL_FAKE_LOG + '.state';
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.panes = state.panes.filter((p) => p.pane_id !== pane);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 2, 'on replaces a pane closed outside pi');
  const replacement = p
    .calls()
    .filter((argv) => argv[1] === 'run')
    .at(-1)[2];
  await h.commands.get('hud').handler('off', c.ctx);
  assert.deepEqual(p.calls().at(-1), ['pane', 'close', replacement]);
  await h.commands.get('hud').handler('status', c.ctx);
  assert.equal(h.calls.notices.at(-1), 'HUD: closed');
  await h.commands.get('hud').handler('toggle', c.ctx);
  assert.equal(p.counts().splits, 3);
  await h.commands.get('hud').handler('toggle', c.ctx);
  assert.equal(h.calls.notices.at(-1), 'HUD: closed');
  await h.commands.get('hud').handler('', c.ctx);
  assert.equal(p.counts().splits, 4, 'bare /hud toggles the panel open');
  await h.commands.get('hud').handler('', c.ctx);
  assert.equal(h.calls.notices.at(-1), 'HUD: closed', 'bare /hud toggles the panel closed');
  assert.equal(h.calls.messages, 0);
  await h.emit('session_shutdown', c.ctx);
});

test('combined pi packages retain delegation after canceled navigation and display reconnect', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f);
  await load(f, h, p);
  await load(f, h, p, 'hud-display.mjs');
  t.after(() => h.emit('session_shutdown', c.ctx));
  await h.emit('session_start', c.ctx);
  const roster = () => h.tools.get('hud_roster').execute('synthetic', {}, undefined, undefined, c.ctx);
  assert.ok((await roster()).details.roles.length);
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
    await h.emit(event, c.ctx); // No successful transition follows: navigation was canceled.
    await h.commands.get('hud').handler('reconnect', c.ctx);
    assert.equal(h.calls.notices.at(-1), 'HUD: reconnected; panel_not_open');
    assert.ok((await roster()).details.roles.length);
  }
  assert.equal(h.tools.size, 8);
  assert.equal(h.commands.size, 1);
  assert.equal(p.counts().splits, 0);
});

test('delegation collects live oapi requests, using request-time prices and persisted fallback IDs without a footer', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h, 'synthetic-worker', 'rpc');
  const pathToLedger = path.join(f.binding.hudHome, 'exp', 'ledger-openai-api.jsonl');
  const settings = (experiments) =>
    fs.writeFileSync(path.join(f.binding.hudHome, 'hud-settings.json'), JSON.stringify({ experiments }));
  const now = Date.parse('2026-11-20T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const grant = (field, value) =>
    saveExpEdit(f.binding.hudHome, { field, account: 'openai-api', value }, Date.now(), f.env);
  const lines = () => fs.readFileSync(pathToLedger, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const reply = (fields = {}) => ({
    role: 'assistant',
    provider: 'oapi',
    model: 'synthetic-oapi',
    stopReason: 'stop',
    responseId: 'synthetic-vendor-id',
    timestamp: now - 60000,
    content: 'synthetic prompt text must never persist',
    usage: { input: 12500, output: 40000, cacheRead: 20000, cacheWrite: 10000, cost: { total: 99 } },
    ...fields,
  });
  const start = () => h.emit('context', c.ctx);
  const finish = async (message, messageEntryId = 'assistant-entry') => {
    await h.emit('message_end', c.ctx, { message });
    await h.emit('turn_end', c.ctx, { message, messageEntryId });
  };
  c.ctx.model = {
    id: 'synthetic-oapi',
    provider: 'oapi',
    cost: { input: 12, output: 10, cacheRead: 1, cacheWrite: 8 },
  };
  c.ctx.sessionManager.getEntries = () => {
    throw Error('collector must not read old sessions');
  };
  c.ctx.sessionManager.getBranch = c.ctx.sessionManager.getEntries;
  await load(f, h, { options: { env: f.env } });
  await h.emit('session_start', c.ctx);
  settings(true);
  await start();
  await finish(reply());
  assert.equal(fs.existsSync(pathToLedger), false, 'account disabled');
  grant('grant-enabled', true);
  settings(false);
  await start();
  settings(true);
  await finish(reply());
  assert.equal(fs.existsSync(pathToLedger), false, 'no collection for requests started before enable');
  for (const provider of ['openai', 'openai-codex', 'anthropic', 'synthetic-gateway']) {
    await start();
    await finish(reply({ provider }));
  }
  await start();
  await finish(reply({ stopReason: 'error' }));
  await start();
  await finish(reply({ stopReason: 'aborted' }));
  assert.equal(fs.existsSync(pathToLedger), false, 'non-oapi and incomplete requests');

  grant('calibration', 13_400_000);
  await start();
  c.ctx.model.cost.input = 500; // in-flight edits cannot reprice the request
  t.mock.timers.setTime(now + 1000);
  await finish(reply());
  assert.equal(lines()[1].costMicros, 650_000);
  assert.equal(lines()[1].at, new Date(now + 1000).toISOString(), 'actual completion, not message start');
  assert.equal(lines()[1].source, 'priced');
  assert.deepEqual(Object.keys(lines()[1]).sort(), ['at', 'costMicros', 'id', 'model', 'source', 'tokens', 'type']);
  assert.deepEqual(lines()[1].tokens, { input: 12500, output: 40000, cacheRead: 20000, cacheWrite: 10000 });
  assert.doesNotMatch(fs.readFileSync(pathToLedger, 'utf8'), /synthetic prompt|synthetic-vendor-id/);
  if (process.env.EXP_EXAMPLES) t.diagnostic(JSON.stringify(lines()[1]));

  await start();
  await finish(reply());
  assert.equal(readOpenAiBalance(f.binding.hudHome, Date.now()).remainingMicros, 12_750_000);
  const fallback = reply({
    responseId: undefined,
    model: 'synthetic-unknown',
    usage: { ...reply().usage, cost: { total: 0, totalFromProvider: true } },
  });
  await start();
  await h.emit('message_end', c.ctx, { message: fallback });
  assert.equal(lines().length, 3, 'fallback waits for native message ID');
  t.mock.timers.setTime(now + 90_000);
  await h.emit('turn_end', c.ctx, { message: { ...fallback }, messageEntryId: 'stable-entry' });
  assert.equal(lines().at(-1).at, new Date(now + 1000).toISOString(), 'tool time is not completion time');
  await start();
  await finish({ ...fallback }, 'stable-entry');
  assert.equal(lines().at(-1).id, lines().at(-2).id);
  assert.equal(lines().at(-1).source, 'unpriced');
  assert.equal(lines().at(-1).costMicros, null);
  await start();
  await finish({ ...fallback, responseId: 'distinct-same-ms', usage: { ...fallback.usage, cost: { total: 99 } } });
  assert.equal(lines().at(-1).source, 'unpriced', 'unmarked total alone is not billed cost');
  assert.equal(readOpenAiBalance(f.binding.hudHome, Date.now()).unpriced, 2);
  await start();
  await finish(
    reply({ responseId: 'reported', usage: { ...reply().usage, cost: { total: 0.25, totalFromProvider: true } } })
  );
  assert.equal(lines().at(-1).source, 'reported');
  assert.equal(lines().at(-1).costMicros, 250_000);
  await start();
  await finish(
    reply({
      responseId: 'priced-by-actual-route',
      model: 'synthetic-routed',
      usage: {
        ...reply().usage,
        cost: { total: 0.65, input: 0.15, output: 0.4, cacheRead: 0.02, cacheWrite: 0.08, totalFromProvider: false },
      },
    })
  );
  assert.equal(lines().at(-1).source, 'priced');
  assert.equal(lines().at(-1).costMicros, 650_000);
  assert.equal(h.calls.footer, 0);
  const count = lines().length;
  await h.emit('session_shutdown', c.ctx);
  h.tools.clear(); // The replacement Pi runtime starts with a fresh tool registry.
  await load(f, h, { options: { env: f.env } });
  await h.emit('session_start', c.ctx);
  await finish(reply());
  assert.equal(lines().length, count, 'startup/resume does not replay');
  await start();
  settings(false);
  await finish(reply({ responseId: 'disabled-in-flight' }));
  assert.equal(lines().length, count, 'closing EXP stops writes and preserves history');
  await h.emit('session_shutdown', c.ctx);
});

test('delegation isolates the Anthropic API-key ledger from OAuth, gateways, unknown routes, and oapi', async (t) => {
  const f = setup(t), h = host(), c = context(f, h, 'synthetic-worker', 'rpc');
  const home = f.binding.hudHome;
  const now = Date.parse('2026-11-20T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  fs.writeFileSync(path.join(home, 'hud-settings.json'), JSON.stringify({ experiments: true }));
  const edit = (account, field, value) => saveExpEdit(home, { account, field, value }, Date.now(), f.env);
  const ledger = (account) => path.join(home, 'exp', `ledger-${account}.jsonl`);
  const balance = (account) => readExpGrantBalance(home, account, Date.now());
  const anthropic = 'anthropic-api', oapi = 'openai-api';
  edit(oapi, 'grant-enabled', true);
  let oauth = false, status = anthropicKeyStatus, registered = [];
  const registry = {
    isUsingOAuth: () => oauth,
    getProviderAuthStatus: () => status,
    getRegisteredProviderIds: () => registered,
  };
  const model = { ...anthropicModel, id: 'synthetic-claude', cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 } };
  const reply = {
    role: 'assistant', provider: model.provider, api: model.api, model: model.id, stopReason: 'stop', responseId: 'shared-id',
    usage: { input: 10000, output: 5000, cacheRead: 25000, cacheWrite: 10000, cacheWrite1h: 2000, cost: { total: 0 } },
  };
  const start = (selected = model, auth = registry) => {
    c.ctx.model = selected;
    c.ctx.modelRegistry = auth;
    return h.emit('context', c.ctx);
  };
  const finish = async (message = reply) => {
    t.mock.timers.tick(1000);
    await h.emit('message_end', c.ctx, { message });
    await h.emit('turn_end', c.ctx, { message, messageEntryId: 'synthetic-entry' });
  };
  await load(f, h, { options: { env: f.env } });
  await h.emit('session_start', c.ctx);
  t.after(() => h.emit('session_shutdown', c.ctx));
  await start();
  edit(anthropic, 'grant-enabled', true);
  await finish(); // Started before the account was enabled.
  oauth = true;
  await start();
  oauth = false;
  await finish(); // OAuth at request start, even if the registry later changes.
  for (const label of ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'workload identity federation']) {
    status = { ...anthropicKeyStatus, label };
    await start();
    await finish();
  }
  status = { configured: false };
  await start();
  await finish();
  status = anthropicKeyStatus;
  await start(model, null);
  await finish();
  registered = ['anthropic'];
  await start();
  await finish();
  registered = [];
  for (const selected of [
    { ...model, provider: 'synthetic-gateway' },
    { ...model, baseUrl: 'https://api.anthropic.com.synthetic.invalid' },
    { ...model, baseUrl: undefined },
    { ...model, api: 'openai-completions' },
  ]) {
    await start(selected);
    await finish();
  }
  for (const fields of [{ provider: 'synthetic-gateway' }, { model: 'synthetic-other' }, { stopReason: 'error' }]) {
    await start();
    await finish({ ...reply, ...fields });
  }
  assert.equal(fs.existsSync(ledger(anthropic)), false, 'unattributable requests write nothing');
  assert.equal(fs.existsSync(ledger(oapi)), false, 'neither does the other ledger');

  edit(anthropic, 'calibration', 8_000_000);
  edit(oapi, 'calibration', 15_000_000);
  await start();
  await finish(); // 100000 input + 100000 output + 25000 reads + 100000 short writes + 40000 long writes.
  assert.equal(balance(anthropic).remainingMicros, 7_635_000);
  assert.equal(balance(oapi).remainingMicros, 15_000_000);
  await start({ provider: 'oapi', id: 'synthetic-oapi' });
  const reported = (total) => ({ ...reply.usage, cost: { total, totalFromProvider: true } });
  await finish({ ...reply, provider: 'oapi', model: 'synthetic-oapi', usage: reported(2) });
  assert.equal(balance(oapi).remainingMicros, 13_000_000, 'same response ID in the other account is independent');
  await start();
  await finish(); // Duplicate response ID in the same account.
  const noResponseId = { ...reply, responseId: undefined, usage: reported(0.5) };
  for (let i = 0; i < 2; i++) {
    await start();
    await finish(noResponseId); // Duplicate persisted-entry ID in the same session.
  }
  assert.equal(balance(anthropic).remainingMicros, 7_135_000);
  assert.equal(balance(anthropic).billedMicros, 865_000);
  assert.equal(balance(oapi).remainingMicros, 13_000_000);
  const lines = fs.readFileSync(ledger(anthropic), 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(lines.slice(1).map(({ source, costMicros }) => [source, costMicros]), [
    ['priced', 365_000], ['priced', 365_000], ['reported', 500_000], ['reported', 500_000],
  ]);
  assert.equal(h.calls.footer, 0);
});

test('40-column pi footer switches among subscription proxy, oapi, and Anthropic API grants, and clears on master off', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f);
  const home = f.binding.hudHome;
  f.env.NO_COLOR = '1';
  f.env.PATH = path.join(f.home, 'bin'); // Only the fake herdr; no real Codex or provider.
  const settings = (experiments) =>
    fs.writeFileSync(path.join(home, 'hud-settings.json'), JSON.stringify({ experiments }));
  settings(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T10:30:00Z') });
  c.ctx.model = { id: 'gpt-5.2', provider: 'oapi' };
  let oauth = true;
  c.ctx.modelRegistry = { isUsingOAuth: () => oauth, getProviderAuthStatus: () => anthropicKeyStatus };
  const profile = path.join(fs.realpathSync(f.home), '.codex');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'config.toml'), '# synthetic profile\n');
  const change = (field, value) =>
    saveExpEdit(home, { field, account: 'openai-api', value }, Date.now(), f.env);
  change('grant-enabled', true);
  change('calibration', 13_400_000);
  change('binding', profile);
  change('proxy-enabled', true);
  saveExpEdit(home, { field: 'grant-enabled', account: 'anthropic-api', value: true }, Date.now(), f.env);
  saveExpEdit(home, { field: 'calibration', account: 'anthropic-api', value: 8_000_000 }, Date.now(), f.env);
  fs.writeFileSync(
    expProxyPath(home),
    JSON.stringify({
      profile,
      bindingVersion: readExpConfig(home).proxy.bindingVersion,
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 1800 },
      observedAtMs: Date.now(),
      error: null,
      failures: 0,
      nextAttemptMs: null,
    }),
    { mode: 0o600 }
  );
  t.after(() => h.emit('session_shutdown', c.ctx));
  await load(f, h, { options: { env: { ...f.env, HERDR_PANE_ID: undefined } } });
  await load(f, h, p, 'hud-display.mjs');
  await h.emit('session_start', c.ctx);
  const request = async (responseId, total) => {
    await h.emit('context', c.ctx);
    t.mock.timers.tick(1000);
    await h.emit('message_end', c.ctx, {
      message: {
        role: 'assistant',
        provider: c.ctx.model.provider,
        api: c.ctx.model.api,
        model: c.ctx.model.id,
        responseId,
        stopReason: 'stop',
        usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total, totalFromProvider: true } },
      },
    });
    await h.emit('agent_end', c.ctx);
  };
  await request('sample-request', 0.65);
  const row = () => {
    const text = stripAnsi(h.components().footer.render(40)[0]);
    assert.ok(visualWidth(text) <= 40, text);
    return text;
  };
  const select = async (provider, override = {}) => {
    c.ctx.model = provider === 'anthropic'
      ? { ...anthropicModel, id: 'claude-sonnet-4-6', ...override }
      : { id: 'gpt-5.2', provider };
    await h.emit('model_select', c.ctx);
  };
  const api = /API ≈\$12\.75/;
  const proxy = /5h ≈72%/;
  assert.match(row(), api);
  await select('openai');
  assert.doesNotMatch(row(), /API/, 'switching to subscription immediately drops the ledger');
  await until(() => proxy.test(row()), 'timed out loading the synthetic proxy snapshot');
  const subscriptionRow = row();
  await select('oapi');
  const apiRow = row();
  assert.match(apiRow, api);
  assert.doesNotMatch(apiRow, /5h/, 'switching to oapi immediately drops the proxy');
  oauth = false;
  await select('anthropic');
  assert.match(row(), /API ≈\$8\.00/);
  await request('sample-anthropic-request', 0.35);
  const anthropicRow = row();
  assert.match(anthropicRow, /API ≈\$7\.65/);
  assert.doesNotMatch(anthropicRow, /12\.75|5h/);
  oauth = true;
  assert.doesNotMatch(row(), /API|5h/, 'an auth change cannot display a cached Anthropic balance');
  oauth = false;
  await select('anthropic', { baseUrl: 'https://synthetic-gateway.invalid' });
  assert.doesNotMatch(row(), /API|5h/);
  await select('oapi');
  assert.match(row(), api);
  oauth = true;
  await select('openai');
  const switchedBack = row();
  assert.match(switchedBack, proxy);
  assert.doesNotMatch(switchedBack, /API/);
  oauth = false;
  await select('openai');
  assert.doesNotMatch(row(), /5h|API/, 'openai without OAuth uses neither reading');
  if (process.env.EXP_EXAMPLES) {
    t.diagnostic(`openai OAuth: ${subscriptionRow}`);
    t.diagnostic(`oapi: ${apiRow}`);
    t.diagnostic(`anthropic API: ${anthropicRow}`);
  }
  await select('oapi');
  await h.commands.get('hud').handler('footer off', c.ctx);
  await request('overage-request', 15);
  assert.equal(readOpenAiBalance(f.binding.hudHome, Date.now()).remainingMicros, -2_250_000);
  await h.commands.get('hud').handler('footer on', c.ctx);
  assert.match(row(), /API ≈\$0(?:\s|$)/);
  await select('anthropic');
  assert.match(row(), /API ≈\$7\.65/);
  settings(false);
  p.advance(5000); // The existing Work refresh clears an idle footer.
  assert.doesNotMatch(row(), /API/);
});

test('agent_end updates the mounted footer exactly once', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f);
  let scans = 0;
  c.ctx.sessionManager.getBranch = () => {
    scans++;
    return [];
  };
  await load(f, h, p, 'hud-display.mjs');
  await h.emit('session_start', c.ctx);
  scans = 0;
  await h.emit('agent_end', c.ctx);
  assert.equal(scans, 1);
  await h.emit('session_shutdown', c.ctx);
});

test('footer band toggles and footer off restore pi editor and footer, including shutdown', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f);
  c.ctx.sessionManager.getSessionName = () => 'Synthetic ribbon';
  await load(f, h, p, 'hud-display.mjs');
  await h.emit('session_start', c.ctx);
  const command = (args) => h.commands.get('hud').handler('footer ' + args, c.ctx);
  const top = () => h.components().editor.render(160)[0];
  assert.match(top(), /Synthetic ribbon.*cache/);
  assert.equal(h.components().footer.render(160).length, 1);
  await command('band off');
  assert.doesNotMatch(top(), /Synthetic ribbon|cache/);
  assert.match(h.components().footer.render(160)[0], /42%/);
  await command('band on');
  assert.match(top(), /Synthetic ribbon/);
  await command('off');
  assert.deepEqual(h.components(), { editor: undefined, footer: undefined });
  assert.match(h.footer(), /pi-default.*other-status/);
  await command('on');
  assert.match(top(), /Synthetic ribbon/);
  await h.emit('session_shutdown', c.ctx);
  assert.deepEqual(h.components(), { editor: undefined, footer: undefined });
});

test('the delegation-only package registers the tools but no footer, no /hud and no panel', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  await load(f, h, p, 'hud.mjs');
  assert.deepEqual([...h.tools.keys()].sort(), [
    'hud_close',
    'hud_create',
    'hud_peek',
    'hud_read',
    'hud_respond',
    'hud_roster',
    'hud_send',
    'hud_wait',
  ]);
  assert.equal(h.commands.size, 0, 'no /hud command');
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 0, 'the settings-registered package a worker could load opens no panel');
  assert.equal(h.calls.footer, 0, 'no footer');
  assert.equal(h.calls.status.length, 0, 'no Work segment');
  assert.equal(fs.existsSync(path.join(f.binding.hudHome, 'watchers')), false, 'no native sendMessage API');
  await h.emit('session_shutdown', c.ctx);
});

async function until(check, failure = 'timed out waiting for the native watcher') {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < deadline, failure);
    await sleep(20);
  }
}

test('pi delegation wakes the current session natively and fences the watcher on rebind and shutdown', async (t) => {
  const f = setup(t), h = host(), c = context(f, h), p = ports(f);
  const home = f.binding.hudHome, pane = f.env.HERDR_PANE_ID;
  const marker = path.join(home, 'watchers', `${pane}.pid`);
  const id = 'j0000000000000001', dir = path.join(home, 'jobs', id);
  const receipt = { job: id, role: 'imp', herdr_pane: pane, created_at: new Date().toISOString(), cli: { agent: 'claude' } };
  const status = (state) => fs.writeFileSync(path.join(dir, 'STATUS.json'), JSON.stringify({ state }));
  const messages = [];
  h.pi.sendMessage = (message, options) => messages.push({ message, options });
  fs.mkdirSync(path.join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(receipt));
  status('working');
  await load(f, h, p);
  await load(f, h, p, 'hud-display.mjs');
  t.after(() => h.emit('session_shutdown', c.ctx));
  assert.equal(fs.existsSync(marker), false, 'extension load is inert until session_start');
  await h.emit('session_start', c.ctx);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, process.pid);
  const q1 = path.join(dir, 'qa/q1.md');
  fs.writeFileSync(q1, '# Question q1 from imp@demo\n\nWhich layout?\n\nDefault if unanswered: rows\n');
  await until(() => messages.length === 1);
  fs.writeFileSync(path.join(dir, 'qa/q1.answer.md'), 'rows');
  fs.writeFileSync(path.join(dir, 'report.md'), 'Synthetic report.');
  status('idle_grace');
  await until(() => messages.length === 2);
  fs.writeFileSync(path.join(home, 'tries.jsonl'), [
    { root: '/synthetic/other-project', action: 'accept', milestone: 'M1', slices: ['other'] },
    { root: f.cwd, action: 'accept', milestone: 'M1', slices: ['demo'] },
  ].map(JSON.stringify).join('\n') + '\n');
  await until(() => messages.length === 3);
  assert.deepEqual(messages, [
    `[imp@demo] QUESTION q1: Which layout? | default: rows | full text: ${q1} | reply: hud_respond job=${id} request_id=q1`,
    `${id} imp: idle_grace | report`,
    'try accepted workspace M1: demo',
  ].map((content) => ({
    message: { customType: 'hud-watch', content, display: true },
    options: { deliverAs: 'followUp', triggerTurn: true },
  })));
  assert.deepEqual(p.calls(), [], 'native delivery never calls herdr');
  assert.equal(h.calls.messages, 0, 'native delivery never sends as user input');

  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ ...receipt, read_at: new Date().toISOString() }));
  const next = context(f, h, 'session-b');
  const rebinding = h.emit('session_tree', next.ctx);
  assert.equal(fs.existsSync(marker), false, 'fence synchronously unregisters the outgoing watch');
  await rebinding;
  assert.equal(fs.existsSync(marker), true, 'incoming session starts its own watch');
  next.setId('stale');
  fs.writeFileSync(path.join(dir, 'qa/q2.md'), 'A stale binding must not get this question.');
  await until(() => !fs.existsSync(marker));
  assert.equal(messages.length, 3);

  fs.writeFileSync(path.join(dir, 'qa/q2.answer.md'), 'Already answered.');
  next.setId('session-b');
  await h.emit('session_tree', next.ctx);
  assert.equal(fs.existsSync(marker), true);
  fs.writeFileSync(path.join(dir, 'qa/q3.md'), 'A shut-down binding must not get this question.');
  await h.emit('session_shutdown', next.ctx);
  assert.equal(fs.existsSync(marker), false);
  await sleep(150);
  assert.equal(messages.length, 3);
});

test('pi delegation never starts a native watcher for a HUD worker', async (t) => {
  const f = setup(t), h = host(), c = context(f, h), p = ports(f);
  f.env.HUD_JOB_DIR = path.join(f.binding.hudHome, 'jobs/j0000000000000001');
  h.pi.sendMessage = () => assert.fail('a worker must not be woken by the main watcher');
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  assert.equal(fs.existsSync(path.join(f.binding.hudHome, 'watchers')), false);
  await h.emit('session_shutdown', c.ctx);
});
