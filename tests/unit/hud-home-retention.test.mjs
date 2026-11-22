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
