// Load the whole runner generation before the parent grants permission to land.
import { withDistLock } from '../../../scripts/dist-lock.mjs';

const status = await withDistLock(() => import('../../../dist/mcp/land-runner.js'))
  .then(() => 'ready', () => 'load-failed');
if (process.connected) process.send(status, () => {});
