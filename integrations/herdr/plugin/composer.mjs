import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { runSelectSendComposer } = await withDistLock(() => import('../../../dist/cli/select-send.js'));
process.exitCode = await runSelectSendComposer(process.env);
