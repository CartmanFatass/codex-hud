import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { v8HeapArgs } from '../../scripts/dist-lock.mjs';
import { ensureJobWatcher } from '../../dist/mcp/watch-pid.js';
import { fixture, launch, until } from '../helpers/panel-reload-fixture.mjs';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';

const execSupported = typeof process.execve === 'function' && !['win32', 'os400'].includes(process.platform);

function readCmdline(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

test('v8HeapArgs resolves defaults, HUD_HEAP_CAPS overrides, and respects user heap flags', () => {
  assert.deepEqual(v8HeapArgs('panel', {}), ['--max-old-space-size=128', '--max-semi-space-size=4']);
  assert.deepEqual(v8HeapArgs('watch', {}), ['--max-old-space-size=96', '--max-semi-space-size=2']);
  assert.deepEqual(v8HeapArgs('mcp', {}), ['--max-old-space-size=96', '--max-semi-space-size=2']);

  for (const off of ['0', 'off', 'OFF', 'false', 'default', 'none', ' off ']) {
    assert.deepEqual(v8HeapArgs('panel', { HUD_HEAP_CAPS: off }), [], `off=${off}`);
    assert.deepEqual(v8HeapArgs('watch', { HUD_HEAP_CAPS: off }), [], `off=${off}`);
    assert.deepEqual(v8HeapArgs('mcp', { HUD_HEAP_CAPS: off }), [], `off=${off}`);
  }

  assert.deepEqual(v8HeapArgs('panel', { HUD_HEAP_CAPS: '256/8' }), ['--max-old-space-size=256', '--max-semi-space-size=8']);
  assert.deepEqual(v8HeapArgs('mcp', { HUD_HEAP_CAPS: '192' }), ['--max-old-space-size=192']);
  assert.deepEqual(v8HeapArgs('watch', { HUD_HEAP_CAPS: 'invalid' }), ['--max-old-space-size=96', '--max-semi-space-size=2']);

  assert.deepEqual(
    v8HeapArgs('panel', { NODE_OPTIONS: '--max-old-space-size=512' }),
    ['--max-semi-space-size=4']
  );
  assert.deepEqual(
    v8HeapArgs('mcp', { NODE_OPTIONS: '--max_old_space_size=512 --max_semi_space_size=8' }),
    []
  );
  assert.deepEqual(
    v8HeapArgs('watch', {}, ['--max-old-space-size', '200']),
    ['--max-semi-space-size=2']
  );
});

test('hud panel --here launches with 128/4 V8 heap caps and HUD_HEAP_CAPS=off restores defaults', { timeout: 20000 }, async (t) => {
  const probe = async (extraEnv) => {
    const f = fixture(t);
    const preload = encodeURIComponent(
      `import { basename } from 'node:path';
       import v8 from 'node:v8';
       if (basename(process.argv[1] ?? '') === 'hud-dist.mjs') {
         console.log('HEAP_PROBE:' + JSON.stringify({
           execArgv: process.execArgv,
           limitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
         }));
       }`
    );
    const run = launch(f, resolve('bin/hud'), ['panel', '--here'], {
      ...extraEnv,
      NODE_OPTIONS: `--import=data:text/javascript,${preload}`,
    });
    await until(() => run.output().includes('HEAP_PROBE:'), `panel did not emit probe: ${run.stderr()}`);
    const match = run.output().match(/HEAP_PROBE:(\{[^\n]+\})/);
    assert.ok(match, run.output());
    const result = JSON.parse(match[1]);
    if (process.platform === 'win32') run.child.stdin.end();
    else run.child.kill('SIGTERM');
    await run.exited;
    return result;
  };

  const capped = await probe({});
  assert.ok(capped.execArgv.includes('--max-old-space-size=128'), JSON.stringify(capped));
  assert.ok(capped.execArgv.includes('--max-semi-space-size=4'), JSON.stringify(capped));
  assert.ok(capped.limitMb <= 200, `expected capped heap limit <= 200 MB, got ${capped.limitMb}`);

  const uncapped = await probe({ HUD_HEAP_CAPS: 'off' });
  assert.equal(uncapped.execArgv.some((a) => a.startsWith('--max-old-space-size')), false, JSON.stringify(uncapped));
  assert.equal(uncapped.execArgv.some((a) => a.startsWith('--max-semi-space-size')), false, JSON.stringify(uncapped));
  assert.ok(uncapped.limitMb > capped.limitMb, `expected default limit (${uncapped.limitMb}) > capped (${capped.limitMb})`);
});

test('hud-mcp runs with 96/2 V8 heap caps across execve and HUD_HEAP_CAPS=off restores defaults', { skip: !execSupported, timeout: 15000 }, async (t) => {
  const probeMcp = async (extraEnv) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hud-mcp-caps-'));
    let child, exited;
    cleanupFixture(t, { root: dir }, () => child && stopChild(child, exited, { closeStdin: true }));
    child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
      cwd: dir,
      env: { ...process.env, HUD_HOME: join(dir, 'hud'), HUD_MCP_SURFACE: 'roles', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const rl = createInterface({ input: child.stdout });
    const reply = new Promise((res) => rl.once('line', (line) => res(JSON.parse(line))));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'caps-test', version: '1' } },
    }) + '\n');
    const msg = await reply;
    assert.equal(msg.id, 1, stderr);
    const cmdline = readCmdline(child.pid);
    child.stdin.end();
    rl.close();
    assert.deepEqual(await exited, [0, null], stderr);
    return cmdline;
  };

  const capped = await probeMcp({});
  assert.ok(capped.includes('--max-old-space-size=96'), JSON.stringify(capped));
  assert.ok(capped.includes('--max-semi-space-size=2'), JSON.stringify(capped));

  const uncapped = await probeMcp({ HUD_HEAP_CAPS: 'off' });
  assert.equal(uncapped.some((a) => a.startsWith('--max-old-space-size')), false, JSON.stringify(uncapped));
  assert.equal(uncapped.some((a) => a.startsWith('--max-semi-space-size')), false, JSON.stringify(uncapped));
});

