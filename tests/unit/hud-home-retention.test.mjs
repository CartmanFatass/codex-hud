import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';

const MiB = 1024 * 1024;
const DAY = 86_400;
const key = (n) => n.toString(16).padStart(64, '0');

const churn = (dir, name, count, size, now) => {
  for (let i = 0; i < count; i++) {
    const file = join(dir, name(i));
    fs.writeFileSync(file, `synthetic ${i}\n`, { mode: 0o600 });
    fs.truncateSync(file, size);
    fs.utimesSync(file, now - DAY + i, now - DAY + i);
  }
  // An old file can still be useful; atime should protect it from both limits.
  fs.utimesSync(join(dir, name(0)), now - 1, now - 60 * DAY);
  // Put this one first by name and last by recency; it must age out.
  fs.utimesSync(join(dir, name(1)), now - 31 * DAY, now - 31 * DAY);
};

test('hud-watch bounds synthetic cache churn, dead snapshots and legacy trust backups', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-home-retention-')));
  cleanupFixture(t, { root });
  const hud = join(root, 'hud');
  const state = join(hud, 'display', 'state');
  const labels = join(hud, 'display', 'model-cache', 'decision-labels');
  const statusline = join(hud, 'display', 'statusline');
  const trust = join(hud, 'backups', 'trust');
  for (const dir of [state, labels, statusline, trust]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Math.floor(Date.now() / 1000);
  const labelName = (i) => `${key(i)}.json`;
  const statusName = (i) => `transcript-${key(i)}.json`;
  churn(labels, labelName, 560, 4096, now);
  churn(statusline, statusName, 560, 64 * 1024 - 16, now);
  const expiredStatus = join(statusline, statusName(1));
  fs.truncateSync(expiredStatus, 16); // Fits the remaining byte budget; only age evicts it.
  fs.utimesSync(expiredStatus, now - 31 * DAY, now - 31 * DAY);
  const oldAggregate = join(labels, 'cache.json');
  fs.writeFileSync(oldAggregate, '{}');
  fs.utimesSync(oldAggregate, now - 31 * DAY, now - 31 * DAY);

  const unrelated = join(root, 'unrelated.json');
  const symlink = join(statusline, statusName(600));
  fs.writeFileSync(unrelated, 'keep');
  fs.symlinkSync(unrelated, symlink);
  const liveState = `pid-${process.pid}.json`;
  for (const name of [liveState, 'tmux-session.json', 'claude-quota.json']) {
    fs.writeFileSync(join(state, name), '{}');
    fs.utimesSync(join(state, name), now - 60 * DAY, now - 60 * DAY);
  }
  for (let i = 0; i < 61; i++) {
    const pid = 0x7fffffff - i;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    fs.writeFileSync(join(state, `pid-${pid}.json`), '{}');
  }

  // Published group counts and aggregate size, with equal-sized distinct synthetic payloads.
  const bytesPerBackup = Math.round(34 * MiB / 565);
  const groups = [
    ['agy', 'settings.json', 226],
    ['claude', '.claude.json', 174],
    ['grok', 'trusted_folders.toml', 165],
  ];
  const expected = [];
  for (const [agent, base, count] of groups) {
    for (let i = 0; i < count; i++) {
      const stamp = `20260101T000000${String(i).padStart(3, '0')}Z`;
      const name = `${agent}-${stamp}${i === count - 1 ? '-123' : ''}-${base}`;
      const file = join(trust, name);
      fs.writeFileSync(file, `${agent} synthetic revision ${i}\n`, { mode: 0o600 });
      fs.truncateSync(file, bytesPerBackup);
      if (i >= count - 20) expected.push(name);
    }
  }
  const newBackup = `claude-${key(1)}-0000000000000001-.claude.json`;
  fs.writeFileSync(join(trust, newBackup), 'new format', { mode: 0o600 });
  const env = { ...process.env, HOME: root, HUD_HOME: hud, HERDR_SOCKET_PATH: join(root, 'absent.sock') };
  const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));

  for (const [dir, name, count] of [[labels, labelName, 512], [statusline, statusName, 128]]) {
    const files = fs.readdirSync(dir).filter((file) => fs.lstatSync(join(dir, file)).isFile());
    assert.equal(files.length, count);
    assert.ok(files.includes(name(0)), 'recent reads protect a cache entry');
    assert.ok(files.includes(name(559)), 'recent writes protect a cache entry');
    assert.ok(!files.includes(name(1)), 'expired cache entry evicted');
    assert.ok(!files.includes(name(2)), 'least recent cache entry evicted');
    assert.ok(files.reduce((sum, file) => sum + fs.statSync(join(dir, file)).size, 0) <= 8 * MiB);
  }
  assert.ok(!fs.existsSync(oldAggregate));
  assert.equal(fs.readlinkSync(symlink), unrelated);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(state).sort(), ['claude-quota.json', liveState, 'tmux-session.json'].sort());
  assert.deepEqual(fs.readdirSync(trust).sort(), [...expected, newBackup].sort());
  assert.match(fs.readFileSync(join(hud, 'watch.log'), 'utf8'), /pruned legacy trust backups: 505\n/);
  t.diagnostic(`synthetic legacy trust archives freed ${(505 * bytesPerBackup / MiB).toFixed(2)} MiB`);
});

