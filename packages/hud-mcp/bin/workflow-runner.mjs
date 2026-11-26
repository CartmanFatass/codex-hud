import { withDistLock } from '../../../scripts/dist-lock.mjs';

if (process.send) {
  // The full sealed-effect import graph is pinned before the launcher grants permission.
  const land = await withDistLock(() => import('../../../dist/mcp/land-workflow.js')).catch(() => null);
  if (land) process.once('message', land.runLandWorkflow);
  if (process.connected) process.send(land ? 'ready' : 'load-failed', () => {});
} else if (process.argv[2] === '--ticket-edits') {
  const { drainTicketEdits } = await withDistLock(() => import('../../../dist/mcp/ticket-edit-queue.js'));
  await drainTicketEdits(process.env.HUD_HOME, process.argv[3]);
} else {
  const { runWorkflow } = await withDistLock(() => import('../../../dist/mcp/workflow-runner.js'));
  await runWorkflow(process.argv[2]);
}
