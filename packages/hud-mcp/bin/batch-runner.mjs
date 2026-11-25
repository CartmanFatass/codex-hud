import { withDistLock } from '../../../scripts/dist-lock.mjs';

const { runBatch } = await withDistLock(() => import('../../../dist/mcp/batch-runner.js'));
await runBatch(process.argv[2]);