test('hud-watch expires old land receipts and artifacts, not live or recent flow families', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-flow-retention-')));
  cleanupFixture(t, { root });
  const hud = join(root, 'hud'), flows = join(hud, 'flows');
  fs.mkdirSync(flows, { recursive: true });
  const now = Date.now() / 1000;
  const put = (name, body = '', age = DAY + 60) => {
    const path = join(flows, name);
    fs.writeFileSync(path, body);
    fs.utimesSync(path, now - age, now - age);
  };
  for (const state of ['failed', 'completed']) put(`f0000000000000001${state === 'failed' ? '' : '-2'}.json`, JSON.stringify({ state }));
  for (const suffix of ['cancel', 'noticed', 'observed', 'gate-1.log', 'gate-1-rerun.log']) put(`f0000000000000001-2.json.${suffix}`);
  put('f0000000000000002.json.observed'); // A sidecar left behind without its receipt.
  put('f0000000000000003.json', '{"state":"failed"}');
  put('f0000000000000003-2.json', '{"state":"completed"}', DAY - 60);
  put('f0000000000000004.json', '{"state":"running"}');
  put('f0000000000000005.json', '{"state":"cancelled"}');
  fs.mkdirSync(join(hud, 'jobs', 'j0000000000000005'), { recursive: true });
  put('keep.json', '{"state":"completed"}');
  fs.symlinkSync(join(flows, 'keep.json'), join(flows, 'f0000000000000006.json'));

  const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: { ...process.env, HOME: root, HUD_HOME: hud, HERDR_SOCKET_PATH: join(root, 'absent.sock') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  assert.deepEqual(fs.readdirSync(flows).sort(), [
    'f0000000000000003-2.json', 'f0000000000000003.json', 'f0000000000000004.json', 'f0000000000000005.json',
    'f0000000000000006.json', 'keep.json',
  ]);
});

