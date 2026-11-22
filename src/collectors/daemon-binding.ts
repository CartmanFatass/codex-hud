/**
 * Which conversation the main pane's Codex shows, read from the daemon's log.
 *
 * Under the Codex 0.159+ daemon a TUI is a client: the daemon writes every
 * rollout and every shell snapshot, so neither names the pane, and a resumed
 * conversation is not written to until its next turn. What does name it is
 * the daemon's own log, `$CODEX_HOME/logs_2.sqlite`, table `logs`:
 *
 * - the TUI logs rows of its own there, `process_uuid = 'pid:<tui pid>:…'`;
 * - the daemon's rows for a request carry its span, `rpc.method="thread/start"
 *   … app_server.connection_id=21 … app_server.client_name="codex-tui"`, and
 *   the thread it opened in the `thread_id` column;
 * - a resume is answered with `composing running thread resume response
 *   thread_id=… request_id=ConnectionRequestId { connection_id:
 *   ConnectionId(21), … }`.
 *
 * No row names a client's pid, so the TUI's connection is found by timing:
 * the startup request that follows the TUI's first row, paired by rank when
 * several TUIs started inside the same few seconds. Then that connection's
 * latest thread/start, thread/resume or thread/fork is the conversation it
 * shows. Read only, best effort: with no `node:sqlite` (Node before 22), a
 * missing or locked database, another schema, or a log level that leaves the
 * rows out, the answer is null and the finder does what it did before.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { procStartTimeSec, readProcChildren, readProcComm } from '../utils/proc.js';

/** The few `node:sqlite` calls used here; Node 18 and 20 have no such module. */
interface Statement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface Database {
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseCtor = new (file: string, options?: { readOnly?: boolean; timeout?: number }) => Database;

let sqlite: DatabaseCtor | null | undefined;

/** `node:sqlite`'s DatabaseSync, loaded on first use, or null where Node has none. */
export function sqliteDatabase(): DatabaseCtor | null {
  if (sqlite !== undefined) return sqlite;
  // Node 22 prints "SQLite is an experimental feature" once on load; the
  // panel draws on this terminal, so that warning is held back.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(String(text))) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: DatabaseCtor };
    sqlite = mod.DatabaseSync ?? null;
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

/** A log row's time, compared as its two columns: never folded into one float. */
interface Stamp {
  ts: number;
  nanos: number;
}
const before = (a: Stamp, b: Stamp) => a.ts < b.ts || (a.ts === b.ts && a.nanos < b.nanos);

/** How long after a TUI's first row its startup request is looked for, in seconds: 1 s and 4.5 s were seen. */
const STARTUP_WINDOW_S = 10;
/** Rows read per question; the questions are narrow, these only bound a pathological log. */
const ROW_LIMIT = 200;
/** Bound reverse rowid scanning in latestThread so pathological logs cannot spin unboundedly. */
const MAX_LATEST_ROW_SPAN = 100_000;
/** Shared native wall-clock vs /proc boot/start rounding tolerance (also Claude startedAt). */
export const NATIVE_START_TOLERANCE_MS = 2000;

const THREAD_SPAN = /rpc\.method="thread\/(start|resume|fork)"/;
const SPAN_CONNECTION = /\bapp_server\.connection_id=(\d+)(?!\d)/;
const REQUEST_CONNECTION = /^app-server request: thread\/(start|resume|fork) connection_id=ConnectionId\((\d+)\)/;
const RESPONSE = /thread (?:start|resume|fork) response\b.*ConnectionRequestId \{ connection_id: ConnectionId\((\d+)\)/;
const BODY_THREAD = /\bthread_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

export interface ResolveQuery {
  /** The TUI's pid, as its rows' `process_uuid` starts `pid:<pid>:`. */
  pid: number;
  /** Unix seconds before which the TUI had not started: its first row is looked for from here. */
  since: number;
  /** Unix seconds: rows after this are not read. For a look back at a past moment. */
  until?: number;
  /** Role authority: refuse timing ambiguity instead of the display's best-effort ranking. */
  strict?: boolean;
}

/** A TUI's daemon connection, and where in the log its latest thread was read. */
export interface Connection {
  /** The process that logs for the connection: the daemon, or the TUI itself in-process. */
  server: string;
  id: number;
  /** The TUI's first row. */
  from: Stamp;
}

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value));
const text = (value: unknown) => (typeof value === 'string' ? value : '');

function hasThreadlessProcessIndex(db: Database): boolean {
  try {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_logs_process_uuid_threadless_ts'")
        .all().length > 0
    );
  } catch {
    return false;
  }
}

