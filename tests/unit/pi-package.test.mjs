import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createFooterHost, piPackage } from '../fakes/pi.mjs';
const root = process.env.R6A_PI_EMITTED_ROOT ?? path.resolve('dist');
const { roleSummaryPath, readRoleSummary, ROLE_SUMMARY_TTL_MS } = await import(
  pathToFileURL(path.join(root, 'roles/role-summary.js'))
);
const { renderRoleSummary } = await import(pathToFileURL(path.join(root, 'render/role-summary.js')));
const { readProcess } = await import(pathToFileURL(path.join(root, 'core/run/process.js')));
const { displayTarget, saveJson } = await import(pathToFileURL(path.join(root, 'integrations/panel/receipt.js')));
const { visualWidth, truncateAnsi } = await import(pathToFileURL(path.join(root, 'render/colors.js')));
const footerHost = createFooterHost({ visibleWidth: visualWidth, truncateToWidth: truncateAnsi });
const node = fs.realpathSync(process.execPath);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'hud-pi-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'),
    cwd = path.join(dir, 'workspace'),
    release = path.join(dir, 'checkout with spaces'),
    packageDir = path.join(dir, 'pi-package'),
    hudHome = path.join(dir, 'hud');
  for (const p of [home, cwd, hudHome, path.join(packageDir, 'extensions'), path.join(release, 'dist/harness/pi')])
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  // Inject only process/transport/clock ports into the REAL implementation.
  fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(release, 'dist/harness/pi/package-entry.js'),
    `import { installPiPackage as real } from ${JSON.stringify(pathToFileURL(path.join(root, 'harness/pi/package-entry.js')).href)}; export function installPiPackage(pi,b,deps) { return real(pi,b,globalThis[Symbol.for('hud-a5-test-ports')] ?? deps); }`
  );
  for (const entry of ['bin/hud', 'packages/hud-mcp/bin/hud-mcp.mjs']) {
    fs.mkdirSync(path.dirname(path.join(release, entry)), { recursive: true });
    fs.symlinkSync(path.resolve(entry), path.join(release, entry));
  }
  for (const [from, to] of [
    ['package.template.json', 'package.json'],
    ['binding.mjs', 'binding.mjs'],
    ['extensions/hud.mjs', 'extensions/hud.mjs'],
  ])
    fs.copyFileSync(path.join('integrations/pi/package', from), path.join(packageDir, to));
  const binding = { release, hudHome, node };
  fs.writeFileSync(path.join(packageDir, 'binding.json'), JSON.stringify(binding));
  // Native-node package-host tests supply host peers outside the release bundle.
  // Real pi loader alias resolution is separately probed; these modules never ship.
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
    const peer = path.join(packageDir, 'node_modules/@earendil-works', name);
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
  return { home, cwd, packageDir, binding, env };
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
function summary(f, root, now = Date.now()) {
  const dto = {
    schema: 1,
    root,
    producer: { generation: 'synthetic', process: readProcess(process.pid).stamp },
    observedAt: now,
    coverage: 'complete',
    counts: { 'needs-you': 2, 'in-progress': 3, 'awaiting-acceptance': 1, stalled: 0, done: 9 },
    sources: [],
  };
  saveJson(roleSummaryPath(f.env, root), dto);
  return dto;
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
  Object.assign(f.env, { PATH: `${bin}:${path.dirname(node)}`, HERDR_PANE_ID: 'main', PANEL_FAKE_LOG: log });
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
async function load(f, h, p) {
  const key = Symbol.for('hud-a5-test-ports');
  globalThis[key] = p?.options;
  try {
    const entry = await import(pathToFileURL(path.join(f.packageDir, 'extensions/hud.mjs')));
    await entry.default(h.pi);
  } finally {
    delete globalThis[key];
  }
}
test('real package entry loads directly from the checkout with only release, hudHome and node', async (t) => {
  const f = setup(t),
    h = host();
  const binding = { release: path.resolve('.'), hudHome: f.binding.hudHome, node };
  fs.writeFileSync(path.join(f.packageDir, 'binding.json'), JSON.stringify(binding));
  await load(f, h);
  assert.equal(h.calls.command, 1);
  assert.ok(h.commands.has('hud'));
  assert.deepEqual(
    [...h.tools.keys()],
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
  );
  assert.equal(h.calls.footer, 0, 'loading alone starts no UI or runtime resources');
});
test('package hud_roster proxy reaches the real thin server without session identity evidence', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h, 'unpersisted', 'print'),
    p = ports(f, h, c);
  // The tools need neither a persisted native session nor the retired fd3 channel.
  fs.unlinkSync(c.ctx.sessionManager.getSessionFile());
  c.setFile(undefined);
  await load(f, h, p);
  t.after(() => h.emit('session_shutdown', c.ctx));
  await h.emit('session_start', c.ctx);
  assert.deepEqual(h.tools.get('hud_roster').parameters.required, []);
  assert.deepEqual(h.tools.get('hud_create').parameters.required, ['role', 'request_key', 'task']);
  const result = await h.tools.get('hud_roster').execute('roster', {}, undefined, undefined, c.ctx);
  assert.deepEqual(result.details, JSON.parse(result.content[0].text));
  assert.ok(
    result.details.roles.some((role) => role.role === 'imp' && role.pi_role === 'implementer' && role.available)
  );
});
test('REAL package entry start -> reload -> shutdown owns footer, restores defaults, keeps other statuses and exactly six proxies', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  summary(f, c.root, p.now());
  assert.equal(h.footer(), 'pi-default|other-status');
  await load(f, h, p);
  await h.emit('session_start', c.ctx, { reason: 'startup' });
  assert.equal(h.calls.command, 1);
  assert.equal(h.calls.footer, 1);
  assert.equal(h.calls.messages, 0);
  assert.deepEqual(
    [...h.tools.keys()],
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
  );
  assert.equal(
    h.statuses.get('hud-delegation'),
    renderRoleSummary(readRoleSummary(f.env, c.root, { nowMs: p.now() }), 160)
  );
  assert.match(h.footer(), /Synthetic Model/);
  assert.match(h.footer(), /other-status Work:/);
  await h.commands.get('hud').handler('off', c.ctx);
  assert.match(h.footer(), /Synthetic Model/, 'panel off leaves the everyday footer alone');
  assert.equal(h.calls.footer, 1);
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 2);
  const panelCounts = p.counts();
  await h.commands.get('hud').handler('footer off', c.ctx);
  assert.equal(h.footer(), 'pi-default|other-status|' + h.statuses.get('hud-delegation'));
  await h.commands.get('hud').handler('footer on', c.ctx);
  assert.match(h.footer(), /Synthetic Model/);
  assert.deepEqual(p.counts(), panelCounts, 'footer controls do not touch the panel');
  await h.commands.get('hud').handler('footer off path', c.ctx);
  assert.ok(!h.footer().includes(c.ctx.cwd), 'segment forms still use the original parser');
  await h.commands.get('hud').handler('footer on path', c.ctx);
  assert.equal(p.timers.size, 1);
  await h.tools.get('hud_read').execute('host-call', {}, undefined, undefined, c.ctx);
  for (const cmd of ['status', 'on', 'off', 'toggle', 'help', 'reconnect', 'unknown', 'on extra'])
    await h.commands.get('hud').handler(cmd, c.ctx);
  assert.ok(h.calls.notices.some((v) => v.includes('unknown_subcommand')));
  const stop = h.emit('session_shutdown', c.ctx, { reason: 'reload' });
  await assert.rejects(
    () => h.tools.get('hud_read').execute('fenced', {}, undefined, undefined, c.ctx),
    /pi_session_inactive/
  );
  assert.equal(p.timers.size, 0);
  await stop;
  assert.equal(h.footer(), 'pi-default|other-status');
  assert.ok(h.calls.footer >= 4);
  assert.equal(h.calls.messages, 0);
  assert.ok(h.calls.status.every(([k]) => k === 'hud-delegation'));
  assert.equal(
    [...h.handlers.values()].reduce((n, s) => n + s.size, 0),
    0
  );
  const next = host(),
    nextContext = context(f, next);
  await load(f, next, p);
  await next.emit('session_start', nextContext.ctx, { reason: 'reload' });
  await next.emit('session_shutdown', nextContext.ctx);
  assert.equal(next.calls.command, 1);
  assert.equal(next.calls.footer, 2);
});
test('context snapshot refreshes after native user persistence, before the response, never on repaint', async (t) => {
  const pkg = piPackage();
  if (!pkg || pkg.version !== '1.5.1') {
    t.skip('requires installed pi 1.5.1 context estimator; no CLI/provider is launched');
    return;
  }
  const { SessionManager } = await import(pathToFileURL(path.join(pkg.root, 'dist/core/session-manager.js')));
  const { AgentSession } = await import(pathToFileURL(path.join(pkg.root, 'dist/core/agent-session.js')));
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  const native = SessionManager.inMemory(f.cwd);
  const model = { ...c.ctx.model, contextWindow: 200000 };
  const estimator = { sessionManager: native, _limitsModel: () => model };
  let entries = 0,
    branches = 0,
    estimates = 0;
  Object.assign(c.ctx.sessionManager, {
    getEntries: () => {
      entries++;
      return native.getEntries();
    },
    getBranch: () => {
      branches++;
      return native.getBranch();
    },
    getLeafId: () => native.getLeafId(),
  });
  c.ctx.getContextUsage = () => {
    estimates++;
    return AgentSession.prototype.getContextUsage.call(estimator);
  };
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  await h.emit('agent_start', c.ctx);
  await h.emit('turn_start', c.ctx, { timestamp: p.now() });
  const user = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400000) }], timestamp: p.now() };
  // Native 1.5.1 runs extension message_end handlers BEFORE appendMessage.
  await h.emit('message_end', c.ctx, { message: user });
  assert.match(h.footer(), /0\.0%\/200k/);
  native.appendMessage(user);
  assert.equal(AgentSession.prototype.getContextUsage.call(estimator).percent, 50);
  const messages = [user];
  await h.emit('context', c.ctx, { messages });
  assert.deepEqual(messages, [user], 'observing context must not alter provider input');
  assert.match(h.footer(), /50\.0%\/200k/, 'new prompt is visible before any response/turn_end');
  const captured = { entries, branches, estimates };
  for (let i = 0; i < 5; i++) h.footer();
  assert.deepEqual({ entries, branches, estimates }, captured, 'repaints never invoke the native estimator/history');
  await h.emit('session_shutdown', c.ctx);
});
test('footer-off survives same-session tree/reconnect, resetting only on new session or reload', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  await h.commands.get('hud').handler('footer off', c.ctx);
  assert.ok(h.footer().startsWith('pi-default|'));
  await h.emit('session_before_tree', c.ctx);
  await h.emit('session_tree', c.ctx);
  assert.ok(h.footer().startsWith('pi-default|'), 'same-session tree keeps footer off');
  await h.commands.get('hud').handler('reconnect', c.ctx);
  assert.ok(h.footer().startsWith('pi-default|'), 'reconnect must not remount the footer');
  await h.emit('session_before_switch', c.ctx);
  const next = context(f, h, 'session-b');
  await h.emit('session_start', next.ctx);
  assert.match(h.footer(), /Synthetic Model/, 'a new native session defaults on');
  await h.commands.get('hud').handler('footer off', next.ctx);
  await h.emit('session_shutdown', next.ctx, { reason: 'reload' });
  const reloaded = host(),
    again = context(f, reloaded, 'session-b'),
    rp = ports(f, reloaded, again);
  await load(f, reloaded, rp);
  await reloaded.emit('session_start', again.ctx, { reason: 'reload' });
  assert.match(reloaded.footer(), /Synthetic Model/, 'reload resets the session-local choice');
  await reloaded.emit('session_shutdown', again.ctx);
});
test('footer off during deferred host loading cannot reinstall it; panel and six tools stay independent', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  p.options.footerHost = async () => {
    entered();
    await gate;
    return footerHost;
  };
  await load(f, h, p);
  const startup = h.emit('session_start', c.ctx);
  await waiting;
  await h.commands.get('hud').handler('footer off', c.ctx);
  release();
  await startup;
  assert.equal(h.calls.footer, 0);
  assert.equal(p.timers.size, 1);
  assert.equal(p.counts().splits, 1);
  assert.equal(h.tools.size, 6);
  await h.tools.get('hud_read').execute('off-tools', {}, undefined, undefined, c.ctx);
  await h.emit('session_shutdown', c.ctx);
});
test('exact-root refresh expires while idle, changed text only; no discovery, launches, herdr or network in tick/render', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  summary(f, 'another-source/another-session', p.now());
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  assert.equal(h.statuses.has('hud-delegation'), false);
  summary(f, c.root, p.now());
  await h.emit('agent_end', c.ctx);
  assert.match(h.statuses.get('hud-delegation'), /2 needs you/);
  const count = h.calls.status.length;
  const cp = (await import('node:child_process')).default,
    net = (await import('node:net')).default,
    fsDefault = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const saved = [];
  for (const [obj, keys] of [
    [cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    [fsDefault, ['readdir', 'readdirSync']],
    [net, ['connect', 'createConnection']],
  ])
    for (const key of keys) {
      saved.push([obj, key, obj[key]]);
      obj[key] = () => {
        throw Error('hot_path_effect_forbidden');
      };
    }
  syncBuiltinESMExports();
  try {
    p.advance(5000);
    assert.equal(h.calls.status.length, count);
    assert.match(h.footer(), /Work:/);
    p.advance(ROLE_SUMMARY_TTL_MS);
    assert.equal(h.statuses.has('hud-delegation'), false);
    assert.match(h.footer(), /Synthetic Model/);
    assert.match(h.footer(), /other-status/);
    assert.ok(!h.footer().includes('Work:'));
  } finally {
    for (const [obj, key, value] of saved) obj[key] = value;
    syncBuiltinESMExports();
    await h.emit('session_shutdown', c.ctx);
  }
});
for (const mode of ['print', 'rpc', 'json'])
  test(`${mode}: no status, timer or panel, tools remain available`, async (t) => {
    const f = setup(t),
      h = host(),
      c = context(f, h, 'session-a', mode),
      p = ports(f, h, c);
    summary(f, c.root, p.now());
    await load(f, h, p);
    await h.emit('session_start', c.ctx);
    assert.equal(h.tools.size, 6);
    assert.equal(p.counts().splits, 0);
    assert.equal(p.timers.size, 0);
    assert.equal(h.calls.status.length, 0);
    await h.commands.get('hud').handler('on', c.ctx);
    assert.equal(p.counts().splits, 0);
    await h.emit('session_shutdown', c.ctx);
    assert.equal(h.calls.status.length, 0);
  });
