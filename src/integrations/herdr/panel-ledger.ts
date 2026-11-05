/** A fixed-run read-only host check. SQLite/history work never runs on the panel thread. */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { decodeRecord } from '../../ledger/records.js';
import { loadLedgerSqlite, ledgerRuntimeSupported } from '../../ledger/runtime.js';
import { registeredSupervisor } from '../../core/supervision.js';
import { sessionRefKey, validateSessionRef } from '../../core/identity.js';
import type { LedgerReadRun } from '../../core/ledger-read.js';
import type { LedgerEvent } from '../../core/types/execution.js';
import type { ChildBinding } from '../../core/types/identity.js';
import type { Link } from '../../core/types/lifecycle.js';

type Row = Record<string, SQLOutputValue>;
export interface PanelLedgerSnapshot {
  ledgerId: string;
  asOfSeq: number;
  run: LedgerReadRun;
  link: Link;
  bindings: ChildBinding[];
  conflict: boolean;
}
export interface PanelLedgerPin {
  dev: number;
  ino: number;
}
export function panelLedgerPin(path: string, expected?: PanelLedgerPin): PanelLedgerPin {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1 ||
    (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
  )
    throw new Error('ledger_identity_unavailable');
  return { dev: stat.dev, ino: stat.ino };
}
const RUN_COLUMNS = `run_id,link_id,run_seq,operation,target_session_ref,source_id,harness,expected_generation,
mode,launch_cwd,workspace_snapshot,project_origin,supervision_strategy,scope_kind,scope_ref,state,locator,
launch_phase,launch_call_id,launch_correlation_id,launch_message_id,supervisor_pid,supervisor_proc_start,
heartbeat_at,heartbeat_seq,heartbeat_mono_ms,cancel_requested_at,submission_fenced_at,created_at,started_at,
ended_at,exit_code,exit_signal,exit_source,shell_status,shell_signal,terminal_evidence_id,orphan_policy`;
const LINK_COLUMNS = `link_id,state,parent_caller,parent_context_id,parent_context_generation,parent_ref,child_ref,
current_owner,backend,role,label,brief_path,task_digest,report_path,predecessor,routing,created_at,claimed_at,bound_at,closed_at`;
const BINDING_COLUMNS = `binding_id,run_id,session_ref,binding_generation,caller_id,caller_context_id,context_generation,
bound_by,capabilities,evidence_id,is_current,created_at,revoked_at`;
// Clamp text in SQLite before allocating/decoding it in JS. Oversize rows are rejected, never accepted truncated.
const columns = (names: string) =>
  names
    .split(',')
    .map((n) => n.trim())
    .map((n) => `CASE WHEN typeof(${n})='text' THEN substr(${n},1,8193) ELSE ${n} END AS ${n}`)
    .join(',');
