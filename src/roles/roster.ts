/** hud_roster's read-only registry, shared without starting the MCP. */
import * as fs from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAgents, type CliAgent } from './cli-kinds.js';
export interface Role {
  role: string;
  harness: 'pi' | 'jev' | 'cli';
  pi_role?: string;
  split?: boolean;
  can_continue?: boolean;
  model?: string;
  thinking?: string;
  tool?: 'jev-ask' | 'jev-aistudio' | 'jev-flow';
  provider?: 'chatgpt' | 'gemini';
  effort?: string;
  kind?: 'image' | 'video';
  agent?: CliAgent;
  idle_grace_s?: number;
  args?: string[];
  source_file: string;
}
export const piSwitches = ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split'] as const;
export function executable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const path = resolve(dir, command);
    try {
      fs.accessSync(path, fs.constants.X_OK);
      return fs.realpathSync(path);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}
function json<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function entries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function invalidCli(role: Partial<Role>): boolean {
  const agent = role.agent;
  if (typeof agent !== 'string' || !(cliAgents as readonly string[]).includes(agent)) return true;
  if (typeof role.can_continue !== 'boolean') return true;
  if (role.idle_grace_s !== undefined && (!Number.isInteger(role.idle_grace_s) || role.idle_grace_s < 0)) return true;
  if (role.args !== undefined && (!Array.isArray(role.args) || role.args.some((arg) => typeof arg !== 'string')))
    return true;
  return false;
}
function slice(file: string, limit: number): { text: string; truncated: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(size, limit)).toString('utf8'), truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}
/** Project injects bounded signature-cached readers; the MCP keeps its original readers. */
export function roleRegistry(
  hudHome: string,
  cwd: string,
  env = process.env,
  read = slice,
  list = entries,
  bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url)),
  readJson = json<Partial<Role>>
) {
  function roles(): Map<string, Role> {
    const result = new Map<string, Role>();
    for (const root of [join(bundled, 'roles'), join(hudHome, 'roles')]) {
      for (const file of list(root).filter((file) => file.endsWith('.json'))) {
        const role = readJson(join(root, file));
        if (
          !role ||
          typeof role.role !== 'string' ||
          !role.role.trim() ||
          (role.harness !== 'pi' && role.harness !== 'jev' && role.harness !== 'cli') ||
          (role.harness === 'cli' && invalidCli(role)) ||
          (role.harness === 'pi' &&
            (typeof role.pi_role !== 'string' ||
              !role.pi_role.trim() ||
              typeof role.split !== 'boolean' ||
              typeof role.can_continue !== 'boolean')) ||
          (role.harness === 'jev' &&
            (!['jev-ask', 'jev-aistudio', 'jev-flow'].includes(role.tool ?? '') ||
              (role.tool === 'jev-ask' && !['chatgpt', 'gemini'].includes(role.provider ?? '')) ||
              (role.tool === 'jev-flow' && !['image', 'video'].includes(role.kind ?? '')))) ||
          ['model', 'thinking', 'effort'].some(
            (key) => role[key as keyof Role] !== undefined && typeof role[key as keyof Role] !== 'string'
          )
        )
          throw new Error(`invalid_role: ${join(root, file)}`);
        result.set(role.role, {
          ...role,
          source_file: join(root, file),
          ...(role.harness === 'jev' ? { can_continue: false } : {}),
        } as Role);
      }
    }
    return result;
  }
  function assignment(role: Role) {
    let pi_role_file: string | null = null;
    if (role.harness === 'pi') {
      for (const command of ['pi-role', 'pi-dispatch']) {
        const bin = executable(command, env);
        const path = bin && join(dirname(dirname(bin)), 'roles', `${role.pi_role}.md`);
        if (path && fs.existsSync(path)) {
          pi_role_file = path;
          break;
        }
      }
    }
    const frontmatter = pi_role_file && read(pi_role_file, 16384)?.text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    const effective = (key: 'model' | 'thinking') => {
      if (role[key] !== undefined) return { value: role[key], source: role.source_file };
      const value = frontmatter && frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
      return { value: value ? value.replace(/^(['"])(.*)\1$/, '$2') : null, source: value ? pi_role_file : null };
    };
    const model = effective('model'),
      thinking = effective('thinking');
    return {
      ...role,
      model: model.value,
      thinking: thinking.value,
      model_source: model.source,
      thinking_source: thinking.source,
      pi_role_file,
      agent: role.harness === 'cli' ? role.agent : undefined,
      accepts_options:
        role.harness === 'pi'
          ? ['model', 'thinking', ...piSwitches, 'pi_args']
          : role.harness === 'cli'
            ? ['model', 'thinking']
            : [],
      available: true,
    };
  }
  function convention() {
    for (const path of [join(cwd, 'hud-convention.md'), join(hudHome, 'hud-convention.md'), join(bundled, 'hud-convention.md')]) {
      const file = read(path, 80000);
      if (file) return { path, text: file.text.slice(0, 20000), truncated: file.truncated || file.text.length > 20000 };
    }
    throw new Error('convention_not_found');
  }
  return { roles, assignment, convention };
}
