import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { makeSourceId } from './identity.js';
import { readDelegationSummary } from './delegation-summary-store.js';
import type { PiFooterSummaryProvider } from '../harness/pi/footer.js';

function within(root: string, file: string): boolean {
  const name = relative(root, file);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}
/** Explicit configured source AND current native session location. No guessed root, transcript/header scan or authority. */
export function createPiDelegationSummaryProvider(
  env: Readonly<NodeJS.ProcessEnv>,
  now = Date.now
): PiFooterSummaryProvider {
  return (identity) => {
    const started = performance.now();
    try {
      const home = env.HUD_HOME;
      const configured = env.HUD_PI_SOURCE_ROOT;
      if (
        !home ||
        !configured ||
        !isAbsolute(configured) ||
        !identity.sessionFile ||
        !isAbsolute(identity.sessionFile) ||
        !isAbsolute(identity.sessionDir)
      )
        return null;
      const root = realpathSync(configured);
      const directory = realpathSync(identity.sessionDir);
      const file = realpathSync(identity.sessionFile);
      if (
        !statSync(root).isDirectory() ||
        !statSync(directory).isDirectory() ||
        !statSync(file).isFile() ||
        !within(root, directory) ||
        !within(directory, file) ||
        directory === file
      )
        return null;
      const ref = {
        harness: 'pi' as const,
        sourceId: makeSourceId('pi', root),
        sessionId: identity.sessionId,
        threadId: null,
      };
      const summary = readDelegationSummary(home, ref, { nowMs: now(), budgetMs: 20 - (performance.now() - started) });
      return summary && performance.now() - started < 20
        ? { identity: { ...identity }, committedDelegation: summary }
        : null;
    } catch {
      return null;
    }
  };
}
