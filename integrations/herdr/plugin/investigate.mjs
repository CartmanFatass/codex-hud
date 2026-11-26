import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { runInvestigatePaneAction } = await withDistLock(() => import('../../../dist/cli/select-send.js'));
process.exitCode = await runInvestigatePaneAction(process.env);
