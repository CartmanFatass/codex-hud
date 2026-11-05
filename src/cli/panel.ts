import { join } from 'node:path';
import { foreground, installationRoot } from './compat.js';
import type { HudIO } from './link-export.js';

export const PANEL_HELP = `Usage: hud panel

Open the interactive HUD panel in the current terminal.
The panel reads available delegation observations; it does not enable observation publication.
`;

/** Use the installed panel entry, with inherited terminal and normal signal handling. */
export function panelCommand(io: HudIO): Promise<number> {
  return foreground(
    { argv: [process.execPath, join(installationRoot(), 'dist/tree-page.js')] },
    {
      ...io.env,
      CODEX_HUD_PANEL_ALL_DELEGATIONS: '1',
      CODEX_HUD_STANDALONE_PANEL: '1',
    }
  );
}
