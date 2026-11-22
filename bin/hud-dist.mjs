// Internal launcher for entry scripts with no dedicated bin.
import { pathToFileURL } from 'node:url';
import { withDistLock } from '../scripts/dist-lock.mjs';

switch (process.argv[2]) {
  case 'bar':
    await withDistLock(() => import('../dist/index.js'));
    break;
  case 'panel': {
    const { runPanelEntry } = await withDistLock(() => import('../dist/tree-page.js'));
    runPanelEntry();
    break;
  }
  case 'probe-panel': {
    const entry = pathToFileURL(process.argv[3]);
    await withDistLock(() => import(entry.href), new URL('../..', entry));
    break;
  }
  case 'brief':
    await withDistLock(() => import('../dist/brief-dry-run.js'));
    break;
  case 'statusline-setting': {
    const { loadSettings } = await withDistLock(() => import('../dist/settings.js'));
    process.stdout.write(loadSettings().statusline ? '1' : '0');
    break;
  }
  case 'forward': {
    const { runForwardWorker } = await withDistLock(() => import('../dist/statusline-parity/forward-worker.js'));
    await runForwardWorker(process.argv[3]);
    break;
  }
  default:
    throw new Error('Unknown HUD dist entry');
}
