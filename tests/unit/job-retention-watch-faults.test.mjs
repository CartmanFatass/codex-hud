import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { fixture, realSession, expired, until } from '../helpers/job-retention-fixture.mjs';

const DEGRADED_MS = 120;
const timeout = 30_000;
const atomicWriter = new URL('../helpers/thin-mcp-files.mjs', import.meta.url).href;

for (const layout of ['sessions', '.dispatch/helper/sessions']) {
  for (const count of [1, 2]) {
    test(`watcher removes a ${count}-link loop in ${layout} and still scans expired jobs`, { timeout }, async (t) => {
      const f = fixture(t, DEGRADED_MS), open = f.job({ state: 'working' }), old = f.job(expired());
      const folder = join(open, layout);
      fs.mkdirSync(folder, { recursive: true });
      const links = Array.from({ length: count }, (_, i) => join(folder, `${i}.jsonl`));
      links.forEach((link, i) => fs.symlinkSync(links[(i + 1) % count], link));
      const dangling = join(folder, 'dangling.jsonl');
      fs.symlinkSync(join(folder, 'absent.jsonl'), dangling);
      const { child, exited } = f.start();
      await until(() => child.exitCode !== null || (!fs.existsSync(old) && links.every((link) =>
        !fs.lstatSync(link, { throwIfNoEntry: false }))), t.signal);
      assert.equal(child.exitCode, null, 'watcher survives startup with an open job');
      assert.equal(fs.existsSync(old), false);
      assert.ok(links.every((link) => !fs.lstatSync(link, { throwIfNoEntry: false })));
      assert.ok(fs.lstatSync(dangling).isSymbolicLink(), 'ordinary dangling links are not loops');
      for (const link of links) assert.equal(f.log().split('\n').filter((line) => line.includes(`unlink loop ${link}`)).length, 1);
      writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
      await exited;
      assert.equal(child.exitCode, 0);
      assert.match(f.log(), /watch error: .*ELOOP/);
    });
  }
}

const permanentWatchFailure = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.watch = () => { throw Error('synthetic permanent watch failure'); };
syncBuiltinESMExports();`;

test('permanent watch failure still scans and exits with no open jobs', { timeout }, async (t) => {
  const f = fixture(t, DEGRADED_MS), dir = f.job(expired());
  const { child, exited } = f.start(permanentWatchFailure);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.match(f.log(), /watch error: synthetic permanent watch failure/);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('permanently failing session preservation warns once per minute per job, not per scan', { timeout }, async (t) => {
  const f = fixture(t, DEGRADED_MS), open = f.job({ state: 'working' });
  const bad = [f.job(expired()), f.job(expired())];
  for (const dir of bad) realSession(dir, 'sessions', { type: 'session' });
  // With no job events under permanent watch failure, force housekeeping to retry.
  const clock = join(f.home, 'clock'), now = Date.now();
  const setClock = (ms, sweeps = 0) => writeFixtureFile(clock, JSON.stringify({ ms, offset: sweeps * 3_600_000 }));
  setClock(now);
  const { child, exited } = f.start(scanProbe + `
