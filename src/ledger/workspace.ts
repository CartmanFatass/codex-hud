import { canonicalJson } from '../core/canonical.js';
import { captureWorkspace } from '../core/execution.js';
import type { RunWorkspaceSnapshot } from '../core/types/observation.js';
import type { Ledger } from './ledger.js';
import { insertRecord, readRun, validateWorkspace } from './records.js';

export async function captureRunWorkspace(
  ledger: Ledger,
  runId: string,
  supplied: RunWorkspaceSnapshot,
  at: number
): Promise<void> {
  const snapshot = JSON.parse(canonicalJson(supplied)) as RunWorkspaceSnapshot;
  validateWorkspace(snapshot);
  await ledger.transaction((tx) => {
    const capture = captureWorkspace(readRun(tx, runId), snapshot, at);
    tx.run('UPDATE runs SET workspace_snapshot=? WHERE run_id=?', canonicalJson(capture.run.workspaceSnapshot), runId);
    insertRecord(tx, 'events', capture.event);
  });
}
