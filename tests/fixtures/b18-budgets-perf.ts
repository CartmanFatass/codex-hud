import type { ExportInputRecord } from '../../src/core/types/export.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { goldenExportInput } from './contracts/observation-export.js';

const runtimeSkip = ledgerRuntimeSupported() ? false : 'B18 requires Node 22.x >=22.13 or >=24 (23 unsupported)';
const benchmarkSkip =
  runtimeSkip ||
  (process.env.HUD_EXPORT_BENCHMARK === '1'
    ? false
    : 'Run HUD_EXPORT_BENCHMARK=1 for isolated export budget measurements');
const base: ExportInputRecord = {
  ...goldenExportInput().records[0],
  linkId: 'b18-link',
  runId: 'b18-run',
  linkState: 'pending',
  runState: 'starting',
  isCurrentRun: true,
  currentOwner: false,
  parentRef: null,
  childRef: null,
  relationshipConfirmed: false,
  runHandshake: { state: 'pending', reason: null },
  workspaceSnapshot: null,
  createdAt: 1700000000000,
  cwdCapturedAt: 1700000000000,
  startedAt: null,
  endedAt: null,
};
export { runtimeSkip, benchmarkSkip, base };
