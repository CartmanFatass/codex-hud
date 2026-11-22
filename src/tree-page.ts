import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPanel } from './panel/controller.js';
import { restoreTerminal, type InstallCleanup } from './panel/lifecycle.js';
import { PanelReload } from './utils/panel-reload.js';

export { PanelJobPipeline } from './panel/job-pipeline.js';

/** Live keyboard/mouse workbench beside the compact HUD. */
export async function runLivePage(options: { installCleanup?: InstallCleanup } = {}): Promise<void> {
  // Observe the entry generation and capture the launch environment before panel setup.
  return runPanel(new PanelReload(), options.installCleanup);
}

export function runPanelEntry(): void {
  const onCrash = (err: unknown) => {
    restoreTerminal();
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  runLivePage()
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
      restoreTerminal();
      process.exit(process.exitCode ?? 0);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runPanelEntry();
