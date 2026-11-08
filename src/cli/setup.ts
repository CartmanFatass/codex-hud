// Copy known Jev credential names into the HUD home. Values stay off stdout.

import { JevFailure } from '../jev/ask/error.js';
import { importJevEnv } from '../jev/ask/config.js';
import type { HudIO } from './link-export.js';
import { CliError, privateHome } from './runtime.js';

export const SETUP_HELP = `Usage: hud setup --import-jev-env [--from <file>]
       hud setup --help

Copy known Jev credential names into $HUD_HOME/jev.env (mode 0600).
Stdout lists the imported names. Values are never printed.
`;

export async function setupCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(SETUP_HELP);
    return 0;
  }
  let from: string | undefined;
  let importEnv = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--import-jev-env') {
      if (importEnv) throw new CliError('invalid_arguments');
      importEnv = true;
      continue;
    }
    if (flag === '--from') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--') || from !== undefined) throw new CliError('invalid_arguments');
      from = value;
      continue;
    }
    throw new CliError('invalid_arguments');
  }
  if (!importEnv) throw new CliError('invalid_arguments');
  const hudHome = privateHome(io.env);
  try {
    const imported = importJevEnv({ hudHome, from });
    await io.stdout(imported.names.length ? `${imported.names.join('\n')}\n` : '');
    return 0;
  } catch (error) {
    if (error instanceof JevFailure) {
      io.stderr(`${error.code}\n`);
      return 1;
    }
    throw error;
  }
}
