/** hud_roster's read-only registry, shared without starting the MCP. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAgents, type CliAgent } from './cli-kinds.js';
import {
  clearExhausted,
  describePlace,
  isQuotaFailure,
  markExhausted,
  placeKey,
  readExhausted,
  type ExhaustedMark,
  type RolePlace,
} from './exhausted.js';
import { registeredProject } from './projects.js';

export {
  clearExhausted,
  describePlace,
  isQuotaFailure,
  markExhausted,
  placeKey,
  readExhausted,
  type ExhaustedMark,
  type RolePlace,
};

export interface Role {
  role: string;
  instructions?: string;
  harness: 'pi' | 'bro' | 'cli';
  run: RolePlace[];
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
export interface HarnessDefault {
  harness: 'pi' | 'bro' | 'cli';
  agent?: CliAgent;
  model?: string;
  thinking?: string;
  tool?: 'jev-ask' | 'jev-aistudio' | 'jev-flow';
  provider?: 'chatgpt' | 'gemini';
  effort?: string;
  kind?: 'image' | 'video';
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
function normalizeHarness(value: unknown): unknown {
  return value === 'jev' ? 'bro' : value;
}
function badStrings(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'));
}
function badPi(place: Partial<RolePlace>, instructions: unknown, requireSplit: boolean): boolean {
  const piRole = place.pi_role ?? instructions;
  if (typeof piRole !== 'string' || !piRole.trim()) return true;
  if (requireSplit ? typeof place.split !== 'boolean' : place.split !== undefined && typeof place.split !== 'boolean')
    return true;
  for (const flag of ['lens', 'mcp', 'tps', 'ui_ext'] as const)
    if (place[flag] !== undefined && typeof place[flag] !== 'boolean') return true;
  if (badStrings(place.pi_args)) return true;
  return false;
}
function badCli(place: Partial<RolePlace>): boolean {
  if (typeof place.agent !== 'string' || !(cliAgents as readonly string[]).includes(place.agent)) return true;
  if (badStrings(place.args)) return true;
  return false;
}
function badBro(place: Partial<RolePlace>): boolean {
  return (
    !['jev-ask', 'jev-aistudio', 'jev-flow'].includes(place.tool ?? '') ||
    (place.tool === 'jev-ask' && !['chatgpt', 'gemini'].includes(place.provider ?? '')) ||
    (place.tool === 'jev-flow' && place.kind !== undefined && !['image', 'video'].includes(place.kind))
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
function placeReason(
  value: unknown,
  instructions: unknown,
  requireSplit: boolean
): { reason: string | null; harness?: 'pi' | 'bro' | 'cli' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'bad run places' };
  const place = value as Partial<RolePlace>;
  const harness = normalizeHarness(place.harness);
  if (harness !== 'pi' && harness !== 'bro' && harness !== 'cli')
    return { reason: `unknown harness ${harnessToken(place.harness)}` };
  if (harness === 'pi' && (badPi(place, instructions, requireSplit) || badSkills(value)))
    return { reason: 'bad pi fields' };
  if (harness === 'cli' && (badCli(place) || skillsOf(value) !== undefined)) return { reason: 'bad cli fields' };
  if (harness === 'bro' && (badBro(place) || skillsOf(value) !== undefined)) return { reason: 'bad bro fields' };
  if (
    ['model', 'thinking', 'effort'].some(
      (key) => place[key as keyof RolePlace] !== undefined && typeof place[key as keyof RolePlace] !== 'string'
    )
  )
    return { reason: 'bad model/thinking/effort' };
  return { reason: null, harness };
}
function roleReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unparseable JSON';
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== 'string' || !raw.role.trim()) return 'missing role';
  if (raw.instructions !== undefined && (typeof raw.instructions !== 'string' || !raw.instructions.trim()))
    return 'bad instructions';
  if (raw.idle_grace_s !== undefined && (!Number.isInteger(raw.idle_grace_s) || (raw.idle_grace_s as number) < 0))
    return 'bad cli fields';
  if (raw.can_continue !== undefined && typeof raw.can_continue !== 'boolean') return 'bad can_continue';
  if (raw.run !== undefined) {
    if (!Array.isArray(raw.run) || raw.run.length === 0) return 'bad run places';
    let needsContinue = false;
    for (const item of raw.run) {
      const checked = placeReason(item, raw.instructions, false);
      if (checked.reason) return checked.reason;
      if (checked.harness === 'pi' || checked.harness === 'cli') needsContinue = true;
    }
    if (needsContinue && typeof raw.can_continue !== 'boolean') return 'missing can_continue';
    return null;
  }
  const checked = placeReason(value, raw.instructions, true);
  if (checked.reason) return checked.reason;
  if ((checked.harness === 'pi' || checked.harness === 'cli') && typeof raw.can_continue !== 'boolean')
    return checked.harness === 'pi' ? 'bad pi fields' : 'bad cli fields';
  return null;
}
function projectReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unparseable JSON';
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== 'string' || !raw.role.trim()) return 'missing role';
  if (Array.isArray(raw.run)) {
    if (raw.run.some((p) => !p || typeof p !== 'object' || normalizeHarness((p as { harness?: unknown }).harness) !== 'pi'))
      return 'project roles are pi only';
  } else if (normalizeHarness(raw.harness) !== 'pi') {
    return 'project roles are pi only';
  }
  return roleReason(value);
}
function normalizePlace(raw: Partial<RolePlace>, instructions?: string): RolePlace {
  const harness = normalizeHarness(raw.harness) as 'pi' | 'bro' | 'cli';
  const place: RolePlace = { harness };
  if (raw.model !== undefined) place.model = raw.model;
  if (raw.thinking !== undefined) place.thinking = raw.thinking;
  if (harness === 'pi') {
    place.pi_role = raw.pi_role ?? instructions;
    place.split = raw.split ?? false;
    for (const flag of ['lens', 'mcp', 'tps', 'ui_ext'] as const)
      if (raw[flag] !== undefined) place[flag] = raw[flag];
    if (raw.skills !== undefined) place.skills = [...raw.skills];
    if (raw.pi_args !== undefined) place.pi_args = [...raw.pi_args];
  } else if (harness === 'cli') {
    place.agent = raw.agent;
    if (raw.args !== undefined) place.args = [...raw.args];
  } else {
    place.tool = raw.tool;
    if (raw.provider !== undefined) place.provider = raw.provider;
    if (raw.effort !== undefined) place.effort = raw.effort;
    if (raw.tool === 'jev-flow') place.kind = raw.kind ?? 'image';
  }
  return place;
}
function normalizeRole(parsed: Record<string, unknown>, path: string): Role {
  const rawInstructions = typeof parsed.instructions === 'string' ? parsed.instructions.trim() : undefined;
  const rawRun = Array.isArray(parsed.run) ? (parsed.run as Partial<RolePlace>[]) : [parsed as Partial<RolePlace>];
  const run = rawRun.map((item) => normalizePlace(item, rawInstructions));
  const primary = run[0]!;
  const instructions =
    rawInstructions ??
    (!Array.isArray(parsed.run)
      ? primary.harness === 'pi'
        ? primary.pi_role
        : primary.harness === 'cli'
          ? 'implementer'
          : undefined
      : undefined);
  const can_continue = run.every((place) => place.harness === 'bro') ? false : Boolean(parsed.can_continue);
  const idle_grace_s = typeof parsed.idle_grace_s === 'number' ? parsed.idle_grace_s : undefined;
  return {
    role: String(parsed.role),
    ...(instructions !== undefined ? { instructions } : {}),
    harness: primary.harness,
    run,
    can_continue,
    ...(idle_grace_s !== undefined ? { idle_grace_s } : {}),
    ...(primary.pi_role !== undefined ? { pi_role: primary.pi_role } : {}),
    ...(primary.split !== undefined ? { split: primary.split } : {}),
    ...(primary.skills !== undefined ? { skills: primary.skills } : {}),
    ...(primary.model !== undefined ? { model: primary.model } : {}),
    ...(primary.thinking !== undefined ? { thinking: primary.thinking } : {}),
    ...(primary.tool !== undefined ? { tool: primary.tool } : {}),
    ...(primary.provider !== undefined ? { provider: primary.provider } : {}),
    ...(primary.effort !== undefined ? { effort: primary.effort } : {}),
    ...(primary.kind !== undefined ? { kind: primary.kind } : {}),
    ...(primary.agent !== undefined ? { agent: primary.agent } : {}),
    ...(primary.args !== undefined ? { args: primary.args } : {}),
    source_file: path,
  };
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
export function harnessDefaults(
  hudHome: string,
  bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url)),
  readJson: (file: string) => unknown = json
): Record<string, HarnessDefault> {
  const load = (file: string): Record<string, Partial<HarnessDefault>> => {
    try {
      const raw = readJson(file);
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, Partial<HarnessDefault>>)
        : {};
    } catch {
      return {};
    }
  };
  const base = load(join(bundled, 'harnesses.json'));
  const override = load(join(hudHome, 'harnesses.json'));
  const result: Record<string, HarnessDefault> = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const merged = { ...(base[name] ?? {}), ...(override[name] ?? {}) };
    const harness = normalizeHarness(merged.harness);
    if (harness !== 'pi' && harness !== 'cli' && harness !== 'bro') continue;
    result[name] = { ...merged, harness } as HarnessDefault;
  }
  return result;
}
function piRoleInfo(
  piRole: string | undefined,
  env: NodeJS.ProcessEnv,
  read: typeof slice
): { pi_role_file: string | null; frontmatter: string | undefined } {
  let pi_role_file: string | null = null;
  if (piRole) {
    for (const command of ['pi-role', 'pi-dispatch']) {
      const bin = executable(command, env);
      const path = bin && join(dirname(dirname(bin)), 'roles', `${piRole}.md`);
      if (path && fs.existsSync(path)) {
        pi_role_file = path;
        break;
      }
    }
  }
  const frontmatter = pi_role_file
    ? read(pi_role_file, 16384)?.text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
    : undefined;
  return { pi_role_file, frontmatter };
}
function frontmatterValue(frontmatter: string | undefined, key: 'model' | 'thinking'): string | null {
  const value = frontmatter?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return value ? value.replace(/^(['"])(.*)\1$/, '$2') : null;
}
function placeAvailable(
  place: RolePlace,
  env: NodeJS.ProcessEnv,
  exhausted: Map<string, ExhaustedMark>,
  resolvedModel?: string | null
): boolean {
  if (exhausted.has(placeKey(place, resolvedModel))) return false;
  if (place.harness === 'pi') return executable('pi-role', env) !== null;
  if (place.harness === 'cli')
    return executable('herdr', env) !== null && !!place.agent && executable(place.agent, env) !== null;
  return !!place.tool && executable(place.tool, env) !== null;
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
        const role = normalizeRole(parsed as Record<string, unknown>, path);
        roles.set(role.role, role);
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
  function placeDetails(role: Role, place: RolePlace) {
    const piInfo =
      place.harness === 'pi' ? piRoleInfo(place.pi_role ?? role.instructions, env, read) : { pi_role_file: null, frontmatter: undefined };
    const effective = (key: 'model' | 'thinking') => {
      if (place[key] !== undefined) return { value: place[key]!, source: role.source_file };
      const value = frontmatterValue(piInfo.frontmatter, key);
      return { value, source: value ? piInfo.pi_role_file : null };
    };
    const model = effective('model'),
      thinking = effective('thinking');
    return { pi_role_file: piInfo.pi_role_file, model, thinking };
  }
  function assignment(role: Role, nowMs = Date.now()) {
    const exhaustedMap = readExhausted(hudHome, nowMs);
    const evaluated = role.run.map((place) => {
      const details = placeDetails(role, place);
      const key = placeKey(place, details.model.value);
      const mark = exhaustedMap.get(key) ?? null;
      return { place, details, key, mark, ok: placeAvailable(place, env, exhaustedMap, details.model.value) };
    });
    const chosen = evaluated.find((entry) => entry.ok) ?? null;
    const activeEntry = chosen ?? evaluated[0]!;
    const active = activeEntry.place;
    const { pi_role_file, model, thinking } = activeEntry.details;
    return {
      ...role,
      harness: active.harness,
      pi_role: active.harness === 'pi' ? (active.pi_role ?? role.instructions) : undefined,
      split: active.harness === 'pi' ? (active.split ?? false) : undefined,
      skills: active.harness === 'pi' ? active.skills : undefined,
      tool: active.harness === 'bro' ? active.tool : undefined,
      provider: active.harness === 'bro' ? active.provider : undefined,
      effort: active.harness === 'bro' ? active.effort : undefined,
      kind: active.harness === 'bro' ? active.kind : undefined,
      args: active.harness === 'cli' ? active.args : undefined,
      can_continue: active.harness === 'bro' ? false : role.can_continue,
      model: model.value,
      thinking: thinking.value,
      model_source: model.source,
      thinking_source: thinking.source,
      pi_role_file,
      agent: active.harness === 'cli' ? active.agent : undefined,
      accepts_options:
        active.harness === 'pi'
          ? ['on', 'model', 'thinking', ...piSwitches, 'pi_args']
          : active.harness === 'cli'
            ? ['on', 'model', 'thinking']
            : active.tool === 'jev-flow'
              ? ['on', 'kind']
              : ['on'],
      available: chosen !== null,
      run: role.run,
      runs_on: chosen ? chosen.place : null,
      exhausted: evaluated.flatMap((entry) =>
        entry.mark
          ? [{ place: entry.place, key: entry.key, until: entry.mark.until, reason: entry.mark.reason }]
          : []
      ),
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
  return { roles, invalid, invalidPath, assignment, placeDetails, convention, project, projectConfigIgnored };
}

export function recordFailureExhaustion(
  hudHome: string,
  bundled: string,
  dir: string,
  job: {
    role: string;
    cwd?: string;
    place?: RolePlace;
    place_key?: string;
    model?: string | null;
    exhaustion_marked?: boolean;
  },
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): { marked: boolean; reason: string } {
  const jobFile = join(dir, 'job.json');
  let diskJob: Record<string, unknown> | null = null;
  try {
    diskJob = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as Record<string, unknown>;
  } catch {
    /* Job may not exist in synthetic calls. */
  }
  if (job.exhaustion_marked || diskJob?.exhaustion_marked || !isQuotaFailure(reason)) {
    return { marked: false, reason };
  }
  const key = job.place_key ?? (job.place ? placeKey(job.place, job.model) : null);
  if (!key) return { marked: false, reason };
  markExhausted(hudHome, key, reason, nowMs);
  const reg = roleRegistry(hudHome, job.cwd ?? process.cwd(), env, undefined, undefined, bundled);
  const roleDef = reg.roles().get(job.role);
  const nextInfo = roleDef ? reg.assignment(roleDef, nowMs) : null;
  const nextPlace = nextInfo?.runs_on ?? null;
  const suffix = nextPlace
    ? `; next dispatch will use ${describePlace(nextPlace, nextInfo?.model ?? null)}`
    : '; no fallback place available';
  const enriched =
    reason.includes('; next dispatch will use ') || reason.includes('; no fallback place available')
      ? reason
      : `${reason.slice(0, Math.max(0, 500 - suffix.length))}${suffix}`;
  if (diskJob) {
    try {
      const temp = `${jobFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ ...diskJob, exhaustion_marked: true }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, jobFile);
    } catch {
      /* Ignore transient write error. */
    }
  }
  return { marked: true, reason: enriched };
}

export interface PlaceCatalog {
  pi: { models: string[]; thinking: string[] };
  cli: { agents: CliAgent[]; models: Record<CliAgent, string[]>; thinking: string[] };
  bro: {
    tools: ('jev-ask' | 'jev-aistudio' | 'jev-flow')[];
    providers: ('chatgpt' | 'gemini')[];
    kinds: ('image' | 'video')[];
    models: Record<string, string[]>;
  };
}

const BRO_TOOLS = ['jev-ask', 'jev-aistudio', 'jev-flow'] as const;
const BRO_PROVIDERS = ['chatgpt', 'gemini'] as const;
const BRO_KINDS = ['image', 'video'] as const;
const VALID_ROLE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function mergeStrings<T extends string>(base: T[], extra: unknown, allow?: readonly T[]): T[] {
  const out = [...base];
  if (!Array.isArray(extra)) return out;
  for (const item of extra) {
    if (typeof item !== 'string' || !item.trim()) continue;
    if (allow && !(allow as readonly string[]).includes(item)) continue;
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out;
}
function mergeModelMap(base: Record<string, unknown>, extra: unknown, keys: readonly string[]): Record<string, string[]> {
  const ext = asRecord(extra);
  const out: Record<string, string[]> = {};
  for (const key of keys) out[key] = mergeStrings(mergeStrings<string>([], base[key]), ext[key]);
  return out;
}
export function placeCatalog(
  hudHome: string,
  bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url)),
  readJson: (file: string) => unknown = json
): PlaceCatalog {
  const safe = (file: string) => {
    try {
      return asRecord(readJson(file));
    } catch {
      return {};
    }
  };
  const shipped = safe(join(bundled, 'catalog.json'));
  const extra = asRecord(safe(join(hudHome, 'harnesses.json')).catalog);
  const sPi = asRecord(shipped.pi),
    ePi = asRecord(extra.pi);
  const sCli = asRecord(shipped.cli),
    eCli = asRecord(extra.cli);
  const sBro = asRecord(shipped.bro),
    eBro = asRecord(extra.bro);
  const sBroModels = asRecord(sBro.models),
    eBroModels = asRecord(eBro.models);
  const broModelKeys = [...new Set([...Object.keys(sBroModels), ...Object.keys(eBroModels)])];
  return {
    pi: {
      models: mergeStrings(mergeStrings<string>([], sPi.models), ePi.models),
      thinking: mergeStrings(mergeStrings<string>([], sPi.thinking), ePi.thinking),
    },
    cli: {
      agents: mergeStrings(mergeStrings<CliAgent>([], sCli.agents, cliAgents), eCli.agents, cliAgents),
      models: mergeModelMap(asRecord(sCli.models), eCli.models, cliAgents) as Record<CliAgent, string[]>,
      thinking: mergeStrings(mergeStrings<string>([], sCli.thinking), eCli.thinking),
    },
    bro: {
      tools: mergeStrings(mergeStrings([], sBro.tools, BRO_TOOLS), eBro.tools, BRO_TOOLS),
      providers: mergeStrings(mergeStrings([], sBro.providers, BRO_PROVIDERS), eBro.providers, BRO_PROVIDERS),
      kinds: mergeStrings(mergeStrings([], sBro.kinds, BRO_KINDS), eBro.kinds, BRO_KINDS),
      models: mergeModelMap(sBroModels, eBroModels, broModelKeys),
    },
  };
}

function lstatKind(path: string, wantDir: boolean, label: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing symlink: ${label}`);
  if (wantDir ? !st.isDirectory() : !st.isFile()) throw new Error(`refusing non-${wantDir ? 'directory' : 'file'}: ${label}`);
  return true;
}
function readRoleRecord(file: string, label: string): Record<string, unknown> {
  if (!lstatKind(file, false, label)) return {};
  const parsed = json(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid role JSON: ${label}`);
  return parsed as Record<string, unknown>;
}
export function writeRolePlaces(
  hudHome: string,
  role: string,
  run: readonly RolePlace[],
  bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url))
): string {
  if (typeof role !== 'string' || !VALID_ROLE.test(role)) throw new Error(`invalid role name: ${String(role)}`);
  if (!Array.isArray(run) || run.length === 0) throw new Error('run must be a non-empty array');
  const rolesDir = join(hudHome, 'roles');
  const target = join(rolesDir, `${role}.json`);
  lstatKind(rolesDir, true, rolesDir);
  const hasHome = lstatKind(target, false, target);
  const base = hasHome
    ? readRoleRecord(target, target)
    : readRoleRecord(join(bundled, 'roles', `${role}.json`), `shipped/${role}.json`);
  const nextRun = run.map((place) => (place && typeof place === 'object' && !Array.isArray(place) ? { ...place } : place));
  const next: Record<string, unknown> = { ...base, role, run: nextRun };
  if (next.can_continue === undefined && nextRun.some((p) => p && (p.harness === 'pi' || p.harness === 'cli'))) {
    next.can_continue = false;
  }
  const err = roleReason(next);
  if (err) throw new Error(`invalid role places: ${err}`);
  fs.mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  const temp = join(rolesDir, `.${role}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    lstatKind(target, false, target);
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Renamed or failed before creation. */
    }
  }
  return target;
}
