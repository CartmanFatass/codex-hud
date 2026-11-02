import type { LedgerEvent, Run } from '../core/types/execution.js';
import type { Ledger } from './ledger.js';
import { decodeRecord, readRun } from './records.js';

/** B6 fixes runId on entry and uses these committed per-run cursors; reading never writes. */
export function readRunEventPage(
  ledger: Ledger,
  runId: string,
  afterSeq = 0,
  limit = 100
): {
  current: Run;
  events: LedgerEvent[];
  nextSeq: number;
  asOfSeq: number;
  hasMore: boolean;
} {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new TypeError('invalid_event_cursor');
  return ledger.snapshot((tx) => {
    const asOfSeq = Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')?.seq);
    const current = readRun(tx, runId);
    const rows = tx.all(
      'SELECT * FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?',
      runId,
      afterSeq,
      asOfSeq,
      limit + 1
    );
    const events = rows.slice(0, limit).map((row) => decodeRecord<LedgerEvent>(row));
    return { current, events, nextSeq: events.at(-1)?.seq ?? afterSeq, asOfSeq, hasMore: rows.length > limit };
  });
}