for (const transition of ['session_before_switch', 'session_before_fork', 'session_before_tree'])
  test(`${transition}: fence synchronously; canceled transition remains unbound until reconnect`, async (t) => {
    const f = setup(t),
      h = host(),
      c = context(f, h),
      p = ports(f, h, c);
    await load(f, h, p);
    await h.emit('session_start', c.ctx);
    const pending = h.emit(transition, c.ctx);
    await assert.rejects(
      () => h.tools.get('hud_read').execute('old', {}, undefined, undefined, c.ctx),
      /pi_session_inactive/
    );
    await pending;
    assert.equal(p.timers.size, 0);
    await h.emit('model_select', c.ctx);
    await h.commands.get('hud').handler('on', c.ctx);
    assert.match(h.calls.notices.at(-1), /session_unbound/);
    await h.commands.get('hud').handler('reconnect', c.ctx);
    await h.tools.get('hud_read').execute('new', {}, undefined, undefined, c.ctx);
    assert.equal(p.counts().closes, 1);
    await h.emit('session_shutdown', c.ctx);
  });
test('pi on/off/toggle/status uses the caller pane without native ancestry and reopens a missing pane', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  saveJson(path.join(f.binding.hudHome, 'integration-config.json'), { panelAutoOpen: false });
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 0);
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 1);
  const run = p.calls().find((argv) => argv[1] === 'run');
  const pane = run[2];
  assert.deepEqual(p.calls()[0], ['pane', 'split', 'main', '--direction', 'right', '--no-focus', '--cwd', f.cwd]);
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
  assert.equal(h.calls.messages, 0);
  await h.emit('session_shutdown', c.ctx);
});
