import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { fixture, realSession, expired, destination, hour, until } from '../helpers/job-retention-fixture.mjs';

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
  writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
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
    assert.equal(errors.length, kept ? 2 : 0, 'housekeeping and preservation each report their failure');
    if (kept) assert.match(errors[0], odd === 'dispatch file' ? /ENOTDIR/ : /EACCES/);
  });
}

for (const fault of ['unreadable sessions', 'dispatch file']) {
  test(`working tabbed job with ${fault} stays open through housekeeping errors and is reaped`, {
    timeout: 10000, skip: fault === 'unreadable sessions' && process.getuid?.() === 0 ? 'root bypasses chmod 000' : false,
  }, async (t) => {
    let unreadable;
    t.after(() => { if (unreadable) fs.chmodSync(unreadable, 0o700); });
    const f = fixture(t), first = f.job({ state: 'working' }, {}, true);
    const second = fault === 'unreadable sessions' ? f.job({ state: 'working' }, {}, true) : null;
    if (second) {
      unreadable = join(first, 'sessions');
      fs.mkdirSync(unreadable);
      fs.chmodSync(unreadable, 0);
    } else fs.writeFileSync(join(first, '.dispatch'), 'Synthetic incomplete dispatch.\n');
    const { child, exited } = f.start();
    await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'watch.log')) && f.log().includes('keep ')));
    assert.equal(child.exitCode, null, 'housekeeping does not erase the only open job');
    if (second) {
      writeFixtureFile(join(second, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
      await until(() => child.exitCode !== null || JSON.parse(fs.readFileSync(join(second, 'job.json'), 'utf8')).reaped_at);
      assert.ok(JSON.parse(fs.readFileSync(join(second, 'job.json'), 'utf8')).reaped_at, 'the second tab is reaped');
    }
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(child.exitCode, null, 'the first job still keeps the watcher alive after the second settles');
    if (unreadable) fs.chmodSync(unreadable, 0o700);
    writeFixtureFile(join(first, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), (second ? second + '\n' : '') + first + '\n');
    assert.ok(JSON.parse(fs.readFileSync(join(first, 'job.json'), 'utf8')).reaped_at);
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
  });
}

test('an expired terminal job with unreadable sessions is kept but does not keep the watcher alive', {
  timeout: 10000, skip: process.getuid?.() === 0 ? 'root bypasses chmod 000' : false,
}, async (t) => {
  let unreadable;
  t.after(() => { if (unreadable) fs.chmodSync(unreadable, 0o700); });
  const f = fixture(t), dir = f.job(expired());
  const { source, bytes } = realSession(dir);
  unreadable = join(dir, 'sessions');
  fs.chmodSync(unreadable, 0);
  const { child, exited } = f.start();
  await until(() => child.exitCode !== null);
  await exited;
  fs.chmodSync(unreadable, 0o700);
  assert.equal(child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.match(f.log(), /session preservation: .*EACCES/);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

for (const file of ['job.json', 'STATUS.json', 'SESSION.txt']) {
  test(`an unreadable ${file} counts as possibly open until it can be read`, {
    timeout: 10000, skip: process.getuid?.() === 0 ? 'root bypasses chmod 000' : false,
  }, async (t) => {
    let unreadable;
    t.after(() => { if (unreadable) fs.chmodSync(unreadable, 0o600); });
    const f = fixture(t), dir = f.job({ state: 'working' }, {}, true);
    unreadable = join(dir, file);
    fs.chmodSync(unreadable, 0);
    const { child, exited, stderr } = f.start();
    await until(() => child.exitCode !== null || (fs.existsSync(join(f.home, 'watch.log')) && f.log().includes('keep ')));
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(child.exitCode, null, 'uncertain lifecycle evidence must not mean nothing open');
    fs.chmodSync(unreadable, 0o600);
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await until(() => child.exitCode !== null);
    await exited;
    assert.equal(child.exitCode, 0, stderr());
    assert.equal(fs.readFileSync(join(f.home, 'reaps'), 'utf8'), dir + '\n');
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

test('a dead CLI supervisor hands its job to the orchestrator on the next scan; a live one and a pi job do not', { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const ended = spawn(process.execPath, ['-e', '']);
  await once(ended, 'exit');
  const dead = f.job({ state: 'working', harness: 'cli' }, { cli: { agent: 'grok' } });
  fs.writeFileSync(join(dead, 'supervisor.pid'), `${ended.pid}\n`);
  const liveChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);
  t.after(() => liveChild.kill());
  const live = f.job({ state: 'working', harness: 'cli' }, { cli: { agent: 'grok' } });
  fs.writeFileSync(join(live, 'supervisor.pid'), `${liveChild.pid}\n`);
  const pi = f.job({ state: 'working' });
  fs.writeFileSync(join(pi, 'supervisor.pid'), `${ended.pid}\n`);
  f.start();
  // No worker pid is known, so its liveness is unknown: the job waits for the orchestrator instead of failing (SUPERVISOR 08).
  await until(() => /^supervisor exited/.test(JSON.parse(fs.readFileSync(join(dead, 'STATUS.json'), 'utf8')).reason ?? ''));
  assert.equal(JSON.parse(fs.readFileSync(join(dead, 'STATUS.json'), 'utf8')).state, 'waiting_orchestrator');
  assert.equal(JSON.parse(fs.readFileSync(join(live, 'STATUS.json'), 'utf8')).state, 'working');
  assert.equal(JSON.parse(fs.readFileSync(join(pi, 'STATUS.json'), 'utf8')).state, 'working');
  liveChild.kill();
  await once(liveChild, 'exit');
  await until(() => JSON.parse(fs.readFileSync(join(live, 'STATUS.json'), 'utf8')).state === 'waiting_orchestrator');
  assert.equal(JSON.parse(fs.readFileSync(join(pi, 'STATUS.json'), 'utf8')).state, 'working');
});

test('retention deletes CLI and Jev jobs without moving their session files into pi', async (t) => {
  const f = fixture(t);
  const cli = f.job(expired(), { cli: { agent: 'grok' } });
  const jev = f.job(expired(), { bro: { harness: 'bro' } });
  realSession(cli);
  realSession(jev);
  const { child, exited } = f.start();
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(cli), false);
  assert.equal(fs.existsSync(jev), false);
  assert.equal(fs.existsSync(destination(f.pi)), false);
});

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
  writeFixtureFile(join(outside, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: ago(100) }));
  writeFixtureFile(join(outside, 'SESSION.txt'), 'TAB=synthetic-tab\n');
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
  // appendFileSync creates the file before writing, so wait for the complete line, not just the file.
  await until(() => fs.existsSync(join(f.home, 'reaps')) && fs.readFileSync(join(f.home, 'reaps'), 'utf8').endsWith('\n'));
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
