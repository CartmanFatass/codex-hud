import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as TOML from '@iarna/toml';

type Config = ReturnType<typeof TOML.parse>;
function layer(file: string): Config {
  try { return TOML.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Parser messages can quote credentials from the offending line.
    throw new Error(`cannot read or parse ${file}`);
  }
}

/** Local config layers only: `codex mcp list` probes even unrelated HTTP servers. */
export function codexWorkerMcp(cwd: string, args: string[], allowed: Set<string>, hud: Config): string[] {
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const base = [layer('/etc/codex/config.toml'), layer(join(home, 'config.toml'))];
  const overrides: Config[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = /^(?:-(p|C|c)(.*)|--(profile|cd|config)(?:=(.*))?)$/.exec(args[i]!);
    if (!match) continue;
    const option = match[1] ?? match[3], value = match[2] || match[4] || args[++i];
    if (!value) throw new Error('missing Codex config option value');
    if (option === 'C' || option === 'cd') cwd = resolve(cwd, value);
    else if (option === 'p' || option === 'profile') base.push(layer(join(home, `${value}.config.toml`)));
    else if (/^(?:mcp_servers|project_root_markers)\b/.test(value)) {
      try { overrides.push(TOML.parse(value)); } catch { throw new Error('cannot parse Codex config override'); }
    }
  }

  const markers = [...base, ...overrides].reverse().find((config) => config.project_root_markers !== undefined)?.project_root_markers ?? ['.git'];
  if (!Array.isArray(markers) || !markers.every((m): m is string => typeof m === 'string')) throw new Error('invalid project_root_markers');
  const dirs = [cwd];
  for (let dir = cwd; !markers.some((m) => statSync(join(dir, m), { throwIfNoEntry: false })); dir = dirname(dir)) {
    const parent = dirname(dir);
    if (parent === dir) { dirs.length = 1; break; } // Outside a project, Codex considers the working directory.
    dirs.push(parent);
  }
  const project = dirs.reverse().map((dir) => layer(join(dir, '.codex', 'config.toml')));
  const servers = new Map<string, { projectOnly: boolean; http: boolean }>();
  for (const config of [...base, ...project, ...overrides]) {
    const configured = config.mcp_servers ?? {};
    if (typeof configured !== 'object' || Array.isArray(configured)) throw new Error('invalid mcp_servers table');
    for (const [name, server] of Object.entries(configured)) {
      if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('invalid mcp_servers entry');
      const prior = servers.get(name);
      servers.set(name, {
        projectOnly: project.includes(config) && (prior?.projectOnly ?? true),
        http: prior?.http === true || Object.hasOwn(server, 'url'),
      });
    }
  }
  // Leave named servers alone (including their auth, trust and disabled state). A project
  // layer may be ignored by Codex: a disabled project-only entry must have a valid transport
  // even then. Never put an owner's URL, env or command in argv.
  const disabled = [...servers].filter(([name]) => !allowed.has(name)).map(([name, info]) => {
    const transport = info.http ? { url: 'https://disabled.invalid' } : { command: process.execPath };
    return [name, { enabled: false, ...(info.projectOnly ? transport : {}) }];
  });
  let key = 'hud';
  while (servers.has(key)) key += '_worker'; // Don't merge an inherited URL, environment or tool filters into HUD.
  const scoped = { ...Object.fromEntries(disabled), [key]: { ...hud, env_vars: [
    'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID',
  ] } };
  // The inline serializer escapes newlines inside strings but wraps long arrays
  // across lines. Herdr's shell encoder cannot pass those formatting newlines.
  const settings = TOML.stringify.value(scoped).replaceAll('\n', ' ');
  return ['-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', `mcp_servers=${settings}`];
}
