/**
 * Tests for herdr-fork/13: codexH bar on the herdr pane strip (no tmux).
 * Uses a fake herdr fork socket, temporary homes and synthetic data only.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PaneStripClient, BAR_RELOAD_EXIT_CODE } from '../../dist/strip-bar.js';
import { renderSingleLine, renderStatusBarLine } from '../../dist/render/index.js';
import { fitStatusBar } from '../../dist/render/header.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, truncateAnsi, visualLength } from '../../dist/render/colors.js';
import { runCodexLaunch } from '../../dist/cli/codex-launch.js';
import { makeHudData } from '../../dist-test/fixtures/hud-data.js';

const REPO_ROOT = resolve('.');
const FIXED_NOW = Date.parse('2026-03-01T12:00:00.000Z');

async function startFakeForkSocket(t, opts = {}) {
  const {
    version = '0.9.5-hud.7cecc34e',
    paneStrip = true,
    initialWidth = 80,
    initialHeight = 30,
  } = opts;
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-strip-sock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, 'herdr.sock');

  const requests = [];
  const sets = [];
  const clears = [];
  const subscribers = new Set();
  let width = initialWidth;
  let height = initialHeight;

  const server = createServer((conn) => {
    const client = { conn, types: new Set() };
    const rl = createInterface({ input: conn });
    rl.on('line', (raw) => {
      const req = JSON.parse(raw);
      requests.push(req);
      const reply = (result) => conn.write(JSON.stringify({ id: req.id, result }) + '\n');
      const err = (code, message = code) => conn.write(JSON.stringify({ id: req.id, error: { code, message } }) + '\n');

      if (req.method === 'ping') {
        reply({
          type: 'pong',
          version,
          protocol: 22,
          capabilities: { hidden_tabs: true, pane_strip: paneStrip },
        });
        return;
      }
      if (req.method === 'events.subscribe') {
        for (const sub of req.params?.subscriptions ?? []) {
          client.types.add(sub.type);
        }
        subscribers.add(client);
        reply({ type: 'subscription_started' });
        return;
      }
      if (req.method === 'pane.strip.set') {
        if (!paneStrip) {
          err('unknown_method', 'pane.strip.set unsupported');
          return;
        }
        sets.push({ ...req.params, at: Date.now() });
        reply({
          type: 'pane_strip',
          strip: {
            pane_id: req.params.pane_id,
            workspace_id: 'w4E',
            tab_id: 'w4E:t1',
            width,
            height,
            cols: Math.max(1, width - 1),
            rows: Math.max(1, height - 1),
            top: req.params.position === 'top',
            bottom: req.params.position === 'bottom',
            bottom_lease_remaining_ms: req.params.lease_ms ?? 15000,
          },
        });
        return;
      }
      if (req.method === 'pane.strip.clear') {
        clears.push({ ...req.params, at: Date.now() });
        reply({
          type: 'pane_strip',
          strip: {
            pane_id: req.params.pane_id,
            workspace_id: 'w4E',
            tab_id: 'w4E:t1',
            width,
            height,
            cols: Math.max(1, width - 1),
            rows: height,
            top: false,
            bottom: false,
          },
        });
        return;
      }
      reply({});
    });
    conn.on('error', () => {});
    rl.on('error', () => {});
    conn.on('close', () => {
      subscribers.delete(client);
      rl.close();
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const c of subscribers) c.conn.destroy();
    await new Promise((done) => server.close(done));
  });

  return {
    socketPath,
    requests,
    sets,
    clears,
    subscribers,
    emitResize(paneId, nextWidth, nextHeight = height) {
      if (paneId === 'w4E:p1') {
        width = nextWidth;
        height = nextHeight;
      }
      const payload =
        JSON.stringify({
          event: 'pane.resized',
          data: {
            type: 'pane_resized',
            pane_id: paneId,
            workspace_id: 'w4E',
            tab_id: 'w4E:t1',
            width: nextWidth,
            height: nextHeight,
            cols: Math.max(1, nextWidth - 1),
            rows: Math.max(1, nextHeight - 1),
          },
        }) + '\n';
      for (const c of subscribers) {
        if (c.types.has('pane.resized') || c.types.size === 0) {
          try {
            c.conn.write(payload);
          } catch {}
        }
      }
    },
  };
}

async function until(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('bar line pushed to pane strip equals today’s codexH bar at 40, 80 and 120 columns across resizes', async (t) => {
  const fork = await startFakeForkSocket(t, { initialWidth: 80 });
  const data = makeHudData({
    work: { running: 2, queued: 1, roles: { imp: { running: 2, asking: 0 } } },
    localLoad: { cpu: 18, ram: { usedKiB: 6, totalKiB: 8 } },
    outputRate: { tokensPerSecond: 42, sampleMs: 2000, sampledAt: new Date(FIXED_NOW) },
  });

  const previous = setDisplayConfig({ theme: 'terminal', barStyle: 'line', icons: 'unicode' });
  t.after(() => setDisplayConfig(previous));

  const todayBar = (width) => {
    const fitted = fitStatusBar(
      data,
      {
        mode: 'compact',
        showSeparators: true,
        showDuration: true,
        showContextBar: true,
        showContextBreakdown: false,
        barWidth: Math.min(10, Math.max(6, Math.floor(width / 12))),
      },
      width,
      FIXED_NOW
    );
    return truncateAnsi(fitted.line, width);
  };

  for (const style of ['line', 'p10k']) {
    setDisplayConfig({ theme: 'terminal', barStyle: style, icons: 'unicode' });
    fork.emitResize('w4E:p1', 80);
    fork.sets.length = 0;
    fork.clears.length = 0;

    const pushed = [];
    const client = new PaneStripClient({
      paneId: 'w4E:p1',
      position: 'bottom',
      initialWidth: 80,
      leaseMs: 15000,
      renewMs: 5000,
      env: { HERDR_SOCKET_PATH: fork.socketPath },
      onWidthChange: (w) => {
        const line = renderStatusBarLine(data, w, FIXED_NOW);
        pushed.push({ width: w, line });
        void client.push(line, { force: true, nowMs: FIXED_NOW });
      },
    });
    t.after(() => client.stop({ clear: false }));
    client.start();
    await until(() => fork.subscribers.size === 1, 'strip subscriber did not connect');

    // Initial push at 80 columns
    await client.push(renderStatusBarLine(data, client.width, FIXED_NOW), { force: true, nowMs: FIXED_NOW });
    assert.equal(fork.sets.length, 1);
    assert.equal(fork.sets[0].pane_id, 'w4E:p1');
    assert.equal(fork.sets[0].position, 'bottom');
    assert.equal(fork.sets[0].lease_ms, 15000);
    assert.equal(fork.sets[0].line, todayBar(80), `${style} 80 cols must equal today's codexH bar`);
    assert.equal(fork.sets[0].line, renderSingleLine(data, 80, FIXED_NOW));
    assert.ok(visualLength(fork.sets[0].line) <= 80);
    assert.doesNotMatch(fork.sets[0].line, /[\r\n]/);

    // Unrelated pane resize must be ignored
    fork.emitResize('w4E:p99', 40);
    await delay(60);
    assert.equal(fork.sets.length, 1, 'resize for another pane must not trigger push');

    // Resize to 40 columns
    fork.emitResize('w4E:p1', 40);
    await until(() => fork.sets.length >= 2, 'did not push after 40-col resize');
    assert.equal(fork.sets[1].line, todayBar(40), `${style} 40 cols must equal today's codexH bar`);
    assert.ok(visualLength(fork.sets[1].line) <= 40);

    // Resize to 120 columns
    fork.emitResize('w4E:p1', 120);
    await until(() => fork.sets.length >= 3, 'did not push after 120-col resize');
    assert.equal(fork.sets[2].line, todayBar(120), `${style} 120 cols must equal today's codexH bar`);
    assert.ok(visualLength(fork.sets[2].line) <= 120);

    // Distinct widths actually adapt layout
    assert.notEqual(stripAnsi(fork.sets[1].line), stripAnsi(fork.sets[2].line));

    await client.stop({ clear: true });
    assert.equal(fork.clears.length, 1);
    assert.deepEqual(
      { pane_id: fork.clears[0].pane_id, position: fork.clears[0].position },
      { pane_id: 'w4E:p1', position: 'bottom' }
    );
  }
});

test('PaneStripClient renews lease before expiry without spamming unchanged lines and respects clear:false', async (t) => {
  const fork = await startFakeForkSocket(t, { initialWidth: 80 });
  let clock = 1_000_000;
  const client = new PaneStripClient({
    paneId: 'w4E:p1',
    position: 'bottom',
    initialWidth: 80,
    leaseMs: 15000,
    renewMs: 5000,
    env: { HERDR_SOCKET_PATH: fork.socketPath },
    now: () => clock,
  });

  await client.push('synthetic-bar-line', { nowMs: clock });
  assert.equal(fork.sets.length, 1);

  // Within renew window with identical line -> skipped
  clock += 2000;
  await client.push('synthetic-bar-line', { nowMs: clock });
  assert.equal(fork.sets.length, 1);

  // At renew window -> renews lease
  clock += 3000;
  await client.push('synthetic-bar-line', { nowMs: clock });
  assert.equal(fork.sets.length, 2);
  assert.equal(fork.sets[1].lease_ms, 15000);

  // Reload stop keeps strip alive (no clear)
  await client.stop({ clear: false });
  assert.equal(fork.clears.length, 0);
});

test('bin/codex-hud launches Codex directly with bottom strip, pushes resized bar, serves --json, and clears on exit (no tmux)', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-codex-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fork = await startFakeForkSocket(t, { initialWidth: 80 });

  const home = join(root, 'home');
  const hudHome = join(root, 'hud');
  const codexHome = join(root, 'codex');
  const project = join(root, 'project');
  const fakeBin = join(root, 'bin');
  const codexLog = join(root, 'codex-launch.json');
  const releaseFile = join(root, 'release-codex');
  for (const dir of [home, hudHome, codexHome, project, fakeBin]) fs.mkdirSync(dir, { recursive: true });

  // Put a failing tmux trap on PATH to prove codexH NEVER invokes tmux.
  const tmuxTrapLog = join(root, 'tmux-called.log');
  fs.writeFileSync(
    join(fakeBin, 'tmux'),
    `#!/bin/sh\necho "tmux called: $*" >> "${tmuxTrapLog}"\nexit 99\n`,
    { mode: 0o755 }
  );

  // Synthetic Codex CLI: writes a synthetic rollout for this project and waits for releaseFile.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const sessionDir = join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  );
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const rolloutFile = join(sessionDir, `rollout-${stamp}-019bc10d-1111-7000-8000-000000000001.jsonl`);

  fs.writeFileSync(
    join(fakeBin, 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(${JSON.stringify(codexLog)}, JSON.stringify({
  startedAt: Date.now(),
  pid: process.pid,
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  herdrPane: process.env.HERDR_PANE_ID,
}));
fs.mkdirSync(${JSON.stringify(sessionDir)}, { recursive: true });
const cwd = fs.realpathSync(process.cwd());
fs.writeFileSync(${JSON.stringify(rolloutFile)}, [
  JSON.stringify({ type: 'session_meta', payload: { id: '019bc10d-1111-7000-8000-000000000001', cwd, model: 'gpt-5.6-astra' } }),
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-astra', effort: 'high' } }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 40000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 42000 },
        last_token_usage: { input_tokens: 40000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 42000 },
        model_context_window: 200000,
      },
    },
  }),
].join('\\n') + '\\n');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releaseFile)})) {
    clearInterval(timer);
    process.exit(42);
  }
}, 25);
`,
    { mode: 0o755 }
  );

  // Minimal PATH containing fakeBin, node dir, and standard system tools (no tmux except trap).
  // Forward TZ when set (e.g. TZ=UTC in tests) so the launcher and bar search the same day directory as sessionDir.
  const env = {
    HOME: home,
    HUD_HOME: hudHome,
    CODEX_HOME: codexHome,
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: fork.socketPath,
    HERDR_PANE_ID: 'w4E:p1',
    HERDR_TAB_ID: 'w4E:t1',
    HERDR_WORKSPACE_ID: 'w4E',
    CODEX_HUD_SKIP_BUILD: '1',
  };

  // Self-check succeeds with pane_strip capability and without tmux (async spawn so the in-process fake socket stays responsive).
  const selfCheck = await new Promise((resolveDone) => {
    const child = spawn(join(REPO_ROOT, 'bin/codex-hud'), ['--self-check'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.once('exit', (status) => resolveDone({ status, stdout: out, stderr: err }));
  });
  assert.equal(selfCheck.status, 0, selfCheck.stdout + selfCheck.stderr);
  assert.match(selfCheck.stdout, /pane_strip supported/);

  // Launch bin/codex-hud with forwarded Codex args.
  const launcher = spawn(join(REPO_ROOT, 'bin/codex-hud'), ['--model', 'gpt-5.6-astra'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  launcher.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  t.after(async () => {
    // Let the launcher forward the signal to fake Codex and shut down the bar.
    if (launcher.kill('SIGTERM')) await once(launcher, 'exit');
  });

  // Wait for fake codex to start and bar sidecar to push the rendered session bar at 80 cols.
  await until(
    () =>
      fs.existsSync(codexLog) &&
      fork.sets.some((s) => stripAnsi(s.line).includes('5.6-astra') && stripAnsi(s.line).includes('project')),
    () => `bar never pushed rendered line; sets=${JSON.stringify(fork.sets)}; stderr=${stderr}`
  );

  const launchInfo = JSON.parse(fs.readFileSync(codexLog, 'utf8'));
  assert.ok(fork.sets[0].at <= launchInfo.startedAt + 50, 'strip reservation must precede codex spawn');
  assert.equal(launchInfo.codexHome, codexHome);
  assert.equal(launchInfo.herdrPane, 'w4E:p1');
  assert.ok(launchInfo.argv.includes('--model') && launchInfo.argv.includes('gpt-5.6-astra'));
  assert.ok(
    launchInfo.argv.some((a) => a === 'shell_environment_policy.set.HERDR_PANE_ID="w4E:p1"'),
    `expected herdr context override in ${JSON.stringify(launchInfo.argv)}`
  );

  const firstBar = fork.sets.find((s) => stripAnsi(s.line).includes('5.6-astra'));
  assert.ok(visualLength(firstBar.line) <= 80);

  // Wait for bar subscription socket, then emit 40-col and 120-col resizes.
  await until(() => fork.subscribers.size >= 1, 'bar sidecar did not subscribe to pane.resized');
  const before40 = fork.sets.length;
  fork.emitResize('w4E:p1', 40);
  await until(() => fork.sets.length > before40, 'no strip push after 40-col resize');
  const line40 = fork.sets.at(-1).line;
  assert.ok(visualLength(line40) <= 40, `expected <=40 cols, got ${visualLength(line40)}: ${stripAnsi(line40)}`);

  const before120 = fork.sets.length;
  fork.emitResize('w4E:p1', 120);
  await until(() => fork.sets.length > before120, 'no strip push after 120-col resize');
  const line120 = fork.sets.at(-1).line;
  assert.ok(visualLength(line120) <= 120);
  assert.notEqual(stripAnsi(line40), stripAnsi(line120));

  // --json reads the pane snapshot without tmux and carries no bridgeHealth.
  const snapRes = spawnSync(join(REPO_ROOT, 'bin/codex-hud'), ['--json'], {
    cwd: project,
    env,
    encoding: 'utf8',
  });
  assert.equal(snapRes.status, 0, snapRes.stderr);
  const snapshot = JSON.parse(snapRes.stdout);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.project.name, 'project');
  assert.equal(Object.hasOwn(snapshot, 'bridgeHealth'), false);

  // Release fake codex -> exits with 42, clears bottom strip, never invokes tmux.
  fs.writeFileSync(releaseFile, 'exit\n');
  const [exitCode] = await once(launcher, 'exit');
  assert.equal(exitCode, 42, `expected codex exit code 42; stderr=${stderr}`);
  assert.ok(
    fork.clears.some((c) => c.pane_id === 'w4E:p1' && c.position === 'bottom'),
    `expected bottom strip clear on exit, got ${JSON.stringify(fork.clears)}`
  );
  assert.equal(fs.existsSync(tmuxTrapLog), false, 'tmux must never be invoked in codexH path');
});

test('codex-launch respawns bar sidecar seamlessly on reload exit 75 without restarting Codex or clearing strip', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-codex-reload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fork = await startFakeForkSocket(t, { initialWidth: 100 });

  // Synthetic hudDir with a fake bin/hud-dist.mjs whose bar reloads once (exit 75) and then pushes v2.
  const hudDir = join(root, 'hud-checkout');
  const fakeBin = join(root, 'bin');
  const home = join(root, 'home');
  const hudHome = join(root, 'hud');
  const codexHome = join(root, 'codex');
  const countFile = join(root, 'bar-generation.txt');
  const releaseFile = join(root, 'release-codex');
  for (const dir of [join(hudDir, 'bin'), fakeBin, home, hudHome, codexHome]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    join(hudDir, 'bin/hud-dist.mjs'),
    `import fs from 'node:fs';
import net from 'node:net';
const gen = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1 : 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(gen));
const sock = net.createConnection(process.env.HERDR_SOCKET_PATH);
await new Promise((r) => sock.once('connect', r));
sock.write(JSON.stringify({ id: 'gen-' + gen, method: 'pane.strip.set', params: { pane_id: process.env.CODEX_HUD_STRIP_PANE, position: 'bottom', line: 'bar-gen-' + gen, lease_ms: 15000 } }) + '\\n');
await new Promise((r) => sock.once('data', r));
sock.destroy();
if (gen === 1) process.exit(${BAR_RELOAD_EXIT_CODE});
setInterval(() => {}, 1000);
`
  );
  fs.writeFileSync(
    join(fakeBin, 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(t); process.exit(0); } }, 20);
`,
    { mode: 0o755 }
  );

  const env = {
    HOME: home,
    HUD_HOME: hudHome,
    CODEX_HOME: codexHome,
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: fork.socketPath,
    HERDR_PANE_ID: 'w4E:p1',
  };

  const running = runCodexLaunch([], { env, cwd: root, hudDir, stdout: () => {}, stderr: () => {} });
  await until(() => fork.sets.some((s) => s.line === 'bar-gen-2'), 'bar sidecar did not respawn on reload exit 75');
  assert.ok(fork.sets.some((s) => s.line === 'bar-gen-1'));
  assert.equal(fork.clears.length, 0, 'reload must not clear the strip while Codex is running');

  fs.writeFileSync(releaseFile, 'done\n');
  assert.equal(await running, 0);
  assert.equal(fork.clears.length, 1);
  assert.equal(fork.clears[0].position, 'bottom');
});

test('older fork without pane_strip and non-herdr env refuse clearly naming herdr-hud; STATUSLINE=0 launches Codex directly', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-codex-refuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldFork = await startFakeForkSocket(t, { version: '0.9.5-hud.0409f9fa', paneStrip: false });
  const fakeBin = join(root, 'bin');
  const codexCalled = join(root, 'codex-called');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    join(fakeBin, 'codex'),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(codexCalled)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
    { mode: 0o755 }
  );

  const baseEnv = {
    HOME: join(root, 'home'),
    HUD_HOME: join(root, 'hud'),
    CODEX_HOME: join(root, 'codex'),
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_HUD_SKIP_BUILD: '1',
  };
  for (const dir of [baseEnv.HOME, baseEnv.HUD_HOME, baseEnv.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });

  // 1) Older fork without pane_strip refuses clearly naming herdr-hud.
  let err1 = '';
  const code1 = await runCodexLaunch([], {
    env: { ...baseEnv, HERDR_ENV: '1', HERDR_SOCKET_PATH: oldFork.socketPath, HERDR_PANE_ID: 'w4E:p1' },
    cwd: root,
    hudDir: REPO_ROOT,
    stdout: () => {},
    stderr: (s) => {
      err1 += s;
    },
  });
  assert.equal(code1, 1);
  assert.match(err1, /herdr-hud/);
  assert.match(err1, /pane_strip/);
  assert.equal(fs.existsSync(codexCalled), false, 'must not spawn codex on refusal');

  // 2) Outside herdr refuses clearly naming herdr-hud.
  let err2 = '';
  const code2 = await runCodexLaunch([], {
    env: baseEnv,
    cwd: root,
    hudDir: REPO_ROOT,
    stdout: () => {},
    stderr: (s) => {
      err2 += s;
    },
  });
  assert.equal(code2, 1);
  assert.match(err2, /herdr-hud/);
  assert.equal(fs.existsSync(codexCalled), false);

  // 3) HUD_STATUSLINE=0 overrides CODEX_HUD_STATUSLINE=1 and starts Codex directly without strip or pane_strip.
  const code3 = await runCodexLaunch(['--model', 'gpt-5'], {
    env: { ...baseEnv, CODEX_HUD_STATUSLINE: '1', HUD_STATUSLINE: '0' },
    cwd: root,
    hudDir: REPO_ROOT,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code3, 0);
  assert.equal(fs.existsSync(codexCalled), true);
  assert.equal(oldFork.sets.length, 0);
});
