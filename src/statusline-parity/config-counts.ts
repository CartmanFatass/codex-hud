/** claude-hud 0.8.0 scope/count rules (MIT). Bounded source reads; cache lives in HUD_HOME. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { cachePath, cached, readJson, record, saveJson, signature } from './storage.js';
export interface ConfigCounts {
  claudeMdCount: number;
  rulesCount: number;
  mcpCount: number;
  hooksCount: number;
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
  const roots = [
    join(claude, 'CLAUDE.md'),
    join(claude, 'rules'),
    join(claude, 'settings.json'),
    join(claude, 'settings.local.json'),
    userJson,
  ];
  if (cwd)
    roots.push(
      cwd,
      join(cwd, 'CLAUDE.md'),
      join(cwd, 'CLAUDE.local.md'),
      join(cwd, '.claude'),
      join(cwd, '.claude', 'CLAUDE.md'),
      join(cwd, '.claude', 'CLAUDE.local.md'),
      join(cwd, '.claude', 'rules'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
      join(cwd, '.mcp.json')
    );
  const previous = cached<CountCache>(file);
  if (previous && Object.entries(previous.stamps).every(([p, s]) => signature(p) === s)) return previous.counts;
  const stamps: Record<string, string> = {};
  const mark = (p: string) => {
    stamps[p] = signature(p);
  };
  roots.forEach(mark);
  const json = (p: string) => {
    try {
      return record(readJson(p));
    } catch {
      return {};
    }
  };
  const exists = (p: string) => signature(p) !== '-';
  const same = (a: string, b: string) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return resolve(a) === resolve(b);
    }
  };
  const rules = (root: string): number => {
    let entries = 0,
      directories = 0;
    const visited = new Set<string>();
    const walk = (p: string): number => {
      if (entries >= 10000 || directories >= 1000) return 0;
      let real: string, stat: fs.Stats;
      try {
        real = fs.realpathSync(p);
        stat = fs.statSync(real);
      } catch {
        return 0;
      }
      if (visited.has(real)) return 0;
      visited.add(real);
      // Membership changes update the directory, not the content of every rule file.
      // A file symlink also needs its target's stamp (the target can disappear elsewhere).
      if (stat.isDirectory() || fs.lstatSync(p).isSymbolicLink()) mark(p);
      if (!stat.isDirectory()) return p.endsWith('.md') && stat.isFile() ? 1 : 0;
      directories++;
      let count = 0;
      try {
        const dir = fs.opendirSync(real);
        try {
          let e: fs.Dirent | null;
          while (entries < 10000 && (e = dir.readSync())) {
            entries++;
            count += walk(join(p, e.name));
          }
        } finally {
          dir.closeSync();
        }
      } catch {
        /* unreadable rules are absent, as upstream */
      }
      return count;
    };
    return walk(root);
  };
  let claudeMdCount = Number(exists(join(claude, 'CLAUDE.md'))),
    rulesCount = rules(join(claude, 'rules'));
  const user = json(join(claude, 'settings.json')),
    global = json(userJson);
  const names = (v: Record<string, unknown>) => Object.keys(record(v.mcpServers));
  const userMcps = new Set([...names(user), ...names(global)]);
  const disabled = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  disabled(global.disabledMcpServers).forEach((n) => userMcps.delete(n));
  const hooks = (v: Record<string, unknown>) => Object.keys(record(v.hooks)).length;
  let hooksCount = hooks(user);
  const projectMcps = new Set<string>();
  if (cwd) {
    const p = join(cwd, '.claude'),
      overlaps = same(p, claude),
      local = json(join(p, 'settings.local.json'));
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) claudeMdCount += Number(exists(join(cwd, name)));
    if (!overlaps) {
      claudeMdCount += Number(exists(join(p, 'CLAUDE.md')));
      rulesCount += rules(join(p, 'rules'));
      const settings = json(join(p, 'settings.json'));
      names(settings).forEach((n) => projectMcps.add(n));
      hooksCount += hooks(settings);
    }
    claudeMdCount += Number(exists(join(p, 'CLAUDE.local.md')));
    names(local).forEach((n) => projectMcps.add(n));
    hooksCount += hooks(local);
    const mcp = new Set(names(json(join(cwd, '.mcp.json'))));
    disabled(local.disabledMcpjsonServers).forEach((n) => mcp.delete(n));
    mcp.forEach((n) => projectMcps.add(n));
  }
  const counts = { claudeMdCount, rulesCount, mcpCount: userMcps.size + projectMcps.size, hooksCount };
  try {
    saveJson(file, { version: 1, stamps, counts });
  } catch {
    /* display cache is optional */
  }
  return counts;
}