function bounded(row: Row | undefined): Row {
  if (
    !row ||
    Object.values(row).some((v) => (typeof v === 'string' ? Buffer.byteLength(v) > 8192 : v instanceof Uint8Array))
  )
    throw new Error('ledger_row_unavailable');
  return row;
}
function snapshot(
  db: DatabaseSync,
  path: string,
  pin: PanelLedgerPin,
  linkId: string,
  runId: string
): PanelLedgerSnapshot {
  panelLedgerPin(path, pin);
  db.exec('BEGIN');
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('ledger_schema_unavailable');
    const ledgerId = bounded(
      db.prepare('SELECT substr(ledger_id,1,8193) AS ledger_id FROM ledger_metadata WHERE singleton=1').get()
    ).ledger_id;
    if (typeof ledgerId !== 'string' || !ledgerId) throw new Error('ledger_identity_unavailable');
    const asOfSeq = Number(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()?.seq);
    const raw = bounded(
      db.prepare(`SELECT ${columns(RUN_COLUMNS)} FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1`).get(linkId)
    );
    if (raw.run_id !== runId) throw new Error('run_changed');
    const { supervisor_pid: pid, supervisor_proc_start: start, ...safe } = raw;
    const run = decodeRecord<LedgerReadRun>(safe);
    const claim = bounded(
      db
        .prepare(
          'SELECT supervisor_pid,substr(supervisor_proc_start,1,8193) AS supervisor_proc_start FROM claims WHERE run_id=?'
        )
        .get(runId)
    );
    const events = db
      .prepare(
        `SELECT ${columns('seq,link_id,run_id,kind,payload,at')} FROM events WHERE run_id=? AND kind='supervisor.registered' ORDER BY seq LIMIT 2`
      )
      .all(runId)
      .map((row) => decodeRecord<LedgerEvent>(bounded(row)));
    const registered = registeredSupervisor(run, events);
    run.supervisor =
      registered &&
      registered.pid === pid &&
      registered.proc_start === start &&
      registered.pid === claim.supervisor_pid &&
      registered.proc_start === claim.supervisor_proc_start
        ? registered
        : null;
    const link = decodeRecord<Link>(
      bounded(db.prepare(`SELECT ${columns(LINK_COLUMNS)} FROM links WHERE link_id=?`).get(linkId))
    );
    const bindings = db
      .prepare(
        `SELECT ${columns(BINDING_COLUMNS)} FROM child_bindings WHERE run_id=? AND is_current=1 AND revoked_at IS NULL LIMIT 2`
      )
      .all(runId)
      .map((row) => decodeRecord<ChildBinding>(bounded(row)));
    for (const ref of [link.parentRef, link.childRef, run.targetSessionRef, ...bindings.map((b) => b.sessionRef)])
      if (ref) validateSessionRef(ref);
    const refs = [...new Set([link.childRef, run.targetSessionRef].filter((r) => r !== null).map(sessionRefKey))];
    // Preserve cross-link conflicts for the same complete SessionRef. No payload/history rows leave SQLite.
    const conflict = !!db
      .prepare(
        `SELECT 1 AS found FROM evidence e
      LEFT JOIN runs r ON r.run_id=e.run_id LEFT JOIN links l ON l.link_id=coalesce(e.link_id,r.link_id)
      WHERE e.kind='conflict' AND (e.link_id=? OR r.link_id=? OR
        coalesce(r.target_session_ref,l.child_ref) IN (SELECT value FROM json_each(?))) LIMIT 1`
      )
      .get(linkId, linkId, JSON.stringify(refs));
    panelLedgerPin(path, pin);
    db.exec('COMMIT');
    return { ledgerId, asOfSeq, run, link, bindings, conflict };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* The original read remains unavailable. */
    }
    throw error;
  }
}

export function openPanelLedgerReader(path: string, linkId: string, runId: string, timeoutMs = 500) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 500) throw new Error('invalid_read_deadline');
  const pin = panelLedgerPin(path);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'panel-ledger', path, pin, linkId, runId },
    resourceLimits: { maxOldGenerationSizeMb: 32 },
    env: {},
    execArgv: [],
  });
  let closed = false;
  let termination: Promise<number> | null = null;
  let pending: { resolve: (s: PanelLedgerSnapshot) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null =
    null;
  const stop = () => {
    closed = true;
    termination ??= worker.terminate();
    return termination;
  };
  const fail = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('panel_ledger_unavailable'));
      pending = null;
    }
    void stop();
  };
  worker.on('error', fail);
  worker.on('exit', () => {
    closed = true;
    if (pending) fail();
  });
  worker.on('message', (message: { ok: boolean; snapshot?: PanelLedgerSnapshot }) => {
    if (!pending) return;
    const item = pending;
    pending = null;
    clearTimeout(item.timer);
    if (message.ok && message.snapshot) item.resolve(message.snapshot);
    else {
      item.reject(new Error('panel_ledger_unavailable'));
      void stop();
    }
  });
  return {
    read(): Promise<PanelLedgerSnapshot> {
      if (closed || pending) return Promise.reject(new Error('panel_ledger_unavailable'));
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(fail, timeoutMs) };
        worker.postMessage('read');
      });
    },
    async close(): Promise<void> {
      fail();
      await stop();
    },
  };
}

if (!isMainThread && workerData?.kind === 'panel-ledger') {
  let db: DatabaseSync | null = null;
  try {
    if (!ledgerRuntimeSupported()) throw new Error('ledger_runtime_unavailable');
    panelLedgerPin(workerData.path, workerData.pin);
    const sqlite = await loadLedgerSqlite();
    db = new sqlite.DatabaseSync(workerData.path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0');
    parentPort!.on('message', () => {
      try {
        parentPort!.postMessage({
          ok: true,
          snapshot: snapshot(db!, workerData.path, workerData.pin, workerData.linkId, workerData.runId),
        });
      } catch {
        parentPort!.postMessage({ ok: false });
      }
    });
  } catch {
    db?.close();
    parentPort!.postMessage({ ok: false });
  }
}