fs.watch = () => { throw Error('synthetic permanent watch failure'); };
syncBuiltinESMExports();
const readClock = () => JSON.parse(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
const perfNow = performance.now.bind(performance);
performance.now = () => perfNow() + readClock().offset;
Date.now = () => readClock().ms;`);
  const warnings = (dir) => f.log().split('\n').filter((line) => line.includes(
    `keep ${dir.split('/').at(-1)} session preservation:`));
  const scans = () => fs.readFileSync(join(f.home, 'scans'), 'utf8').trim().split('\n').length;
  await until(() => fs.existsSync(join(f.home, 'scans')) && bad.every((dir) => warnings(dir).length >= 1), t.signal);
  await until(() => scans() >= 4, t.signal); // Three finished scans, even under scheduler load.
  assert.equal(child.exitCode, null, 'working job keeps degraded scans running');
  for (const dir of bad) assert.equal(warnings(dir).length, 1, 'repeated failures within a minute are suppressed');
  setClock(now + 59999, 1);
  const before = scans();
  await until(() => scans() >= before + 2, t.signal);
  for (const dir of bad) assert.equal(warnings(dir).length, 1, 'still suppressed just before one minute');
  setClock(now + 60000, 2);
  await until(() => bad.every((dir) => warnings(dir).length >= 2), t.signal);
  for (const dir of bad) assert.equal(warnings(dir).length, 2, 'each job warns again after one minute');
  writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('ambiguous reap failures back off, log outcome changes and stop without claiming cleanup', { timeout }, async (t) => {
  const f = fixture(t), dir = f.job(expired(), {}, true);
  fs.appendFileSync(join(f.home, '..', 'bin', 'hud-reap'), `
const attempts = fs.readFileSync(process.env.HUD_HOME + '/reaps', 'utf8').trim().split('\\n').length;
process.exitCode = attempts < 3 ? 1 : 2;
`);
  const { exited } = f.start(`
import fs from 'node:fs';
let now = Date.now();
Date.now = () => now;
process.env.HUD_WATCH_CLI_CHECK_MS = '30000';
const timeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, wait, ...args) => {
  if (wait < 30000) return timeout(callback, wait, ...args);
  fs.appendFileSync(process.env.HUD_HOME + '/timers', wait + '\\n');
  return timeout(() => { now += wait; callback(...args); }, 1);
};`);
  assert.deepEqual(await exited, [0, null]);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), (dir + '\n').repeat(10));
  assert.deepEqual(fs.readFileSync(join(f.home, 'timers'), 'utf8').trim().split('\n').map(Number),
    [30000, 60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000]);
  const logs = f.log().split('\n').filter((line) => line.includes(`reap ${dir.split('/').at(-1)} `));
  assert.deepEqual(logs.map((line) => [Number(/exit=(\d+)/.exec(line)[1]), line.includes('retry limit reached')]),
    [[1, false], [2, false], [2, true]]);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).reaped_at, undefined);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('degraded watching polls for new jobs while a failed tab deadline keeps it alive', { timeout }, async (t) => {
  const f = fixture(t), now = Date.now(), ended_at = new Date(now).toISOString();
  const failed = f.job({ state: 'failed', ended_at }, {}, true);
  const timers = join(f.home, 'timers');
  const { child, exited, stderr } = f.start(permanentWatchFailure + `
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
// Polls still run on real timers, but scheduler delays must not advance the failed-tab deadline.
Date.now = () => ${now};
const timeout = globalThis.setTimeout, scheduled = [];
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = timeout(callback, delay, ...args);
  // Ignore wrapper timers before the watcher publishes its PID under the dist lock.
  if (fs.existsSync(process.env.HUD_HOME + '/watch.pid')) {
    scheduled.push(delay);
    writeFixtureFile(${JSON.stringify(timers)}, JSON.stringify(scheduled));
  }
  return timer;
};`);
  const readTimers = () => fs.existsSync(timers) ? JSON.parse(fs.readFileSync(timers, 'utf8')) : [];
  await until(() => child.exitCode !== null || readTimers().length >= 1, t.signal);
  assert.equal(child.exitCode, null, stderr());
  assert.equal(readTimers()[0], 1000, 'unconfigured degraded interval');
  const second = f.job({ state: 'working' }, {}, true);
  writeFixtureFile(join(second, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at }));
  await until(() => child.exitCode !== null || JSON.parse(fs.readFileSync(join(second, 'job.json'), 'utf8')).reaped_at, t.signal);
  assert.equal(child.exitCode, null, 'the first failed deadline is still pending');
  // Bound the scheduled fallback intervals, not OS time to deliver them and run the reaper.
  const scheduled = readTimers();
  assert.ok(scheduled.length >= 2 && scheduled.every((ms) => ms > 0 && ms <= 1000),
    `expected degraded fallback intervals <= 1000ms, got ${JSON.stringify(scheduled)}`);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n');
  assert.equal(JSON.parse(fs.readFileSync(join(failed, 'job.json'), 'utf8')).reaped_at, undefined);
  writeFixtureFile(join(failed, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at }));
  await exited;
  assert.equal(child.exitCode, 0, stderr());
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n' + failed + '\n');
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

for (const fault of ['permanent startup failure', 'later error']) {
  test(`watcher polls after ${fault}, handles a newly settled job and exits`, { timeout }, async (t) => {
    const f = fixture(t, DEGRADED_MS), dir = f.job({ state: 'working' }, {}, true);
    const poll = join(f.home, 'poll-delay');
    const { child, exited, stderr } = f.start(`