/** Only startup evidence can anchor timing. Retained activity after log pruning cannot. */
function firstRow(db: Database, q: ResolveQuery): Stamp | null {
  const prefix = `pid:${q.pid}:`;
  const minTs = Math.floor(q.since - (q.strict ? NATIVE_START_TOLERANCE_MS / 1000 : 0));
  const maxTs = q.until ?? Number.MAX_SAFE_INTEGER;
  // When Codex's partial index on (process_uuid, ts) WHERE thread_id IS NULL exists, unary `+ts`
  // steers SQLite away from scanning every threadless row in idx_logs_thread_id_ts.
  const tsClause = hasThreadlessProcessIndex(db) ? '+ts >= ? AND +ts <= ?' : 'ts >= ? AND ts <= ?';
  const rows = db
    .prepare(
      `SELECT ts, ts_nanos FROM logs WHERE thread_id IS NULL AND process_uuid >= ? AND process_uuid < ?
       AND target = 'codex_tui::app::startup'
       AND ${tsClause} ORDER BY ts, ts_nanos LIMIT 1`
    )
    .all(prefix, `pid:${q.pid};`, minTs, maxTs);
  if (!rows[0]) return null;
  const found = { ts: num(rows[0].ts), nanos: num(rows[0].ts_nanos) };
  if (q.strict && found.ts + found.nanos / 1e9 < q.since - NATIVE_START_TOLERANCE_MS / 1000) return null;
  return found;
}

/** Strict authority needs the connection's earliest retained evidence, not merely
 * a unique resume inside this TUI's window. Inspect all request kinds and history
 * without a lower time bound; bound correlation work, never guess past the bound.
 */
function strictConnectionStart(db: Database, q: ResolveQuery, connection: { server: string; id: number }): boolean {
  const rows = db
    .prepare(
      `SELECT ts, ts_nanos, feedback_log_body AS body FROM logs
    WHERE process_uuid = ? AND ts <= ? AND
      (feedback_log_body LIKE ? OR feedback_log_body LIKE ? OR feedback_log_body LIKE ?)
    ORDER BY ts, ts_nanos, id LIMIT ?`
    )
    .all(
      connection.server,
      q.until ?? Number.MAX_SAFE_INTEGER,
      `%app_server.connection_id=${connection.id}%`,
      `%connection_id=ConnectionId(${connection.id})%`,
      `%connection_id: ConnectionId(${connection.id})%`,
      ROW_LIMIT
    );
  const exact = rows.filter((row) => {
    const body = text(row.body);
    const match = SPAN_CONNECTION.exec(body) ?? /\bconnection_id(?:=|: )ConnectionId\((\d+)\)/.exec(body);
    return match && Number(match[1]) === connection.id;
  });
  const earliest = exact[0];
  if (!earliest || num(earliest.ts) + num(earliest.ts_nanos) / 1e9 < q.since - NATIVE_START_TOLERANCE_MS / 1000)
    return false;
  // initialize/account requests can precede thread creation on an ordinary TUI.
  const threadIndex = exact.findIndex(
    (row) => THREAD_SPAN.test(text(row.body)) || REQUEST_CONNECTION.test(text(row.body))
  );
  if (threadIndex < 0) return false;
  const first = text(exact[threadIndex].body);
  const span = THREAD_SPAN.exec(first);
  if (span) return span[1] !== 'fork' && /\bapp_server\.client_name="codex-tui"/.test(first);
  const trace = REQUEST_CONNECTION.exec(first);
  const requestId = /\brequest_id=String\(("(?:[^"\\]|\\.)*")\)/.exec(first);
  if (!trace || trace[1] === 'fork' || !requestId) return false;
  let id: unknown;
  try {
    id = JSON.parse(requestId[1]);
  } catch {
    return false;
  }
  if (typeof id !== 'string' || !id || id.length > 256) return false;
  return exact.slice(threadIndex + 1).some((row) => {
    const body = text(row.body);
    const method = THREAD_SPAN.exec(body);
    const correlated = /\brpc\.request_id=([^\s}]+)/.exec(body)?.[1];
    return method?.[1] === trace[1] && correlated === id && /\bapp_server\.client_name="codex-tui"/.test(body);
  });
}

