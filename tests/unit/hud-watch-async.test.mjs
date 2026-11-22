import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runCommand } from '../../dist/roles/herdr-run.js';
import { procStat } from '../../dist/roles/worker-tree.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { fixture, until } from '../helpers/job-retention-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const text = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const json = (dir, file) => JSON.parse(text(join(dir, file)) || 'null');
const save = (dir, file, value) => writeFixtureFile(join(dir, file), JSON.stringify(value));
const status = (dir) => json(dir, 'STATUS.json');
const receipt = (dir) => json(dir, 'job.json');
const reaped = (dir) => receipt(dir)?.reaped_at;
const closed = () => ({ state: 'closed', ended_at: new Date().toISOString() });
function bin(f, name, body) {
  fs.writeFileSync(join(dirname(f.home), 'bin', name), `#!${process.execPath}
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
${body}\n`, { mode: 0o700 });
}
function reapStub(f, body) {
  bin(f, 'pi-role-reap', `const dir = process.argv[2];
fs.appendFileSync(join(process.env.HUD_HOME, 'reaps'), dir + '\\n');
${body}`);
}
const attempts = (f, dir) => text(join(f.home, 'reaps')).split('\n').filter((line) => line === dir).length;
const tab = (dir, name) => writeFixtureFile(join(dir, 'SESSION.txt'), `TAB=${name}\nPRIMARY=${name}-agent\n`);
function settled() {
  const now = Date.now();
  return {
    created: new Date(now - 2000).toISOString(),
    state: { state: 'idle_grace', output_written: true, settled_at: new Date(now - 500).toISOString() },
    reportTime: (now - 1000) / 1000,
  };
}
async function herdrSocket(t, f, answer) {
  const path = join(dirname(f.home), 'herdr.sock');
  const sockets = new Set();
  let subscriber, queries = 0, pending = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    createInterface({ input: socket }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'events.subscribe') subscriber = socket;
      if (method === 'agent.get') {
        queries++;
        pending++;
        socket.once('close', () => pending--);
        if (answer) socket.write(JSON.stringify({ id, result: { agent: { agent_status: answer } } }) + '\n');
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => server.close(done));
  });
  return {
    preload: `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(path)};`,
    ready: () => Boolean(subscriber), queries: () => queries, pending: () => pending,
    closeTab: (id) => subscriber.write(JSON.stringify({ event: 'tab.closed', data: { tab_id: id } }) + '\n'),
  };
}

test('watcher settles other jobs, starts checks and handles failures during a 5 s reap', { timeout: 15000 }, async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f);
  const slow = f.job(closed(), {}, true), fast = f.job({ state: 'working' }, {}, true);
  const { created, state, reportTime } = settled();
  const checked = f.job({ state: 'working' }, { checks: ['true'], cwd: dirname(f.home), created_at: created });
  fs.utimesSync(join(checked, 'report.md'), reportTime, reportTime);
  const failed = f.job({ state: 'working' }), cli = f.job({ state: 'working' }, { cli: { agent: 'claude' } });
  tab(failed, 'external');
  const supervisor = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(supervisor, 'exit');
  reapStub(f, `if (dir === ${JSON.stringify(slow)}) await delay(5000);`);
  const { child, exited } = f.start(herdr.preload + "process.env.HUD_WATCH_FAILED_RETENTION_MS = '0';");
  await until(() => attempts(f, slow) && herdr.ready());

  const start = performance.now();
  save(fast, 'STATUS.json', closed());
  save(checked, 'STATUS.json', { ...state, state: 'closed' });
  save(cli, 'STATUS.json', { state: 'working', supervisor_pid: supervisor.pid });
  herdr.closeTab('external');
  const storm = (async () => {
    for (let i = 0; i < 10; i++) {
      save(slow, 'job.json', { ...receipt(slow), update: i });
      save(slow, 'STATUS.json', closed());
      await delay(10);
    }
  })();
  await Promise.all(Object.entries({ settlement: () => reaped(fast),
    checks: () => json(checked, 'checks.json')?.state === 'done',
    'tab failure': () => status(failed).exit_reason === 'tab closed',
    'supervisor failure': () => status(cli).state === 'waiting_orchestrator',
  }).map(async ([name, ready]) => {
    while (!ready() && performance.now() - start < 500) await delay(5);
    const elapsed = Math.round(performance.now() - start);
    t.diagnostic(`${name}: ${elapsed} ms`);
    assert.ok(ready() && elapsed < 500, `${name} must finish within 500 ms (observed ${elapsed} ms)`);
  }));
  await storm;
  assert.equal(json(checked, 'checks.json').results[0].exit_code, 0);
  assert.equal(reaped(slow), undefined, 'slow reap is still running');
  save(cli, 'STATUS.json', closed());
  const [code, signal] = await exited;
  assert.deepEqual([code, signal], [0, null]);
  assert.ok(reaped(slow));
  assert.equal(receipt(slow).update, 9, 'keep concurrent receipt updates');
  assert.equal(attempts(f, slow), 1, 'one reap despite repeated disk events');
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
  assert.equal(child.exitCode, 0);
});

