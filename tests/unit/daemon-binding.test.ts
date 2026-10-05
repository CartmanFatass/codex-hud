/**
 * The daemon's log as the binding reads it: rows shaped like the ones Codex
 * 0.159's daemon wrote on 2026-10-04, in a temporary sqlite file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DaemonBinding,
  processStart,
  resolveDaemonThread,
  sqliteDatabase,
} from '../../src/collectors/daemon-binding.js';
import { SessionFinder } from '../../src/collectors/session-finder.js';

const Db = sqliteDatabase();
const skip = Db ? false : 'node:sqlite is not in this Node';

const DAEMON = 'pid:196900:e8b48fb4-7b94-413c-b703-83abe9025aba';
const FRESH = '01a10a47-b559-7ba2-a18c-ec3c852cd73c';
const RESUMED = '01a0ef2b-a391-7693-a748-60e24be246ae';
const OTHER = '01a109fa-0000-7000-8000-000000000003';
const THIRD = '01a109fb-0000-7000-8000-000000000004';

interface Row {
  ts: number;
  nanos?: number;
  level?: string;
  target: string;
  body: string;
  thread?: string;
  uuid: string;
}

const SCHEMA = `CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT,
  file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)`;

function database(file: string, rows: Row[], schema = SCHEMA): void {
  const db = new Db!(file);
  db.prepare(schema).all();
  append(file, rows);
  db.close();
}

function append(file: string, rows: Row[]): void {
  const db = new Db!(file);
  for (const row of rows)
    db.prepare(
      'INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).all(row.ts, row.nanos ?? 0, row.level ?? 'INFO', row.target, row.body, row.thread ?? null, row.uuid);
  db.close();
}

/** A TUI's first rows: its own process, no thread. */
const tuiStart = (pid: number, ts: number, nanos: number): Row[] => [
  { ts, nanos, target: 'codex_http_client::custom_ca', body: 'using system root certificates', uuid: `pid:${pid}:aa` },
  {
    ts,
    nanos: nanos + 100_000_000,
    level: 'DEBUG',
    target: 'codex_tui::app::startup',
    body: 'connected app-server',
    uuid: `pid:${pid}:aa`,
  },
];
/** The daemon's row inside a thread/start the TUI's startup sent, carrying the new thread. */
const started = (connection: number, thread: string, ts: number, nanos: number, client = 'codex-tui'): Row => ({
  ts,
  nanos,
  target: 'codex_core::shell_snapshot',
  thread,
  uuid: DAEMON,
  body: `app_server.request{otel.kind="server" otel.name="thread/start" rpc.system="jsonrpc" rpc.method="thread/start" rpc.transport="unix_socket" rpc.request_id=startup-thread-start-d7780f42 app_server.connection_id=${connection} app_server.api_version="v2" app_server.client_name="${client}"}: shell snapshot`,
});
/** The request itself, at TRACE, before the daemon knows the thread. */
const request = (connection: number, method: string, ts: number, nanos: number): Row => ({
  ts,
  nanos,
  level: 'TRACE',
  target: 'codex_app_server::message_processor',
  uuid: DAEMON,
  body: `app-server request: thread/${method} connection_id=ConnectionId(${connection}) request_id=String("startup-thread-start-x")`,
});
/** The daemon answering a /resume. */
const resumed = (connection: number, thread: string, ts: number): Row => ({
  ts,
  nanos: 177_495_082,
  level: 'DEBUG',
  target: 'codex_app_server::request_processors::thread_lifecycle',
  thread,
  uuid: DAEMON,
  body: `composing running thread resume response thread_id=${thread} request_id=ConnectionRequestId { connection_id: ConnectionId(${connection}), request_id: Integer(8) } active_turn_present=false`,
});

function scratch(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hud-daemon-'));
  return { dir, file: join(dir, 'logs_2.sqlite') };
}

/** The real log's day, 2026-10-04 21:17 PDT: one TUI started, then resumed an older conversation. */
const DAY: Row[] = [
  ...tuiStart(562894, 1791173833, 866_308_462),
  request(21, 'start', 1791173834, 22_000_000),
  started(21, FRESH, 1791173834, 977_664_883),
  request(21, 'resume', 1791173951, 100_000_000),
  resumed(21, RESUMED, 1791173951),
];

