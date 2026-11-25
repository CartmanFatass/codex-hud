/** `hud setup --detect`, `--apply PLAN` and `--remove`. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { readJsonFile as readJson, writeFileAtomic } from '../utils/atomic-fs.js';
import { fileURLToPath } from 'node:url';
import { getHudHome } from '../hud-home.js';
import { proposedDisposablePaths } from '../mcp/managed-worktree.js';
import { projectRoot, registeredProject } from '../roles/projects.js';
import { executable, projectReason, roleRegistry, type Role } from '../roles/roster.js';
import { isPiProfile, piProfileError } from '../roles/pi-defaults.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

const USAGE = 'usage: hud setup --detect [--cwd DIR] | --apply PLAN [--cwd DIR] | --remove [--cwd DIR]';
const DEFAULT_SKILL_ROOTS = ['~/.pi/agent/skills', '~/.claude/skills', '~/.agents/skills'];
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const PLAN_FIELDS = new Set(['version', 'roles', 'pi_roles', 'runs', 'skills', 'agents', 'convention', 'disposable']);
const ROLE_FIELDS = new Set(['from', 'pi_role', 'model', 'thinking', 'split', 'can_continue', 'skills']);
type Registry = ReturnType<typeof roleRegistry>;
type Kind = 'missing' | 'file' | 'link' | 'dir' | 'other';
interface PlanRole {
  from?: string;
  pi_role?: string;
  model?: string;
  thinking?: string;
  split?: boolean;
  can_continue?: boolean;
  skills?: string[];
}
type RoleBody = { text: string; differs: boolean };
interface Plan {
  roles: string[];
  roleFiles: Map<string, RoleBody>;
  skills: Record<string, string>;
  agents: Record<string, string>;
  convention: 'keep' | 'copy-default';
  disposable?: string[];
}
interface Records {
  land?: unknown;
  worktree?: unknown;
  scratch?: unknown;
  design?: unknown;
  links: Set<string>;
  role_files: Set<string>;
  agents: Set<string>;
  convention: boolean;
}

export async function setupCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.includes('--import-jev-env')) {
    io.stderr('retired: use hud import\n');
    return 2;
  }
  const parsed = parse(args);
  const cwd = parsed.cwd ? directory(parsed.cwd) : process.cwd();
  if (parsed.mode === 'detect') {
    await io.stdout(JSON.stringify(await detect(cwd, io.env), null, 2) + '\n');
    return 0;
  }
  if (parsed.mode === 'remove') return remove(cwd, io.env, io);
  return apply(parsed.plan!, cwd, io.env, io);
}

function parse(args: readonly string[]): { mode: 'detect' | 'apply' | 'remove'; cwd?: string; plan?: string } {
  let mode: 'detect' | 'apply' | 'remove' | undefined;
  let cwd: string | undefined;
  let plan: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--detect' || arg === '--apply' || arg === '--remove') {
      if (mode) throw new CliError(USAGE);
      mode = arg.slice(2) as 'detect' | 'apply' | 'remove';
    } else if (arg === '--cwd') {
      const dir = args[++i];
      if (cwd || !dir || dir.startsWith('-')) throw new CliError(USAGE);
      cwd = dir;
    } else if (mode === 'apply' && !arg.startsWith('-')) {
      if (plan) throw new CliError(USAGE);
      plan = arg;
    } else throw new CliError(USAGE);
  }
  if (!mode || (mode === 'apply' && !plan)) throw new CliError(USAGE);
  return { mode, cwd, plan };
}

function directory(arg: string): string {
  try {
    const resolved = fs.realpathSync(arg);
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* Fall through to the usage error. */
  }
  throw new CliError(`not a directory: ${arg}`);
}

