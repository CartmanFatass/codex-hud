import type { LedgerEvent } from '../types/execution.js';

export interface WakeMessageDetails {
  linkId: string;
  runs: Array<{ runId: string; kind: string; seq: number }>;
  throughSeq: number;
  contextGeneration: number;
}
/** No report payload, source path or suggested cursor enters a native wake. */
export function wakeMessage(details: WakeMessageDetails): string {
  const token = (s: string) => encodeURIComponent(s);
  const runs = [...new Set(details.runs.map((e) => token(e.runId)))];
  const kinds = [
    ...new Set(
      details.runs.map((e) =>
        e.kind === 'report.received' ? 'report' : e.kind === 'run.terminal' ? 'run_terminal' : 'uncertain'
      )
    ),
  ];
  const tail = ` kinds=${kinds.join(',')} throughSeq=${details.throughSeq} stale=false — call delegate_wait{runId, afterSeq:<your cursor>} and drain until hasMore=false; the ledger is the truth.`;
  const prefix = `[hud] wake link=${token(details.linkId)} run=`;
  const line = prefix + runs.join(',') + tail;
  if (Buffer.byteLength(line) <= 512) return line;
  // Pathological synthetic identifiers cannot fit the transport. Do not truncate
  // an ID into a different target; ask for an authorized ledger resynchronization.
  return `[hud] wake throughSeq=${details.throughSeq} stale=false — read the ledger with delegate_status; use your own cursor with delegate_wait and drain until hasMore=false; the ledger is the truth.`;
}
export function wakeDetails(linkId: string, contextGeneration: number, events: LedgerEvent[]): WakeMessageDetails {
  return {
    linkId,
    contextGeneration,
    runs: events.map((e) => ({ runId: e.runId!, kind: e.kind, seq: e.seq })),
    throughSeq: Math.max(...events.map((e) => e.seq)),
  };
}