test('overlapping watcher startups publish only one ready PID', async (t) => {
  const f = fixture(t);
  f.job({ state: 'working' });
  const runs = [f.start(), f.start()];
  await until(() => runs.some(({ child }) => child.exitCode === 0));
  const pid = Number(text(join(f.home, 'watch.pid')));
  const live = runs.find(({ child }) => child.pid === pid);
  assert.ok(live);
  assert.equal(f.log().match(/start pid=/g)?.length, 1);
  live.child.kill('SIGTERM');
  assert.deepEqual(await Promise.all(runs.map(({ exited }) => exited)), [[0, null], [0, null]]);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('watcher dispatches at most four concurrent reaps and resumes the backlog', { timeout: 10000 }, async (t) => {
  const f = fixture(t), dirs = Array.from({ length: 6 }, () => f.job(closed(), {}, true));
  reapStub(f, `while (!fs.existsSync(join(process.env.HUD_HOME, 'release'))) await delay(10);`);
  const { exited } = f.start();
  const count = () => text(join(f.home, 'reaps')).trim().split('\n').filter(Boolean).length;
  await until(() => count() >= 4);
  await delay(100);
  assert.equal(count(), 4);
  fs.writeFileSync(join(f.home, 'release'), '');
  assert.deepEqual(await exited, [0, null]);
  assert.ok(dirs.every((dir) => reaped(dir) && attempts(f, dir) === 1));
});

for (const [answer, event] of [['idle', 'self close'], ['working', 'no spin'], [null, 'external close']]) {
  test(`read-close preflight: ${event}`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), herdr = await herdrSocket(t, f, answer);
    const { created, state, reportTime } = settled();
    const dir = f.job(state, { created_at: created, read_at: new Date().toISOString() });
    fs.utimesSync(join(dir, 'report.md'), reportTime, reportTime);
    tab(dir, 'pi');
    reapStub(f, `while (!fs.existsSync(join(dir, 'release'))) await delay(10);`);
    const { child, exited } = f.start(herdr.preload);
    await until(() => herdr.ready() && herdr.queries());
    if (event === 'no spin') {
      await delay(600);
      assert.equal(herdr.queries(), 1);
      assert.equal(attempts(f, dir), 0);
      child.kill('SIGTERM');
    } else if (event === 'self close') {
      await until(() => attempts(f, dir) === 1);
      herdr.closeTab('pi');
      await delay(100);
      assert.equal(status(dir).state, 'idle_grace');
      fs.writeFileSync(join(dir, 'release'), '');
      await until(() => reaped(dir));
      assert.equal(status(dir).state, 'closed');
      assert.equal(status(dir).exit_reason, 'closed after report read');
    } else {
      assert.equal(herdr.pending(), 1);
      const start = performance.now();
      herdr.closeTab('pi');
      await until(() => herdr.pending() === 0 && status(dir).state === 'failed');
      assert.ok(performance.now() - start < 1000, 'cancel the query without waiting for its 2 s budget');
      assert.equal(status(dir).exit_reason, 'tab closed');
      assert.equal(attempts(f, dir), 0, 'failed tab is still in retention');
      child.kill('SIGTERM');
    }
    assert.deepEqual(await exited, [0, null]);
  });
}

