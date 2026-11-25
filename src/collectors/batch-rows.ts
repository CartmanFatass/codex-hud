/** The fixed batches a panel shows and controls, from their flow headers alone. Off the paint path. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { batchActive, isBatchId, type Batch } from '../mcp/batch-state.js';
import { headerScanner } from '../workflows/header-scan.js';
import { runVisible } from '../workflows/scope.js';
import type { ThinJobScope } from './thin-jobs.js';
import type { WorkBatch } from './workboard-types.js';

/** An ended batch stays listed this long after its last write, so the totals a stop leaves can be read. */
const ENDED_MS = 60 * 60_000;
const scan = headerScanner();

/** Unfinished batches first, newest first; the same visibility as `hud_read` on the batch. */
export function readBatchRows(home: string, scope: ThinJobScope, now = Date.now()): WorkBatch[] {
  const { files, header } = scan(home);
  const rows = files.flatMap((file) => {
    if (!file.endsWith('.json') || !isBatchId(file.slice(0, -5))) return [];
    try {
      const b = header<Batch>(file);
      if (!b?.scale || !b.totals || !runVisible(b, scope.pane, scope.project ?? undefined)) return [];
      const open = batchActive(b) || b.state === 'paused';
      if (!open && now - fs.statSync(join(home, 'flows', file)).mtimeMs > ENDED_MS) return [];
      const row: WorkBatch = { flow: b.flow, role: b.scale.role, state: b.state, reason: b.reason, count: b.scale.count, totals: b.totals };
      return [{ row, open, at: b.created_at }];
    } catch { return []; } // An unreadable or vanished header has no row.
  });
  return rows.sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at).map((r) => r.row);
}
