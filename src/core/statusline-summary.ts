/** D3 bounded index fallback. No collectors, transcript reads, tree construction or writes. */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { makeSourceId, sameSessionRef, sessionRefKey, validateSessionRef } from './identity.js';
import type { SessionRef } from './types/identity.js';
import type { Coverage, ObservationStamp, StatusProjection } from './types/observation.js';
import { openObservationStore, type ObservationStore } from './observation-store.js';
import { projectFreshness } from './observation.js';
import { PrivateLedgerGate } from '../ledger/local-manager.js';
import { loadLedgerSqlite } from '../ledger/runtime.js';
import { readDelegationSummary } from './delegation-summary-store.js';
import { delegationSummaryStatusline } from './delegation-summary-schema.js';

export interface StatuslineChild {
  key: string;
  ref: SessionRef | null;
  label: string;
  backend: string;
  linkState: string;
  run: null | {
    id: string;
    state: string;
    mode: string;
    generation: number;
    createdAt: number;
    endedAt: number | null;
    cancelRequestedAt: number | null;
  };
  status: StatusProjection | null;
  stamp: ObservationStamp | null;
  coverage: Coverage | null;
  unavailableReason: string | null;
  conflict?: { count: number; since: number } | null;
}
export interface StatuslineSummary {
  state: 'partial' | 'unavailable';
  reason: string;
  source: 'parent_index' | 'committed_summary' | null;
  asOfSeq: number | null;
  /** Unknown, not zero. The bounded direct-parent index cannot prove a tree total. */
  treeCounts: null;
  children: StatuslineChild[];
  limitReached: boolean;
  elapsedMs: number;
}

function privatePath(file: string, directory: boolean): string {
  const stat = lstatSync(file);
  if (
    realpathSync(file) !== file ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('unsafe_path');
  return `${stat.dev}:${stat.ino}`;
}
function projectionPaths(home: string, sourceId: string): Map<string, string> {
  const result = new Map<string, string>();
  const dir = join(home, 'sources', sourceId);
  for (const path of [join(home, 'sources'), dir]) result.set(path, privatePath(path, true));
  const file = join(dir, 'observation.sqlite');
  result.set(file, privatePath(file, false));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      result.set(file + suffix, privatePath(file + suffix, false));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}

/** Source selection is explicit; stdin paths and bare session IDs never select a ledger owner. */
export function statuslineRef(
  input: unknown,
  sourceRoot: string | undefined
): { ref: SessionRef; root: string } | null {
  if (!sourceRoot || !isAbsolute(sourceRoot) || sourceRoot.includes('\0')) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 256) return null;
  if (value.agent_id !== undefined && (typeof value.agent_id !== 'string' || value.agent_id.length > 256)) return null;
  const root = realpathSync(sourceRoot);
  if (!lstatSync(root).isDirectory()) return null;
  const ref: SessionRef = {
    harness: 'claude',
    sourceId: makeSourceId('claude', root),
    sessionId: value.session_id,
    threadId: typeof value.agent_id === 'string' && value.agent_id ? value.agent_id : null,
  };
  validateSessionRef(ref);
  return { ref, root };
}

type Row = Record<string, SQLOutputValue>;
const text = (r: Row, key: string): string => {
  if (typeof r[key] !== 'string') throw new Error('invalid_ledger');
  return r[key] as string;
};
const integer = (r: Row, key: string): number => {
  if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 0) throw new Error('invalid_ledger');
  return Number(r[key]);
};
const nullableInteger = (r: Row, key: string) => (r[key] === null ? null : integer(r, key));
function refValue(raw: SQLOutputValue): SessionRef | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('invalid_ledger');
  const tuple: unknown = JSON.parse(raw);
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new Error('invalid_ledger');
  const ref = { harness: tuple[0], sourceId: tuple[1], sessionId: tuple[2], threadId: tuple[3] } as SessionRef;
  validateSessionRef(ref);
  return ref;
}