/**
 * The connection a TUI opened at startup: the thread/start (or resume) its
 * startup sent, a few seconds after its first row. Several TUIs starting in
 * the same seconds are paired with the startup requests in order: the k-th
 * TUI to log is the k-th connection the daemon accepted. Otherwise the
 * request nearest after the TUI's first row.
 */
export function findConnection(db: Database, q: ResolveQuery): Connection | null {
  const from = firstRow(db, q);
  if (!from) return null;
  const end = Math.min((q.strict ? q.since : from.ts) + STARTUP_WINDOW_S, q.until ?? Number.MAX_SAFE_INTEGER);
  const start = q.strict ? Math.floor(q.since - NATIVE_START_TOLERANCE_MS / 1000) : from.ts - STARTUP_WINDOW_S;
  const requests = db
    .prepare(
      `SELECT ts, ts_nanos, process_uuid, feedback_log_body AS body FROM logs
       WHERE ts >= ? AND ts <= ? AND (feedback_log_body LIKE '%rpc.method="thread/%'
         OR feedback_log_body LIKE 'app-server request: thread/%')
       ORDER BY ts, ts_nanos, id LIMIT ${q.strict ? ROW_LIMIT + 1 : ROW_LIMIT}`
    )
    .all(start, end);
  if (q.strict && requests.length > ROW_LIMIT) return null;
  // One entry per connection, at its first request.
  const seen = new Map<string, Stamp & { server: string; id: number }>();
  for (const row of requests) {
    const body = text(row.body);
    const span = THREAD_SPAN.test(body) && !/client_name="(?!codex-tui)/.test(body) ? SPAN_CONNECTION.exec(body) : null;
    const request = span ? null : REQUEST_CONNECTION.exec(body);
    const id = span ? Number(span[1]) : request ? Number(request[2]) : NaN;
    if (!Number.isFinite(id)) continue;
    const server = text(row.process_uuid);
    const key = `${server}#${id}`;
    if (!seen.has(key)) seen.set(key, { ts: num(row.ts), nanos: num(row.ts_nanos), server, id });
  }
  const connections = [...seen.values()];
  if (!connections.length) return null;
  // The TUIs that started around this one, each at its first row of its own.
  const tuis = db
    .prepare(
      `SELECT process_uuid, ts, ts_nanos FROM logs WHERE ts >= ? AND ts <= ? AND thread_id IS NULL
       AND target = 'codex_tui::app::startup' ORDER BY ts, ts_nanos, id LIMIT ${ROW_LIMIT * 5 + (q.strict ? 1 : 0)}`
    )
    .all(start, end);
  if (q.strict && tuis.length > ROW_LIMIT * 5) return null;
  const starts = new Map<string, Stamp>();
  for (const row of tuis) {
    const uuid = text(row.process_uuid);
    if (uuid.startsWith('pid:') && !starts.has(uuid)) starts.set(uuid, { ts: num(row.ts), nanos: num(row.ts_nanos) });
  }
  const own = [...starts.keys()].find((uuid) => uuid.startsWith(`pid:${q.pid}:`));
  const after = connections.filter((c) => !before(c, from));
  if (q.strict) {
    if (!own || starts.size !== 1 || connections.length !== 1 || !strictConnectionStart(db, q, connections[0]))
      return null;
    return { server: connections[0].server, id: connections[0].id, from };
  }
  if (own && starts.size > 1) {
    const order = [...starts.entries()].sort(([, a], [, b]) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    const rank = order.findIndex(([uuid]) => uuid === own);
    // Connections are numbered as the daemon accepts them.
    const byId = [...connections].sort((a, b) => a.id - b.id);
    if (byId.length === order.length) return { server: byId[rank].server, id: byId[rank].id, from };
  }
  const nearest = after[0];
  return nearest ? { server: nearest.server, id: nearest.id, from } : null;
}

function matchLatestRow(rows: Array<Record<string, unknown>>, connectionId: number): string | null {
  for (const row of rows) {
    const body = text(row.body);
    const span = THREAD_SPAN.test(body) ? SPAN_CONNECTION.exec(body) : null;
    const response = span ? null : RESPONSE.exec(body);
    const conn = span ? Number(span[1]) : response ? Number(response[1]) : NaN;
    if (conn !== connectionId) continue;
    const threadId = text(row.thread_id) || BODY_THREAD.exec(body)?.[1] || null;
    if (threadId) return threadId;
  }
  return null;
}

/**
 * The thread `connection` opened last: the newest thread/start, thread/resume
 * or thread/fork row of that connection, read from `afterId` on.
 */
export function latestThread(
  db: Database,
  connection: Connection,
  afterId = 0,
  until?: number
): { threadId: string | null; lastId: number } {
  const id = connection.id;
  const minTs = connection.from.ts - STARTUP_WINDOW_S;
  const maxTs = until ?? Number.MAX_SAFE_INTEGER;
  // The newest row first, so a row written while this reads is left for the next read.
  const top = (
    until === undefined
      ? db.prepare('SELECT MAX(id) AS id FROM logs').all()
      : db.prepare('SELECT MAX(id) AS id FROM logs WHERE ts <= ?').all(until)
  )[0];
  const lastId = Math.max(afterId, num(top?.id) || 0);
  if (lastId <= afterId) return { threadId: null, lastId };

  // Bound the primary-key scan from below using idx_logs_ts when starting cold (afterId === 0).
  let lowId = afterId;
  if (lowId === 0) {
    const floor = db
      .prepare('SELECT id FROM logs WHERE ts >= ? ORDER BY ts ASC, ts_nanos ASC, id ASC LIMIT 1')
      .all(minTs)[0];
    const minRowId = num(floor?.id);
    if (Number.isFinite(minRowId) && minRowId > 64) lowId = minRowId - 64;
  }

  const scanLowId = Math.max(lowId, lastId - MAX_LATEST_ROW_SPAN);
  const spanLike = `%app_server.connection_id=${id}%`;
  const responseLike = `%ConnectionRequestId { connection_id: ConnectionId(${id})%`;

  // Step backwards by INTEGER PRIMARY KEY (id DESC) with LIMIT 1 so SQLite stops on the first
  // matching row instead of scanning the entire history to collect up to ROW_LIMIT matches.
  const stepStmt = db.prepare(
    `SELECT id, thread_id, feedback_log_body AS body FROM logs
     WHERE id > ? AND id <= ? AND ts >= ? AND ts <= ? AND process_uuid = ? AND thread_id IS NOT NULL
     AND ((feedback_log_body LIKE '%rpc.method="thread/%' AND feedback_log_body LIKE ?)
       OR feedback_log_body LIKE ?)
     ORDER BY id DESC LIMIT 1`
  );
  let cursor = lastId;
  for (let step = 0; step < ROW_LIMIT && cursor > scanLowId; step++) {
    const row = stepStmt.all(scanLowId, cursor, minTs, maxTs, connection.server, spanLike, responseLike)[0];
    if (!row) break;
    const matched = matchLatestRow([row], id);
    if (matched) return { threadId: matched, lastId };
    const rowId = num(row.id);
    if (!Number.isFinite(rowId) || rowId <= scanLowId) break;
    cursor = rowId - 1;
  }

  // On an initial bind for a very long-lived TUI whose startup row predates MAX_LATEST_ROW_SPAN,
  // still check the narrow startup window via idx_logs_ts.
  if (afterId === 0 && scanLowId > lowId) {
    const startupMaxTs = Math.min(connection.from.ts + STARTUP_WINDOW_S, maxTs);
    const startupRows = db
      .prepare(
        `SELECT id, thread_id, feedback_log_body AS body FROM logs
         WHERE id > ? AND id <= ? AND ts >= ? AND ts <= ? AND process_uuid = ? AND thread_id IS NOT NULL
         AND ((feedback_log_body LIKE '%rpc.method="thread/%' AND feedback_log_body LIKE ?)
           OR feedback_log_body LIKE ?)
         ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT ${ROW_LIMIT}`
      )
      .all(lowId, scanLowId, minTs, startupMaxTs, connection.server, spanLike, responseLike);
    const matched = matchLatestRow(startupRows, id);
    if (matched) return { threadId: matched, lastId };
  }

  return { threadId: null, lastId };
}

export interface DaemonQueryRequest {
  dbPath: string;
  pid: number;
  since: number;
  connection: Connection | null;
  lastId: number;
}

export interface DaemonQueryResponse {
  ok: boolean;
  connection: Connection | null;
  threadId: string | null;
  lastId: number;
}

/** Read-only query executed inside the off-event-loop worker thread. Never writes or vacuums. */
export function queryDaemonBinding(request: DaemonQueryRequest): DaemonQueryResponse {
  const Db = sqliteDatabase();
  if (!Db) return { ok: false, connection: request.connection, threadId: null, lastId: request.lastId };
  let db: Database | null = null;
  try {
    db = new Db(request.dbPath, { readOnly: true, timeout: 200 });
    const connection = request.connection ?? findConnection(db, { pid: request.pid, since: request.since });
    if (!connection) return { ok: true, connection: null, threadId: null, lastId: 0 };
    const latest = latestThread(db, connection, request.lastId);
    return { ok: true, connection, threadId: latest.threadId, lastId: latest.lastId };
  } catch {
    return { ok: false, connection: request.connection, threadId: null, lastId: request.lastId };
  } finally {
    db?.close();
  }
}

/** The conversation the TUI with `q.pid` shows, as the daemon's log has it. Null when it cannot tell. */
export function resolveDaemonThread(dbPath: string, q: ResolveQuery): string | null {
  const Db = sqliteDatabase();
  if (!Db || !fs.existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Db(dbPath, { readOnly: true, timeout: 200 });
    const connection = findConnection(db, q);
    return connection ? latestThread(db, connection, 0, q.until).threadId : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const TMUX_TIMEOUT_MS = 1000;
const TMUX_MAX_BUFFER = 64 * 1024;

/** The pid of the Codex TUI in tmux pane `pane`: the pane's process or its nearest `codex` descendant. */
export function tuiPidForPane(pane: string): Promise<number | null> {
  const tmux = process.env.CODEX_HUD_TMUX_BIN || 'tmux';
  return new Promise((resolvePid) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(tmux, ['display-message', '-p', '-t', pane, '#{pane_pid}'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolvePid(null);
      return;
    }
    const finish = (pid: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePid(pid);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      finish(null);
    }, TMUX_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > TMUX_MAX_BUFFER) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code, signal) => {
      if (signal !== null || code !== 0) {
        finish(null);
        return;
      }
      const root = Number.parseInt(Buffer.concat(chunks).toString('utf8').trim(), 10);
      if (!Number.isFinite(root) || root <= 0) {
        finish(null);
        return;
      }
      finish(codexProcess(root));
    });
  });
}

