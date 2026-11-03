import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Startup eligibility only: mirror CLI privateHome and never create a home or ledger. */
export function existingHudHome(env: Readonly<Record<string, string | undefined>>): string | null {
  const requested = env.HUD_HOME ?? path.join(homedir(), '.hud');
  if (!path.isAbsolute(requested) || requested.includes('\0')) return null;
  const home = requested.replace(/(?:\/\.?)+$/, '') || '/';
  try {
    const info = fs.lstatSync(home);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      fs.realpathSync(home) !== home ||
      process.getuid?.() !== process.geteuid?.() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      return null;
    return fs.statSync(path.join(home, 'ledger.sqlite')).isFile() ? home : null;
  } catch {
    return null;
  }
}
