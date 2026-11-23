import { withDistLock } from '../../../scripts/dist-lock.mjs';

const { runTicketQueue } = await withDistLock(() => import('../../../dist/mcp/ticket-queue-runner.js'));
await runTicketQueue(process.argv[2]);
