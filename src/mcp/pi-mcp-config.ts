import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// The adapter accepts JSONC: remove comments and trailing commas without touching quoted strings.
function parseConfig(text: string): Record<string, unknown> {
  const tokens = /"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[ \t\r\n]+|[{}\[\],]|[^"/{}\[\],\s]+/gy;
  const parts: string[] = [];
  while (tokens.lastIndex < text.length) {
    const token = tokens.exec(text)?.[0];
    if (!token) throw new Error('invalid JSONC');
    if (token.startsWith('/') || /^\s/.test(token)) continue;
    if ((token === '}' || token === ']') && parts.at(-1) === ',' && !['{', '[', ','].includes(parts.at(-2)!)) parts.pop();
    parts.push(token);
  }
  const value: unknown = JSON.parse(parts.join(' '));
  if (!object(value)) throw new Error('expected config object');
  return value;
}

function config(path: string): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.lstatSync(path, { throwIfNoEntry: false })) return;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('not a bounded config file');
    const bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw new Error('config changed');
    return parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, stat.size)));
  } finally {
    fs.closeSync(fd);
  }
}

function hasServersOrImports(value: Record<string, unknown> = {}): boolean {
  for (const key of ['mcpServers', 'mcp-servers', 'scriptTools']) {
    const map = value[key];
    if (map !== undefined && (!object(map) || Object.keys(map).length)) return true;
  }
  for (const list of [value.imports, value.claudePlugins]) {
    if (list !== undefined && (!Array.isArray(list) || list.length)) return true;
  }
  const settings = value.settings;
  if (settings === undefined) return false;
  if (!object(settings)) return true;
  return settings.hostConfigDiscovery === 'on' || [settings.agentPluginPaths, settings.ancestorConfigRoots]
    .some(list => list !== undefined && (!Array.isArray(list) || list.length));
}

// A Pi package can provide servers without an entry in mcp.json. Inspect only its manifest,
// never import the package or chase a plugin's config. Unknown source layouts stay with pi-role.
function packagesMayProvideServers(dir: string): boolean {
  const packages = config(join(dir, 'settings.json'))?.packages;
  if (packages === undefined) return false;
  if (!Array.isArray(packages)) return true;
  return packages.some(entry => {
    const source = object(entry) ? entry.source : entry;
    if (typeof source !== 'string' || !source) return true;
    let root: string;
    if (source.startsWith('npm:')) {
      const name = /^npm:((?:@[\w.-]+\/)?[\w-][\w.-]*)(?:@[^/]*)?$/.exec(source)?.[1];
      if (!name) return true;
      root = join(dir, 'npm', 'node_modules', name);
    } else if (/^([\w+-]+:|git@)/.test(source)) return true;
    else root = resolve(dir, source);
    const manifest = config(join(root, 'package.json'));
    return !manifest || (manifest.pi !== undefined && (!object(manifest.pi) || manifest.pi.mcp !== undefined));
  });
}

/** A negative probe only: anything we cannot establish locally leaves pi-role's auto mode alone. */
export function piMcpConfigEmpty(cwd: string, piArgs: string[] = []): boolean {
  if (piArgs.some(arg => /^--mcp-config(?:=|$)/.test(arg))) return false;
  try {
    const home = homedir();
    const host = process.env.PI_PACKAGE_DIR && config(resolve(cwd, process.env.PI_PACKAGE_DIR, 'package.json'))?.piConfig;
    const configDir = object(host) && typeof host.configDir === 'string' ? host.configDir.trim() || '.pi' : '.pi';
    const appName = object(host) && typeof host.name === 'string' ? host.name.trim() || 'pi' : 'pi';
    const dir = process.env[`${appName.toUpperCase()}_CODING_AGENT_DIR`]?.trim();
    const agent = !dir ? join(home, configDir, 'agent') : dir === '~' ? home : dir.startsWith('~/') ? resolve(home, dir.slice(2)) : resolve(cwd, dir);
    const adapter = join(agent, 'mcp-adapter.json');
    if (process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === 'exclusive') return !hasServersOrImports(config(adapter));
    const project = resolve(cwd, configDir);
    const files = [join(home, '.config/mcp/mcp.json'), join(home, '.agents/mcp.json'), join(home, '.agents/mcp/mcp.json'),
      join(agent, 'mcp.json'), adapter, join(cwd, '.mcp.json'), join(project, 'mcp.json'), join(project, 'mcp-adapter.json')];
    return !files.some(file => hasServersOrImports(config(file))) && ![agent, project].some(packagesMayProvideServers);
  } catch {
    return false;
  }
}
