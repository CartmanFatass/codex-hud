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
import { createWorkSummaryPublisher } from '../../dist/collectors/work-summary-snapshot.js';
import { createPiSegment } from '../../dist/harness/pi/segment.js';
import { writePrivateFile } from '../../dist/utils/atomic-fs.js';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';
import { syntheticProc } from '../fixtures/local-load.mjs';

const pane = 'w4E:p1';
function fixture(t, stop) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-job-snapshot-'));
  if (stop) cleanupFixture(t, { root: home }, stop);
  else t.after(() => fs.rmSync(home, { recursive: true, force: true }));
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

test('passive pi status shows available machine readings and clears on stop', (t) => {
  const { home, job } = fixture(t);
  job(1, 'queued');
  let timer, text;
  const { root, write } = syntheticProc(home);
  write('meminfo', 'MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n');
  const ram = process.platform === 'linux' ? 'M50%' : undefined;
  const segment = createPiSegment({ env: { HUD_HOME: home, HUD_STATUSLINE_PROC_ROOT: root, HUD_ICONS: 'unicode', NO_COLOR: '1' },
    schedule(fn) { timer = fn; return () => {}; } });
  t.after(() => segment.stop());
  const ctx = { mode: 'tui', hasUI: true, ui: { setStatus(_key, value) { text = value; } } };
  segment.start(ctx, () => true);
  assert.equal(text, ram);
  createWorkSummaryPublisher(home, 'hud-mcp').publish();
  timer();
  assert.equal(text, ['◷1', ram].filter(Boolean).join(' │ '));
  segment.stop();
  timer();
  assert.equal(text, undefined);
});

test('a live lifecycle watch relays job deltas without a second recursive watch, then hands back on exit', { timeout: 10_000 }, async (t) => {
  let handle, child, exited;
  const { home, job } = fixture(t, async () => {
    handle?.close();
    if (child) await stopChild(child, exited);
  }), { id, status } = job(1);
  const ready = new EventEmitter();
  handle = fs.watch(home, (_event, file) => {
    if (file === 'jobs-revision.json' && fs.existsSync(join(home, file))) ready.emit('ready');
  });
  child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: { ...process.env, HUD_HOME: home }, stdio: 'ignore',
  });
  exited = once(child, 'exit');
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
