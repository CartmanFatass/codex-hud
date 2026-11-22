import { withDistLock } from '../../../scripts/dist-lock.mjs';
export const { sonicState, sonicChildren, sonicCollectPrompt } = await withDistLock(() => import('../../../dist/worker/sonic-jobs.js'));
