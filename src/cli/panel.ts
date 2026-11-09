import { join } from 'node:path';
import { foreground, installationRoot } from './compat.js';
import type { HudIO } from './link-export.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { CliError } from './runtime.js';

export const PANEL_HELP = `Usage: hud panel [--root <namespace/session-id>]

Open the interactive HUD panel in the current terminal.
--root selects observations only, never execution/control identity.
Without --root the existing all-delegations view is unchanged.
When a local ledger is available, the panel owns a bounded observation worker.
If the worker is unavailable, the panel continues with read-only observations.
Presentation aliases: HUD_THEME, HUD_DENSITY, HUD_GLYPHS, HUD_ICONS, HUD_LOOK,
HUD_REDUCED_MOTION, HUD_CONTEXT, HUD_TREE_WIDTH, HUD_CLEAR_SCROLLBACK.
HUD_SETTINGS_PATH selects the existing settings file. Present HUD_* values win
over their CODEX_HUD_* counterparts, including empty values. Saved display
settings retain priority; NO_COLOR still disables color.
`;

/** Shared CLI validation; no caller identity, routing selection or storage writes. */
export function panelRoot(args: readonly string[]): string | null {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--root') throw new CliError('invalid_arguments');
  try {
    return formatRosterRoot(parseRosterRoot(args[1]!));
  } catch {
    throw new CliError('invalid_arguments');
  }
}

/** Use the installed panel entry, with inherited terminal and normal signal handling. */
export function panelCommand(io: HudIO, args: readonly string[] = []): Promise<number> {
  const root = panelRoot(args);
  return foreground(
    { argv: [process.execPath, join(installationRoot(), 'dist/tree-page.js')] },
    {
      ...io.env,
      CODEX_HUD_PANEL_ALL_DELEGATIONS: root ? '0' : '1',
      ...(root ? { CODEX_HUD_PANEL_ROOT: root } : {}),
      CODEX_HUD_STANDALONE_PANEL: '1',
    }
  );
}