const comm = (pid: number) => readProcComm(pid) ?? '';

const children = (pid: number): number[] => readProcChildren(pid)?.pids ?? [];

/** `root` when it is Codex, else its shallowest `codex` descendant, three levels at most. */
export function codexProcess(root: number): number | null {
  let level = [root];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const found = level.find((pid) => /^codex/.test(comm(pid)));
    if (found) return found;
    level = level.flatMap(children);
  }
  return null;
}

/** When `pid` started, in Unix seconds, from /proc; null off Linux. */
export function processStart(pid: number): number | null {
  return procStartTimeSec(pid);
}

const WORKER_QUERY_TIMEOUT_MS = 5000;
const WORKER_IDLE_MS = 30_000;

interface PendingWorkerQuery {
  resolve: (response: DaemonQueryResponse) => void;
  timer: NodeJS.Timeout;
  fallback: DaemonQueryResponse;
}

let sharedWorker: Worker | null = null;
let workerIdleTimer: NodeJS.Timeout | null = null;
let nextQueryId = 1;
const pendingQueries = new Map<number, PendingWorkerQuery>();

function clearIdleTimer(): void {
  if (workerIdleTimer) {
    clearTimeout(workerIdleTimer);
    workerIdleTimer = null;
  }
}

function scheduleWorkerIdle(): void {
  clearIdleTimer();
  if (!sharedWorker || pendingQueries.size > 0) return;
  sharedWorker.unref();
  workerIdleTimer = setTimeout(() => {
    workerIdleTimer = null;
    if (pendingQueries.size === 0) disposeDaemonWorker();
  }, WORKER_IDLE_MS);
  workerIdleTimer.unref();
}

