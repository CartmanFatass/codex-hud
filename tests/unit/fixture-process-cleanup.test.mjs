import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { until } from '../helpers/thin-mcp-harness.mjs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertNoFixtureProcesses,
  findFixtureProcesses,
  reapFixtureProcesses,
} from '../helpers/process-cleanup.mjs';

test('guard fails when a fixture leaves a live detached child and passes once reaped', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'thin-mcp-guard-'));
  const hudHome = join(root, 'hud_home');
  t.after(async () => {
    await reapFixtureProcesses({ root, hudHome, graceMs: 100 });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(hudHome, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    env: { ...process.env, HOME: join(root, 'home'), HUD_HOME: hudHome },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const found = findFixtureProcesses({ root, hudHome });
  assert.ok(found.some((proc) => proc.pid === child.pid && proc.hudHome === hudHome));
  assert.throws(
    () => assertNoFixtureProcesses({ root, hudHome }),
    (error) => error instanceof assert.AssertionError && error.message.includes(String(child.pid)) && error.message.includes(hudHome)
  );

  const survivors = await reapFixtureProcesses({ root, hudHome, graceMs: 100 });
  assert.deepEqual(survivors, []);
  assertNoFixtureProcesses({ root, hudHome });
});

test('reapFixtureProcesses leaves unrelated processes with a different HUD_HOME untouched', async (t) => {
  const fixtureHome = (prefix) => {
    const root = fs.mkdtempSync(join(tmpdir(), prefix));
    const hudHome = join(root, 'hud_home');
    t.after(async () => {
      await reapFixtureProcesses({ root, hudHome, graceMs: 100 });
      fs.rmSync(root, { recursive: true, force: true });
    });
    return [root, hudHome];
  };
  const [ownRoot, ownHud] = fixtureHome('thin-mcp-own-');
  const [otherRoot, otherHud] = fixtureHome('thin-mcp-other-');
  fs.mkdirSync(ownHud, { recursive: true });
  fs.mkdirSync(otherHud, { recursive: true });
  const own = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    env: { ...process.env, HOME: join(ownRoot, 'home'), HUD_HOME: ownHud },
    detached: true,
    stdio: 'ignore',
  });
  own.unref();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    env: { ...process.env, HOME: join(otherRoot, 'home'), HUD_HOME: otherHud },
    detached: true,
    stdio: 'ignore',
  });
  other.unref();

  assert.deepEqual(await reapFixtureProcesses({ root: ownRoot, hudHome: ownHud, graceMs: 100 }), []);
  assert.deepEqual(findFixtureProcesses({ root: ownRoot, hudHome: ownHud }), []);
  assert.ok(findFixtureProcesses({ root: otherRoot, hudHome: otherHud }).some((proc) => proc.pid === other.pid));
});

test('thin-mcp and job-retention fixtures leave no processes after forced failures, SIGSTOP, and timeouts', { timeout: 30000 }, async (t) => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'fixture-cleanup-subrun-'));
  const homesFile = join(workDir, 'homes.txt');
  const recordedHomes = () =>
    fs.existsSync(homesFile) ? fs.readFileSync(homesFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  t.after(async () => {
    await reapFixtureProcesses({ root: workDir, graceMs: 100 });
    fs.rmSync(workDir, { recursive: true, force: true });
  });
  const script = join(workDir, 'forced-failures.test.mjs');
  const harnessPath = resolve('tests/helpers/thin-mcp-harness.mjs');
  const retentionPath = resolve('tests/helpers/job-retention-fixture.mjs');
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, rolePlacesFixture, fakeCliWithChild, writeCliRole, cliState, until } from ${JSON.stringify(harnessPath)};
import { fixture as retentionFixture } from ${JSON.stringify(retentionPath)};

const record = (hudHome) => fs.appendFileSync(${JSON.stringify(homesFile)}, hudHome + '\\n');

test('forced fail after cli hud_create', async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'fail-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), t.signal);
  assert.fail('forced failure with live hud-watch and hud-cli');
});

test('forced fail while hud-watch and hud-cli are SIGSTOPped', async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'stopped-cli', 8);
  const job = await f.call('hud_create', { role: 'stopped-cli', request_key: 'sigstop-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), t.signal);
  process.kill(cliState(job.task_dir).supervisor_pid, 'SIGSTOP');
  process.kill(Number(fs.readFileSync(join(f.env.HUD_HOME, 'watch.pid'), 'utf8')), 'SIGSTOP');
  assert.fail('forced failure while processes are stopped');
});

test('forced timeout while hud_read wait_ms blocks hud-mcp', { timeout: 1200 }, async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'timeout-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), t.signal);
  await f.call('hud_read', { job: job.job, wait_ms: 120000 });
});

