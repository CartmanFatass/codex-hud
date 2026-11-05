import { EXPORT_HELP, EXPORT_USAGE, linkExport, type HudIO } from './link-export.js';
import { CliError, privateHome } from './runtime.js';
import { RUN_HELP, RUN_USAGE, runCommand } from './run.js';
import { CACHE_HELP, CACHE_USAGE, cacheCommand } from './cache.js';
import { CLAUDE_HELP, claudeCommand, codexCommand } from './launcher.js';
import { panelCommand, PANEL_HELP } from './panel.js';

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    const onError = (error: Error) => reject(error);
    stdout.once('error', onError);
    try {
      stdout.write(text, (error) => {
        if (error) {
          // The callback can precede the error event; retain its one-shot listener.
          reject(error);
        } else {
          stdout.off('error', onError);
          resolve();
        }
      });
    } catch (error) {
      stdout.off('error', onError);
      reject(error);
    }
  });
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: HudIO = {
    env: process.env,
    stdout: writeStdout,
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  try {
    if (args[0] === 'panel') {
      if (args.length === 2 && args[1] === '--help') {
        await io.stdout(PANEL_HELP);
        return 0;
      }
      if (args.length !== 1) throw new CliError('invalid_arguments');
      return await panelCommand(io);
    }
    if (args[0] === 'run') {
      if (args.length === 2 && args[1] === '--help') {
        await io.stdout(RUN_HELP);
        return 0;
      }
      const usage = args.length === 3 && args[2] === '--help' ? RUN_USAGE.get(args[1]) : undefined;
      if (usage) {
        await io.stdout(`Usage: ${usage}\n`);
        return 0;
      }
      return await runCommand(args.slice(1), privateHome(io.env), io);
    }
    if (args[0] === 'cache') {
      // Help must work without reading or validating HUD_HOME.
      if (args.length === 2 && args[1] === '--help') {
        await io.stdout(CACHE_HELP);
        return 0;
      }
      if (args.length === 3 && args[1] === 'show' && args[2] === '--help') {
        await io.stdout(`Usage: ${CACHE_USAGE}\n`);
        return 0;
      }
      return await cacheCommand(args.slice(1), privateHome(io.env), io);
    }
    if (args[0] === 'claude') {
      if (args.length === 2 && args[1] === '--help') {
        await io.stdout(CLAUDE_HELP);
        return 0;
      }
      return await claudeCommand(args.slice(1), privateHome(io.env), io);
    }
    if (args[0] === 'codex' || args[0] === 'codex-hud') return await codexCommand(args.slice(1), io);
    if (
      (args.length === 1 && args[0] === '--help') ||
      (args.length === 2 && args[0] === 'link' && args[1] === '--help') ||
      (args.length === 3 && args[0] === 'link' && args[1] === 'export' && args[2] === '--help')
    ) {
      await io.stdout(EXPORT_HELP);
      return 0;
    }
    if (args[0] !== 'link' || args[1] !== 'export') {
      io.stderr(`invalid_command: ${EXPORT_USAGE}\n`);
      return 2;
    }
    return await linkExport(args.slice(2), io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    const reason = error instanceof Error ? error.message : '';
    if (
      [
        'capability_unverified',
        'unsupported',
        'slot_busy',
        'task_mismatch',
        'expected_run_mismatch',
        'idempotency_conflict',
        'parent_unconfirmed',
        'not_current_owner',
        'unresolved_conflict',
        'backend_not_found',
        'run_not_found',
        'link_not_found',
        'no_run',
        'configuration_invalid',
        'visible_launch_not_in_this_build',
        'unsafe_ledger_path',
        'ledger_path_replaced',
        'unauthorized_local_manager',
      ].includes(reason)
    ) {
      io.stderr(`${reason}\n`);
      return 4;
    }
    if (error instanceof Error && 'code' in error && error.code === 'ledger_busy') {
      io.stderr('busy\n');
      return 4;
    }
    if (reason.startsWith('The HUD ledger requires')) {
      io.stderr('runtime_unavailable: Node 22.x >=22.13 or Node >=24 required (23 unsupported)\n');
      return 5;
    }
    io.stderr('internal_or_output_failure\n');
    return 1;
  }
}