async function detect(cwd: string, env: NodeJS.ProcessEnv) {
  const hudHome = getHudHome(env),
    bundled = bundledRoot(),
    gate = registeredProject(hudHome, cwd);
  const projectJson = join(gate.root, '.hud', 'project.json');
  const projectRoles = join(gate.root, '.hud', 'roles');
  const skipJson = (file: string) => (file === projectJson ? unreadable() : readJson(file));
  const full = roleRegistry(hudHome, cwd, env, undefined, undefined, bundled);
  const reference = roleRegistry(
    hudHome,
    cwd,
    env,
    undefined,
    (dir) => (dir === projectRoles ? [] : listDir(dir)),
    bundled,
    skipJson
  );
  const open = roleRegistry(hudHome, cwd, env, undefined, undefined, bundled, skipJson);
  const pi = executable('pi-role', env);
  const projectFiles = [...open.roles(true).values()].filter((role) => role.source_file.startsWith(projectRoles + sep));
  const skilled = projectFiles.filter((role): role is Role & { skills: string[] } => Array.isArray(role.skills));
  const roots = skillRoots(hudHome, env.HOME);
  return {
    project: {
      root: gate.root,
      registered: gate.registered,
      hud_dir: gate.hud_dir,
      hud_dir_exists: isDir(gate.hud_dir),
    },
    pi: { installed: pi !== null, pi_role: pi },
    reference_roles: listed(reference, [...reference.roles(true).values()], bundled, hudHome),
    project_roles: listed(open, projectFiles, bundled, hudHome, true),
    enabled_roles: [...full.roles().keys()].sort(cmp),
    invalid: full.invalid().map(({ path, reason }) => ({ path, reason })),
    skills: skills(roots),
    worker_skills: Object.fromEntries(
      skilled.sort((a, b) => cmp(a.role, b.role)).map((role) => [role.role, role.skills])
    ),
    skill_links: gate.registered ? skillLinks(gate.root) : [],
    proposed_disposable: gate.registered ? await proposedDisposablePaths(hudHome, gate.root) : [],
  };
}

function listed(found: Registry, roles: Role[], bundled: string, hudHome: string, includeRun = false) {
  return roles
    .map((role) => ({
      ...roleRow(found.assignment(role), roleSource(role.source_file, bundled, hudHome)),
      ...(includeRun ? { run: role.run } : {}),
    }))
    .sort((a, b) => cmp(a.role, b.role));
}

function roleRow(role: ReturnType<Registry['assignment']>, source: string) {
  return {
    role: role.role,
    harness: role.harness,
    ...(role.pi_role !== undefined ? { pi_role: role.pi_role } : {}),
    ...(role.agent !== undefined ? { agent: role.agent } : {}),
    model: role.model ?? null,
    thinking: role.thinking ?? null,
    ...(role.optionalEnabled === undefined ? {} : { enabled: role.optionalEnabled }),
    source,
  };
}

function roleSource(file: string, bundled: string, hudHome: string): string {
  const base = basename(file);
  if (file.startsWith(join(bundled, 'roles') + sep)) return 'shipped';
  if (file.startsWith(join(hudHome, 'roles') + sep)) return `$HUD_HOME/roles/${base}`;
  return `.hud/roles/${base}`;
}

function skillRoots(hudHome: string, home: string | undefined): string[] {
  const bundled = bundledSkillRoot();
  const base = userSkillRoots(hudHome, home);
  return base.includes(bundled) ? base : [...base, bundled];
}

function userSkillRoots(hudHome: string, home: string | undefined): string[] {
  const defaults = expandAll(DEFAULT_SKILL_ROOTS, home) ?? [];
  let parsed: unknown;
  try {
    parsed = readJson(join(hudHome, 'setup.json'));
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
  const listedRoots = (parsed as { skill_roots?: unknown }).skill_roots;
  return Array.isArray(listedRoots) ? (expandAll(listedRoots, home) ?? defaults) : defaults;
}

function expandAll(values: readonly unknown[], home: string | undefined): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value) return null;
    const path = value === '~' ? home : value.startsWith('~/') ? home && join(home, value.slice(2)) : value;
    if (!path || !isAbsolute(path)) return null;
    out.push(path);
  }
  return out;
}

