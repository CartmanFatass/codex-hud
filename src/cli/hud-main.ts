import { statuslineCommand } from './statusline.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';
import { getHudHome } from '../hud-home.js';
import { allowCouncil } from '../roles/council-grant.js';
import { codexCommand } from './compat.js';
import { panelCommand, PANEL_HELP } from './panel.js';
import { trustCommand } from './trust.js';
import { setupCommand } from './setup.js';
import { ticketsCommand } from './tickets.js';
import { actCommand } from './act.js';
import { watchCommand } from './watch.js';
import { boardCommand } from './board.js';
import { doctorCommand, versionCommand } from './doctor.js';
import { jobStatsCommand } from './job-stats.js';
import { adviseCommand } from './advise.js';

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
    if (args[0] === 'tickets') return await ticketsCommand(args.slice(1), io);
    if (args[0] === 'watch') return await watchCommand(args.slice(1), io);
    if (args[0] === 'council') {
      const mod = args.length === 4 && args[2] === '--via' && args[3] === 'claude-mod';
      if (args[1] !== 'allow' || (!mod && args.length !== 2)) throw new CliError('Usage: hud council allow');
      await allowCouncil(getHudHome(io.env), mod ? 'claude-mod' : 'cli');
      await io.stdout('One council authorized for the next 30 minutes.\n');
      return 0;
    }
    if (args[0] === 'act') return await actCommand(args.slice(1), io);
    if (args[0] === 'board') return await boardCommand(args.slice(1), io);
    if (args[0] === 'advise') return await adviseCommand(args.slice(1), io);
    if (args[0] === 'doctor') return await doctorCommand(args.slice(1), io);
    if (args.length === 1 && args[0] === '--version') return await versionCommand(io);
    if (args[0] === 'stats' || args[0] === 'day') return await jobStatsCommand(args[0], args.slice(1), io);
    if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) {
      await io.stdout(
        'Usage: hud panel --help          Open the interactive panel\n' +
          '       hud statusline --help     Render stdin or manage statusline settings\n' +
          '       hud import --help         Import settings and credentials\n' +
          '       hud trust <dir>           Add a directory to grok, agy and claude trust lists\n' +
          '       hud setup --detect [--cwd DIR]  Print project worker setup as JSON\n' +
          '       hud setup --apply PLAN [--cwd DIR]  Write project worker setup from a plan\n' +
          '       hud setup --remove [--cwd DIR]  Drop project registration\n' +
          '       hud tickets sync [--cwd DIR]  Mirror GitHub parent/sub-issues into .scratch/\n' +
          '       hud unattended --help     Keep selected Objectives moving without a main session\n' +
          '       hud watch [--all]         Stream job change lines for this pane (or all jobs)\n' +
          '       hud act answer|try|retry|stop|pause|resume  Owner actions from a command (--help)\n' +
          '       hud council allow         Authorize one council for 30 minutes\n' +
          '       hud doctor               Check the local installation without changing it\n' +
          '       hud doctor <jobId>       Print one job\'s disk facts without changing it\n' +
          '       hud --version            Print version, build commit and build time\n' +
          '       hud stats [--days N] [--by role|model|route|feature]  Report job usage and outcomes\n' +
          '       hud day [--project]       Summarize today\'s jobs and landings\n' +
          '       hud board [--html] [--cwd DIR] [--out FILE] [--open]  Write the HTML review board\n' +
          '       hud codex [ARG ...]        Existing codex-hud launcher (alias: codex-hud)\n' +
          '       hud uninstall [--with names]  Remove commands and extensions; keep HUD data.\n'
      );
      return 0;
    }
    io.stderr('invalid_command: hud panel|statusline|import|trust|setup|tickets|unattended|watch|act|council|board|doctor|stats|day|codex|codex-hud|uninstall\n');
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
