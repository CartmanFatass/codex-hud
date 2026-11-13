/** hud_roster's read-only registry, shared without starting the MCP. */
import * as fs from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAgents, type CliAgent } from './cli-kinds.js';
import { registeredProject } from './projects.js';
export interface Role {
  role: string;
  harness: 'pi' | 'jev' | 'cli';
  pi_role?: string;
  split?: boolean;
  can_continue?: boolean;
  skills?: string[];
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
export interface InvalidRole {
  path: string;
  reason: string;
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
function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
function badPi(role: Partial<Role>): boolean {
  return (
    typeof role.pi_role !== 'string' ||
    !role.pi_role.trim() ||
    typeof role.split !== 'boolean' ||
    typeof role.can_continue !== 'boolean'
  );
}
function badJev(role: Partial<Role>): boolean {
  return (
    !['jev-ask', 'jev-aistudio', 'jev-flow'].includes(role.tool ?? '') ||
    (role.tool === 'jev-ask' && !['chatgpt', 'gemini'].includes(role.provider ?? '')) ||
    (role.tool === 'jev-flow' && !['image', 'video'].includes(role.kind ?? ''))
  );
}
/** A short token only. Anything longer or odd is file content and stays out of the reason. */
function harnessToken(value: unknown): string {
  if (typeof value === 'string' && value.length <= 32 && /^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return typeof value === 'string' ? 'invalid' : typeof value;
}
function skillsOf(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { skills?: unknown }).skills
    : undefined;
}
function badSkills(value: unknown): boolean {
  const skills = skillsOf(value);
  return (
    skills !== undefined &&
    (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string' || item.length === 0))
  );
}
function roleReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unparseable JSON';
  const role = value as Partial<Role>;
  if (typeof role.role !== 'string' || !role.role.trim()) return 'missing role';
  if (role.harness !== 'pi' && role.harness !== 'jev' && role.harness !== 'cli')
    return `unknown harness ${harnessToken(role.harness)}`;
  if (role.harness === 'pi' && (badPi(role) || badSkills(value))) return 'bad pi fields';
  if (role.harness === 'cli' && (invalidCli(role) || skillsOf(value) !== undefined)) return 'bad cli fields';
  if (role.harness === 'jev' && (badJev(role) || skillsOf(value) !== undefined)) return 'bad jev fields';
  if (
    ['model', 'thinking', 'effort'].some(
      (key) => role[key as keyof Role] !== undefined && typeof role[key as keyof Role] !== 'string'
    )
  )
    return 'bad model/thinking/effort';
  return null;
}
function projectReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unparseable JSON';
  const role = value as Partial<Role>;
  if (typeof role.role !== 'string' || !role.role.trim()) return 'missing role';
  if (role.harness !== 'pi') return 'project roles are pi only';
  return roleReason(value);
}
function namedRole(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const role = (value as { role?: unknown }).role;
  return typeof role === 'string' && role.trim() ? role : undefined;
}
function readReason(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return null;
  return typeof code === 'string' ? 'unreadable' : 'unparseable JSON';
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
  readJson: (file: string) => unknown = json
) {
  let gate: ReturnType<typeof registeredProject> | undefined;
  function project() {
    return (gate ??= registeredProject(hudHome, cwd));
  }
  /** Unregistered root that still has a `.hud/` directory. Nothing under it is loaded. */
  function projectConfigIgnored(): string | null {
    const info = project();
    if (info.registered) return null;
    try {
      return fs.statSync(info.hud_dir).isDirectory() ? info.root : null;
    } catch {
      return null;
    }
  }
  function allowed(file: string): Set<string> | null {
    try {
      const parsed = readJson(file);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const names = (parsed as { roles?: unknown }).roles;
      if (names === undefined) return null;
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return null;
      return new Set(names);
    } catch {
      return null;
    }
  }
  function scan(): { roles: Map<string, Role>; invalid: (InvalidRole & { role?: string })[] } {
    const roles = new Map<string, Role>();
    const invalid: (InvalidRole & { role?: string })[] = [];
    const take = (root: string, projectFile: boolean) => {
      for (const file of list(root).filter((name) => name.endsWith('.json'))) {
        const path = join(root, file);
        let parsed: unknown;
        try {
          parsed = readJson(path);
        } catch (error) {
          const reason = readReason(error);
          if (reason) invalid.push({ path, reason });
          continue;
        }
        const reason = projectFile ? projectReason(parsed) : roleReason(parsed);
        if (reason) {
          const role = namedRole(parsed);
          invalid.push(role ? { path, reason, role } : { path, reason });
          continue;
        }
        const role = parsed as Role;
        roles.set(role.role, {
          ...role,
          source_file: path,
          ...(role.harness === 'jev' ? { can_continue: false } : {}),
        });
      }
    };
    const info = project();
    take(join(bundled, 'roles'), false);
    take(join(hudHome, 'roles'), false);
    if (info.registered) {
      take(join(info.root, '.hud', 'roles'), true);
      const names = allowed(join(info.root, '.hud', 'project.json'));
      if (names) for (const name of [...roles.keys()]) if (!names.has(name)) roles.delete(name);
    }
    return { roles, invalid };
  }
  function roles(): Map<string, Role> {
    return scan().roles;
  }
  function invalid(): InvalidRole[] {
    return scan().invalid.map(({ path, reason }) => ({ path, reason }));
  }
  /** Last invalid file that names this role, when no valid file does. */
  function invalidPath(name: string): string | null {
    const found = scan();
    if (found.roles.has(name)) return null;
    return found.invalid.filter((item) => item.role === name).at(-1)?.path ?? null;
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
    const info = project();
    const paths = [
      ...(info.registered ? [join(info.root, '.hud', 'hud-convention.md')] : []),
      join(cwd, 'hud-convention.md'),
      join(hudHome, 'hud-convention.md'),
      join(bundled, 'hud-convention.md'),
    ];
    for (const path of paths) {
      const file = read(path, 80000);
      if (file) return { path, text: file.text.slice(0, 20000), truncated: file.truncated || file.text.length > 20000 };
    }
    throw new Error('convention_not_found');
  }
  return { roles, invalid, invalidPath, assignment, convention, project, projectConfigIgnored };
}