test('failed Pi read-close retries its live root after the tab disappears', async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f, 'idle');
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const ended = once(worker, 'exit');
  t.after(async () => { worker.kill(); await ended; });
  const { created, state, reportTime } = settled();
  const dir = f.job({ ...state, pid: worker.pid, pid_start_time: procStat(worker.pid).start },
    { created_at: created, read_at: new Date().toISOString() });
  fs.utimesSync(join(dir, 'report.md'), reportTime, reportTime);
  tab(dir, 'pi');
  reapStub(f, `if (!fs.existsSync(join(dir, 'tab-gone'))) {
    while (!fs.existsSync(join(dir, 'tab-gone'))) await delay(10);
    process.exit(1);
  }`);
  const { exited } = f.start(herdr.preload);
  await until(() => herdr.ready() && attempts(f, dir) === 1);
  herdr.closeTab('pi');
  fs.writeFileSync(join(dir, 'tab-gone'), '');
  await until(() => f.log().includes('state=idle_grace exit=1'));
  assert.equal(status(dir).state, 'idle_grace');
  await until(() => reaped(dir));
  assert.deepEqual(await exited, [0, null]);
  assert.equal(attempts(f, dir), 2);
  assert.equal(herdr.queries(), 1, 'the missing tab cannot answer another preflight');
  assert.equal(status(dir).exit_reason, 'closed after report read');
});

test('watcher removes two merged worktrees from the same checkout', { timeout: 10000 }, async (t) => {
  const f = fixture(t), parent = dirname(f.home), main_root = initRepo(parent);
  const base_head = git(main_root, 'rev-parse', 'HEAD');
  const trees = Array.from({ length: 2 }, () => {
    const dir = f.job(closed(), {}, true), name = `imp-${basename(dir).slice(-6)}`;
    const root = join(parent, 'demo-wt', name), branch = `wt/${name}`;
    git(main_root, 'worktree', 'add', '-qb', branch, root, base_head);
    save(dir, 'job.json', { ...receipt(dir), cwd: root, worktree: { root, branch, main_root, base_head } });
    return { dir, root, branch };
  });
  assert.deepEqual(await f.start().exited, [0, null]);
  for (const { dir, root, branch } of trees) {
    assert.ok(receipt(dir).worktree_removed_at);
    assert.equal(receipt(dir).worktree_kept_reason, undefined);
    assert.equal(fs.existsSync(root), false);
    assert.equal(git(main_root, 'branch', '--list', branch), '');
  }
});

for (const stubborn of [false, true]) {
  test(`watcher SIGTERM drains ${stubborn ? 'TERM-resistant' : 'cooperative'} reap group without live orphans`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), dir = f.job(closed(), {}, true);
    bin(f, 'herdr', `if (${stubborn}) process.on('SIGTERM', () => {});
fs.writeFileSync(join(process.env.HUD_HOME, 'herdr-pid'), String(process.pid));
await delay(30000);`);
    reapStub(f, `fs.writeFileSync(join(process.env.HUD_HOME, 'reap-pid'), String(process.pid));
if (${stubborn}) spawnSync('herdr', [], { stdio: 'ignore' });
else {
  process.on('SIGTERM', () => {}); // Exit after libuv has reaped the cooperative child.
  spawn('herdr', [], { stdio: 'ignore' });
}`);
    const { child, exited } = f.start();
    const helpers = [];
    const alive = ({ pid, start }) => {
      const current = procStat(pid);
      return current?.start === start && !/^[ZXx]$/.test(current.state);
    };
    t.after(() => { for (const helper of helpers) if (alive(helper)) process.kill(helper.pid, 'SIGKILL'); });
    const herdrPid = join(f.home, 'herdr-pid');
    await until(() => text(herdrPid));
    for (const name of ['reap-pid', 'herdr-pid']) {
      const pid = Number(text(join(f.home, name)));
      helpers.push({ pid, start: procStat(pid).start });
    }
    const start = performance.now();
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    const elapsed = Math.round(performance.now() - start);
    t.diagnostic(`SIGTERM (${stubborn ? 'escalated' : 'cooperative'}): ${elapsed} ms`);
    assert.ok(stubborn ? elapsed >= 1900 && elapsed < 3000 : elapsed < 300);
    assert.ok(helpers.every((helper) => !alive(helper)));
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
    assert.equal(reaped(dir), undefined);
    assert.match(f.log(), /reap .* state=closed exit=aborted;/);
    assert.match(f.log(), /exit pid=\d+: signal=SIGTERM/);
  });
}