function skills(roots: string[]) {
  const found: { name: string; path: string; root: string; model_invocable: boolean }[] = [];
  for (const root of roots) {
    for (const name of listDir(root)) {
      const child = join(root, name);
      if (!isDir(child)) continue;
      let text: string;
      try {
        text = fs.readFileSync(join(child, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      found.push({ ...skillRecord(text, name), path: realDir(child), root });
    }
  }
  return found.sort(
    (a, b) => cmp(a.name, b.name) || roots.indexOf(a.root) - roots.indexOf(b.root) || cmp(a.path, b.path)
  );
}

function skillRecord(text: string, dir: string): { name: string; model_invocable: boolean } {
  const body = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const field = (key: string) =>
    body
      ?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  return { name: field('name') || dir, model_invocable: field('disable-model-invocation') !== 'true' };
}

function skillLinks(root: string) {
  const dir = join(root, '.hud', 'skills');
  return listDir(dir)
    .sort(cmp)
    .map((name) => {
      const path = join(dir, name);
      let target: string | null = null,
        broken = true;
      try {
        if (fs.lstatSync(path).isSymbolicLink()) {
          target = fs.readlinkSync(path);
          fs.statSync(path);
          broken = false;
        }
      } catch {
        /* A missing target or unreadable entry stays broken. */
      }
      return { name, target, broken };
    });
}

function bundledDir(parts: readonly string[], check: readonly string[], fallback: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ...parts);
    if (isDir(join(candidate, ...check))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fileURLToPath(new URL(fallback, import.meta.url));
}

function bundledRoot(): string {
  return bundledDir(['packages', 'hud-mcp'], ['roles'], '../../packages/hud-mcp/');
}

function bundledSkillRoot(): string {
  return bundledDir(['integrations', 'skills'], [], '../../integrations/skills');
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function isDir(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function realDir(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}
function unreadable(): never {
  throw new Error('unreadable');
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bad(reason: string): never {
  throw new CliError(`invalid plan: ${reason}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fileKind(path: string): Kind {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) return 'link';
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'dir';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}
function refuseParent(path: string, label: string): void {
  const kind = fileKind(path);
  if (kind === 'missing') return;
  if (kind === 'link') throw new CliError(`refusing: ${label} is a symlink`);
  if (kind !== 'dir') throw new CliError(`refusing: ${label} is not a directory`);
}
function referenceRegistry(hudHome: string, root: string, env: NodeJS.ProcessEnv): Registry {
  const projectRoles = join(root, '.hud', 'roles');
  const projectJson = join(root, '.hud', 'project.json');
  return roleRegistry(
    hudHome,
    root,
    env,
    undefined,
    (dir) => (dir === projectRoles ? [] : listDir(dir)),
    bundledRoot(),
    (file) => (file === projectJson ? unreadable() : readJson(file))
  );
}
function names(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}
function loadRecords(file: string): Records {
  try {
    const parsed = readJson(file);
    if (!isRecord(parsed)) return { links: new Set(), role_files: new Set(), agents: new Set(), convention: false };
    return {
      land: parsed.land, worktree: parsed.worktree, scratch: parsed.scratch, design: parsed.design,
      links: names(parsed.links),
      role_files: names(parsed.role_files),
      agents: names(parsed.agents),
      convention: parsed.convention === true,
    };
  } catch {
    return { links: new Set(), role_files: new Set(), agents: new Set(), convention: false };
  }
}
function skillDir(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory() && fs.statSync(join(path, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}
function stable(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([a], [b]) => cmp(a, b))
        .map(([key, child]) => [key, sort(child)])
    );
  };
  return JSON.stringify(sort(value));
}
function loadPlan(path: string, hudHome: string, root: string, env: NodeJS.ProcessEnv): Plan {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    bad('unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    bad('not json');
  }
  if (!isRecord(parsed)) bad('not an object');
  for (const key of Object.keys(parsed)) if (!PLAN_FIELDS.has(key)) bad(`unknown field ${key}`);
  if (parsed.version !== 1) bad('version');
  if (!Array.isArray(parsed.roles) || parsed.roles.some((item) => typeof item !== 'string' || !item)) bad('roles');
  const reference = referenceRegistry(hudHome, root, env);
  const skills = loadSkills(parsed.skills);
  const pi_roles = loadPiRoles(parsed.pi_roles, new Set(Object.keys(skills)), reference);
  const known = new Set([...reference.roles(true).keys(), ...Object.keys(pi_roles)]);
  for (const name of parsed.roles as string[]) if (!known.has(name)) bad(`role ${name}`);
  const agents = loadAgents(parsed.agents, pi_roles, reference);
  const convention = parsed.convention === undefined ? 'keep' : parsed.convention;
  if (convention !== 'keep' && convention !== 'copy-default') bad('convention');
  if (convention === 'copy-default' && fileKind(join(bundledRoot(), 'hud-convention.md')) !== 'file') bad('convention');
  const roleFiles = loadRuns(parsed.runs, known, pi_roles, reference);
  for (const [name, entry] of Object.entries(pi_roles)) {
    if (!roleFiles.has(name)) roleFiles.set(name, roleBody(name, entry, reference));
  }
  const disposable = parsed.disposable;
  if (disposable !== undefined && (!Array.isArray(disposable) || disposable.some(
    (glob) => typeof glob !== 'string' || !glob.trim() || /[\x00-\x1f\x7f]/.test(glob)
  ))) bad('disposable');
  return { roles: parsed.roles as string[], roleFiles, skills, agents, convention, disposable };
}
function loadRuns(value: unknown, known: Set<string>, piRoles: Record<string, PlanRole>, reference: Registry) {
  const files = new Map<string, RoleBody>();
  if (value === undefined) return files;
  if (!isRecord(value)) bad('runs');
  for (const [name, chain] of Object.entries(value)) {
    if (!NAME.test(name) || !known.has(name) || !Array.isArray(chain)) bad(`runs.${name}`);
    const entry = Object.hasOwn(piRoles, name) ? piRoles[name] : undefined;
    const base = reference.roles(true).get(entry?.from ?? name);
    const { role: _, can_continue, ...tuning } = entry
      ? tunedPiRole(name, entry, reference)
      : { can_continue: base?.can_continue ?? false };
    const run = chain.map((place) => isRecord(place) && place.harness === 'pi' ? { ...tuning, ...place } : place);
    const body = { role: name, instructions: base?.instructions, can_continue, run };
    const reason = projectReason(body);
    if (reason) bad(`runs.${name}: ${reason}`);
    files.set(name, { text: JSON.stringify(body, null, 2) + '\n', differs: true });
  }
  return files;
}
function loadSkills(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) bad('skills');
  const skills: Record<string, string> = {};
  for (const [name, path] of Object.entries(value)) {
    if (!NAME.test(name) || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !skillDir(path))
      bad(`skills.${name}`);
    skills[name] = path;
  }
  return skills;
}
function loadPiRoles(value: unknown, skillNames: Set<string>, reference: Registry): Record<string, PlanRole> {
  if (value === undefined) return {};
  if (!isRecord(value)) bad('pi_roles');
  const roles: Record<string, PlanRole> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!NAME.test(name) || !isRecord(raw)) bad(`pi_roles.${name}`);
    for (const key of Object.keys(raw)) if (!ROLE_FIELDS.has(key)) bad(`pi_roles.${name}.${key}`);
    const role: PlanRole = {};
    for (const key of ['from', 'pi_role', 'model', 'thinking'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'string' || ((key === 'from' || key === 'pi_role') && raw[key] === ''))
        bad(`pi_roles.${name}.${key}`);
      role[key] = raw[key];
    }
    if (role.pi_role !== undefined && !isPiProfile(role.pi_role)) bad(`pi_roles.${name}.pi_role: ${piProfileError}`);
    for (const key of ['split', 'can_continue'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'boolean') bad(`pi_roles.${name}.${key}`);
      role[key] = raw[key];
    }
    if (raw.skills !== undefined) {
      if (!Array.isArray(raw.skills) || raw.skills.some((item) => typeof item !== 'string' || !skillNames.has(item)))
        bad(`pi_roles.${name}.skills`);
      role.skills = raw.skills as string[];
    }
    const definitions = reference.roles(true), existing = definitions.get(name);
    if (existing && existing.harness !== 'pi') bad(`pi_roles.${name} is not pi`);
    if (!existing && role.from === undefined) bad(`pi_roles.${name}.from`);
    if (role.from !== undefined && definitions.get(role.from)?.harness !== 'pi') bad(`pi_roles.${name}.from`);
    roles[name] = role;
  }
  return roles;
}
function loadAgents(value: unknown, piRoles: Record<string, PlanRole>, reference: Registry): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) bad('agents');
  const agents: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    const pi = name in piRoles || reference.roles(true).get(name)?.harness === 'pi';
    if (!NAME.test(name) || !pi || typeof text !== 'string') bad(`agents.${name}`);
    if (Buffer.byteLength(text) > 65536) bad(`agents.${name} too long`);
    agents[name] = text;
  }
  return agents;
}
function piRoleShape(role: Role, name = role.role): Record<string, unknown> {
  const pi = role.run.find((place) => place.harness === 'pi');
  if (!pi) bad(`pi_roles.${name}.from`);
  const shape: Record<string, unknown> = {
    role: name,
    harness: 'pi',
    ...(pi.pi_role !== undefined ? { pi_role: pi.pi_role } : {}),
    split: pi.split ?? false,
    can_continue: role.can_continue ?? false,
  };
  for (const key of ['lens', 'mcp', 'tps', 'ui_ext'] as const) {
    if (pi[key] !== undefined) shape[key] = pi[key];
  }
  if (pi.model !== undefined) shape.model = pi.model;
  if (pi.thinking !== undefined) shape.thinking = pi.thinking;
  if (pi.skills !== undefined) shape.skills = [...pi.skills];
  if (pi.pi_args !== undefined) shape.pi_args = [...pi.pi_args];
  return shape;
}
function tunedPiRole(name: string, entry: PlanRole, reference: Registry) {
  const base = reference.roles(true).get(entry.from ?? name);
  if (!base || base.harness !== 'pi') bad(`pi_roles.${name}.from`);
  const next = piRoleShape(base, name);
  if (entry.pi_role !== undefined) next.pi_role = entry.pi_role;
  if (entry.model !== undefined) next.model = entry.model;
  if (entry.thinking !== undefined) next.thinking = entry.thinking;
  if (entry.split !== undefined) next.split = entry.split;
  if (entry.can_continue !== undefined) next.can_continue = entry.can_continue;
  if (entry.skills !== undefined) next.skills = [...entry.skills];
  return next;
}
function roleBody(name: string, entry: PlanRole, reference: Registry): RoleBody {
  const next = tunedPiRole(name, entry, reference);
  const same = reference.roles(true).get(name);
  return {
    text: JSON.stringify(next, null, 2) + '\n',
    differs: !same || same.harness !== 'pi' || stable(next) !== stable(piRoleShape(same)),
  };
}
let tmpSeq = 0;
function atomicWrite(file: string, text: string): void {
  writeFileAtomic(file, text, { mkdir: false, dotPrefix: true, mode: 0o644 });
}
function atomicSymlink(target: string, link: string): void {
  const tmp = join(dirname(link), `.${basename(link)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* Already renamed, or never created. */
    }
    throw error;
  }
}
function ensureDir(dir: string): void {
  if (fileKind(dir) !== 'missing') return;
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
}
function placeFile(
  abs: string,
  rel: string,
  text: string,
  owned: boolean,
  lines: string[],
  keep: Set<string>,
  name: string
) {
  const kind = fileKind(abs);
  if (kind === 'dir' || kind === 'other' || ((kind === 'file' || kind === 'link') && !owned)) {
    lines.push(`skipped (exists) ${rel}`);
    return;
  }
  if (kind === 'file' && fs.readFileSync(abs, 'utf8') === text) {
    keep.add(name);
    return;
  }
  ensureDir(dirname(abs));
  atomicWrite(abs, text);
  lines.push(`wrote ${rel}`);
  keep.add(name);
}
function placeLink(
  abs: string,
  rel: string,
  target: string,
  owned: boolean,
  lines: string[],
  keep: Set<string>,
  name: string
) {
  const kind = fileKind(abs);
  if (kind === 'dir' || kind === 'other' || ((kind === 'file' || kind === 'link') && !owned)) {
    lines.push(`skipped (exists) ${rel}`);
    return;
  }
  if (kind === 'link' && fs.readlinkSync(abs) === target) {
    keep.add(name);
    return;
  }
  ensureDir(dirname(abs));
  atomicSymlink(target, abs);
  lines.push(`linked ${rel}`);
  keep.add(name);
}
function removeManaged(abs: string, rel: string, lines: string[], keep: Set<string>, name: string): void {
  const kind = fileKind(abs);
  if (kind === 'missing') return;
  if (kind === 'dir' || kind === 'other') {
    lines.push(`skipped (exists) ${rel}`);
    keep.add(name);
    return;
  }
  fs.unlinkSync(abs);
  lines.push(`removed ${rel}`);
}
function sameRoot(stored: string, root: string): boolean {
  if (stored === root) return true;
  try {
    return fs.realpathSync(stored) === root;
  } catch {
    return false;
  }
}
function readProjects(file: string, strict: boolean): Record<string, unknown> | null {
  const kind = fileKind(file);
  if (kind === 'link') throw new CliError('refusing: projects.json is a symlink');
  if (kind === 'missing') return null;
  if (kind !== 'file') {
    if (strict) throw new CliError('refusing: projects.json is not version 1');
    return null;
  }
  try {
    const parsed = readJson(file);
    if (isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.projects)) return parsed;
  } catch {
    /* Fall through to the strict refusal or a missing registration. */
  }
  if (strict) throw new CliError('refusing: projects.json is not version 1');
  return null;
}
function registered(projects: Record<string, unknown> | null, root: string): boolean {
  return (
    (projects?.projects as unknown[] | undefined)?.some(
      (item) => isRecord(item) && typeof item.root === 'string' && item.root.length > 0 && sameRoot(item.root, root)
    ) ?? false
  );
}
function writeProjects(file: string, projects: Record<string, unknown> | null, root: string): void {
  const hudHome = dirname(file);
  if (fileKind(hudHome) === 'missing') {
    fs.mkdirSync(hudHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(hudHome, 0o700);
  }
  const data = projects ?? { version: 1, projects: [] };
  (data.projects as unknown[]).push({ root, registered_at: new Date().toISOString() });
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
}
function lineRank(line: string): number {
  if (line.startsWith('removed ')) return 0;
  if (line.startsWith('wrote ')) return 1;
  if (line.startsWith('linked ')) return 2;
  if (line.startsWith('skipped ')) return 3;
  return 4;
}
async function apply(planPath: string, cwd: string, env: NodeJS.ProcessEnv, io: HudIO): Promise<number> {
  const root = projectRoot(cwd);
  const hudHome = getHudHome(env);
  const plan = loadPlan(planPath, hudHome, root, env);
  const hud = join(root, '.hud');
  refuseParent(hud, '.hud');
  const projectFile = join(hud, 'project.json');
  const projectKind = fileKind(projectFile);
  if (projectKind === 'link' || projectKind === 'dir' || projectKind === 'other')
    throw new CliError('refusing: .hud/project.json is not a file');
  const records = loadRecords(projectFile);
  let worktree = records.worktree;
  if (plan.disposable?.length) {
    if (worktree !== undefined && !isRecord(worktree)) throw new CliError('refusing: invalid worktree configuration');
    const current = worktree?.disposable;
    if (current !== undefined && (!Array.isArray(current) || current.some(glob => typeof glob !== 'string')))
      throw new CliError('refusing: invalid worktree.disposable configuration');
    worktree = { ...worktree, disposable: [...new Set([...(current ?? []), ...plan.disposable])] };
  }
  const parents = [
    ...(plan.roleFiles.size || records.role_files.size
      ? [['.hud/roles', join(hud, 'roles')] as const]
      : []),
    ...(Object.keys(plan.skills).length || records.links.size ? [['.hud/skills', join(hud, 'skills')] as const] : []),
    ...(Object.keys(plan.agents).length || records.agents.size ? [['.hud/agents', join(hud, 'agents')] as const] : []),
  ];
  for (const [label, path] of parents) refuseParent(path, label);
  const projectsFile = join(hudHome, 'projects.json');
  const projects = readProjects(projectsFile, true);
  const lines: string[] = [];
  const next: Records = { links: new Set(), role_files: new Set(), agents: new Set(), convention: false };
  ensureDir(hud);
  for (const name of [...new Set([...plan.roleFiles.keys(), ...records.role_files])].sort(cmp)) {
    const rel = join('.hud', 'roles', `${name}.json`);
    const abs = join(root, rel);
    const body = plan.roleFiles.get(name);
    if (!body) {
      if (records.role_files.has(name)) removeManaged(abs, rel, lines, next.role_files, name);
      continue;
    }
    if (!body.differs) {
      if (records.role_files.has(name)) removeManaged(abs, rel, lines, next.role_files, name);
      else if (fileKind(abs) !== 'missing') lines.push(`skipped (exists) ${rel}`);
      continue;
    }
    placeFile(abs, rel, body.text, records.role_files.has(name), lines, next.role_files, name);
  }
  for (const name of [...new Set([...Object.keys(plan.skills), ...records.links])].sort(cmp)) {
    const rel = join('.hud', 'skills', name);
    const abs = join(root, rel);
    const target = plan.skills[name];
    if (!target) {
      if (records.links.has(name)) removeManaged(abs, rel, lines, next.links, name);
      continue;
    }
    placeLink(abs, rel, target, records.links.has(name), lines, next.links, name);
  }
  for (const name of [...new Set([...Object.keys(plan.agents), ...records.agents])].sort(cmp)) {
    const rel = join('.hud', 'agents', `${name}.md`);
    const abs = join(root, rel);
    const text = plan.agents[name];
    if (text === undefined) {
      if (records.agents.has(name)) removeManaged(abs, rel, lines, next.agents, name);
      continue;
    }
    placeFile(abs, rel, text, records.agents.has(name), lines, next.agents, name);
  }
  const convention = join(hud, 'hud-convention.md');
  if (plan.convention === 'copy-default') {
    const owned = new Set<string>();
    placeFile(
      convention,
      '.hud/hud-convention.md',
      fs.readFileSync(join(bundledRoot(), 'hud-convention.md'), 'utf8'),
      records.convention,
      lines,
      owned,
      'convention'
    );
    next.convention = owned.has('convention');
  } else if (records.convention && fileKind(convention) !== 'missing') next.convention = true;
  const ledger =
    JSON.stringify(
      {
        version: 1,
        roles: plan.roles,
        links: [...next.links].sort(cmp),
        role_files: [...next.role_files].sort(cmp),
        agents: [...next.agents].sort(cmp),
        convention: next.convention,
        land: records.land, worktree, scratch: records.scratch, design: records.design,
      },
      null,
      2
    ) + '\n';
  placeFile(projectFile, '.hud/project.json', ledger, true, lines, new Set(), 'project');
  if (!registered(projects, root)) {
    writeProjects(projectsFile, projects, root);
    lines.push('registered');
  }
  lines.sort((a, b) => lineRank(a) - lineRank(b) || cmp(a, b));
  await io.stdout((lines.length ? lines : ['no changes']).join('\n') + '\n');
  return lines.some((line) => line.startsWith('skipped ')) ? 1 : 0;
}
async function remove(cwd: string, env: NodeJS.ProcessEnv, io: HudIO): Promise<number> {
  const root = projectRoot(cwd);
  const file = join(getHudHome(env), 'projects.json');
  const projects = readProjects(file, false);
  if (!projects || !registered(projects, root)) {
    await io.stdout('not registered\n');
    return 0;
  }
  projects.projects = (projects.projects as unknown[]).filter(
    (item) => !(isRecord(item) && typeof item.root === 'string' && item.root.length > 0 && sameRoot(item.root, root))
  );
  atomicWrite(file, JSON.stringify(projects, null, 2) + '\n');
  await io.stdout('unregistered\n');
  return 0;
}
