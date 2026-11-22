import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { JobSnapshotIndex } from '../../dist/collectors/job-snapshot-index.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { watchJobChanges } from '../../dist/collectors/job-changes.js';
import { createPiSegment } from '../../dist/harness/pi/segment.js';
import { writePrivateFile } from '../../dist/utils/atomic-fs.js';

const pane = 'w4E:p1';
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-job-snapshot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  function job(n, state = 'working') {
    const id = 'j' + n.toString(16).padStart(16, '0');
    const dir = join(home, 'jobs', id), created_at = new Date().toISOString();
    const status = (value) => writePrivateFile(join(dir, 'STATUS.json'), JSON.stringify(value));
    writePrivateFile(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', herdr_pane: pane, created_at }));
    status({ state, agent: 'codex', agent_session_id: `synthetic-${n}` });
    return { id, dir, status };
  }
  return { home, job };
}

test('warm snapshots patch directory order and worker-session IDs by changed job, not a full enumeration', (t) => {
  const { home, job } = fixture(t);
  const jobs = Array.from({ length: 12 }, (_, i) => job(i));
  const index = new JobSnapshotIndex(home);
  assert.equal(index.directoryInventory().totalValid, jobs.length);
  assert.equal(index.codexWorkerSessions().length, jobs.length);
  const updated = jobs[0], deleted = jobs.at(-1);
  updated.status({ state: 'closed', agent: 'codex', agent_session_id: 'synthetic-new' });
  fs.rmSync(deleted.dir, { recursive: true });
  index.invalidate([updated.id, deleted.id]);
  const stats = [];
  const original = fs.lstatSync;
  fs.lstatSync = (file, ...args) => { stats.push(file); return original(file, ...args); };
  syncBuiltinESMExports();
  try {
    const dirs = index.directoryInventory();
    assert.equal(dirs.totalValid, jobs.length - 1);
    assert.equal(dirs.dirs[0].id, updated.id);
    const sessions = index.codexWorkerSessions();
    assert.ok(sessions.includes('synthetic-new'), 'closed workers still exclude their rollout');
    assert.ok(!sessions.includes('synthetic-0') && !sessions.includes('synthetic-11'));
    assert.strictEqual(index.directoryInventory(), dirs);
    assert.deepEqual(stats, [updated.dir, deleted.dir, join(updated.dir, 'STATUS.json'), join(deleted.dir, 'STATUS.json')]);
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
});

test('equivalent fact snapshots keep the published thin-jobs inode', (t) => {
  const { home, job } = fixture(t);
  job(1); job(2);
  const scope = { project: null, pane }, file = join(home, 'display', 'thin-jobs.json');
  readThinJobs(home, scope);
  const initial = fs.statSync(file, { bigint: true });
  readThinJobs(home, scope, undefined, { openedAt: 0 });
  const same = fs.statSync(file, { bigint: true });
  assert.equal(same.ino, initial.ino);
  assert.equal(same.mtimeNs, initial.mtimeNs);
});

test('pi footer fills asynchronously, follows local question and answer changes, and fences a stopped read', { timeout: 10_000 }, async (t) => {
  const { home, job } = fixture(t), { dir } = job(1);
  const statuses = new EventEmitter();
  let timer, text;
  const segment = createPiSegment({ env: { HUD_HOME: home, HERDR_PANE_ID: pane }, schedule(fn) { timer = fn; return () => {}; } });
  t.after(() => segment.stop());
  const ctx = { mode: 'tui', hasUI: true, ui: { setStatus(_key, value) { text = value; statuses.emit('status', value); } } };
  const initial = once(statuses, 'status');
  segment.start(ctx, 'pi-synthetic/synthetic', () => true);
  assert.deepEqual(await initial, [undefined], 'start publishes before any worker scan finishes');
  assert.deepEqual(await once(statuses, 'status'), ['Work: 1 running']);
  const awaitChange = async (expected) => {
    const next = once(statuses, 'status');
    // Use the independent five-second refresh port without a wall-clock wait.
    await new Promise((done) => setTimeout(done, 50));
    timer();
    assert.deepEqual(await next, [expected]);
  };
  writePrivateFile(join(dir, 'qa', 'q1.md'), '# Question\n\nSynthetic choice?');
  await awaitChange('Work: 1 needs you');
  writePrivateFile(join(dir, 'qa', 'q1.answer.md'), 'Synthetic answer');
  await awaitChange('Work: 1 running');
  timer();
  segment.stop();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(text, undefined);
});

test('a live lifecycle watch relays job deltas without a second recursive watch, then hands back on exit', { timeout: 10_000 }, async (t) => {
  const { home, job } = fixture(t), { id, status } = job(1);
  const ready = new EventEmitter();
  const handle = fs.watch(home, (_event, file) => {
    if (file === 'jobs-revision.json' && fs.existsSync(join(home, file))) ready.emit('ready');
  });
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: { ...process.env, HUD_HOME: home }, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  t.after(async () => { handle.close(); child.kill(); await exited; });
  await once(ready, 'ready');
  handle.close();
  assert.equal(fs.statSync(join(home, 'jobs-revision.json')).mode & 0o777, 0o600);

  const notifications = new EventEmitter();
  let recursiveWatches = 0;
  const original = fs.watch;
  fs.watch = (file, ...args) => {
    if (String(file) === join(home, 'jobs') && args[0]?.recursive) recursiveWatches++;
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  const source = watchJobChanges(home, (notice, ids) => notifications.emit('notice', notice, ids));
  try {
    source.attach();
    assert.equal(recursiveWatches, 0);
    const changed = once(notifications, 'notice');
    status({ state: 'working', blocked: true });
    assert.deepEqual(await changed, [true, [id]]);
    const handback = once(notifications, 'notice');
    child.kill();
    assert.deepEqual(await handback, [true, null]);
    assert.equal(recursiveWatches, 1);
  } finally { source.close(); fs.watch = original; syncBuiltinESMExports(); }
});