for (const token of [true, false]) test(`unexpected detached leader death: ${token ? 'drain verified helpers' : 'refuse unverified group'}`, async (t) => {
  const f = fixture(t), dir = f.job(closed(), {}, true);
  const env = { ...process.env, HUD_HOME: f.home, PATH: `${dirname(f.home)}/bin:${process.env.PATH}` };
  bin(f, 'herdr', `process.on('SIGTERM', () => {});
fs.writeFileSync(join(process.env.HUD_HOME, 'helper'), String(process.pid));
await delay(30000);`);
  reapStub(f, `fs.writeFileSync(join(dir, 'leader'), String(process.pid));
spawnSync('herdr', [], { stdio: 'ignore', env: ${token ? 'process.env' : "{ ...process.env, HUD_REAP_GROUP_TOKEN: 'unrelated' }"} });`);
  const run = runCommand('pi-role-reap', [dir], env, { killProcessGroup: true, killGraceMs: 100 });
  await until(() => text(join(f.home, 'helper')));
  const pid = Number(text(join(f.home, 'helper'))), start = procStat(pid).start;
  const alive = () => { const s = procStat(pid); return s?.start === start && !/^[ZXx]$/.test(s.state); };
  t.after(() => { if (alive()) process.kill(pid, 'SIGKILL'); });
  process.kill(Number(text(join(dir, 'leader'))), 'SIGKILL');
  const result = await run;
  assert.equal(result.reason, 'lost');
  if (token) await until(() => !alive());
  else {
    assert.match(result.groupCleanupIssue, /ownership unverified; not signalling/);
    assert.ok(alive());
  }
});

for (const reason of ['timeout', 'unavailable']) {
  test(`watcher records exit=${reason} without marking the job reaped`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), dir = f.job(closed(), {}, true);
    reapStub(f, 'await delay(30000);');
    const preload = reason === 'timeout' ? `
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
const raw = timers.setTimeout;
timers.setTimeout = (cb, ms, ...args) => raw(cb, ms === 135000 ? 150 : ms, ...args);
syncBuiltinESMExports();` : "process.env.PATH = '';";
    const { child, exited } = f.start(preload);
    await until(() => text(join(f.home, 'watch.log')).includes(`state=closed exit=${reason};`));
    assert.equal(reaped(dir), undefined);
    child.kill('SIGINT');
    assert.deepEqual(await exited, [0, null]);
    assert.match(f.log(), /exit pid=\d+: signal=SIGINT/);
  });
}

test('runCommand uses wall time and preserves the timeout reason through SIGKILL', async () => {
  const raw = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => raw(cb, ms / 20, ...args);
  try {
    const start = performance.now();
    const result = await runCommand(process.execPath, ['-e', `
process.on('SIGTERM', () => process.stdout.write('TERM observed'));
setInterval(() => {}, 1000);`], process.env, { budgetMs: 400, killGraceMs: 80 });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, 'TERM observed');
    assert.ok(performance.now() - start >= 450);
  } finally { globalThis.setTimeout = raw; }
});

test('runCommand bounds combined UTF-8 output and stops a TERM-resistant overflow', async () => {
  const result = await runCommand(process.execPath, ['-e', `
process.on('SIGTERM', () => {});
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.stderr.write('synthetic stderr');
process.stdout.write('€'.repeat(800_000));
setInterval(() => {}, 1000);`], process.env, { budgetMs: 3000, killGraceMs: 40 });
  const combined = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  assert.ok(combined <= 1024 * 1024 && combined >= 1024 * 1024 - 3);
  assert.equal(result.stdout.includes('\ufffd'), false);
  assert.equal(result.reason, 'lost');
  assert.equal(result.exitCode, null);
});
