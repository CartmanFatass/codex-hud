import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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
        !fs.lstatSync(link, { throwIfNoEntry: false }))));
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

for (const kind of ['session preservation', 'reap']) {
  test(`permanently failing ${kind} warns once per minute per job, not per scan`, { timeout }, async (t) => {
    const f = fixture(t, DEGRADED_MS), open = f.job({ state: 'working' });
    const bad = [f.job(expired(), {}, kind === 'reap'), f.job(expired(), {}, kind === 'reap')];
    if (kind === 'session preservation') {
      for (const dir of bad) realSession(dir, 'sessions', { type: 'session' });
    } else {
      fs.appendFileSync(join(f.home, '..', 'bin', 'pi-role-reap'), `
if (fs.existsSync(process.env.HUD_HOME + '/reap-ownership-lost')) {
  console.error('pi-role-reap: ' + process.argv[2] + ': TAB synthetic-tab name changed or missing; not closing');
}
process.exitCode = 1;
`);
    }
    // The watcher reads this file as its clock; write it atomically so a read never sees it empty.
    const clock = join(f.home, 'clock'), now = Date.now();
    const setClock = (ms) => writeFixtureFile(clock, String(ms));
    setClock(now);
    const completed = join(f.home, 'completed-reaps');
    // A scan can now finish before its reaps. Advance the fake clock only after the watcher has handled their results.
    const reapProbe = kind === 'reap' ? `
import childProcess from 'node:child_process';
const spawn = childProcess.spawn;
childProcess.spawn = (bin, ...args) => {
  const child = spawn(bin, ...args);
  if (bin === 'pi-role-reap') child.once('close', () => setImmediate(() =>
    fs.appendFileSync(${JSON.stringify(completed)}, args[0][0] + '\\n')));
  return child;
};` : '';
    const { child, exited } = f.start(scanProbe + reapProbe + `
fs.watch = () => { throw Error('synthetic permanent watch failure'); };
syncBuiltinESMExports();
Date.now = () => Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
    const warnings = (dir) => f.log().split('\n').filter((line) => line.includes(
      kind === 'reap' ? `reap ${dir.split('/').at(-1)} ` : `keep ${dir.split('/').at(-1)} session preservation:`));
    const scans = () => fs.readFileSync(join(f.home, 'scans'), 'utf8').trim().split('\n').length;
    await until(() => fs.existsSync(join(f.home, 'scans')) && bad.every((dir) => warnings(dir).length >= 1));
    await until(() => scans() >= 4); // Three finished scans, even under scheduler load.
    assert.equal(child.exitCode, null, 'working job keeps degraded scans running');
    for (const dir of bad) assert.equal(warnings(dir).length, 1, 'repeated failures within a minute are suppressed');
    setClock(now + 59999);
    const before = scans();
    await until(() => scans() >= before + 2);
    if (kind === 'reap') await until(() => fs.existsSync(completed) &&
      fs.readFileSync(completed, 'utf8').trim().split('\n').length >= 4);
    for (const dir of bad) assert.equal(warnings(dir).length, 1, 'still suppressed just before one minute');
    // A terminal reap is retried on the slow timer, not at every intervening scan.
    setClock(now + (kind === 'reap' ? 60999 : 60000));
    await until(() => bad.every((dir) => warnings(dir).length >= 2));
    for (const dir of bad) assert.equal(warnings(dir).length, 2, 'each job warns again after one minute');
    writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    if (kind === 'reap') {
      assert.ok(fs.readFileSync(join(f.home, 'reaps'), 'utf8').trim().split('\n').length >= 6, 'reap keeps retrying despite throttled logs');
      const beforeClose = scans();
      await until(() => scans() >= beforeClose + 2); // The degraded scan has observed the last job closing.
      assert.equal(child.exitCode, null, 'pending cleanup keeps the watcher alive without a working job');
      writeFixtureFile(join(f.home, 'reap-ownership-lost'), '');
      setClock(now + 61999);
    }
    await exited;
    if (kind === 'reap') for (const dir of bad)
      assert.equal(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).reaped_at, undefined);
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
  });
}

test('degraded watching polls for new jobs while a failed tab deadline keeps it alive', { timeout }, async (t) => {
  const f = fixture(t), failed = f.job({ state: 'failed', ended_at: new Date().toISOString() }, {}, true);
  const { child, exited, stderr } = f.start(permanentWatchFailure + `
const timeout = globalThis.setTimeout, now = Date.now, startup = now();
Date.now = () => startup;
globalThis.setTimeout = (callback, delay, ...args) => {
  Date.now = now;
  fs.appendFileSync(process.env.HUD_HOME + '/timers', delay + '\\n');
  return timeout(callback, delay, ...args);
};`);
  await until(() => child.exitCode !== null || fs.existsSync(join(f.home, 'timers')));
  assert.equal(child.exitCode, null, stderr());
  assert.equal(fs.readFileSync(join(f.home, 'timers'), 'utf8').split('\n')[0], '1000', 'unconfigured degraded interval');
  const second = f.job({ state: 'working' }, {}, true);
  writeFixtureFile(join(second, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const settled = Date.now();
  await until(() => child.exitCode !== null || JSON.parse(fs.readFileSync(join(second, 'job.json'), 'utf8')).reaped_at);
  assert.equal(child.exitCode, null, 'the first failed deadline is still pending');
  assert.ok(Date.now() - settled <= 4000, 'new job reaped within a few fallback intervals');
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n');
  assert.equal(JSON.parse(fs.readFileSync(join(failed, 'job.json'), 'utf8')).reaped_at, undefined);
  writeFixtureFile(join(failed, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n' + failed + '\n');
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

for (const fault of ['permanent startup failure', 'later error']) {
  test(`watcher polls after ${fault}, handles a newly settled job and exits`, { timeout }, async (t) => {
    const f = fixture(t, DEGRADED_MS), dir = f.job({ state: 'working' }, {}, true);
    const probe = fault === 'permanent startup failure' ? permanentWatchFailure : `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch;
fs.watch = (...args) => {
  const watcher = watch(...args);
  if (args[1]?.recursive) setTimeout(() => watcher.emit('error', Error('synthetic later watch error')), 100);
  return watcher;
};
syncBuiltinESMExports();`;
    const { child, exited, stderr } = f.start(probe);
    await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'watch.log')) &&
      f.log().includes(fault === 'later error' ? 'synthetic later watch error' : 'using file events only')));
    assert.equal(child.exitCode, null, f.log() + stderr());
    const settled = Date.now();
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(expired()));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(Date.now() - settled <= 800, 'settlement handled within the scaled fallback interval and reap overhead');
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

test('persistent asynchronous watch errors stay at one scan per second and throttle diagnostics', { timeout }, async (t) => {
  const f = fixture(t, DEGRADED_MS), bad = f.job({ state: 'working' }), dir = f.job({ state: 'working' }, {}, true);
  const badFile = join(bad, 'STATUS.json');
  fs.unlinkSync(badFile);
  fs.mkdirSync(badFile);
  const { child, exited } = f.start(scanProbe + `
import { EventEmitter } from 'node:events';
let attempts = 0;
fs.watch = () => {
  fs.appendFileSync(process.env.HUD_HOME + '/attempts', Date.now() + '\\n');
  const watcher = new EventEmitter();
  watcher.close = () => {};
  process.nextTick(() => watcher.emit('error', Error('synthetic async watch failure ' + (++attempts))));
  return watcher;
};
syncBuiltinESMExports();`);
  await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'scans')) && f.log().includes('watch error:')));
  assert.equal(child.exitCode, null);
  await new Promise((done) => setTimeout(done, 400));
  const stamps = (name) => fs.readFileSync(join(f.home, name), 'utf8').trim().split('\n').map(Number);
  const scans = stamps('scans'), attempts = stamps('attempts');
  assert.ok(scans.length >= 3 && scans.length <= 5, `expected about one scan per ${DEGRADED_MS}ms, got ${scans.length}`);
  for (let i = 1; i < scans.length; i++) assert.ok(scans[i] - scans[i - 1] >= DEGRADED_MS * 0.9, 'no error-handler scan loop');
  assert.equal(attempts.length, scans.length, 'watch installs only at startup and timer scans');
  assert.equal(f.log().split('\n').filter((line) => line.includes('watch error:')).length, 1, 'one warning even when error text changes');
  assert.equal(f.log().split('\n').filter((line) => line.includes(`keep ${bad.split('/').at(-1)} scan:`)).length, 1);
  fs.rmdirSync(badFile);
  writeFixtureFile(badFile, JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await until(() => child.exitCode !== null);
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
  await until(() => child.exitCode !== null);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
});

for (const fault of ['healthy watch', 'transient startup failure', 'transient later error']) {
  test(`${fault}: a working watch does not poll after recovery`, { timeout }, async (t) => {
    const f = fixture(t, DEGRADED_MS), dir = f.job({ state: 'working' }, {}, true);
    const { child, exited, stderr } = f.start(scanProbe + `
import { writeFixtureFile } from ${JSON.stringify(atomicWriter)};
const watch = fs.watch;
let attempts = 0;
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  attempts++;
  if (${fault === 'transient startup failure'} && attempts <= 2) throw Error('synthetic transient startup failure');
  const watcher = watch(...args);
  if (${fault === 'transient later error'} && attempts === 1) {
    setTimeout(() => watcher.emit('error', Error('synthetic transient later error')), 100);
  } else writeFixtureFile(process.env.HUD_HOME + '/watch-ready', String(attempts));
  return watcher;
};
syncBuiltinESMExports();`);
    await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'watch-ready')) &&
      fs.existsSync(join(f.home, 'scans'))));
    assert.equal(child.exitCode, null, stderr());
    const scans = () => fs.readFileSync(join(f.home, 'scans'), 'utf8').trim().split('\n').length;
    const before = scans();
    assert.equal(Number(fs.readFileSync(join(f.home, 'watch-ready'), 'utf8')),
      fault === 'healthy watch' ? 1 : fault === 'transient startup failure' ? 3 : 2);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(scans(), before, 'no periodic scans with a working watch');
    if (fault === 'healthy watch') assert.equal(before, 1, 'exactly the initial catch-up scan');
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
  });
}