function failAllPending(): void {
  for (const [id, entry] of pendingQueries) {
    clearTimeout(entry.timer);
    pendingQueries.delete(id);
    entry.resolve(entry.fallback);
  }
}

/** Terminate the shared off-event-loop SQLite worker if idle or during shutdown. */
export function disposeDaemonWorker(): void {
  clearIdleTimer();
  const worker = sharedWorker;
  sharedWorker = null;
  failAllPending();
  if (worker) {
    void worker.terminate().catch(() => {});
  }
}

function getDaemonWorker(): Worker | null {
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new Worker(new URL('./daemon-binding-worker.js', import.meta.url), { execArgv: [] });
    worker.unref();
    worker.on('message', (reply: { id: number; response: DaemonQueryResponse }) => {
      const entry = pendingQueries.get(reply.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingQueries.delete(reply.id);
      if (pendingQueries.size === 0) scheduleWorkerIdle();
      entry.resolve(reply.response);
    });
    worker.on('error', () => {
      if (sharedWorker === worker) sharedWorker = null;
      clearIdleTimer();
      failAllPending();
    });
    worker.on('exit', () => {
      if (sharedWorker === worker) sharedWorker = null;
      clearIdleTimer();
      failAllPending();
    });
    sharedWorker = worker;
    return worker;
  } catch {
    return null;
  }
}