test('a fresh start binds to the thread the startup opened; /resume moves it to the resumed one', { skip }, () => {
  const { dir, file } = scratch();
  try {
    database(file, DAY);
    const q = { pid: 562894, since: 1791173818 };
    assert.equal(resolveDaemonThread(file, { ...q, until: 1791173950 }), FRESH);
    assert.equal(resolveDaemonThread(file, { ...q, until: 1791173951 }), RESUMED);
    assert.equal(resolveDaemonThread(file, q), RESUMED);
    assert.equal(resolveDaemonThread(file, { pid: 1, since: 1791173818 }), null, 'a pid that logged nothing');
    assert.equal(
      resolveDaemonThread(file, { ...q, since: 1791173900 }),
      null,
      'a start after its rows: another process'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the binding holds with the TRACE rows pruned, and with only the TRACE request and the response', { skip }, () => {
  const { dir, file } = scratch();
  try {
    database(
      file,
      DAY.filter((row) => row.level !== 'TRACE')
    );
    assert.equal(resolveDaemonThread(file, { pid: 562894, since: 1791173818 }), RESUMED);
    rmSync(file);
    database(file, [
      ...tuiStart(562894, 1791173833, 866_308_462),
      request(21, 'start', 1791173834, 22_000_000),
      resumed(21, RESUMED, 1791173951),
    ]);
    assert.equal(resolveDaemonThread(file, { pid: 562894, since: 1791173818 }), RESUMED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two TUIs on their own connections do not cross, whichever logged first', { skip }, () => {
  const { dir, file } = scratch();
  try {
    database(file, [
      ...tuiStart(100, 1000, 100_000_000),
      // The second TUI's first row comes before the first one's request:
      // "the request nearest after" alone would give it connection 5.
      ...tuiStart(200, 1000, 300_000_000),
      started(5, FRESH, 1001, 0),
      started(6, OTHER, 1001, 200_000_000),
      resumed(5, RESUMED, 1100),
    ]);
    assert.equal(resolveDaemonThread(file, { pid: 100, since: 990 }), RESUMED);
    assert.equal(resolveDaemonThread(file, { pid: 200, since: 990 }), OTHER, 'the resume on 5 is not 6');
    assert.equal(resolveDaemonThread(file, { pid: 100, since: 990, until: 1050 }), FRESH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'several startups inside the window: each TUI by its own timing, other clients and other numbers left out',
  { skip },
  () => {
    const { dir, file } = scratch();
    try {
      database(file, [
        // A thread a VS Code client started in the same seconds is no TUI's.
        started(4, '01a10000-0000-7000-8000-00000000000f', 999, 900_000_000, 'codex_vscode'),
        ...tuiStart(100, 1000, 0),
        started(7, FRESH, 1000, 500_000_000),
        ...tuiStart(300, 1040, 0),
        started(21, THIRD, 1040, 400_000_000),
        // Connection 210 is not connection 21.
        resumed(210, OTHER, 1050),
      ]);
      assert.equal(resolveDaemonThread(file, { pid: 100, since: 990 }), FRESH);
      assert.equal(resolveDaemonThread(file, { pid: 300, since: 1030 }), THIRD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('a missing database, another schema or an empty log say nothing', { skip }, () => {
  const { dir, file } = scratch();
  try {
    assert.equal(resolveDaemonThread(file, { pid: 562894, since: 0 }), null);
    database(file, [], 'CREATE TABLE logs (id INTEGER PRIMARY KEY, message TEXT)');
    assert.equal(resolveDaemonThread(file, { pid: 562894, since: 0 }), null);
    rmSync(file);
    writeFileSync(file, 'not a database');
    assert.equal(resolveDaemonThread(file, { pid: 562894, since: 0 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the binding reads the log again only when it changed, and at most every two seconds', { skip }, () => {
  const { dir, file } = scratch();
  try {
    database(file, DAY.slice(0, 4));
    let now = 1_000_000;
    let looks = 0;
    const binding = new DaemonBinding(dir, '%16', null, {
      now: () => now,
      findPid: () => (looks++, 562894),
      started: () => 1791173832,
    });
    assert.equal(binding.threadId(), FRESH);
    append(file, DAY.slice(4));
    now += 1000;
    assert.equal(binding.threadId(), FRESH, 'within two seconds, the last answer');
    now += 1000;
    assert.equal(binding.threadId(), RESUMED);
    now += 5000;
    assert.equal(binding.threadId(), RESUMED, 'nothing new, the same');
    assert.equal(looks, 1, 'the pane is asked for its TUI once');
    rmSync(file);
    now += 5000;
    assert.equal(binding.threadId(), null, 'the log gone, no answer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processStart reads when a process started', () => {
  const start = processStart(process.pid);
  if (start === null) return; // not Linux
  assert.ok(Math.abs(start - Date.now() / 1000) < 3600, String(start));
});

/** A rollout's first line, as Codex writes it. */
function rollout(home: string, id: string, meta: Record<string, unknown> = {}): void {
  const dir = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-09-29T14-56-49-${id}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: home, ...meta } })}\n`
  );
}

test(
  'the finder binds the pane to a resumed conversation through the log, and stays on it when Codex shows a subagent',
  { skip },
  async () => {
    if (process.platform !== 'linux') return;
    const home = mkdtempSync(join(tmpdir(), 'hud-daemon-home-'));
    // A process named codex, as the pane's TUI is, and a tmux that names its pid.
    const codex = join(home, 'codex');
    symlinkSync('/bin/sleep', codex);
    const tui = spawn(codex, ['30'], { stdio: 'ignore' });
    const tmux = join(home, 'tmux');
    writeFileSync(tmux, `#!/bin/sh\necho ${tui.pid}\n`);
    chmodSync(tmux, 0o755);
    const saved = {
      home: process.env.CODEX_HOME,
      pane: process.env.CODEX_HUD_MAIN_PANE,
      tmux: process.env.CODEX_HUD_TMUX_BIN,
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = Math.floor(Date.now() / 1000);
      const subagent = '01a0ef2d-4ce4-7670-8c68-f31819368f06';
      rollout(home, RESUMED);
      rollout(home, subagent, { session_id: RESUMED, parent_thread_id: RESUMED, thread_source: 'subagent' });
      database(join(home, 'logs_2.sqlite'), [
        ...tuiStart(tui.pid!, now, 0),
        started(21, FRESH, now, 500_000_000),
        resumed(21, RESUMED, now + 1),
        resumed(21, subagent, now + 2),
      ]);
      process.env.CODEX_HOME = home;
      process.env.CODEX_HUD_MAIN_PANE = '%16';
      process.env.CODEX_HUD_TMUX_BIN = tmux;
      const finder = new SessionFinder(home, undefined, new Date(Date.now() - 60_000));
      assert.equal(finder.check()?.sessionId, RESUMED);
    } finally {
      tui.kill();
      for (const [key, value] of [
        ['CODEX_HOME', saved.home],
        ['CODEX_HUD_MAIN_PANE', saved.pane],
        ['CODEX_HUD_TMUX_BIN', saved.tmux],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(home, { recursive: true, force: true });
    }
  }
);
