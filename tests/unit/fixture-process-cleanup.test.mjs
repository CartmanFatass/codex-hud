import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  fs.mkdirSync(hudHome, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    env: { ...process.env, HOME: join(root, 'home'), HUD_HOME: hudHome },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  t.after(async () => {
    await reapFixtureProcesses({ root, hudHome, graceMs: 100 });
    fs.rmSync(root, { recursive: true, force: true });
  });

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
  const ownRoot = fs.mkdtempSync(join(tmpdir(), 'thin-mcp-own-'));
  const otherRoot = fs.mkdtempSync(join(tmpdir(), 'thin-mcp-other-'));
  const ownHud = join(ownRoot, 'hud_home');
  const otherHud = join(otherRoot, 'hud_home');
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
  t.after(async () => {
    await reapFixtureProcesses({ root: ownRoot, hudHome: ownHud, graceMs: 100 });
    await reapFixtureProcesses({ root: otherRoot, hudHome: otherHud, graceMs: 100 });
    fs.rmSync(ownRoot, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  assert.deepEqual(await reapFixtureProcesses({ root: ownRoot, hudHome: ownHud, graceMs: 100 }), []);
  assert.deepEqual(findFixtureProcesses({ root: ownRoot, hudHome: ownHud }), []);
  assert.ok(findFixtureProcesses({ root: otherRoot, hudHome: otherHud }).some((proc) => proc.pid === other.pid));
});

test('thin-mcp and job-retention fixtures leave no processes after forced failures, SIGSTOP, and timeouts', { timeout: 30000 }, async (t) => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'fixture-cleanup-subrun-'));
  const homesFile = join(workDir, 'homes.txt');
  const script = join(workDir, 'forced-failures.test.mjs');
  const harnessPath = resolve('tests/helpers/thin-mcp-harness.mjs');
  const retentionPath = resolve('tests/helpers/job-retention-fixture.mjs');
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, fakeCliWithChild, writeCliRole, cliState, until } from ${JSON.stringify(harnessPath)};
import { fixture as retentionFixture } from ${JSON.stringify(retentionPath)};

const record = (hudHome) => fs.appendFileSync(${JSON.stringify(homesFile)}, hudHome + '\\n');

test('forced fail after cli hud_create', async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'fail-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  assert.fail('forced failure with live hud-watch and hud-cli');
});

test('forced fail while hud-watch and hud-cli are SIGSTOPped', async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'stopped-cli', 8);
  const job = await f.call('hud_create', { role: 'stopped-cli', request_key: 'sigstop-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  process.kill(cliState(job.task_dir).supervisor_pid, 'SIGSTOP');
  process.kill(Number(fs.readFileSync(join(f.env.HUD_HOME, 'watch.pid'), 'utf8')), 'SIGSTOP');
  assert.fail('forced failure while processes are stopped');
});

test('forced timeout while hud_read wait_ms blocks hud-mcp', { timeout: 1200 }, async (t) => {
  const f = await fixture(t);
  record(f.env.HUD_HOME);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'timeout-cli', task: 'Synthetic.' });
  await until(() => cliState(job.task_dir)?.supervisor_pid && fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  await f.call('hud_read', { job: job.job, wait_ms: 120000 });
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
  await until(() => fs.existsSync(join(f.home, 'watch.pid')));
  assert.fail('forced failure with SIGTERM-resistant hud-watch');
});
`);

  const recordedHomes = () =>
    fs.existsSync(homesFile) ? fs.readFileSync(homesFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  t.after(async () => {
    for (const hudHome of recordedHomes()) {
      await reapFixtureProcesses({ root: join(hudHome, '..'), hudHome, graceMs: 100 });
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', script], { env, encoding: 'utf8', timeout: 25000 });
  assert.notEqual(run.status, 0, `forced failing subtests should exit non-zero:\n${run.stdout}\n${run.stderr}`);
  const homes = recordedHomes();
  assert.equal(homes.length, 5, `expected all 5 subtests to run:\n${run.stdout}\n${run.stderr}`);

  const survivors = [];
  for (const hudHome of homes) {
    survivors.push(...findFixtureProcesses({ root: join(hudHome, '..'), hudHome }));
  }
  assert.deepEqual(
    survivors,
    [],
    `Forced failing/timed-out tests left live processes: ${JSON.stringify(survivors)}`
  );
});
