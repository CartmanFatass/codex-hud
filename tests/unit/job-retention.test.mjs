import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const hour = 3600000;
const watcher = resolve('packages/hud-mcp/bin/hud-watch.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'job-retention-'));
  const home = join(root, 'hud'), bin = join(root, 'bin'), jobs = join(home, 'jobs');
  const pi = join(root, 'pi'), defaultPi = join(root, 'home', '.pi', 'agent');
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(join(root, 'home'));
  fs.writeFileSync(join(bin, 'pi-role-reap'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.HUD_HOME + '/reaps', process.argv[2] + '\\n');
`, { mode: 0o700 });
  const children = [];
  t.after(async () => {
    for (const { child, exited, stderr } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      assert.equal(stderr(), '');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let next = 0;
  function job(status, receipt = {}, tab = false, name = `j${(++next).toString(16).padStart(16, '0')}`) {
    const dir = join(jobs, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: name, dispatch_exit_code: 0, ...receipt }));
    if (status) fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(status));
    if (tab) fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=synthetic-tab\n');
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report.');
    return dir;
  }
  function start(probe = '', agentDir = pi) {
    const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
    const child = spawn(process.execPath, [...preload, watcher], {
      env: { ...process.env, HOME: join(root, 'home'), HUD_HOME: home, PI_CODING_AGENT_DIR: agentDir,
        HERDR_SOCKET_PATH: join(root, 'absent.sock'), PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    children.push({ child, exited, stderr: () => stderr });
    return { child, exited, stderr: () => stderr };
  }
  return { home, jobs, pi, defaultPi, job, start, log: () => fs.readFileSync(join(home, 'watch.log'), 'utf8') };
}
function realSession(dir, layout = 'sessions', header = { type: 'session', cwd: '/synthetic/work.space/repo' }) {
  const sessions = join(dir, layout);
  fs.mkdirSync(sessions, { recursive: true });
  if (layout.startsWith('.dispatch/')) fs.writeFileSync(join(dir, '.dispatch', 'current.json'), '{}\n');
  const source = join(sessions, 'synthetic-session.jsonl');
  const bytes = Buffer.from(JSON.stringify(header) + '\r\n{"type":"message","text":"合成 session"}\n');
  fs.writeFileSync(source, bytes);
  return { source, bytes };
}
const expired = () => ({ state: 'closed', ended_at: new Date(Date.now() - 25 * hour).toISOString() });
const destination = (pi) => join(pi, 'sessions', '--synthetic-work.space-repo--', 'synthetic-session.jsonl');

for (const layout of ['sessions', '.dispatch/helper/sessions']) {
  test(`retention moves real ${layout} history byte-for-byte before deleting the job`, async (t) => {
    const f = fixture(t), dir = f.job(expired());
    const { bytes } = realSession(dir, layout);
    const { child, exited } = f.start();
    await exited;
    assert.equal(child.exitCode, 0);
    assert.deepEqual(fs.readFileSync(destination(f.pi)), bytes);
    assert.equal(fs.existsSync(dir), false);
  });
}

test('helper receipt beside sonic sessions keeps the watcher alive and preserves expired history', { timeout: 10000 }, async (t) => {
  const f = fixture(t), open = f.job({ state: 'working' }), old = f.job(expired());
  const active = realSession(open, '.dispatch/sonic-1/sessions');
  const settled = realSession(old, '.dispatch/sonic-1/sessions');
  const { child, exited, stderr } = f.start();
  await until(() => child.exitCode !== null || !fs.existsSync(old));
  assert.equal(child.exitCode, null, stderr());
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(fs.readFileSync(destination(f.pi)), settled.bytes);
  assert.deepEqual(fs.readFileSync(active.source), active.bytes, 'active sessions stay in the job');
  fs.writeFileSync(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await exited;
  assert.equal(child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(active.source), active.bytes);
});

for (const odd of ['dispatch file', 'linked helper file', 'unreadable sessions']) {
  test(`an odd ${odd} does not block deletion and reaping of other jobs`, {
    timeout: 10000, skip: odd === 'unreadable sessions' && process.getuid?.() === 0 ? 'root bypasses chmod 000' : false,
  }, async (t) => {
    let unreadable;
    t.after(() => { if (unreadable) fs.chmodSync(unreadable, 0o700); });
    const f = fixture(t), bad = f.job(expired()), old = f.job(expired());
    const tabbed = f.job({ state: 'closed', ended_at: new Date().toISOString() }, {}, true);
    const { source, bytes } = realSession(bad);
    if (odd === 'dispatch file') fs.writeFileSync(join(bad, '.dispatch'), 'Synthetic incomplete helper layout.\n');
    if (odd === 'linked helper file') {
      fs.mkdirSync(join(bad, '.dispatch'));
      fs.symlinkSync(join(bad, 'report.md'), join(bad, '.dispatch', 'linked'));
    }
    if (odd === 'unreadable sessions') {
      unreadable = join(bad, 'sessions');
      fs.chmodSync(unreadable, 0);
    }
    const { child, exited } = f.start();
    await exited;
    if (unreadable) fs.chmodSync(unreadable, 0o700);
    assert.equal(child.exitCode, 0);
    const kept = odd !== 'linked helper file';
    assert.deepEqual(fs.readFileSync(kept ? source : destination(f.pi)), bytes);
    assert.equal(fs.existsSync(bad), kept, 'uncertain session discovery retains the job; linked helpers are ignored');
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), tabbed + '\n');
    assert.ok(JSON.parse(fs.readFileSync(join(tabbed, 'job.json'), 'utf8')).reaped_at);
    const errors = f.log().split('\n').filter((line) => line.includes(`keep ${bad.split('/').at(-1)} `));
    assert.equal(errors.length, kept ? 1 : 0, 'one diagnostic for each bad job in this scan');
    if (kept) assert.match(errors[0], odd === 'dispatch file' ? /ENOTDIR/ : /EACCES/);
  });
}

for (const state of ['closed', 'failed', 'stopped']) {
  test(`expired ${state} job reaps its tab before retention, then keeps a full day after reap`, async (t) => {
    const f = fixture(t), dir = f.job({ ...expired(), state }, {}, true);
    const { source, bytes } = realSession(dir);
    const first = f.start();
    await first.exited;
    assert.equal(first.child.exitCode, 0);
    assert.ok(fs.existsSync(join(dir, 'STATUS.json')));
    assert.equal(fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8'), 'TAB=synthetic-tab\n');
    assert.deepEqual(fs.readFileSync(source), bytes, 'no session move before tab reap');
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
    assert.equal(f.log().includes('delete '), false);
    const reaped = Date.parse(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).reaped_at);
    assert.ok(Math.abs(reaped - Date.now()) < 5000, 'reaped_at records the actual close time');
    const second = f.start(`Date.now = () => ${reaped + 23 * hour};`);
    await second.exited;
    assert.equal(second.child.exitCode, 0);
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.equal(fs.existsSync(destination(f.pi)), false);
    const third = f.start(`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Date.now = () => ${reaped + 25 * hour};
const rm = fs.rmSync;
fs.rmSync = (path, options) => {
  assert.equal(fs.existsSync(${JSON.stringify(source)}), false, 'move sessions before delete');
  assert.deepEqual(fs.readFileSync(${JSON.stringify(destination(f.pi))}), Buffer.from(${JSON.stringify([...bytes])}));
  return rm(path, options);
};
syncBuiltinESMExports();`);
    await third.exited;
    assert.equal(third.child.exitCode, 0);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readFileSync(destination(f.pi)), bytes);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n', 'reap only once');
  });
}

test('retention uses the default pi agent directory when PI_CODING_AGENT_DIR is empty', async (t) => {
  const f = fixture(t), dir = f.job(expired());
  const { bytes } = realSession(dir);
  const { child, exited } = f.start('', '');
  await exited;
  assert.equal(child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(destination(f.defaultPi)), bytes);
  assert.equal(fs.existsSync(dir), false);
});

test('retention deletes session links in both layouts without touching their target', async (t) => {
  const f = fixture(t), dir = f.job(expired());
  const target = join(f.pi, 'synthetic-history.jsonl'), bytes = Buffer.from('Synthetic history.\n');
  fs.mkdirSync(f.pi);
  fs.writeFileSync(target, bytes);
  const before = fs.statSync(target);
  for (const layout of ['sessions', '.dispatch/helper/sessions']) {
    fs.mkdirSync(join(dir, layout), { recursive: true });
    fs.symlinkSync(target, join(dir, layout, 'synthetic-link.jsonl'));
  }
  const { child, exited } = f.start();
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(fs.statSync(target).ino, before.ino);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
});

for (const failure of ['missing cwd', 'relative cwd', 'existing target', 'dangling target', 'rename EXDEV']) {
  test(`retention keeps the whole job and logs once on ${failure}`, async (t) => {
    const f = fixture(t), dir = f.job(expired(), { reaped_at: expired().ended_at }, true);
    const header = failure === 'missing cwd' ? { type: 'session' }
      : { type: 'session', cwd: failure === 'relative cwd' ? 'relative/repo' : '/synthetic/work.space/repo' };
    const { source, bytes } = realSession(dir, '.dispatch/helper/sessions', header);
    const target = destination(f.pi);
    if (failure === 'existing target' || failure === 'dangling target') {
      fs.mkdirSync(join(f.pi, 'sessions', '--synthetic-work.space-repo--'), { recursive: true });
      if (failure === 'existing target') fs.writeFileSync(target, 'Existing synthetic history.\n');
      else fs.symlinkSync(join(f.pi, 'absent.jsonl'), target);
    }
    const probe = failure === 'rename EXDEV' ? `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.renameSync = () => { throw Object.assign(Error('synthetic EXDEV'), { code: 'EXDEV' }); };
syncBuiltinESMExports();` : '';
    const { child, exited } = f.start(probe);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(fs.existsSync(join(dir, 'report.md')), 'the whole job must stay');
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.equal(f.log().split('\n').filter((line) => line.includes(`keep ${dir.split('/').at(-1)} `)).length, 1);
    assert.equal(f.log().includes('delete '), false);
    assert.equal(fs.existsSync(join(f.home, 'reaps')), false);
    if (failure === 'existing target') assert.equal(fs.readFileSync(target, 'utf8'), 'Existing synthetic history.\n');
    if (failure === 'dangling target') assert.equal(fs.readlinkSync(target), join(f.pi, 'absent.jsonl'));
  });
}

for (const layout of ['sessions', '.dispatch/helper/sessions']) {
  for (const count of [1, 2]) {
    test(`watcher removes a ${count}-link loop in ${layout} and still scans expired jobs`, { timeout: 10000 }, async (t) => {
      const f = fixture(t), open = f.job({ state: 'working' }), old = f.job(expired());
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
      fs.writeFileSync(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
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

test('permanent watch failure still scans and exits with no open jobs', { timeout: 10000 }, async (t) => {
  const f = fixture(t), dir = f.job(expired());
  const { child, exited } = f.start(permanentWatchFailure);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.match(f.log(), /watch error: synthetic permanent watch failure/);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('degraded watching polls for new jobs while a failed tab deadline keeps it alive', { timeout: 10000 }, async (t) => {
  const f = fixture(t), failed = f.job({ state: 'failed', ended_at: new Date().toISOString() }, {}, true);
  const { child, exited, stderr } = f.start(permanentWatchFailure + `
const timeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  fs.appendFileSync(process.env.HUD_HOME + '/timers', delay + '\\n');
  return timeout(callback, delay, ...args);
};`);
  await until(() => child.exitCode !== null || fs.existsSync(join(f.home, 'timers')));
  assert.equal(child.exitCode, null, stderr());
  const second = f.job({ state: 'working' }, {}, true);
  fs.writeFileSync(join(second, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  const settled = Date.now();
  await until(() => child.exitCode !== null || JSON.parse(fs.readFileSync(join(second, 'job.json'), 'utf8')).reaped_at);
  assert.equal(child.exitCode, null, 'the first failed deadline is still pending');
  assert.ok(Date.now() - settled <= 4000, 'new job reaped within a few fallback intervals');
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n');
  assert.equal(JSON.parse(fs.readFileSync(join(failed, 'job.json'), 'utf8')).reaped_at, undefined);
  fs.writeFileSync(join(failed, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), second + '\n' + failed + '\n');
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

for (const fault of ['permanent startup failure', 'later error']) {
  test(`watcher polls after ${fault}, handles a newly settled job and exits`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), dir = f.job({ state: 'working' }, {}, true);
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
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(expired()));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(Date.now() - settled <= 5000, 'settlement handled within the fallback interval');
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
    assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).reaped_at);
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
    if (fault === 'permanent startup failure') {
      assert.equal(f.log().split('\n').filter((line) => line.includes('watch error: synthetic permanent')).length, 2,
        'startup and first catch-up retry; final scan exits without retrying');
    }
  });
}

const scanProbe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readdir = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
  if (path === process.env.HUD_HOME + '/jobs' && args.length === 0)
    fs.appendFileSync(process.env.HUD_HOME + '/scans', Date.now() + '\\n');
  return readdir(path, ...args);
};
syncBuiltinESMExports();`;

test('watch recovery catches settlement between the degraded scan and watch registration', { timeout: 10000 }, async (t) => {
  const f = fixture(t), dir = f.job({ state: 'working' }, {}, true);
  const { child, exited } = f.start(`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch;
let attempts = 0;
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  if (++attempts <= 2) throw Error('synthetic transient watch failure');
  fs.writeFileSync(${JSON.stringify(join(dir, 'STATUS.json'))}, JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  return watch(...args);
};
syncBuiltinESMExports();`);
  await until(() => child.exitCode !== null);
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
});

for (const fault of ['healthy watch', 'transient startup failure', 'transient later error']) {
  test(`${fault}: a working watch does not poll after recovery`, { timeout: 10000 }, async (t) => {
    const f = fixture(t), dir = f.job({ state: 'working' }, {}, true);
    const { child, exited, stderr } = f.start(scanProbe + `
const watch = fs.watch;
let attempts = 0;
fs.watch = (...args) => {
  if (!args[1]?.recursive) return watch(...args);
  attempts++;
  if (${fault === 'transient startup failure'} && attempts <= 2) throw Error('synthetic transient startup failure');
  const watcher = watch(...args);
  if (${fault === 'transient later error'} && attempts === 1) {
    setTimeout(() => watcher.emit('error', Error('synthetic transient later error')), 100);
  } else fs.writeFileSync(process.env.HUD_HOME + '/watch-ready', String(attempts));
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
    await new Promise((done) => setTimeout(done, 2200));
    assert.equal(scans(), before, 'no periodic scans with a working watch');
    if (fault === 'healthy watch') assert.equal(before, 1, 'exactly the initial catch-up scan');
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
  });
}

for (const layout of ['sessions', '.dispatch/helper/sessions']) {
  test(`retention skips a symlinked ${layout} folder without moving target files`, async (t) => {
    const f = fixture(t), dir = f.job(expired());
    const outside = join(f.home, 'outside');
    fs.mkdirSync(outside);
    const { source, bytes } = realSession(outside);
    const before = fs.statSync(source);
    const folder = join(dir, layout);
    fs.mkdirSync(resolve(folder, '..'), { recursive: true });
    fs.symlinkSync(join(outside, 'sessions'), folder, 'dir');
    const { child, exited } = f.start();
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.equal(fs.statSync(source).ino, before.ino);
    assert.equal(fs.statSync(source).mtimeMs, before.mtimeMs);
    assert.equal(fs.existsSync(destination(f.pi)), false);
  });
}

test('retention uses pi cwd encoding for colons and backslashes', async (t) => {
  const f = fixture(t), dir = f.job(expired());
  const { bytes } = realSession(dir, 'sessions', { type: 'session', cwd: '/synthetic/work:space/repo\\part' });
  const { child, exited } = f.start();
  await exited;
  assert.equal(child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(join(f.pi, 'sessions', '--synthetic-work-space-repo-part--', 'synthetic-session.jsonl')), bytes);
  assert.equal(fs.existsSync(dir), false);
});

for (const oversized of [false, true]) {
  test(`retention reads only a 1 MiB prefix and ${oversized ? 'keeps a header beyond the bound' : 'moves a large transcript'}`, async (t) => {
    const f = fixture(t), dir = f.job(expired());
    const { source } = realSession(dir, 'sessions', oversized
      ? { type: 'session', padding: 'x'.repeat(1024 * 1024), cwd: '/synthetic/work.space/repo' }
      : { type: 'session', cwd: '/synthetic/work.space/repo' });
    fs.appendFileSync(source, 'x'.repeat(2 * 1024 * 1024));
    const bytes = fs.readFileSync(source);
    const { child, exited } = f.start(`
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
const source = ${JSON.stringify(source)}, readFile = fs.readFileSync, open = fs.openSync, read = fs.readSync;
let sessionFd, total = 0;
fs.readFileSync = (file, ...args) => {
  if (${!oversized}) assert.notEqual(file, source, 'must not read the whole session file');
  return readFile(file, ...args);
};
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args);
  if (file === source) sessionFd = fd;
  return fd;
};
fs.readSync = (fd, buffer, offset, length, position) => {
  if (fd === sessionFd) {
    total += length;
    assert.ok(total <= 1024 * 1024, 'bounded session header read');
    assert.ok(position === null || position === 0, 'read the prefix');
  }
  return read(fd, buffer, offset, length, position);
};
syncBuiltinESMExports();`);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(dir), oversized);
    assert.deepEqual(fs.readFileSync(oversized ? source : destination(f.pi)), bytes);
    if (oversized) assert.match(f.log(), /session preservation:/);
  });
}

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'watcher condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('watcher deletes only terminal job directories older than one day, using end-time precedence', { timeout: 10000 }, async (t) => {
  const f = fixture(t), now = Date.now();
  const ago = (hours) => new Date(now - hours * hour).toISOString();
  const deleted = [
    f.job({ state: 'closed', ended_at: ago(25) }, { reaped_at: ago(25) }, true),
    f.job({ state: 'failed', ended_at: ago(25) }, { reaped_at: ago(25) }, true),
    f.job({ state: 'stopped', ended_at: ago(25) }),
    f.job({ state: 'closed', ended_at: ago(1) }, { reaped_at: ago(25) }, true),
    f.job({ state: 'closed', settled_at: ago(25), ended_at: ago(1) }),
    f.job({ state: 'closed' }),
    f.job({ state: 'failed', ended_at: 'invalid' }),
  ];
  for (const dir of deleted.slice(-2)) fs.utimesSync(join(dir, 'STATUS.json'), (now - 25 * hour) / 1000, (now - 25 * hour) / 1000);
  const kept = [
    f.job({ state: 'closed', ended_at: ago(23) }, {}, true),
    f.job({ state: 'closed', ended_at: ago(25) }, { reaped_at: ago(23) }),
    f.job({ state: 'closed', settled_at: ago(23), ended_at: ago(25) }),
    ...['working', 'idle_grace', 'waiting', 'waiting_answer'].map((state) =>
      f.job({ state, settled_at: ago(100), ended_at: ago(100) }, { reaped_at: ago(100) }, true)),
    f.job(null, { created_at: ago(100) }),
    f.job({ state: 'closed', ended_at: ago(100) }, {}, true, 'not-a-job'),
  ];
  for (const dir of kept) {
    for (const name of fs.readdirSync(dir)) fs.utimesSync(join(dir, name), (now - 100 * hour) / 1000, (now - 100 * hour) / 1000);
    fs.utimesSync(dir, (now - 100 * hour) / 1000, (now - 100 * hour) / 1000);
  }
  const outside = join(f.home, 'synthetic-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: ago(100) }));
  fs.writeFileSync(join(outside, 'SESSION.txt'), 'TAB=synthetic-tab\n');
  const symlink = join(f.jobs, 'jaaaaaaaaaaaaaaaa');
  fs.symlinkSync(outside, symlink, 'dir');
  const { child } = f.start(`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rm = fs.rmSync;
fs.rmSync = (dir, options) => {
  fs.appendFileSync(process.env.HUD_HOME + '/removals', JSON.stringify({ dir, options }) + '\\n');
  return rm(dir, options);
};
syncBuiltinESMExports();`);
  await until(() => deleted.every((dir) => !fs.existsSync(dir)));
  await until(() => fs.existsSync(join(f.home, 'reaps')));
  for (const dir of kept) assert.ok(fs.existsSync(dir), dir);
  assert.ok(fs.lstatSync(symlink).isSymbolicLink());
  assert.ok(fs.existsSync(join(outside, 'STATUS.json')));
  assert.equal(child.exitCode, null, 'active jobs keep the watcher alive');
  const removals = fs.readFileSync(join(f.home, 'removals'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(removals.map((r) => r.dir).sort(), [...deleted].sort());
  assert.ok(removals.every((r) => r.options.recursive === true && r.options.force === true));
  for (const dir of deleted) assert.equal(f.log().split('\n').filter((line) => line.includes(`delete ${dir.split('/').at(-1)} `)).length, 1);
  assert.deepEqual(fs.readFileSync(join(f.home, 'reaps'), 'utf8').trim().split('\n'), [kept[0]],
    'expired tabless/already-reaped jobs delete directly; active, non-job and symlink directories are never reaped');
});

test('watcher exits without expiry timers and deletes tabless and already-reaped jobs on next catch-up', { timeout: 10000 }, async (t) => {
  const f = fixture(t), now = Date.parse('2030-01-02T12:00:00Z');
  const ago = (hours) => new Date(now - hours * hour).toISOString();
  const dirs = [
    f.job({ state: 'closed', settled_at: ago(23) }),
    f.job({ state: 'failed', ended_at: ago(100) }, { reaped_at: ago(23) }, true),
  ];
  for (const elapsed of [0, hour, hour + 1]) {
    const { child, exited } = f.start(`
Date.now = () => ${now + elapsed};
globalThis.setTimeout = () => { throw Error('unexpected expiry timer'); };`);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(dirs.every((dir) => fs.existsSync(dir) === (elapsed <= hour)), 'delete only when strictly over 24 hours');
    assert.equal(fs.existsSync(join(f.home, 'reaps')), false);
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
  }
  assert.equal(f.log().split('\n').filter((line) => line.includes('delete ')).length, 2);
  assert.match(f.log(), /no open jobs or failed deadlines/);
});
