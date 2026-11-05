import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchCommand } from '../core/types/capabilities.js';
import type { HudIO } from './link-export.js';
/** Works in root, test and hud-mcp emitted layouts without an environment-selected module. */
export function installationRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++, directory = dirname(directory)) {
    if (existsSync(join(directory, 'bin/hud-run')) && existsSync(join(directory, 'package.json'))) return directory;
  }
  throw new Error('installation_unavailable');
}

/** A foreground compatibility child. Never retry or change execution form after dispatch. */
export function foreground(command: LaunchCommand, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const argv = command.argv ?? [command.shellPath, '-ic', command.shell];
    const child = spawn(argv[0], argv.slice(1), { env, stdio: 'inherit', shell: false });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const clean = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', () => {
      clean();
      reject(new Error('launch_failed'));
    });
    child.once('exit', (code, signal) => {
      clean();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

export function codexCommand(args: readonly string[], io: HudIO): Promise<number> {
  return foreground({ argv: [join(installationRoot(), 'bin/codex-hud'), ...args] }, io.env);
}
