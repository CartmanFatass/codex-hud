import { promises as fs, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { LaunchCommand } from '../types/capabilities.js';

/** Version probes are not delegation recipients. Scrub authority after profile overrides. */
export function launchProbeEnvironment(
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...inherited, ...overrides }).filter(
      ([key]) => !key.startsWith('HUD_') && !key.startsWith('PI_SESSION_') && key !== 'PI_CODING_AGENT_SESSION_DIR'
    )
  );
}

export interface ExecutableIdentity {
  path: string;
  /** Captured by trusted startup/version discovery, never a delegate.json assertion. */
  version: string;
}
/** File identity is captured without executing a CLI on the acceptance path.
 * Version discovery remains a trusted startup dependency; the capability verifier
 * additionally compares its complete actual-runtime version tuple.
 */
export async function executableIdentity(command: LaunchCommand, env: NodeJS.ProcessEnv, known?: ExecutableIdentity) {
  const configured = command.argv ? command.argv[0] : command.shellPath;
  const candidates = isAbsolute(configured)
    ? [configured]
    : configured.includes('/')
      ? []
      : (env.PATH ?? '')
          .split(delimiter)
          .filter((path) => isAbsolute(path))
          .slice(0, 32)
          .map((path) => join(path, configured));
  const paths = await Promise.all(
    candidates.map(async (path) => {
      try {
        const canonical = await fs.realpath(path);
        await fs.access(canonical, constants.X_OK);
        const stat = await fs.stat(canonical);
        return stat.isFile()
          ? { path: canonical, file: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } }
          : null;
      } catch {
        return null;
      }
    })
  );
  const found = paths.find((path) => path !== null) ?? null;
  if (known && (!known.version || !isAbsolute(known.path) || (found && (await fs.realpath(known.path)) !== found.path)))
    throw new Error('executable_identity_mismatch');
  return { configured, resolved: found?.path ?? null, file: found?.file ?? null, version: known?.version ?? null };
}

const runVariables = new Set([
  'cwd',
  'launchCwd',
  'sessionId',
  'resumeSessionId',
  'claim',
  'runId',
  'linkId',
  'hudHome',
  'HUD_CLAIM',
  'HUD_RUN',
  'HUD_LINK',
  'HUD_HOME',
  'prompt',
  'brief',
  'briefPath',
  'reportPath',
  'stdinPath',
]);
/** Render a structured template, not a command string. Run values are typed
 * sentinels; literal bytes and fixed profile substitutions retain their shape.
 */
export function capabilityTemplate(command: LaunchCommand, fixed: Readonly<Record<string, string>>) {
  const render = (value: string) => {
    const parts: (
      | { kind: 'literal'; value: string }
      | { kind: 'run'; name: string }
      | { kind: 'profile'; name: string; value: string }
    )[] = [];
    const pattern = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
    let position = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index! > position) parts.push({ kind: 'literal', value: value.slice(position, match.index) });
      const name = match[1];
      if (runVariables.has(name)) parts.push({ kind: 'run', name });
      else if (Object.hasOwn(fixed, name)) parts.push({ kind: 'profile', name, value: fixed[name] });
      else throw new Error('undeclared_launch_placeholder');
      position = match.index! + match[0].length;
    }
    if (position < value.length || parts.length === 0) parts.push({ kind: 'literal', value: value.slice(position) });
    return parts;
  };
  return command.argv
    ? { kind: 'argv', arguments: command.argv.map(render) }
    : { kind: 'shell', shellPath: command.shellPath, script: render(command.shell) };
}
