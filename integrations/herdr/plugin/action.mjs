import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { runSelectSendAction } = await withDistLock(() => import('../../../dist/cli/select-send.js'));
process.exitCode = await runSelectSendAction(process.env);
