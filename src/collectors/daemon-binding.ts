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
import { spawnSync } from 'node:child_process';

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

/** The TUI's first row at or after `since`, or null when it logged none. */
function firstRow(db: Database, q: ResolveQuery): Stamp | null {
  const prefix = `pid:${q.pid}:`;
  const rows = db
    .prepare(
      `SELECT ts, ts_nanos FROM logs WHERE thread_id IS NULL AND process_uuid >= ? AND process_uuid < ?
       AND ts >= ? AND ts <= ? ORDER BY ts, ts_nanos LIMIT 1`
    )
    .all(prefix, `pid:${q.pid};`, Math.floor(q.since), q.until ?? Number.MAX_SAFE_INTEGER);
  return rows[0] ? { ts: num(rows[0].ts), nanos: num(rows[0].ts_nanos) } : null;
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
  const end = Math.min(from.ts + STARTUP_WINDOW_S, q.until ?? Number.MAX_SAFE_INTEGER);
  const requests = db
    .prepare(
      `SELECT ts, ts_nanos, process_uuid, feedback_log_body AS body FROM logs
       WHERE ts >= ? AND ts <= ? AND (feedback_log_body LIKE '%rpc.method="thread/%'
         OR feedback_log_body LIKE 'app-server request: thread/%')
       ORDER BY ts, ts_nanos, id LIMIT ${ROW_LIMIT}`
    )
    .all(from.ts - STARTUP_WINDOW_S, end);
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
       AND target LIKE 'codex_tui::%' ORDER BY ts, ts_nanos, id LIMIT ${ROW_LIMIT * 5}`
    )
    .all(from.ts - STARTUP_WINDOW_S, end);
  const starts = new Map<string, Stamp>();
  for (const row of tuis) {
    const uuid = text(row.process_uuid);
    if (uuid.startsWith('pid:') && !starts.has(uuid)) starts.set(uuid, { ts: num(row.ts), nanos: num(row.ts_nanos) });
  }
  const own = [...starts.keys()].find((uuid) => uuid.startsWith(`pid:${q.pid}:`));
  const after = connections.filter((c) => !before(c, from));
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
  // The newest row first, so a row written while this reads is left for the next read.
  const top = (
    until === undefined
      ? db.prepare('SELECT MAX(id) AS id FROM logs').all()
      : db.prepare('SELECT MAX(id) AS id FROM logs WHERE ts <= ?').all(until)
  )[0];
  const lastId = Math.max(afterId, num(top?.id) || 0);
  const rows = db
    .prepare(
      `SELECT id, thread_id, feedback_log_body AS body FROM logs
       WHERE id > ? AND id <= ? AND ts >= ? AND ts <= ? AND process_uuid = ? AND thread_id IS NOT NULL
       AND ((feedback_log_body LIKE '%rpc.method="thread/%' AND feedback_log_body LIKE ?)
         OR feedback_log_body LIKE ?)
       ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT ${ROW_LIMIT}`
    )
    .all(
      afterId,
      lastId,
      connection.from.ts - STARTUP_WINDOW_S,
      until ?? Number.MAX_SAFE_INTEGER,
      connection.server,
      `%app_server.connection_id=${id}%`,
      `%ConnectionRequestId { connection_id: ConnectionId(${id})%`
    );
  for (const row of rows) {
    const body = text(row.body);
    const span = THREAD_SPAN.test(body) ? SPAN_CONNECTION.exec(body) : null;
    const response = span ? null : RESPONSE.exec(body);
    const conn = span ? Number(span[1]) : response ? Number(response[1]) : NaN;
    if (conn !== id) continue;
    const threadId = text(row.thread_id) || BODY_THREAD.exec(body)?.[1] || null;
    if (threadId) return { threadId, lastId };
  }
  return { threadId: null, lastId };
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

/** The pid of the Codex TUI in tmux pane `pane`: the pane's process or its nearest `codex` descendant. */
export function tuiPidForPane(pane: string): number | null {
  const tmux = process.env.CODEX_HUD_TMUX_BIN || 'tmux';
  const result = spawnSync(tmux, ['display-message', '-p', '-t', pane, '#{pane_pid}'], {
    encoding: 'utf8',
    timeout: 1000,
  });
  const root = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  if (result.status !== 0 || !Number.isFinite(root) || root <= 0) return null;
  return codexProcess(root);
}

const comm = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
};

const children = (pid: number): number[] => {
  try {
    return fs
      .readdirSync(`/proc/${pid}/task`)
      .flatMap((task) => fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/))
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};

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
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command may hold spaces and parentheses: fields count from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const boot = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1];
    // USER_HZ is 100 on every Linux the HUD runs on.
    return Number.isFinite(ticks) && boot ? Number(boot) + ticks / 100 : null;
  } catch {
    return null;
  }
}

/** Least time between two reads of the log. */
const CHECK_MS = 2000;
/** Least time between two looks for the pane's TUI while there is none. */
const PID_RETRY_MS = 10_000;

/**
 * The binding for one pane, kept up to date at most every two seconds and
 * only when the log changed. The TUI's connection is found once; later reads
 * look only at rows added since the last.
 */
export class DaemonBinding {
  private readonly dbPath: string;
  private pid: number | null = null;
  private lastPidLook = -Infinity;
  private lastCheck = -Infinity;
  private signature = '';
  private connection: Connection | null = null;
  private lastId = 0;
  private thread: string | null = null;

  private readonly now: () => number;
  private readonly findPid: (pane: string) => number | null;
  private readonly started: (pid: number) => number | null;

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
      findPid?: (pane: string) => number | null;
      started?: (pid: number) => number | null;
    } = {}
  ) {
    this.dbPath = path.join(codexHome, 'logs_2.sqlite');
    this.now = seams.now ?? Date.now;
    this.findPid = seams.findPid ?? tuiPidForPane;
    this.started = seams.started ?? processStart;
  }

  /** The thread the pane's Codex shows, or null when the log cannot say. */
  threadId(): string | null {
    const now = this.now();
    if (now - this.lastCheck < CHECK_MS) return this.thread;
    this.lastCheck = now;
    const Db = sqliteDatabase();
    if (!Db) return null;
    const signature = this.stat();
    if (!signature) return (this.thread = null);
    if (signature === this.signature && this.connection) return this.thread;
    if (this.pid === null && now - this.lastPidLook >= PID_RETRY_MS) {
      this.lastPidLook = now;
      this.pid = this.findPid(this.pane);
    }
    if (this.pid === null) return null;
    let db: Database | null = null;
    try {
      db = new Db(this.dbPath, { readOnly: true, timeout: 200 });
      if (!this.connection) {
        const started = this.started(this.pid);
        const since = started !== null ? started - 2 : (this.startMs ?? now) / 1000 - 300;
        this.connection = findConnection(db, { pid: this.pid, since });
        if (!this.connection) return null;
      }
      const latest = latestThread(db, this.connection, this.lastId);
      this.lastId = latest.lastId;
      if (latest.threadId) this.thread = latest.threadId;
      this.signature = signature;
      return this.thread;
    } catch {
      return this.thread;
    } finally {
      db?.close();
    }
  }

  /** The database's and its write-ahead log's size and mtime: the log changed when this does. */
  private stat(): string | null {
    try {
      const db = fs.statSync(this.dbPath);
      let wal = '';
      try {
        const w = fs.statSync(`${this.dbPath}-wal`);
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
