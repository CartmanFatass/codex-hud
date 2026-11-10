// There is one migration entry point; the historical setup importer no longer writes.
import type { HudIO } from './link-export.js';
export const SETUP_HELP = 'Use hud import preview|apply [--from <file>] (see hud import --help).\n';
export async function setupCommand(_args: readonly string[], io: HudIO): Promise<number> {
  await io.stdout(SETUP_HELP);
  return _args.length === 1 && _args[0] === '--help' ? 0 : 2;
}