test('hud-watch keeps expired land flows with pending flake collection and prunes them once done or resolved', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-flake-retention-')));
  cleanupFixture(t, { root });
  const hud = join(root, 'hud'), flows = join(hud, 'flows'), repo = join(root, 'repo');
  const issues = join(repo, '.scratch', 'test-flakes', 'issues');
  fs.mkdirSync(flows, { recursive: true });
  fs.mkdirSync(join(repo, '.hud'), { recursive: true });
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(join(repo, '.hud', 'project.json'), JSON.stringify({ flakes: { feature: 'test-flakes' } }));

  const writeTicket = (num, status) => {
    const file = join(issues, `${num}-gate-flakes-running-list.md`);
    fs.writeFileSync(file, [
      `# ${num}: Gate flakes running list`, '', `**Status:** ${status}`, '**Owner try:** no', '**Live try:** none', '**Blocked by:** none',
      '', '**What to build:** Running list.', '', '### Cases', '',
      '- `case` (sample/a.test.mjs) — flow `f0000000000000000`', '', '- [ ] Pass', '', '## Comments', '',
    ].join('\n'));
    return file;
  };
  const ticket01 = writeTicket('01', 'ready-for-agent');
  const ticket02 = writeTicket('02', 'ready-for-agent');
  const ticket03 = writeTicket('03', 'ready-for-agent');
  writeTicket('04', 'ready-for-agent');

  const now = Date.now() / 1000;
  const put = (name, body = '', age = DAY + 60) => {
    const path = join(flows, name);
    fs.writeFileSync(path, body);
    fs.utimesSync(path, now - age, now - age);
    return path;
  };
  const seedFlow = (id, flakeCollection) => {
    const logPath = put(`${id}.json.gate-1.log`, 'synthetic gate failure excerpt\n');
    put(`${id}.json`, JSON.stringify({
      flow: id,
      job: `j${id.slice(1)}`,
      state: 'completed',
      wt: { main_root: repo, root: join(root, 'wt'), base_head: 'abc', branch: 'wt/a' },
      reruns: [{ step: 'gate[1]', tests: ['case'], output_path: logPath, rerun_ok: true }],
      flake_collection: flakeCollection,
    }));
  };

  // Pending edit, pending dispatches (to be resolved via done / claimed / wontfix / claiming job), and already-done flow.
  seedFlow('f0000000000000010', { state: 'pending', stage: 'edit', error: 'hand edit', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });
  seedFlow('f0000000000000011', { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/01', error: 'waiting', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });
  seedFlow('f0000000000000012', { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/02', error: 'waiting', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });
  seedFlow('f0000000000000013', { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/03', error: 'waiting', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });
  seedFlow('f0000000000000014', { state: 'pending', stage: 'dispatch', ticket: 'test-flakes/04', error: 'waiting', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });
  seedFlow('f0000000000000015', { state: 'done', ticket: 'test-flakes/01', attempts: 1, updated_at: '2026-01-01T00:00:00Z' });

  const runWatch = () => {
    const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
      env: { ...process.env, HOME: root, HUD_HOME: hud, HERDR_SOCKET_PATH: join(root, 'absent.sock') },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  };

  runWatch();
  assert.deepEqual(fs.readdirSync(flows).sort(), [
    'f0000000000000010.json', 'f0000000000000010.json.gate-1.log',
    'f0000000000000011.json', 'f0000000000000011.json.gate-1.log',
    'f0000000000000012.json', 'f0000000000000012.json.gate-1.log',
    'f0000000000000013.json', 'f0000000000000013.json.gate-1.log',
    'f0000000000000014.json', 'f0000000000000014.json.gate-1.log',
  ], 'pending families and their gate logs stay; expired done family is pruned');

  // Independently resolve 01 (done), 02 (claimed), 03 (wontfix), and claim 04 via a live job.
  fs.writeFileSync(ticket01, fs.readFileSync(ticket01, 'utf8').replace('ready-for-agent', 'done'));
  fs.writeFileSync(ticket02, fs.readFileSync(ticket02, 'utf8').replace('ready-for-agent', 'claimed'));
  fs.writeFileSync(ticket03, fs.readFileSync(ticket03, 'utf8').replace('ready-for-agent', 'wontfix'));
  const claimJobDir = join(hud, 'jobs', 'j0000000000000099');
  fs.mkdirSync(claimJobDir, { recursive: true });
  fs.writeFileSync(join(claimJobDir, 'job.json'), JSON.stringify({
    job: 'j0000000000000099', cwd: repo, project_root: repo, role: 'imp', ticket: 'test-flakes/04',
    created_at: new Date().toISOString(), dispatch_exit_code: 0,
  }));
  fs.writeFileSync(join(claimJobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));

  runWatch();
  assert.deepEqual(fs.readdirSync(flows).sort(), [
    'f0000000000000010.json', 'f0000000000000010.json.gate-1.log',
  ], 'resolved dispatch families are pruned; pending edit family stays');

  // Mark pending edit flow done and age past cutoff -> pruned on next run.
  seedFlow('f0000000000000010', { state: 'done', ticket: 'test-flakes/05', attempts: 2, updated_at: '2026-01-01T00:00:00Z' });
  runWatch();
  assert.deepEqual(fs.readdirSync(flows), []);
});
