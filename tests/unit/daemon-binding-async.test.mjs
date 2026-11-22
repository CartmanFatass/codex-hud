/**
 * Off-event-loop checks for DaemonBinding (async tmux + worker-thread SQLite)
 * and statusline-parity git (async subprocesses + 2 s cache). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  DaemonBinding,
  disposeDaemonWorker,
  latestThread,
  resolveDaemonThread,
  sqliteDatabase,
  tuiPidForPane,
} from '../../dist/collectors/daemon-binding.js';
import { collectParityGit } from '../../dist/statusline-parity/git.js';

const Db = sqliteDatabase();
const skipSqlite = Db ? false : 'node:sqlite is unavailable';

const DAEMON = 'pid:196900:e8b48fb4-7b94-413c-b703-83abe9025aba';
const FRESH = '01a10a47-b559-7ba2-a18c-ec3c852cd73c';
const RESUMED = '01a0ef2b-a391-7693-a748-60e24be246ae';
const OTHER = '01a109fa-0000-7000-8000-000000000003';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
  CREATE INDEX idx_logs_thread_id ON logs(thread_id);
  CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
  CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;
`;

const tuiStart = (pid, ts, nanos = 0) => ({
  ts,
  nanos,
  level: 'DEBUG',
  target: 'codex_tui::app::startup',
  body: 'connected app-server',
  thread: null,
  uuid: `pid:${pid}:synthetic`,
});

const started = (connection, thread, ts, nanos = 500_000_000) => ({
  ts,
  nanos,
  level: 'INFO',
  target: 'codex_core::shell_snapshot',
  thread,
  uuid: DAEMON,
  body: `app_server.request{rpc.method="thread/start" app_server.connection_id=${connection} app_server.client_name="codex-tui"}: shell snapshot`,
});

const resumed = (connection, thread, ts, nanos = 100_000_000) => ({
  ts,
  nanos,
  level: 'DEBUG',
  target: 'codex_app_server::request_processors::thread_lifecycle',
  thread,
  uuid: DAEMON,
  body: `composing running thread resume response thread_id=${thread} request_id=ConnectionRequestId { connection_id: ConnectionId(${connection}), request_id: Integer(8) }`,
});

function createDb(file, rows) {
  const db = new Db(file);
  db.exec(SCHEMA);
  appendRows(db, rows);
  db.close();
}

function appendRows(dbOrFile, rows) {
  const owned = typeof dbOrFile === 'string';
  const db = owned ? new Db(dbOrFile) : dbOrFile;
  const ins = db.prepare(
    'INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    ins.all(row.ts, row.nanos ?? 0, row.level ?? 'INFO', row.target, row.body, row.thread ?? null, row.uuid);
  }
  if (owned) db.close();
}

test('DaemonBinding runs tmux and SQLite off the event loop and updates cached thread on change', { skip: skipSqlite }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-daemon-async-'));
  t.after(() => {
    disposeDaemonWorker();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = join(dir, 'logs_2.sqlite');
  createDb(dbPath, [
    tuiStart(562894, 1791173833, 866_308_462),
    started(21, FRESH, 1791173834, 977_664_883),
  ]);

  let now = 1_000_000;
  let pidCalls = 0;
  const changes = [];
  const binding = new DaemonBinding(dir, '%16', null, {
    now: () => now,
    findPid: async () => {
      pidCalls++;
      await new Promise((r) => setTimeout(r, 40));
      return 562894;
    },
    started: () => 1791173832,
    onChange: (thread) => changes.push(thread),
  });
  t.after(() => binding.stop());

  // threadId() must return immediately without blocking the event loop.
  const t0 = performance.now();
  assert.equal(binding.threadId(), null);
  const syncBlockMs = performance.now() - t0;
  assert.ok(syncBlockMs < 15, `expected non-blocking threadId(), took ${syncBlockMs.toFixed(2)} ms`);

  // Event loop ticks freely while the in-flight refresh runs.
  let heartbeats = 0;
  const hb = setInterval(() => {
    heartbeats++;
  }, 5);
  try {
    const resolved = await binding.refresh();
    assert.equal(resolved, FRESH);
  } finally {
    clearInterval(hb);
  }
  assert.ok(heartbeats >= 2, `expected event loop heartbeats during refresh, got ${heartbeats}`);
  assert.equal(binding.threadId(), FRESH);
  assert.deepEqual(changes, [FRESH]);

  // Append a /resume row; throttled within 2 s, picked up at +2 s.
  appendRows(dbPath, [resumed(21, RESUMED, 1791173951)]);
  now += 1000;
  assert.equal(await binding.refresh(), FRESH);
  now += 1000;
  assert.equal(await binding.refresh(), RESUMED);
  assert.equal(binding.threadId(), RESUMED);
  assert.equal(pidCalls, 1, 'pid is only checked every PID_RETRY_MS');

  // Unchanged DB skips SQLite; removing DB clears cached thread.
  now += 2500;
  assert.equal(await binding.refresh(), RESUMED);
  fs.rmSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix);
    } catch {
      /* optional */
    }
  }
  now += 2500;
  assert.equal(await binding.refresh(), null);
  assert.equal(binding.threadId(), null);
  assert.deepEqual(changes, [FRESH, RESUMED, null]);
});

