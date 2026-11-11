/** Open the current pi session's display beside its local herdr pane. */
import { join } from 'node:path';
import { openPanelPane } from '../../cli/panel-pane.js';
import type { PiPackageBinding, PiPackageContext } from './package-context.js';

export function openPiPanel(binding: PiPackageBinding, ctx: PiPackageContext, env: NodeJS.ProcessEnv) {
  return openPanelPane(
    [
      binding.node,
      join(binding.release, 'bin/hud'),
      'panel',
      '--here',
      '--harness',
      'pi',
      '--session',
      ctx.sessionManager.getSessionId(),
      '--source',
      ctx.sessionManager.getSessionDir(),
    ],
    ctx.cwd,
    env
  );
}