/** One indexed direct-parent query, at most 50 rows. All lifecycle/status evidence remains read-only. */
export async function readStatuslineSummary(
  input: unknown,
  env: Readonly<NodeJS.ProcessEnv>,
  sourceRoot?: string,
  options: { budgetMs?: number; maxChildren?: number; nowMs?: number; clock?: () => number } = {}
): Promise<StatuslineSummary> {
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const budget = Math.min(20, options.budgetMs ?? 20);
  const maximum = Math.min(50, options.maxChildren ?? 50);
  const unavailable = (reason: string): StatuslineSummary => ({
    state: 'unavailable',
    reason,
    source: null,
    asOfSeq: null,
    treeCounts: null,
    children: [],
    limitReached: false,
    elapsedMs: clock() - started,
  });
  let db: DatabaseSync | undefined;
  const stores = new Map<string, ObservationStore | null>();
  const pins = new Map<string, Map<string, string>>();
  let result = unavailable('read_unavailable');
  const deadline = () => {
    if (clock() - started >= budget) throw new Error('budget_exceeded');
  };
  try {
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error('invalid_budget');
    const selected = statuslineRef(input, sourceRoot ?? env.CLAUDE_CONFIG_DIR);
    if (!selected) throw new Error('identity_unavailable');
    const { ref, root } = selected;
    const home = env.HUD_HOME ?? (env.HOME ? join(env.HOME, '.hud') : '');
    if (!isAbsolute(home) || home.includes('\0')) throw new Error('ledger_unavailable');
    const cached = readDelegationSummary(home, ref, {
      nowMs: options.nowMs,
      budgetMs: budget - (clock() - started),
      clock,
    });
    deadline();
    if (cached) {
      const summary = delegationSummaryStatusline(cached, options.nowMs ?? Date.now());
      if (summary.children.length > maximum) {
        summary.children = summary.children.slice(0, maximum);
        summary.limitReached = true;
      }
      return { ...summary, elapsedMs: clock() - started };
    }
    const gate = new PrivateLedgerGate(home);
    deadline();
    const { DatabaseSync } = await loadLedgerSqlite();
    deadline();
    db = new DatabaseSync(gate.path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0; BEGIN');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('ledger_unavailable');
    const source = db.prepare('SELECT harness,root_path FROM sources WHERE source_id=?').get(ref.sourceId);
    if (source?.harness !== ref.harness || source.root_path !== root) throw new Error('identity_unavailable');
    const parentKey = sessionRefKey(ref);
    if (!db.prepare('SELECT 1 FROM sessions WHERE session_ref=?').get(parentKey))
      throw new Error('identity_unavailable');
    const asOfSeq = Number(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()?.seq);
    if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0) throw new Error('ledger_unavailable');
    deadline();
    // The correlated lookups use existing indexes; never walk descendants or read report/event bodies.
    const rows = db
      .prepare(
        `SELECT l.link_id,l.child_ref,l.backend,l.state AS link_state,l.current_owner,
      substr(coalesce(l.label,l.role,''),1,256) AS label,
      r.run_id,r.state AS run_state,r.mode,r.expected_generation,r.source_id,r.harness,
      r.created_at,r.ended_at,r.cancel_requested_at,
      b.session_ref AS bound_ref,b.binding_generation,
      (SELECT max(e.seq) FROM events e WHERE e.link_id=l.link_id) AS link_seq
      FROM (SELECT link_id,child_ref,backend,state,label,role,current_owner
        FROM links INDEXED BY links_parent WHERE parent_ref=? LIMIT ?) l
      LEFT JOIN runs r ON r.run_id=(SELECT run_id FROM runs WHERE link_id=l.link_id ORDER BY run_seq DESC LIMIT 1)
      LEFT JOIN child_bindings b ON b.run_id=r.run_id AND b.is_current=1
`
      )
      .all(parentKey, maximum);
    const children: StatuslineChild[] = [];
    let remainingBytes = 256 * 1024;
    const nowMs = options.nowMs ?? Date.now();
    for (const row of rows) {
      deadline();
      // Cap candidate work BEFORE excluding historical owners; never scan past the first page.
      if (
        row.current_owner !== 1 &&
        !(row.child_ref === null && ['pending', 'claimed', 'failed'].includes(String(row.link_state)))
      )
        continue;
      const childRef = refValue(row.child_ref);
      const run =
        row.run_id === null
          ? null
          : {
              id: text(row, 'run_id'),
              state: text(row, 'run_state'),
              mode: text(row, 'mode'),
              generation: integer(row, 'expected_generation'),
              createdAt: integer(row, 'created_at'),
              endedAt: nullableInteger(row, 'ended_at'),
              cancelRequestedAt: nullableInteger(row, 'cancel_requested_at'),
            };
      const child: StatuslineChild = {
        key: text(row, 'link_id'),
        ref: childRef,
        label: text(row, 'label'),
        backend: text(row, 'backend'),
        linkState: text(row, 'link_state'),
        run,
        status: null,
        stamp: null,
        coverage: null,
        unavailableReason: 'projection_unavailable',
      };
      children.push(child);
      const boundRef = refValue(row.bound_ref);
      if (
        !childRef ||
        !run ||
        !boundRef ||
        !sameSessionRef(childRef, boundRef) ||
        childRef.sourceId !== row.source_id ||
        childRef.harness !== row.harness ||
        row.binding_generation !== run.generation
      )
        continue;
      try {
        if (!stores.has(childRef.sourceId)) {
          pins.set(childRef.sourceId, projectionPaths(home, childRef.sourceId));
          stores.set(
            childRef.sourceId,
            await openObservationStore({ hudHome: home, sourceId: childRef.sourceId, readOnly: true, busyTimeoutMs: 0 })
          );
        }
        deadline();
        const committed =
          remainingBytes > 0
            ? stores.get(childRef.sourceId)?.readProjection(childRef, Math.min(32 * 1024, remainingBytes), (bytes) => {
                remainingBytes -= bytes;
              })
            : null;
        if (!committed) continue;
        const status = committed.summary.statusProjection;
        const stamp = status.observationStamp;
        // A source snapshot is not a cross-database transaction. A newer link event invalidates it.
        if (
          !stamp ||
          stamp.runId !== run.id ||
          stamp.bindingGeneration !== run.generation ||
          stamp.inputLedgerSeq !== asOfSeq ||
          (typeof row.link_seq === 'number' && stamp.inputLedgerSeq < row.link_seq) ||
          !sameSessionRef(stamp.ref, childRef) ||
          status.observedAt > nowMs ||
          nowMs - status.observedAt > 5000 ||
          !committed.summary.loaded ||
          committed.summary.conflict ||
          status.isRunTerminal !== ['ended', 'failed', 'cancelled'].includes(run.state)
        )
          continue;
        child.status = {
          ...status,
          freshness: projectFreshness(status.freshness.sources, status.freshness.requiredSourceIds, nowMs),
        };
        child.stamp = stamp;
        child.coverage = committed.summary.coverage;
        child.unavailableReason = null;
      } catch (error) {
        if (error instanceof Error && error.message === 'budget_exceeded') throw error;
        stores.set(childRef.sourceId, stores.get(childRef.sourceId) ?? null);
      }
    }
    db.exec('COMMIT');
    gate.check();
    for (const paths of pins.values())
      for (const [path, identity] of paths) {
        if (privatePath(path, lstatSync(path).isDirectory()) !== identity) throw new Error('projection_replaced');
      }
    deadline();
    result = {
      state: 'partial',
      reason: 'direct_children_only',
      source: 'parent_index',
      asOfSeq,
      treeCounts: null,
      children,
      limitReached: rows.length === maximum,
      elapsedMs: clock() - started,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    result = unavailable(
      ['budget_exceeded', 'identity_unavailable', 'ledger_unavailable', 'invalid_budget'].includes(reason)
        ? reason
        : 'read_unavailable'
    );
  } finally {
    // Close belongs to the complete data-entry budget too. Cleanup cannot suppress stdin line 1.
    for (const store of stores.values()) {
      try {
        store?.close();
      } catch {
        result = unavailable('read_unavailable');
      }
    }
    try {
      db?.close();
    } catch {
      result = unavailable('read_unavailable');
    }
  }
  const elapsedMs = clock() - started;
  return elapsedMs >= budget ? { ...unavailable('budget_exceeded'), elapsedMs } : { ...result, elapsedMs };
}