function runDaemonQueryInWorker(request: DaemonQueryRequest): Promise<DaemonQueryResponse> {
  const fallback: DaemonQueryResponse = {
    ok: false,
    connection: request.connection,
    threadId: null,
    lastId: request.lastId,
  };
  const worker = getDaemonWorker();
  if (!worker) return Promise.resolve(fallback);
  clearIdleTimer();
  worker.ref();
  return new Promise((resolveQuery) => {
    const id = nextQueryId++;
    const timer = setTimeout(() => {
      if (!pendingQueries.delete(id)) return;
      // Terminate a wedged worker so the next refresh starts clean.
      if (sharedWorker === worker) {
        sharedWorker = null;
        clearIdleTimer();
        failAllPending();
        void worker.terminate().catch(() => {});
      }
      resolveQuery(fallback);
    }, WORKER_QUERY_TIMEOUT_MS);
    timer.unref();
    pendingQueries.set(id, { resolve: resolveQuery, timer, fallback });
    try {
      worker.postMessage({ id, request });
    } catch {
      clearTimeout(timer);
      pendingQueries.delete(id);
      if (pendingQueries.size === 0) scheduleWorkerIdle();
      resolveQuery(fallback);
    }
  });
}

/** Least time between two reads of the log. */
const CHECK_MS = 2000;
/** Recheck identity even while bound: a pane can replace its Codex process. */
const PID_RETRY_MS = 10_000;

/**
 * The binding for one pane, kept up to date off the event loop at most every
 * two seconds and only when the log changed. The TUI's connection is found
 * once; later reads look only at rows added since the last.
 */
export class DaemonBinding {
  private readonly dbPath: string;
  private pid: number | null = null;
  private pidStarted: number | null = null;
  private lastPidLook = -Infinity;
  private lastCheck = -Infinity;
  private signature = '';
  private connection: Connection | null = null;
  private lastId = 0;
  private thread: string | null = null;
  private inFlight: Promise<string | null> | null = null;
  private stopped = false;

  private readonly now: () => number;
  private readonly findPid: (pane: string) => number | null | Promise<number | null>;
  private readonly started: (pid: number) => number | null;
  private readonly queryDb: (request: DaemonQueryRequest) => Promise<DaemonQueryResponse>;
  private readonly onChange?: (threadId: string | null) => void;