test('DaemonBinding invalidates cached thread on PID replacement or reuse without DB change', { skip: skipSqlite }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-daemon-pid-'));
  t.after(() => {
    disposeDaemonWorker();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = join(dir, 'logs_2.sqlite');
  createDb(dbPath, [
    tuiStart(100, 1000, 0),
    started(11, FRESH, 1001, 0),
    tuiStart(200, 2000, 0),
    started(22, OTHER, 2001, 0),
  ]);

  let now = 1_000_000;
  let pid = 100;
  let start = 999;
  const binding = new DaemonBinding(dir, '%16', null, {
    now: () => now,
    findPid: () => pid,
    started: () => start,
  });
  t.after(() => binding.stop());

  assert.equal(await binding.refresh(), FRESH);
  pid = 200;
  start = 1999;
  now += 10_000;
  assert.equal(await binding.refresh(), OTHER);
  start = 3000;
  now += 10_000;
  assert.equal(await binding.refresh(), null);
  pid = 100;
  start = 999;
  now += 10_000;
  assert.equal(await binding.refresh(), FRESH);
});

test('tuiPidForPane runs tmux asynchronously without blocking the event loop', async (t) => {
  if (process.platform !== 'linux') return;
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-daemon-tmux-'));
  const codexBin = join(dir, 'codex');
  fs.symlinkSync('/bin/sleep', codexBin);
  const child = spawn(codexBin, ['30'], { stdio: 'ignore' });
  const fakeTmux = join(dir, 'tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nsleep 0.08\necho ${child.pid}\n`, { mode: 0o755 });
  const prevTmux = process.env.CODEX_HUD_TMUX_BIN;
  process.env.CODEX_HUD_TMUX_BIN = fakeTmux;
  t.after(() => {
    child.kill();
    if (prevTmux === undefined) delete process.env.CODEX_HUD_TMUX_BIN;
    else process.env.CODEX_HUD_TMUX_BIN = prevTmux;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let heartbeats = 0;
  const hb = setInterval(() => {
    heartbeats++;
  }, 10);
  try {
    const pid = await tuiPidForPane('%16');
    assert.equal(pid, child.pid);
  } finally {
    clearInterval(hb);
  }
  assert.ok(heartbeats >= 3, `expected heartbeats while tmux ran, got ${heartbeats}`);
});

test('latestThread handles substring connection ID collisions and resolveDaemonThread respects until', { skip: skipSqlite }, (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-daemon-sql-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'logs_2.sqlite');
  createDb(dbPath, [
    tuiStart(100, 1000, 0),
    started(2, FRESH, 1001, 0),
    started(21, OTHER, 1002, 0),
    resumed(2, RESUMED, 1010, 0),
    started(21, OTHER, 1015, 0),
  ]);

  assert.equal(resolveDaemonThread(dbPath, { pid: 100, since: 999, until: 1005 }), FRESH);
  assert.equal(resolveDaemonThread(dbPath, { pid: 100, since: 999 }), RESUMED);

  const ro = new Db(dbPath, { readOnly: true, timeout: 200 });
  try {
    const first = latestThread(ro, { server: DAEMON, id: 2, from: { ts: 1000, nanos: 0 } }, 0);
    assert.equal(first.threadId, RESUMED);
    const second = latestThread(ro, { server: DAEMON, id: 2, from: { ts: 1000, nanos: 0 } }, first.lastId);
    assert.equal(second.threadId, null);
    assert.equal(second.lastId, first.lastId);
  } finally {
    ro.close();
  }
});

test('collectParityGit runs asynchronously and reuses the 2 s cache', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-parity-git-async-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const hud = join(dir, 'hud');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.mkdirSync(hud);
  const git = (args) =>
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=s@invalid', ...args], {
      cwd: repo,
      stdio: 'pipe',
    });
  git(['init', '-b', 'main']);
  fs.writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  const env = { ...process.env, HOME: home, HUD_HOME: hud };
  const t0 = 1_700_000_000_000;
  const cold = await collectParityGit(repo, env, t0);
  assert.deepEqual(cold, { branch: 'main', dirty: false, ahead: 0, behind: 0 });

  // Within 2 s TTL with unchanged git metadata, the cache is reused even if a worktree file changes.
  fs.writeFileSync(join(repo, 'a.txt'), 'changed\n');
  const warm = await collectParityGit(repo, env, t0 + 1000);
  assert.deepEqual(warm, { branch: 'main', dirty: false, ahead: 0, behind: 0 });

  // After 2 s TTL expires, async refresh detects the dirty worktree.
  const refreshed = await collectParityGit(repo, env, t0 + 2500);
  assert.deepEqual(refreshed, { branch: 'main', dirty: true, ahead: 0, behind: 0 });
});