import fs from 'node:fs';
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch, timer = globalThis.setTimeout;
let faulted = false, recorded = false;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (faulted && !recorded) {
    writeFixtureFile(${JSON.stringify(poll)}, String(ms));
    recorded = true;
  }
  return timer(fn, ms, ...args);
};
fs.watch = (...args) => {
  if (${fault === 'permanent startup failure'}) {
    if (args[1]?.recursive) faulted = true;
    throw Error('synthetic permanent watch failure');
  }
  const watcher = watch(...args);
  if (args[1]?.recursive) timer(() => {
    faulted = true;
    watcher.emit('error', Error('synthetic later watch error'));
  }, 100);
  return watcher;
};
syncBuiltinESMExports();`);
    await until(() => child.exitCode !== null || (fs.existsSync(poll) &&
      f.log().includes(fault === 'later error' ? 'synthetic later watch error' : 'using file events only')), t.signal);
    assert.equal(child.exitCode, null, f.log() + stderr());
    // Bound the scheduled fallback, not the OS time to deliver it and start the reaper.
    const ms = Number(fs.readFileSync(poll, 'utf8'));
    assert.ok(ms > 0 && ms <= DEGRADED_MS, `expected a fallback poll within ${DEGRADED_MS}ms, got ${ms}`);
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(expired()));
    await until(() => child.exitCode !== null, t.signal);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
    assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).reaped_at);
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
    if (fault === 'permanent startup failure') {
      assert.equal(f.log().split('\n').filter((line) => line.includes('watch error: synthetic permanent')).length, 1,
        'repeated watch errors are throttled for a minute');
    }
  });
}

const scanProbe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const lstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  if (path === process.env.HUD_HOME + '/jobs')
    fs.appendFileSync(process.env.HUD_HOME + '/scans', Date.now() + '\\n');
  return lstat(path, ...args);
};
syncBuiltinESMExports();`;

test('a settled auto-land flake with an open question waits without spinning and wakes on an answer', { timeout }, async (t) => {
  const f = fixture(t);
  const main_root = join(f.home, 'synthetic-repo'), root = `${main_root}-wt`;
  const dir = f.job({ state: 'closed', output_written: true }, { auto_land: true, cwd: root, worktree: { root, main_root } });
  writeFixtureFile(join(dir, 'report.md'), 'Blockers: owner decision needed\n');
  fs.mkdirSync(join(dir, 'qa'));
  writeFixtureFile(join(dir, 'qa', 'q1.md'), 'An open synthetic question.\n');
  const jobFile = join(dir, 'job.json');
  const blocked = () => JSON.parse(fs.readFileSync(jobFile, 'utf8')).auto_land_blocked;

  // Put the bounded retry beyond the test deadline so only an event can account for the wake.
  const { child, exited, stderr } = f.start(scanProbe + `\nprocess.env.HUD_WATCH_CLI_CHECK_MS = '60000';`);
  const scansFile = join(f.home, 'scans');
  await until(() => fs.existsSync(scansFile), t.signal);
  const scans = () => fs.readFileSync(scansFile, 'utf8').trim().split('\n').length;
  const before = scans();
  await delay(350, undefined, { signal: t.signal });
  const extra = scans() - before;
  assert.ok(extra <= 2, `expected at most two extra scans in 350 ms, got ${extra}`);
  assert.equal(child.exitCode, null, stderr());
  assert.equal(blocked(), undefined, 'the open question defers the report decision');

  writeFixtureFile(join(dir, 'qa', 'q1.answer.md'), 'Synthetic answer.\n');
  await until(() => blocked(), t.signal);
  assert.equal(blocked().reason, 'Blockers: owner decision needed');
  assert.deepEqual(await exited, [0, null]);
});

