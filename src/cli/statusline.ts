import { fileURLToPath } from 'node:url';
import { statuslinePreview } from '../statusline-preview.js';
import { statuslineSettings } from '../statusline-settings.js';
import type { HudIO } from './link-export.js';

export const STATUSLINE_HELP = `Usage: hud statusline [--width COLUMNS]
       hud statusline settings preview
       hud statusline settings apply --plan ABSOLUTE_FILE
       hud statusline settings restore --backup ABSOLUTE_FILE
       hud-statusline [same arguments]

Render one stdin Claude statusline JSON; no installation by default.
Settings commands are explicit Linux opt-in operations under HOME/.claude.
Preview before apply; keep the returned backup path for exact restore.
USD is the provider's estimated session cost, not an invoice.
See docs/statusline/product-settings.md for safety and recovery limits.
`;

export async function statuslineCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(STATUSLINE_HELP);
    return 0;
  }
  if (args[0] === 'settings') {
    try {
      const result = statuslineSettings(
        args.slice(1),
        io.env.HOME ?? '',
        process.execPath,
        fileURLToPath(new URL('../../bin/hud-statusline', import.meta.url))
      );
      await io.stdout(JSON.stringify(result, null, 2) + '\n');
      return 0;
    } catch {
      io.stderr('statusline_settings_failed: invalid input, changed settings, unsafe path, or unavailable build\n');
      return 2;
    }
  }
  return statuslinePreview(args, process.stdin, {
    columns: io.env.COLUMNS,
    ttyColumns: process.stdout.isTTY ? process.stdout.columns : undefined,
    stdout: async (text) => {
      await io.stdout(text);
    },
    stderr: io.stderr,
  });
}
