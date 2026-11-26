// Internal launcher for entry scripts with no dedicated bin.
import { pathToFileURL } from 'node:url';
import { withDistLock } from '../scripts/dist-lock.mjs';

switch (process.argv[2]) {
  case 'bar': {
    const { runBar } = await withDistLock(() => import('../dist/index.js'));
    await runBar();
    break;
  }
  case 'codex-launch': {
    const { runCodexLaunch } = await withDistLock(() => import('../dist/cli/codex-launch.js'));
    process.exitCode = await runCodexLaunch(process.argv.slice(3));
    break;
  }
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
  case 'advise': {
    const { adviseCommand } = await withDistLock(() => import('../dist/cli/advise.js'));
    const args = process.argv.slice(3);
    const wantsHelp = args.includes('--help') || args.includes('-h');
    process.exitCode = await adviseCommand(
      args.length ? args : ['--stdin'],
      wantsHelp
        ? { env: process.env, stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } }
        : { env: process.env, stdout: () => {}, stderr: () => {} }
    );
    break;
  }
  default:
    throw new Error('Unknown HUD dist entry');
}
