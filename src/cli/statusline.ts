import { fileURLToPath } from 'node:url';
import { statuslinePreview } from '../statusline-preview.js';
import { statuslineSettings } from '../statusline-settings.js';
import { readStatuslineSummary } from '../core/statusline-summary.js';
import { renderStatuslineSession } from '../render/statusline-session.js';
import { renderStatuslineSummary } from '../render/statusline-summary.js';
import type { HudIO } from './link-export.js';

export const STATUSLINE_HELP = `Usage: hud statusline [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
       hud statusline settings preview
       hud statusline settings apply --plan ABSOLUTE_FILE
       hud statusline settings restore --backup ABSOLUTE_FILE
       hud-statusline [same arguments]

Render stdin Claude facts, with a bounded read-only delegation line when available.
Delegation source: --source or explicit CLAUDE_CONFIG_DIR; no guessed source/home.
Direct-child fallback is partial, never a full-tree total. Missing data keeps line 1.
No transcript reading, collection, network access or installation by default.
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
  let sourceRoot: string | undefined;
  const widthArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--source') {
      if (sourceRoot !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
        io.stderr('invalid_arguments\n');
        return 2;
      }
      sourceRoot = args[++index];
    } else widthArgs.push(args[index]);
  }
  return statuslinePreview(widthArgs, process.stdin, {
    columns: io.env.COLUMNS,
    ttyColumns: process.stdout.isTTY ? process.stdout.columns : undefined,
    stdout: async (text) => {
      await io.stdout(text);
    },
    stderr: io.stderr,
    render: async (value, width) => {
      const first = renderStatuslineSession(value, width);
      const nowMs = Date.now();
      const summary = await readStatuslineSummary(value, io.env, sourceRoot, { nowMs });
      const second = renderStatuslineSummary(summary, width, nowMs);
      return second ? `${first}\n${second}` : first;
    },
  });
}