test('hud-watch runs with 96/2 V8 heap caps via ensureJobWatcher and direct execve, and HUD_HEAP_CAPS=default restores defaults', { skip: !execSupported, timeout: 15000 }, async (t) => {
  const makeWatcherHome = (stop) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hud-watch-caps-'));
    const home = join(dir, 'hud');
    cleanupFixture(t, { root: dir, hudHome: home }, stop);
    const jobDir = join(home, 'jobs', 'j0000000000000001');
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ job: 'j0000000000000001', role: 'imp', cwd: dir, created_at: new Date().toISOString() }));
    fs.writeFileSync(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'working', role: 'imp', harness: 'pi' }));
    return home;
  };

  // 1. Launcher path: ensureJobWatcher
  const home1 = makeWatcherHome();
  const prevCaps = process.env.HUD_HEAP_CAPS;
  delete process.env.HUD_HEAP_CAPS;
  try {
    ensureJobWatcher(home1);
    const pidFile = join(home1, 'watch.pid');
    await until(() => fs.existsSync(pidFile), 'ensureJobWatcher did not publish watch.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const cmdline = readCmdline(pid);
    assert.ok(cmdline.includes('--max-old-space-size=96'), JSON.stringify(cmdline));
    assert.ok(cmdline.includes('--max-semi-space-size=2'), JSON.stringify(cmdline));
  } finally {
    if (prevCaps === undefined) delete process.env.HUD_HEAP_CAPS;
    else process.env.HUD_HEAP_CAPS = prevCaps;
  }

  // 2. Direct launch (also covers execve reload dropping execArgv) + HUD_HEAP_CAPS=default override
  for (const [override, expectCapped] of [[undefined, true], ['default', false]]) {
    let child, exited;
    const home = makeWatcherHome(() => child && stopChild(child, exited));
    const env = { ...process.env, HUD_HOME: home };
    if (override) env.HUD_HEAP_CAPS = override;
    else delete env.HUD_HEAP_CAPS;
    child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
    exited = once(child, 'exit');
    const pidFile = join(home, 'watch.pid');
    await until(() => fs.existsSync(pidFile), `watcher (${override ?? 'capped'}) did not publish watch.pid`);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.equal(pid, child.pid, 'execve keeps the watcher PID');
    const cmdline = readCmdline(pid);
    assert.equal(cmdline.includes('--max-old-space-size=96'), expectCapped, JSON.stringify(cmdline));
    assert.equal(cmdline.includes('--max-semi-space-size=2'), expectCapped, JSON.stringify(cmdline));
    child.kill('SIGTERM');
    await exited;
  }
});
