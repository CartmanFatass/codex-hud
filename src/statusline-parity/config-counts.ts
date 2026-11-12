/** The MCP servers Claude has configured (claude-hud 0.8.0 scope rules, MIT). Bounded source reads; cache lives in HUD_HOME. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { cachePath, cached, readJson, record, saveJson, signature } from './storage.js';
export interface ConfigCounts {
  mcpCount: number;
}
interface CountCache {
  version: 1;
  stamps: Record<string, string>;
  counts: ConfigCounts;
}
export function collectConfigCounts(cwd: string | undefined, env: NodeJS.ProcessEnv): ConfigCounts {
  const home = env.HOME ?? '',
    claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  // 0.8.0 uses the config directory's sibling .json when redirected.
  const userJson = env.CLAUDE_CONFIG_DIR ? claude + '.json' : join(home, '.claude.json');
  const file = cachePath(env, 'config', JSON.stringify([home, claude, cwd]));
  const roots = [join(claude, 'settings.json'), userJson];
  if (cwd)
    roots.push(
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
      join(cwd, '.mcp.json')
    );
  const previous = cached<CountCache>(file);
  if (previous && Object.entries(previous.stamps).every(([p, s]) => signature(p) === s)) return previous.counts;
  const stamps = Object.fromEntries(roots.map((p) => [p, signature(p)]));
  const json = (p: string) => {
    try {
      return record(readJson(p));
    } catch {
      return {};
    }
  };
  const same = (a: string, b: string) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return resolve(a) === resolve(b);
    }
  };
  const names = (v: Record<string, unknown>) => Object.keys(record(v.mcpServers));
  const userMcps = new Set([...names(json(join(claude, 'settings.json'))), ...names(json(userJson))]);
  const disabled = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  disabled(json(userJson).disabledMcpServers).forEach((n) => userMcps.delete(n));
  const projectMcps = new Set<string>();
  if (cwd) {
    const p = join(cwd, '.claude'),
      local = json(join(p, 'settings.local.json'));
    if (!same(p, claude)) names(json(join(p, 'settings.json'))).forEach((n) => projectMcps.add(n));
    names(local).forEach((n) => projectMcps.add(n));
    const mcp = new Set(names(json(join(cwd, '.mcp.json'))));
    disabled(local.disabledMcpjsonServers).forEach((n) => mcp.delete(n));
    mcp.forEach((n) => projectMcps.add(n));
  }
  const counts = { mcpCount: userMcps.size + projectMcps.size };
  try {
    saveJson(file, { version: 1, stamps, counts });
  } catch {
    /* display cache is optional */
  }
  return counts;
}