test('persistent asynchronous watch errors stay at one scan per second and throttle diagnostics', { timeout }, async (t) => {
  const f = fixture(t, DEGRADED_MS), bad = f.job({ state: 'working' }), dir = f.job({ state: 'working' }, {}, true);
  const badFile = join(bad, 'STATUS.json');
  fs.unlinkSync(badFile);
  fs.mkdirSync(badFile);
  const { child, exited } = f.start(scanProbe + `
import { EventEmitter } from 'node:events';
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
let attempts = 0, reportingError = false;
const delays = [], watch = fs.watch, timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (reportingError) delays.push(ms);
  return timer(fn, ms, ...args);
};
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  fs.appendFileSync(process.env.HUD_HOME + '/attempts', Date.now() + '\\n');
  const watcher = new EventEmitter();
  watcher.close = () => {};
  process.nextTick(() => {
    reportingError = true;
    watcher.emit('error', Error('synthetic async watch failure ' + (++attempts)));
    reportingError = false;
    if (attempts === 4) {
      const stamps = (name) => fs.readFileSync(process.env.HUD_HOME + '/' + name, 'utf8').trim().split('\\n').map(Number);
      writeFixtureFile(process.env.HUD_HOME + '/scan-sample', JSON.stringify({ scans: stamps('scans'), attempts: stamps('attempts'), delays }));
    }
  });
  return watcher;
};
syncBuiltinESMExports();`);
  await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'scans')) && f.log().includes('watch error:')), t.signal);
  assert.equal(child.exitCode, null);
  // Take a coherent snapshot in the watcher after four watch attempts, not after a parent-side sleep.
  const sample = join(f.home, 'scan-sample');
  await until(() => fs.existsSync(sample), t.signal);
  const { scans, attempts, delays } = JSON.parse(fs.readFileSync(sample, 'utf8'));
  assert.deepEqual(delays, attempts.map(() => DEGRADED_MS), 'each error schedules the configured retry interval');
  assert.ok(scans.length >= 3 && scans.length <= 5, `expected about one scan per ${DEGRADED_MS}ms, got ${scans.length}`);
  for (let i = 1; i < scans.length; i++) assert.ok(scans[i] - scans[i - 1] >= DEGRADED_MS * 0.9, 'no error-handler scan loop');
  assert.equal(attempts.length, scans.length, 'watch installs only at startup and timer scans');
  assert.equal(f.log().split('\n').filter((line) => line.includes('watch error:')).length, 1, 'one warning even when error text changes');
  assert.equal(f.log().split('\n').filter((line) => line.includes(`keep ${bad.split('/').at(-1)} scan:`)).length, 1);
  fs.rmdirSync(badFile);
  writeFixtureFile(badFile, JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await until(() => child.exitCode !== null, t.signal);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
});

test('watch recovery catches settlement between the degraded scan and watch registration', { timeout }, async (t) => {
  const f = fixture(t, DEGRADED_MS), dir = f.job({ state: 'working' }, {}, true);
  const { child, exited } = f.start(`
import fs from 'node:fs';
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch;
let attempts = 0;
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  if (++attempts <= 2) throw Error('synthetic transient watch failure');
  writeFixtureFile(${JSON.stringify(join(dir, 'STATUS.json'))}, JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  return watch(...args);
};
syncBuiltinESMExports();`);
  await until(() => child.exitCode !== null, t.signal);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
});

for (const fault of ['healthy watch', 'transient startup failure', 'transient later error']) {
  test(`${fault}: a working watch does not poll after recovery`, { timeout }, async (t) => {
    const f = fixture(t, DEGRADED_MS), dir = f.job({ state: 'working' }, {}, true);
    const { child, exited, stderr } = f.start(scanProbe + `
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
const watch = fs.watch, timer = globalThis.setTimeout;
let attempts = 0, recovered = false;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (recovered) fs.appendFileSync(process.env.HUD_HOME + '/recovery-timers', ms + '\\n');
  return timer(fn, ms, ...args);
};
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  attempts++;
  if (${fault === 'transient startup failure'} && attempts <= 2) throw Error('synthetic transient startup failure');
  const watcher = watch(...args);
  if (${fault === 'transient later error'} && attempts === 1) {
    setTimeout(() => watcher.emit('error', Error('synthetic transient later error')), 100);
  } else {
    recovered = true;
    // Registration precedes the synchronous catch-up scan and its decision whether to arm another timer.
    setImmediate(() => writeFixtureFile(process.env.HUD_HOME + '/watch-ready', String(attempts)));
  }
  return watcher;
};
syncBuiltinESMExports();`);
    await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'watch-ready')) &&
      fs.existsSync(join(f.home, 'scans'))), 15000);
    assert.equal(child.exitCode, null, stderr());
    const scans = () => fs.readFileSync(join(f.home, 'scans'), 'utf8').trim().split('\n').length;
    const before = scans();
    assert.equal(Number(fs.readFileSync(join(f.home, 'watch-ready'), 'utf8')),
      fault === 'healthy watch' ? 1 : fault === 'transient startup failure' ? 3 : 2);
    assert.equal(fs.existsSync(join(f.home, 'recovery-timers')), false, 'a working watch did not arm a periodic scan');
    assert.equal(scans(), before, 'no periodic scans with a working watch');
    if (fault === 'healthy watch') assert.equal(before, 1, 'exactly the initial catch-up scan');
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await until(() => child.exitCode !== null, 15000);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
  });
}
