/** Narrow installation-management entry. Never loads execution/provider/client setup. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installationRoot } from './compat.js';
import type { HudIO } from './link-export.js';
export async function installCommand(args: readonly string[], io: HudIO): Promise<number> {
  try {
    const root = installationRoot();
    const module = join(
      root,
      existsSync(join(root, 'runtime-package')) ? 'runtime-package' : 'scripts/runtime-package',
      'activation-cli.mjs'
    );
    const { activationCommand } = await import(pathToFileURL(module).href);
    const result = activationCommand(args, io.env);
    await io.stdout(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
    return result.status === 'CONFLICT' ? 4 : 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'activation_failed'}\n`);
    return 1;
  }
}