  /**
   * `startMs` is the HUD's start, the bound for the TUI's first row where
   * /proc cannot say when the TUI started. The rest are seams for tests.
   */
  constructor(
    codexHome: string,
    private readonly pane: string,
    private readonly startMs: number | null,
    seams: {
      now?: () => number;
      findPid?: (pane: string) => number | null | Promise<number | null>;
      started?: (pid: number) => number | null;
      queryDb?: (request: DaemonQueryRequest) => Promise<DaemonQueryResponse>;
      onChange?: (threadId: string | null) => void;
    } = {}
  ) {
    this.dbPath = path.join(codexHome, 'logs_2.sqlite');
    this.now = seams.now ?? Date.now;
    this.findPid = seams.findPid ?? tuiPidForPane;
    this.started = seams.started ?? processStart;
    this.queryDb = seams.queryDb ?? runDaemonQueryInWorker;
    this.onChange = seams.onChange;
  }

  /**
   * The cached thread the pane's Codex shows, or null when not yet known.
   * Never blocks the event loop; triggers a single-flight background refresh when due.
   */
  threadId(): string | null {
    const now = this.now();
    if (!this.stopped && !this.inFlight && now - this.lastCheck >= CHECK_MS) {
      void this.refresh();
    }
    return this.thread;
  }

  /** Run or await the current off-event-loop refresh (throttled to CHECK_MS). */
  refresh(): Promise<string | null> {
    if (this.stopped) return Promise.resolve(this.thread);
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS) return Promise.resolve(this.thread);
    this.lastCheck = now;
    const promise = this.runRefresh(now).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  /** Stop background refreshes and ignore any in-flight result. */
  stop(): void {
    this.stopped = true;
  }

  private async runRefresh(now: number): Promise<string | null> {
    const previousThread = this.thread;
    const Db = sqliteDatabase();
    if (!Db) return null;

    if (now - this.lastPidLook >= PID_RETRY_MS) {
      this.lastPidLook = now;
      const pid = await Promise.resolve(this.findPid(this.pane)).catch(() => null);
      if (this.stopped) return this.thread;
      const started = pid === null ? null : this.started(pid);
      if (pid !== this.pid || started !== this.pidStarted) {
        this.connection = null;
        this.lastId = 0;
        this.thread = null;
        this.signature = '';
      }
      this.pid = pid;
      this.pidStarted = started;
    }

    if (this.pid === null) {
      if (this.thread !== previousThread) this.onChange?.(this.thread);
      return null;
    }

    const signature = await this.stat();
    if (this.stopped) return this.thread;
    if (!signature) {
      this.connection = null;
      this.lastId = 0;
      this.signature = '';
      this.thread = null;
      if (this.thread !== previousThread) this.onChange?.(this.thread);
      return null;
    }

    if (signature === this.signature) {
      if (this.thread !== previousThread) this.onChange?.(this.thread);
      return this.thread;
    }

    const pid = this.pid;
    const started = this.pidStarted;
    const since = started !== null ? started - 2 : (this.startMs ?? now) / 1000 - 300;
    const response = await this.queryDb({
      dbPath: this.dbPath,
      pid,
      since,
      connection: this.connection,
      lastId: this.lastId,
    });
    if (this.stopped || this.pid !== pid || this.pidStarted !== started) return this.thread;
    if (!response.ok) return this.thread;

    this.connection = response.connection;
    this.lastId = response.lastId;
    if (response.threadId) this.thread = response.threadId;
    this.signature = signature;
    if (this.thread !== previousThread) this.onChange?.(this.thread);
    return this.thread;
  }

  /** The database's and its write-ahead log's size and mtime: the log changed when this does. */
  private async stat(): Promise<string | null> {
    try {
      const db = await fs.promises.stat(this.dbPath);
      let wal = '';
      try {
        const w = await fs.promises.stat(`${this.dbPath}-wal`);
        wal = `${w.size}:${w.mtimeMs}`;
      } catch {
        // No write-ahead log: the database alone.
      }
      return `${db.size}:${db.mtimeMs}:${wal}`;
    } catch {
      return null;
    }
  }
}
