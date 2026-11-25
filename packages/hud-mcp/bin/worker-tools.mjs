import { withDistLock } from '../../../scripts/dist-lock.mjs';
export const { workerJob, capturePiTree, recordStartupShellSession, finishReport, progress, startSonic, watchSonicReady, waitSonic, workerLease, callWorkerTool, workerTools, ask, listWorkerTools } = await withDistLock(() => import('../../../dist/worker/tools.js'));
