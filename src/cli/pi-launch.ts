/** A local foreground launcher, not a delegated run or an identity assertion. */
import { isAbsolute } from 'node:path';
import { foreground } from './compat.js';
import { CliError } from './runtime.js';
import type { HudIO } from './link-export.js';
import type { LaunchCommand } from '../core/types/capabilities.js';

export const PI_LAUNCH_HELP = `Usage: hud pi launch [--executable /absolute/path/to/pi] [-- PI_ARG ...]

Start an installed pi in the current directory with inherited terminal streams.
Defaults to pi on PATH. Native arguments after -- are forwarded unchanged, without a shell.
Examples: hud pi launch
          hud pi launch -- --continue
          hud pi launch -- --print "Summarize this repository"
          hud pi launch -- --session /absolute/session.jsonl

Uses pi's native configuration and credentials; HUD does not create or edit them.
Inherited managed HUD claims and old pi session markers are removed.
This is a local user launch, not delegate_spawn/resume, a verified binding, or MCP setup.
No capability manifest is promoted; managed pi delegation remains separate.
Numeric child exit codes are preserved; SIGINT/SIGTERM exits map to 130/143, other signals to 1.
Only SIGINT/SIGTERM are forwarded to the direct child; no process-group supervision is provided.
Missing/unlaunchable executable returns 4.
`;

export function parsePiLaunch(args: readonly string[]): LaunchCommand {
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args : args.slice(0, separator);
  const native = separator < 0 ? [] : [...args.slice(separator + 1)];
  let executable = 'pi';
  if (flags.length) {
    if (flags.length !== 2 || flags[0] !== '--executable' || !isAbsolute(flags[1]) || flags[1].includes('\0'))
      throw new CliError('invalid_pi_launch_arguments');
    executable = flags[1];
  }
  if (native.some((arg) => arg.includes('\0'))) throw new CliError('invalid_pi_launch_arguments');
  return { argv: [executable, ...native] };
}

/** Configuration/credential environment is preserved, but another run's authority is not inherited. */
export function piLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const key of [
    'HUD_CLAIM',
    'HUD_RUN',
    'HUD_LINK',
    'HUD_MCP_REGISTRY_DIR',
    'HUD_RUN_PORT_MODULE',
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
  ])
    delete child[key];
  return child;
}

export async function piLaunchCommand(
  args: readonly string[],
  io: HudIO,
  launch: typeof foreground = foreground
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(PI_LAUNCH_HELP);
    return 0;
  }
  const command = parsePiLaunch(args);
  try {
    return await launch(command, piLaunchEnvironment(io.env));
  } catch {
    // Never retry a dispatched child or print argv/credentials as diagnostics.
    throw new CliError('pi_launch_failed', 4);
  }
}
