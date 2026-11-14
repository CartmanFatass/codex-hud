import { statuslineCommand } from './statusline.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';
import { codexCommand } from './compat.js';
import { panelCommand, PANEL_HELP } from './panel.js';
import { trustCommand } from './trust.js';
import { setupCommand } from './setup.js';
import { watchCommand } from './watch.js';

export async function main(args: readonly string[], io: HudIO): Promise<number> {
  try {
    if (args[0] === 'statusline') return await statuslineCommand(args.slice(1), io);
    if (args[0] === 'panel') {
      if (args.length === 2 && args[1] === '--help') {
        await io.stdout(PANEL_HELP);
        return 0;
      }
      return await panelCommand(io, args.slice(1));
    }
    if (args[0] === 'codex' || args[0] === 'codex-hud') return await codexCommand(args.slice(1), io);
    if (args[0] === 'trust') return await trustCommand(args.slice(1), io);
    if (args[0] === 'setup') return await setupCommand(args.slice(1), io);
    if (args[0] === 'watch') return await watchCommand(args.slice(1), io);
    if (args.length === 1 && args[0] === '--help') {
      await io.stdout(
        'Usage: hud panel --help          Open the interactive panel\n' +
          '       hud statusline --help     Render stdin or manage statusline settings\n' +
          '       hud import --help         Import settings and credentials\n' +
          '       hud trust <dir>           Add a directory to grok, agy and claude trust lists\n' +
          '       hud setup --detect [--cwd DIR]  Print project worker setup as JSON\n' +
          '       hud setup --apply PLAN [--cwd DIR]  Write project worker setup from a plan\n' +
          '       hud setup --remove [--cwd DIR]  Drop project registration\n' +
          '       hud watch [--all]         Stream job change lines for this pane (or all jobs)\n' +
          '       hud codex [ARG ...]        Existing codex-hud launcher (alias: codex-hud)\n' +
          '       hud uninstall [--with names]  Remove commands and extensions; keep HUD data.\n'
      );
      return 0;
    }
    io.stderr('invalid_command: hud panel|statusline|import|trust|setup|watch|codex|codex-hud|uninstall\n');
    return 2;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    io.stderr('internal_or_output_failure\n');
    return 1;
  }
}
