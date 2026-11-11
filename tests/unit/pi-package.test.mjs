import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, replaceFixtureFile } from '../../scripts/runtime-package/test-fixture.mjs';
import { planInstall, executeInstall } from '../../scripts/runtime-package/installer.mjs';
import {
  planActivation,
  applyActivation,
  restoreActivation,
  observe,
} from '../../scripts/runtime-package/activation.mjs';
import { PI_TEMPLATES, piSettingsStep, piPreferenceStep } from '../../scripts/runtime-package/pi.mjs';
import { piPackageCommand } from '../../scripts/pi-package.mjs';
import { digest } from '../../scripts/runtime-package/safety.mjs';
import { EXTRA_FILES, REQUIRED_OUTPUTS } from '../../scripts/pack-cloud-preview.mjs';
import { REQUIRED } from '../../scripts/runtime-package/manifest.mjs';
import { createFooterHost, piPackage } from '../fakes/pi.mjs';
const root = process.env.R6A_PI_EMITTED_ROOT ?? path.resolve('dist');
const { capturePiPanel } = await import(pathToFileURL(path.join(root, 'harness/pi/package-native.js')));
const { roleSummaryPath, readRoleSummary, ROLE_SUMMARY_TTL_MS } = await import(
  pathToFileURL(path.join(root, 'roles/role-summary.js'))
);
const { renderRoleSummary } = await import(pathToFileURL(path.join(root, 'render/role-summary.js')));
const { readProcess } = await import(pathToFileURL(path.join(root, 'core/run/process.js')));
const { displayTarget, PanelStore, panelKey, saveJson } = await import(
  pathToFileURL(path.join(root, 'integrations/panel/receipt.js'))
);
const { visualWidth, truncateAnsi } = await import(pathToFileURL(path.join(root, 'render/colors.js')));
const footerHost = createFooterHost({ visibleWidth: visualWidth, truncateToWidth: truncateAnsi });
const node = fs.realpathSync(process.execPath);
function setup(t) {
  const f = fixture(t, 'pi');
  for (const name of [
    ...PI_TEMPLATES,
    'integrations/pi/package/README.md',
    'integrations/skills/hud-delegate/SKILL.md',
  ])
    replaceFixtureFile(f, name, fs.readFileSync(name));
  // Test-release adapter injects only native process/transport/clock ports into the REAL implementation.
  replaceFixtureFile(
    f,
    'dist/harness/pi/package-entry.js',
    `import { installPiPackage as real } from ${JSON.stringify(pathToFileURL(path.join(root, 'harness/pi/package-entry.js')).href)}; export function installPiPackage(pi,b,deps) { return real(pi,b,globalThis[Symbol.for('hud-a5-test-ports')] ?? deps); }`
  );
  const p = planInstall(f.bundle, f.prefix, undefined, false, true);
  executeInstall(f.bundle, f.prefix, p.planDigest, undefined, { stageOnly: true });
  const options = {
    prefix: f.prefix,
    release: p.bundleDigest,
    hudHome: path.join(f.home, 'hud'),
    shimDir: path.join(f.home, 'bin'),
    path: '/usr/bin',
    pi: { node },
  };
  const plan = planActivation(options),
    applied = applyActivation(options, plan.planId);
  const binding = JSON.parse(fs.readFileSync(path.join(plan.piPackage, 'binding.json')));
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
    const peer = path.join(plan.piPackage, 'node_modules/@earendil-works', name);
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(peer, 'index.js'), body);
  }
  return { ...f, options, plan, applied, binding, env: { ...f.env, HUD_HOME: options.hudHome } };
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
function ports(f, _h, c) {
  let time = Date.now(),
    starts = 0,
    stops = 0,
    live = false,
    executions = 0;
  const timers = new Set();
  const bridge = {
    async start() {
      starts++;
      live = true;
    },
    stop() {
      stops++;
      live = false;
      return Promise.resolve();
    },
    async execute() {
      assert.ok(live);
      executions++;
      return { content: [{ type: 'text', text: 'synthetic' }] };
    },
  };
  const stamp = { pid: 400, proc_start: '10', boot_id: 'boot', pid_domain: 'domain' };
  const origin = { pane: 'main', tab: 'tab', terminal: 'tty', workspace: 'w', process: stamp };
  const panels = new Map([['main', origin]]);
  let splits = 0,
    closes = 0;
  const main = { stamp, ppid: 300, pgid: 400, foregroundPgid: 400, tty: 10 };
  const target = displayTarget('pi', c.ctx.sessionManager.getSessionId(), c.source);
  const panelContext = {
    target,
    main: stamp,
    instance: 'instance',
    origin,
    runtime: { node, entry: path.join(f.binding.release, 'bin/hud'), digest: f.binding.digest },
  };
  const native = {
    identity: { harness: 'pi', root: { namespace: target.ref.sourceId, sessionId: target.ref.sessionId } },
    topology: 'top-level',
    ui: 'tui',
    verified: true,
  };
  const generations = [];
  const herdr = {
    instance: async () => 'instance',
    preflight: async () => 'instance',
    observe: async (p) => panels.get(p) ?? null,
    async split(r) {
      splits++;
      generations.push(r.generation);
      panels.set('display', { ...origin, pane: 'display', process: { ...stamp, pid: 500 }, atPrompt: true });
      return { pane: 'display', workspace: 'w' };
    },
    async start() {
      const store = new PanelStore(f.env),
        r = store.read(panelKey(panelContext));
      saveJson(store.registration(r.token), { generation: r.generation, panel: panels.get('display') });
    },
    async close(p) {
      assert.equal(p, 'display');
      closes++;
      panels.delete(p);
    },
  };
  const processInfo = (pid) => (pid === 400 ? main : null);
  const launch = (pid) => (pid === 400 ? { argv: ['pi'], env: {} } : null);
  const options = {
    env: f.env,
    footerHost: async () => footerHost,
    bridge: () => bridge,
    capture: async (_b, _c, _e, isCurrent) => ({ context: panelContext, native, herdr, isCurrent }),
    panelProbes: { processInfo, processLaunch: launch, registered: () => true },
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
    herdr,
    main,
    launch,
    processInfo,
    panelContext,
    native,
    timers,
    generations,
    bridge,
    advance(ms) {
      time += ms;
      const todo = [...timers];
      timers.clear();
      for (const x of todo) x.cb();
    },
    counts: () => ({ starts, stops, executions, splits, closes }),
    now: () => time,
  };
}
async function load(f, h, p) {
  const key = Symbol.for('hud-a5-test-ports');
  globalThis[key] = p?.options;
  try {
    const entry = await import(pathToFileURL(path.join(f.plan.piPackage, 'extensions/hud.mjs')));
    await entry.default(h.pi);
  } finally {
    delete globalThis[key];
  }
}
test('templates materialize one versioned package, explicit resources, immutable pin, hash-verified canonical skill, relocation with spaces', async (t) => {
  const f = setup(t),
    pkg = f.plan.piPackage;
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')));
  assert.equal(manifest.name, 'hud');
  assert.equal(manifest.version, f.plan.releaseVersion);
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*', typebox: '*' });
  assert.deepEqual(manifest.pi, { extensions: ['./extensions/hud.mjs'], skills: ['./skills/hud-delegate/SKILL.md'] });
  assert.equal(f.binding.release, path.join(f.prefix, 'releases', f.plan.runtimeDigest));
  assert.equal(f.binding.digest, f.plan.runtimeDigest);
  assert.equal(digest(fs.readFileSync(path.join(pkg, 'skills/hud-delegate/SKILL.md'))), f.plan.skillHash);
  assert.ok(f.manifest.entries.every((e) => e.path.split('/').every((p) => !p.startsWith('.'))));
  const relocated = path.join(f.home, 'relocated package with spaces');
  fs.cpSync(pkg, relocated, { recursive: true });
  const h = host();
  const entry = await import(pathToFileURL(path.join(relocated, 'extensions/hud.mjs')));
  await entry.default(h.pi);
  assert.equal(h.calls.command, 1);
  assert.equal(h.tools.size, 6);
  assert.equal(h.calls.footer, 0);
});
test('inventory is complete and no generated skill or host SDK is bundled as a pi template', () => {
  for (const p of PI_TEMPLATES) {
    assert.ok(EXTRA_FILES.includes(p));
    assert.ok(REQUIRED.includes(p));
  }
  for (const n of ['segment', 'package-entry', 'package-native'])
    assert.ok(Object.values(REQUIRED_OUTPUTS).includes(`dist/harness/pi/${n}.js`));
  assert.ok(!PI_TEMPLATES.some((p) => p.includes('node_modules') || p.includes('/skills/')));
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
  assert.equal(p.counts().starts, 1);
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
  test(`${mode}: no status, timer or panel, bridge still starts`, async (t) => {
    const f = setup(t),
      h = host(),
      c = context(f, h, 'session-a', mode),
      p = ports(f, h, c);
    summary(f, c.root, p.now());
    await load(f, h, p);
    await h.emit('session_start', c.ctx);
    assert.equal(p.counts().starts, 1);
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
    assert.equal(p.counts().starts, 2);
    assert.equal(p.counts().closes, 1);
    await h.emit('session_shutdown', c.ctx);
  });
test('auto-open false is honored; explicit on opens; failed local operations stay finite and never send a model message', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  saveJson(path.join(f.options.hudHome, 'integration-config.json'), { panelAutoOpen: false });
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 0);
  await h.commands.get('hud').handler('on', c.ctx);
  assert.equal(p.counts().splits, 1);
  p.options.capture = async () => {
    throw Error('sensitive /path\nnot reflected');
  };
  await h.commands.get('hud').handler('status', c.ctx);
  assert.equal(h.calls.notices.at(-1), 'HUD: local_operation_failed');
  assert.equal(h.calls.messages, 0);
  await h.emit('session_shutdown', c.ctx);
});
test('shutdown closes its retained generation even when an open is racing; it cannot close replacement panel', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  let release;
  const waiting = new Promise((r) => (release = r));
  const realStart = p.herdr.start;
  p.herdr.start = async (...args) => {
    await waiting;
    return realStart(...args);
  };
  await load(f, h, p);
  const started = h.emit('session_start', c.ctx);
  for (let i = 0; i < 100 && !p.counts().splits; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(p.counts().splits, 1);
  const stopped = h.emit('session_shutdown', c.ctx);
  release();
  await Promise.all([started, stopped]);
  assert.equal(p.counts().closes, 1);
  const h2 = host(),
    c2 = context(f, h2, 'session-b'),
    p2 = ports(f, h2, c2);
  await load(f, h2, p2);
  await h2.emit('session_start', c2.ctx);
  const newGeneration = p2.generations.at(-1);
  assert.notEqual(newGeneration, p.generations[0]);
  await h.emit('session_shutdown', c.ctx);
  assert.equal(p2.counts().closes, 0);
  const store = new PanelStore(f.env);
  assert.equal(store.read(panelKey(p2.panelContext)).generation, newGeneration);
  await h2.emit('session_shutdown', c2.ctx);
});
test('reload leaves panel closed until explicit on opens exactly one replacement, without inherited continuity', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 1);
  await h.emit('session_shutdown', c.ctx, { reason: 'reload' });
  assert.equal(p.counts().closes, 1);
  const next = host(),
    ctx = context(f, next),
    p2 = ports(f, next, ctx);
  await load(f, next, p2);
  await next.emit('session_start', ctx.ctx, { reason: 'reload' });
  assert.equal(p2.counts().splits, 0);
  await next.commands.get('hud').handler('on', ctx.ctx);
  assert.equal(p2.counts().splits, 1);
  await next.commands.get('hud').handler('on', ctx.ctx);
  assert.equal(p2.counts().splits, 1);
  await next.emit('session_shutdown', ctx.ctx);
  assert.equal(p2.counts().closes, 1);
});
test('queued old closes cannot adopt a legitimately replaced generation from a stale A3 result', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  const { controlPanel } = await import(pathToFileURL(path.join(root, 'integrations/panel/control.js')));
  let blocked = false,
    release,
    entered;
  const gate = new Promise((r) => (release = r)),
    waiting = new Promise((r) => (entered = r));
  p.options.panel = async (operation, context, options) => {
    if (operation === 'close' && blocked) {
      blocked = false;
      entered();
      await gate;
    }
    return controlPanel(operation, context, options);
  };
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  const store = new PanelStore(f.env),
    key = panelKey(p.panelContext),
    g1 = store.read(key).generation;
  blocked = true;
  const off = h.commands.get('hud').handler('off', c.ctx);
  await waiting;
  const replacementOptions = {
    ...p.options.panelProbes,
    env: f.env,
    herdr: p.herdr,
    native: p.native,
    isCurrent: () => true,
  };
  const closed = await controlPanel('close', p.panelContext, { ...replacementOptions, generation: g1 });
  assert.equal(closed.receipt.phase, 'closed');
  const replacement = await controlPanel('open', p.panelContext, replacementOptions);
  assert.equal(replacement.receipt.phase, 'open');
  assert.notEqual(replacement.receipt.generation, g1);
  const closes = p.counts().closes;
  const shutdown = h.emit('session_shutdown', c.ctx);
  release();
  await Promise.all([off, shutdown]);
  assert.equal(p.counts().closes, closes, 'stale off result cannot transfer G2 to queued shutdown');
  assert.equal(store.read(key).generation, replacement.receipt.generation);
  assert.equal(store.read(key).phase, 'open');
  await controlPanel('close', p.panelContext, { ...replacementOptions, generation: replacement.receipt.generation });
  assert.equal(p.counts().closes, closes + 1);
});
test('old-generation shutdown refuses a newer panel generation even for the same display root', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  await load(f, h, p);
  await h.emit('session_start', c.ctx);
  const store = new PanelStore(f.env),
    key = panelKey(p.panelContext),
    receipt = store.read(key);
  const { randomUUID } = await import('node:crypto');
  const oldGeneration = receipt.generation;
  receipt.generation = randomUUID();
  store.write(receipt);
  saveJson(store.registration(receipt.token), { generation: receipt.generation, panel: receipt.panel });
  await h.emit('session_shutdown', c.ctx);
  assert.notEqual(receipt.generation, oldGeneration);
  assert.equal(p.counts().closes, 0, 'an old shutdown must never select the current receipt generation');
  assert.equal(store.read(key).phase, 'open');
  assert.equal(store.read(key).generation, receipt.generation);
  const { controlPanel } = await import(pathToFileURL(path.join(root, 'integrations/panel/control.js')));
  await controlPanel('close', p.panelContext, {
    ...p.options.panelProbes,
    env: f.env,
    herdr: p.herdr,
    native: p.native,
    generation: receipt.generation,
  });
  assert.equal(p.counts().closes, 1);
});
for (const variant of [
  'open',
  'pane-closed',
  'off',
  'auto-off',
  'uncertain',
  'different-generation',
  'instance-change',
  'occupant-change',
  'deadline',
  'epoch-change',
  'canceled',
  'double',
  'parent-session',
]) {
  test(`tree continuity ${variant}: live exact-generation proof, preference and one-use fencing`, async (t) => {
    const f = setup(t),
      h = host(),
      c = context(f, h),
      p = ports(f, h, c);
    const { controlPanel } = await import(pathToFileURL(path.join(root, 'integrations/panel/control.js')));
    let observing = false,
      epochChange;
    const reads = [];
    const instance = p.herdr.instance,
      observe = p.herdr.observe;
    p.herdr.instance = async (...args) => {
      if (observing) {
        reads.push('instance');
        if (variant === 'deadline') return new Promise(() => {});
        if (variant === 'instance-change') return 'changed-instance';
        if (variant === 'epoch-change') epochChange = h.emit('session_before_switch', c.ctx);
      }
      return instance(...args);
    };
    p.herdr.observe = async (...args) => {
      const live = await observe(...args);
      if (observing) {
        reads.push('observe');
        if (variant === 'occupant-change' && live) return { ...live, process: { ...live.process, pid: 999 } };
      }
      return live;
    };
    p.options.panel = async (operation, context, options) => {
      observing = operation === 'status';
      const result = await controlPanel(operation, context, options);
      if (operation === 'status' && result.receipt) {
        if (variant === 'uncertain') return { ...result, receipt: { ...result.receipt, phase: 'uncertain' } };
        if (variant === 'different-generation')
          return { ...result, receipt: { ...result.receipt, generation: 'different' } };
      }
      return result;
    };
    await load(f, h, p);
    await h.emit('session_start', c.ctx);
    assert.equal(p.counts().splits, 1);
    if (variant === 'pane-closed') await p.herdr.close('display');
    if (variant === 'off') await h.commands.get('hud').handler('off', c.ctx);
    if (variant === 'auto-off')
      saveJson(path.join(f.options.hudHome, 'integration-config.json'), { panelAutoOpen: false });
    const before = h.emit('session_before_tree', c.ctx);
    await assert.rejects(
      h.tools.get('hud_read').execute('during-tree', {}, undefined, undefined, c.ctx),
      /pi_session_inactive/
    );
    await before;
    await epochChange;
    assert.ok(reads.every((call) => ['instance', 'observe'].includes(call)));
    if (variant === 'open') assert.deepEqual(reads, ['instance', 'observe']);
    if (variant === 'pane-closed' || variant === 'occupant-change') assert.deepEqual(reads, ['instance', 'observe']);
    if (variant === 'instance-change' || variant === 'epoch-change' || variant === 'deadline')
      assert.deepEqual(reads, ['instance']);
    if (variant === 'off' || variant === 'uncertain' || variant === 'different-generation') assert.deepEqual(reads, []);
    if (variant === 'deadline') assert.equal(h.calls.notices.at(-1), 'HUD: panel_tree_continuity_unverified');
    if (variant === 'parent-session')
      c.ctx.sessionManager.getHeader = () => ({
        type: 'session',
        id: 'session-a',
        parentSession: '/synthetic/parent.jsonl',
      });
    if (variant === 'double') await Promise.all([h.emit('session_tree', c.ctx), h.emit('session_tree', c.ctx)]);
    else if (variant !== 'canceled') await h.emit('session_tree', c.ctx);
    assert.equal(p.counts().splits, variant === 'open' ? 2 : 1);
    if (variant === 'canceled') {
      assert.equal(h.statuses.has('hud-delegation'), false);
      await assert.rejects(
        h.tools.get('hud_read').execute('canceled', {}, undefined, undefined, c.ctx),
        /pi_session_inactive/
      );
    }
    await h.emit('session_shutdown', c.ctx);
    assert.equal(await p.herdr.observe('display'), null);
  });
}
test('native capture requires real header, complete foreground ancestry and matching origin; nested, workers and inherited pane alone refuse', async (t) => {
  const f = setup(t),
    h = host(),
    c = context(f, h),
    p = ports(f, h, c);
  const stamp = (pid) => ({ ...p.main.stamp, pid });
  const processInfo = (pid) =>
    pid === 400
      ? p.main
      : pid === 300
        ? { ...p.main, stamp: stamp(300), ppid: 200 }
        : pid === 200
          ? { ...p.main, stamp: stamp(200), ppid: 1 }
          : null;
  let worker = false,
    nested = false,
    server = true;
  const launch = (pid) => ({
    argv:
      pid === 400
        ? ['pi', ...(worker ? ['--hud-role-contract', '/synthetic'] : [])]
        : pid === 200
          ? [server ? 'herdr' : 'shell']
          : ['bash'],
    env: {},
  });
  c.ctx.sessionManager.getHeader = () => ({
    type: 'session',
    id: 'session-a',
    cwd: f.cwd,
    ...(nested ? { parentSession: '/synthetic/parent' } : {}),
  });
  const env = { ...f.env, HERDR_PANE_ID: 'main', HERDR_SOCKET_PATH: '/synthetic/socket' };
  const deps = { pid: 400, processInfo, launch, herdr: p.herdr };
  const captured = await capturePiPanel(f.binding, c.ctx, env, () => true, deps);
  assert.equal(captured.native.topology, 'top-level');
  assert.equal(captured.context.target.root, c.root);
  worker = true;
  await assert.rejects(() => capturePiPanel(f.binding, c.ctx, env, () => true, deps), /panel_worker_session/);
  worker = false;
  nested = true;
  await assert.rejects(() => capturePiPanel(f.binding, c.ctx, env, () => true, deps), /panel_nested_session/);
  nested = false;
  server = false;
  await assert.rejects(() => capturePiPanel(f.binding, c.ctx, env, () => true, deps), /panel_origin_unverified/);
  server = true;
  await assert.rejects(() => capturePiPanel(f.binding, c.ctx, env, () => false, deps), /panel_origin_unverified/);
  assert.equal(p.counts().splits, 0);
});
test('row 7 and row 10 use A1 exact restore, preserve unrelated settings, refuse stale bytes and symlinks; write-set hashes are explicit', (t) => {
  const f = setup(t),
    file = path.join(f.home, 'pi-agent/settings.json');
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  const before = Buffer.from('{"theme":"synthetic", "packages":["/synthetic/other"]}\n');
  fs.writeFileSync(file, before, { mode: 0o640 });
  const base = { ...f.options };
  delete base.pi;
  const opts = { ...base, steps: [piSettingsStep(file, f.plan.piPackage, observe)] };
  const plan = planActivation(opts);
  assert.equal(plan.actions.find((s) => s.path === file).original.sha256, digest(before));
  const applied = applyActivation(opts, plan.planId);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    theme: 'synthetic',
    packages: ['/synthetic/other', f.plan.piPackage],
  });
  const after = digest(fs.readFileSync(file));
  assert.notEqual(after, digest(before));
  console.log(
    'ROW7_WRITE_SET ' +
      JSON.stringify({
        paths: plan.actions.map((s) => ({
          path: s.path,
          kind: s.kind,
          before: s.original.sha256 ?? null,
          after: fs.statSync(s.path).isFile() ? digest(fs.readFileSync(s.path)) : null,
          mode: fs.statSync(s.path).mode & 0o777,
        })),
        journal: { path: applied.receipt, before: null, after: digest(fs.readFileSync(applied.receipt)) },
        noMcpConfig: true,
      })
  );
  fs.appendFileSync(file, ' ');
  assert.equal(restoreActivation(applied.receipt).status, 'CONFLICT');
  fs.writeFileSync(file, plan.actions.find((s) => s.path === file).content, { mode: 0o640 });
  // Atomic same-inode write preserves recorded identity; matching bytes restores exactly.
  const restored = restoreActivation(applied.receipt);
  assert.equal(restored.status, 'deactivated; release retained');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  console.log(
    'ROW7_RESTORE_SET ' +
      JSON.stringify({
        settings: { path: file, after: digest(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 },
        journal: { path: applied.receipt, after: digest(fs.readFileSync(applied.receipt)) },
        transientLocks: [
          path.join(f.prefix, 'install-lock'),
          path.join(f.options.hudHome, 'installation/activation-lock'),
        ].map((path) => ({ path, before: null, after: observe(path).kind })),
        noMcpConfig: true,
      })
  );
  const staleOpts = { ...base, steps: [piSettingsStep(file, f.plan.piPackage, observe)] },
    stale = planActivation(staleOpts);
  fs.appendFileSync(file, ' ');
  assert.throws(
    () => applyActivation(staleOpts, stale.planId),
    /target_changed_during_preview|stale_plan|foreign_owned_file/
  );
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.home, 'foreign'), file);
  assert.throws(() => piSettingsStep(file, f.plan.piPackage, observe), /symlink/);
  const prefOpts = { ...base, steps: [piPreferenceStep(f.options.hudHome, false, observe)] },
    pref = planActivation(prefOpts),
    r = applyActivation(prefOpts, pref.planId);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.options.hudHome, 'integration-config.json'))).panelAutoOpen,
    false
  );
  assert.equal(restoreActivation(r.receipt).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(path.join(f.options.hudHome, 'integration-config.json')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'mcp.json')), false);
  assert.ok(plan.actions.every((s) => !s.path.endsWith('mcp.json')));
});
test('fork replacement closes prior panel; forked and nested sessions keep tools/segment but refuse panel with finite reason', async (t) => {
  const f = setup(t),
    old = host(),
    c = context(f, old),
    p = ports(f, old, c);
  await load(f, old, p);
  await old.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 1);
  await old.emit('session_before_fork', c.ctx);
  assert.equal(p.counts().closes, 1);
  // pi 1.5.1 replaces the extension runtime on fork: shutdown, reload, start(reason=fork).
  await old.emit('session_shutdown', c.ctx, { reason: 'fork' });
  for (const id of ['forked', 'nested']) {
    const h = host(),
      next = context(f, h, id),
      portsNext = ports(f, h, next);
    next.ctx.sessionManager.getHeader = () => ({
      type: 'session',
      id,
      cwd: f.cwd,
      parentSession: '/synthetic/parent.jsonl',
    });
    portsNext.options.capture = (b, ctx, env, current) => capturePiPanel(b, ctx, env, current);
    summary(f, next.root, portsNext.now());
    await load(f, h, portsNext);
    await h.emit('session_start', next.ctx, { reason: id === 'forked' ? 'fork' : 'startup' });
    assert.equal(portsNext.counts().splits, 0);
    assert.match(h.statuses.get('hud-delegation'), /2 needs you/);
    await h.tools.get('hud_read').execute(id, {}, undefined, undefined, next.ctx);
    await h.commands.get('hud').handler('on', next.ctx);
    assert.equal(h.calls.notices.at(-1), 'HUD: panel_nested_session');
    await h.emit('session_shutdown', next.ctx);
  }
});
test('pi CLI preview refuses ambiguous row combination and apply without exact plan', (t) => {
  const f = setup(t),
    args = [
      '--prefix',
      f.prefix,
      '--release',
      f.options.release,
      '--node',
      node,
      '--hud-home',
      f.options.hudHome,
      '--shim-dir',
      f.options.shimDir,
    ];
  assert.throws(() => piPackageCommand(['apply', ...args], f.env), /explicit_plan_required/);
  assert.throws(
    () => piPackageCommand(['preview', ...args, '--settings', '/synthetic/settings.json'], f.env),
    /explicit_node_required/
  );
  const settings = path.join(f.home, 'selected-agent/settings.json');
  const row = [...args, '--settings', settings, '--package', f.plan.piPackage];
  const preview = piPackageCommand(['row-7-preview', ...row], f.env);
  assert.ok(preview.actions.some((s) => s.path === settings));
  assert.equal(fs.existsSync(settings), false);
  const foreign = path.join(f.home, 'foreign-package');
  fs.mkdirSync(foreign, { mode: 0o700 });
  fs.copyFileSync(path.join(f.plan.piPackage, 'binding.json'), path.join(foreign, 'binding.json'));
  assert.throws(
    () => piPackageCommand(['row-7-preview', ...args, '--settings', settings, '--package', foreign], f.env),
    /materialize_matching_pi_package_first/
  );
  const existing = path.join(f.home, 'existing-settings.json');
  fs.writeFileSync(
    existing,
    JSON.stringify({ packages: ['/synthetic/hud/installation/integrations/' + 'b'.repeat(64) + '/pi'] }),
    { mode: 0o600 }
  );
  assert.throws(
    () => piSettingsStep(existing, f.plan.piPackage, observe),
    /existing_hud_package_requires_owner_resource_preview/
  );
});
