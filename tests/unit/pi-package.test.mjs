import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createFooterHost } from '../fakes/pi.mjs';
const root = process.env.R6A_PI_EMITTED_ROOT ?? path.resolve('dist');
const { displayTarget } = await import(pathToFileURL(path.join(root, 'integrations/panel/receipt.js')));
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
  assert.equal(
    p.calls()[0].join('|'),
    `pane|split|main|--direction|right|--ratio|0.7|--no-focus|--cwd|${f.cwd}|--env|HUD_PANEL_CALLER_PANE=main`
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
  assert.equal(h.tools.size, 6);
  assert.equal(h.commands.size, 1);
  assert.equal(p.counts().splits, 0);
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
    'hud_read',
    'hud_respond',
    'hud_roster',
    'hud_send',
  ]);
  assert.equal(h.commands.size, 0, 'no /hud command');
  await h.emit('session_start', c.ctx);
  assert.equal(p.counts().splits, 0, 'the settings-registered package a worker could load opens no panel');
  assert.equal(h.calls.footer, 0, 'no footer');
  assert.equal(h.calls.status.length, 0, 'no Work segment');
  await h.emit('session_shutdown', c.ctx);
});