test('forced timeout with a live role-places watcher', async (t) => {
  const f = await rolePlacesFixture(t);
  record(f.env.HUD_HOME);
  await f.call('hud_create', { role: 'imp', request_key: 'role-timeout', task: 'Synthetic.' });
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), t.signal);
  await t.test('hung operation', { timeout: 200 }, async () => {
    const tick = setInterval(() => {}, 1000);
    t.after(() => clearInterval(tick));
    await new Promise(() => {});
  });
});

test('forced fail with fakeCliWithChild detached descendant', async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  const worker = fakeCliWithChild(t, f);
  await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  process.kill(worker.pid, 'SIGKILL');
  assert.fail('forced failure after worker died leaving detached child');
});

test('forced fail with SIGTERM-resistant job-retention watcher', async (t) => {
  const f = retentionFixture(t);
  record(f.home);
  f.job({ state: 'working' });
  f.start('process.on("SIGTERM", () => {});');
  await until(() => fs.existsSync(join(f.home, 'watch.pid')), t.signal);
  assert.fail('forced failure with SIGTERM-resistant hud-watch');
});
`);

  const env = { ...process.env, TMPDIR: workDir, HUD_HOME: join(workDir, 'hud') };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-timeout=10000', '--test-force-exit', script], { env, encoding: 'utf8', timeout: 25000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 1, `forced failing subtests should exit non-zero:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /test timed out after 200ms/);
  const homes = recordedHomes();
  assert.equal(homes.length, 6, `expected all 6 subtests to run:\n${run.stdout}\n${run.stderr}`);

  const survivors = [];
  for (const hudHome of homes) {
    const root = join(hudHome, '..');
    assert.equal(fs.existsSync(root), false, `Forced failure left fixture directory ${root}`);
    survivors.push(...findFixtureProcesses({ root, hudHome }));
  }
  assert.deepEqual(
    survivors,
    [],
    `Forced failing/timed-out tests left live processes: ${JSON.stringify(survivors)}`
  );
});

test('SIGKILL of the node --test coordinator leaves no watcher or directory for either fixture', { timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'fixture-cleanup-killed-'));
  let run, exited;
  t.after(async () => {
    if (run?.pid) {
      // If an assertion fails before SIGKILL, still stop the coordinator and test worker.
      try { process.kill(-run.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      await exited;
    }
    await reapFixtureProcesses({ root: dir, graceMs: 100 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const script = join(dir, 'killed.test.mjs'), homesFile = join(dir, 'homes'), ready = join(dir, 'ready');
  fs.writeFileSync(script, `
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, rolePlacesFixture, until } from ${JSON.stringify(resolve('tests/helpers/thin-mcp-harness.mjs'))};

test('start both fixture watchers', async (t) => {
  for (const make of [fixture, rolePlacesFixture]) {
    const f = await make(t);
    fs.appendFileSync(${JSON.stringify(homesFile)}, f.env.HUD_HOME + '\\n');
    await f.call('hud_create', { role: 'imp', request_key: 'killed', task: 'Synthetic.' });
    await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), 25000);
  }
  fs.writeFileSync(${JSON.stringify(ready)}, '');
  await new Promise(() => setInterval(() => {}, 1000));
});
`);
  const homes = () => fs.existsSync(homesFile) ? fs.readFileSync(homesFile, 'utf8').trim().split('\n') : [];
  const env = { ...process.env, TMPDIR: dir };
  delete env.NODE_TEST_CONTEXT;
  run = spawn(process.execPath, ['--test', '--test-timeout=60000', script], { stdio: 'ignore', env, detached: true });
  exited = once(run, 'exit');
  await until(() => fs.existsSync(ready), 30000);
  assert.equal(homes().length, 2);
  for (const hudHome of homes()) assert.ok(findFixtureProcesses({ hudHome }).some(({ cmdline }) => cmdline.includes('hud-watch.mjs')));
  run.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  // No test cleanup hook ran in the killed run; wait for its guardian, not the fallback above.
  await until(() => homes().every(hudHome => !fs.existsSync(join(hudHome, '..'))), 20000);
  for (const hudHome of homes()) assertNoFixtureProcesses({ root: join(hudHome, '..'), hudHome });
});

test('the pi-package suite leaves no hud-watch with a temporary HUD_HOME', { timeout: 35000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-package-suite-'));
  t.after(async () => {
    await reapFixtureProcesses({ root, graceMs: 100 });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, TMPDIR: root, HUD_HOME: join(root, 'hud') };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', 'tests/unit/pi-package.test.mjs'], {
    env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, run.error?.message ?? `${run.stdout}\n${run.stderr}`);
  const watchers = findFixtureProcesses({ root }).filter(({ cmdline, hudHome }) => hudHome && cmdline.includes('hud-watch.mjs'));
  assert.deepEqual(watchers, []);
});
