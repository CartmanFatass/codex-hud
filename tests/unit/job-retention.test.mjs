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
  function start(probe = '') {
    const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
    const child = spawn(process.execPath, [...preload, watcher], {
      env: { ...process.env, HOME: join(root, 'home'), HUD_HOME: home,
        HERDR_SOCKET_PATH: join(root, 'absent.sock'), PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    children.push({ child, exited, stderr: () => stderr });
    return { child, exited };
  }
  return { home, jobs, job, start, log: () => fs.readFileSync(join(home, 'watch.log'), 'utf8') };
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
    f.job({ state: 'closed', ended_at: ago(25) }, {}, true),
    f.job({ state: 'failed', ended_at: ago(25) }, {}, true),
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
    'expired jobs delete directly; active, non-job and symlink directories are never reaped');
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
