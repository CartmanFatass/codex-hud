import { withDistLock } from '../../../scripts/dist-lock.mjs';

const { runWorkflow } = await withDistLock(() => import('../../../dist/mcp/workflow-runner.js'));
await runWorkflow(process.argv[2]);
