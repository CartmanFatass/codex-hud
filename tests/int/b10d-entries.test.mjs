import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { sourceFixture } from './b10d-fixture.mjs';
import { waitUntil } from './b10d-harness.mjs';
const preload = new URL('./b10d-entry-preload.mjs', import.meta.url).href;
async function entry(f, file, args = [], health = false, ledger = true) {
  const trace = join(f.home, 'entry-' + Math.random() + '.jsonl');
  writeFileSync(trace, '');
  const settings = join(f.home, 'hud-settings.json');
  writeFileSync(
    settings,
    JSON.stringify({
      briefing: 'off',
      briefAgents: false,
      briefMain: false,
      agentProgress: false,
      agentLabels: false,
      resultDigest: false,
      notify: false,
    })
  );
  const child = spawn(process.execPath, ['--import', preload, resolve(file), ...args], {
    cwd: f.sourceRoot,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: f.home,
      HUD_HOME: ledger ? f.home : join(f.home, 'absent-ledger-home'),
      CODEX_HOME: f.sourceRoot,
      CODEX_HUD_CWD: '/synthetic/project',
      CODEX_HUD_SETTINGS_PATH: settings,
      B10D_ENTRY_TRACE: trace,
      B10D_ENTRY_HEALTH: health ? '1' : '0',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout = (stdout + b).slice(-20000)));
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-20000)));
  const done = once(child, 'exit');
  return {
    child,
    done,
    trace,
    events: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    output: () => ({ stdout, stderr }),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      await done;
      clearTimeout(timer);
    },
  };
}
for (const [label, path] of [
  ['bar', 'dist/index.js'],
  ['panel', 'dist/tree-page.js'],
])
  test(`B10D production ${label} starts one worker and publishes outside the paint thread`, async (t) => {
    const f = await sourceFixture();
    const id = '019bc10d-c89d-7352-935c-76b351384357';
    const at = new Date().toISOString();
    writeFileSync(
      join(dirname(f.file(f.parent.sessionId)), 'rollout-2026-11-03T00-00-00-' + id + '.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        timestamp: at,
        payload: { id, timestamp: at, cwd: '/synthetic/project', cli_version: 'synthetic' },
      }) + '\n'
    );
    const p = await entry(f, path);
    t.after(async () => {
      await p.close();
      f.cleanup();
    });
    await waitUntil(() => p.events().some((e) => e.kind === 'publishPrepared'), 20000);
    assert.equal(p.events().filter((e) => e.kind === 'worker').length, 1);
    assert.ok(
      p
        .events()
        .filter((e) => e.kind !== 'worker')
        .every((e) => !e.isMainThread)
    );
    assert.doesNotMatch(p.output().stderr, /B10D_MAIN_THREAD_AUTHORITY/);
    await p.close();
    assert.equal(p.child.signalCode, null);
  });
test('B10D read-only CLI status/wait creates zero workers and leaves observation publication untouched', async (t) => {
  const f = await sourceFixture();
  t.after(() => f.cleanup());
  for (const args of [
    ['run', 'status', 'run-n1', '--json'],
    ['run', 'wait', 'run-n1', '--timeout-ms', '0', '--json'],
  ]) {
    const p = await entry(f, 'bin/hud', args);
    t.after(() => p.close());
    await p.done;
    assert.ok([0, 4].includes(p.child.exitCode), JSON.stringify(p.output()));
    assert.equal(p.events().length, 0);
    assert.equal(existsSync(join(f.home, 'sources')), false);
  }
});

for (const [label, path] of [
  ['bar', 'dist/index.js'],
  ['panel', 'dist/tree-page.js'],
])
  test(`B10D ${label} cached busy and permanently unavailable worker opportunities never advance the successful read clock`, async (t) => {
    const f = await sourceFixture();
    const id = '019bc10d-c89d-7352-935c-76b351384357',
      at = new Date().toISOString();
    writeFileSync(
      join(dirname(f.file(f.parent.sessionId)), 'rollout-2026-11-03T00-00-00-' + id + '.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        timestamp: at,
        payload: { id, timestamp: at, cwd: '/synthetic/project', cli_version: 'synthetic' },
      }) + '\n'
    );
    const p = await entry(f, path, [], true);
    t.after(async () => {
      await p.close();
      f.cleanup();
    });
    await waitUntil(() => p.events().some((e) => e.kind === 'storage_stall'), 20000);
    appendFileSync(
      join(dirname(f.file(f.parent.sessionId)), 'rollout-2026-11-03T00-00-00-' + id + '.jsonl'),
      JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) +
        '\n'
    );
    // Native storage holds the real worker while normal main-thread opportunities continue using cached data.
    await new Promise((r) => setTimeout(r, 2200));
    assert.ok(p.events().some((e) => e.kind === 'root_opportunity' && !e.allowed));
    assert.ok(
      p
        .events()
        .filter((e) => e.kind === 'health_read')
        .every((e) => e.allowed)
    );
    for (let k = 0; k < 2; k++) {
      writeFileSync(p.trace + '.kill', '');
      if (k === 0) await waitUntil(() => p.events().filter((e) => e.kind === 'worker').length === 2, 20000);
      else await waitUntil(() => !existsSync(p.trace + '.kill'), 20000);
    }
    await new Promise((r) => setTimeout(r, 200));
    const reads = p.events().filter((e) => e.kind === 'health_read').length;
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(p.events().filter((e) => e.kind === 'worker').length, 2);
    assert.equal(p.events().filter((e) => e.kind === 'health_read').length, reads);
    assert.ok(
      p
        .events()
        .filter((e) => e.kind === 'health_read')
        .every((e) => e.allowed)
    );
  });

for (const [label, path] of [
  ['bar', 'dist/index.js'],
  ['panel', 'dist/tree-page.js'],
])
  test(`B10D production ${label} without a ledger renders legacy output and starts zero observation workers`, async (t) => {
    const f = await sourceFixture(),
      p = await entry(f, path, [], false, false);
    t.after(async () => {
      await p.close();
      f.cleanup();
    });
    await waitUntil(() => p.output().stdout.length > 0, 15000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.events().length, 0);
    assert.doesNotMatch(p.output().stderr, /B10D_MAIN_THREAD_AUTHORITY/);
  });
