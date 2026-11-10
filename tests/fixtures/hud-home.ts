import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface HudHomeOptions {
  /** Base environment is copied, never mutated. No live credentials or HUD overrides survive. */
  env?: NodeJS.ProcessEnv;
  /** Files relative to the fresh root, e.g. 'hud/routing.toml'. */
  files?: Record<string, string | Uint8Array>;
  after?: (cleanup: () => void) => void;
}

/** Each invocation owns only its private paths. No native user configuration is read. */
export function hudHome(options: HudHomeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hud-test-home-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    options.after?.(cleanup);
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    for (const key of Object.keys(env)) {
      if (
        /^(?:HERDR_|HUD_|CODEX_HUD_|PI_ROLE_|PI_ORCHESTRATOR_|PI_DISPATCH_|PI_REAP_)/.test(key) ||
        /(?:SETTINGS_PATH|CONFIG_PATH|CODING_AGENT_DIR|AGENT_DIR)$/.test(key) ||
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)$/.test(key) ||
        /(?:^|_)(?:REAL|LIVE|PROVIDER)(?:_|$)/.test(key) ||
        /^(?:NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|COLORTERM|BASH_ENV|ENV|NODE_OPTIONS)$/.test(key)
      )
        delete env[key];
    }
    const paths = {
      HOME: join(root, 'home'),
      HUD_HOME: join(root, 'hud'),
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
    };
    Object.assign(env, paths);
    const directories = {
      source: join(root, 'source'),
      sessions: join(root, 'sessions'),
      tasks: join(root, 'tasks'),
      jobs: join(paths.HUD_HOME, 'jobs'),
    };
    for (const path of [...Object.values(paths), ...Object.values(directories)])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const write = (name: string, contents: string | Uint8Array) => {
      const file = resolve(root, name);
      const rel = relative(root, file);
      if (!rel || rel.startsWith('..') || isAbsolute(name)) throw Error('seed escapes fixture root');
      let ancestor = root;
      for (const part of rel.split('/')) {
        ancestor = join(ancestor, part);
        try {
          if (lstatSync(ancestor).isSymbolicLink()) throw Error('seed follows symlink');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, contents, { mode: 0o600 });
      return file;
    };
    for (const [name, contents] of Object.entries(options.files ?? {})) write(name, contents);
    return { root, env: env as NodeJS.ProcessEnv & typeof paths, ...paths, ...directories, write, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
