/** Lightweight CLI errors and private-home validation, without opening a ledger. */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getHudHome } from '../hud-home.js';
export class CliError extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode = 2
  ) {
    super(reason);
  }
}
/** Validate before opening a store, loading configuration, or creating any files. */
export function privateHome(env: NodeJS.ProcessEnv): string {
  const requested = getHudHome(env);
  if (!isAbsolute(requested) || requested.includes('\0')) throw new CliError('invalid_hud_home', 3);
  const home = requested.replace(/(?:\/\.?)+$/, '') || '/';
  try {
    const info = lstatSync(home);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(home) !== home ||
      process.getuid?.() !== process.geteuid?.() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error('unsafe');
    return home;
  } catch {
    throw new CliError('invalid_hud_home', 3);
  }
}
