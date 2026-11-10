// Harness-independent HUD storage. This module deliberately imports only Node built-ins.
import * as os from 'node:os';
import * as path from 'node:path';

/** The sole resolver: explicit HUD_HOME, otherwise ~/.hud. No harness home is a default. */
export function getHudHome(
  env: Record<string, string | undefined> = process.env,
  home = env.HOME || os.homedir()
): string {
  return env.HUD_HOME || path.join(home, '.hud');
}

/** Display snapshots, caches and logs share one root across all harnesses. */
export function getHudDisplayHome(
  env: Record<string, string | undefined> = process.env,
  home = env.HOME || os.homedir()
): string {
  return path.join(getHudHome(env, home), 'display');
}
