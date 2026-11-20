/** Shared role resolution and owner role-file writes, without starting the MCP. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
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
import { readModelListCache, type ModelListCache } from './model-discovery.js';
import { HarnessSwitchError, piProviderId, readHarnessSwitches } from './harness-switches.js';

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

export interface RolePreset {
  name: string;
  run: RolePlace[];
}
/** Compare normalized places as data: object key order is irrelevant, place order is not. */
export function currentPreset(role: Pick<Role, 'run' | 'presets' | 'preset'>): string | null {
  if (role.preset !== undefined) return role.preset;
  return role.presets?.find((p) => isDeepStrictEqual(p.run, role.run))?.name ?? null;
}
export const validPresetName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(value);
export interface Role {
  role: string;
  instructions?: string;
  harness: 'pi' | 'bro' | 'cli';
  run: RolePlace[];
  presets?: RolePreset[];
  preset?: string | null;
  preset_missing?: string;
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
  state_trust?: 'turn' | 'advisory';
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
function runReason(run: unknown, instructions: unknown, canContinue: unknown): string | null {
  if (!Array.isArray(run) || run.length === 0) return 'bad run places';
  let needsContinue = false;
  for (const item of run) {
    const checked = placeReason(item, instructions, false);
    if (checked.reason) return checked.reason;
    if (checked.harness === 'pi' || checked.harness === 'cli') needsContinue = true;
  }
  return needsContinue && typeof canContinue !== 'boolean' ? 'missing can_continue' : null;
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
  if (raw.active_preset !== undefined && raw.active_preset !== null && !validPresetName(raw.active_preset))
    return 'bad active_preset';
  const hidden = raw.hidden_presets;
  if (hidden !== undefined && (!Array.isArray(hidden) || !hidden.every(validPresetName) || new Set(hidden).size !== hidden.length))
    return 'bad hidden_presets';
  if (raw.presets !== undefined) {
    if (!Array.isArray(raw.presets)) return 'bad presets';
    const names = new Set<string>();
    for (const preset of raw.presets) {
      if (!preset || typeof preset !== 'object' || Array.isArray(preset) ||
          !validPresetName(preset.name)) return 'bad preset name';
      if (names.has(preset.name)) return `duplicate preset ${preset.name}`;
      names.add(preset.name);
      const reason = runReason(preset.run, raw.instructions, raw.can_continue);
      if (reason) return `preset ${preset.name}: ${reason}`;
    }
  }
  if (raw.run !== undefined) return runReason(raw.run, raw.instructions, raw.can_continue);
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
  const reason = roleReason(value);
  if (reason) return reason;
  if (((raw.presets ?? []) as RolePreset[]).some((p) => p.run.some((place) => normalizeHarness(place.harness) !== 'pi')))
    return 'project roles are pi only';
  return null;
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
    ...primaryFields(primary),
    run,
    presets: ((parsed.presets ?? []) as RolePreset[]).map((p) => ({
      name: p.name, run: p.run.map((item) => normalizePlace(item, rawInstructions)),
    })),
    can_continue,
    ...(idle_grace_s !== undefined ? { idle_grace_s } : {}),
    source_file: path,
  };
}
function primaryFields(primary: RolePlace) {
  return {
    harness: primary.harness,
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
  };
}

type RawPreset = RolePreset & Record<string, unknown>;
type RoleLayer = {
  file: Role;
  raw: Record<string, unknown> & { active_preset?: string | null; hidden_presets?: string[]; presets?: RawPreset[] };
};
function mergePresets(layers: RoleLayer[]) {
  const presets = new Map<string, { preset: RolePreset; path: string; raw: RawPreset }>();
  for (const { file, raw } of layers) {
    for (const name of raw.hidden_presets ?? []) presets.delete(name);
    for (const [i, preset] of (file.presets ?? []).entries())
      presets.set(preset.name, { preset, path: file.source_file, raw: raw.presets![i]! });
  }
  return presets;
}
type ChainChoice = { preset: string | null } | { run: RolePlace[] };
export type PresetChange =
  | { op: 'select'; name: string | null }
  | { op: 'copy' | 'rename'; name: string }
  | { op: 'delete' }
  | { op: 'run'; run: RolePlace[] };
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
    result[name] = {
      ...merged,
      harness,
      ...(harness === 'cli' ? { state_trust: merged.state_trust === 'turn' ? 'turn' : 'advisory' } : {}),
    } as HarnessDefault;
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
function missingCommand(place: RolePlace, has: (command: string) => boolean): string | undefined {
  if (place.harness === 'pi') return has('pi-role') ? undefined : 'pi-role';
  if (place.harness === 'cli') {
    if (!has('herdr')) return 'herdr';
    return place.agent && has(place.agent) ? undefined : place.agent ?? 'CLI agent';
  }
  return place.tool && has(place.tool) ? undefined : place.tool ?? 'browser tool';
}

export function qualifiedPiProvider(model?: string | null): string | undefined {
  const slash = model?.indexOf('/') ?? -1;
  if (slash <= 0 || slash === model!.length - 1) return;
  const id = model!.slice(0, slash);
  if (piProviderId(id)) return id;
}

type PiSettings = { provider: string | null; model: string | null };
// One local, bounded read per settings signature; cache only the two routing fields.
let lastPiSettings: { path: string; signature: string; value?: PiSettings } | undefined;
function piSettings(env: NodeJS.ProcessEnv): PiSettings | undefined {
  const path = join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi', 'agent'), 'settings.json');
  try {
    const stat = fs.statSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > 65536n) return;
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (lastPiSettings?.path === path && lastPiSettings.signature === signature) return lastPiSettings.value;
    lastPiSettings = { path, signature };
    const file = slice(path, 65536);
    if (!file || file.truncated) return;
    const data = JSON.parse(file.text) as Record<string, unknown> | null;
    const provider = data?.defaultProvider, model = data?.defaultModel;
    return (lastPiSettings.value = {
      provider: piProviderId(provider) ? provider : null,
      model: typeof model === 'string' && model ? model : null,
    });
  } catch { /* No settings evidence. An unknown provider does not block dispatch. */ }
}

export type PlaceState = 'active' | 'standby' | 'off' | 'exhausted' | 'missing';
/** The same ordered decision is used for a live chain and the Harnesses what-if preview. */
export function evaluatePlaces<P extends { place: RolePlace; switch_ids: string[]; until?: string; missing?: string }>(
  candidates: readonly P[], disabled: ReadonlySet<string>, explicitModel = false
) {
  let decided = false;
  return candidates.map((candidate) => {
    const off_by = candidate.switch_ids.find((id) => disabled.has(id));
    const state: PlaceState = off_by ? 'off'
      : candidate.until ? 'exhausted' : candidate.missing ? 'missing' : decided ? 'standby' : 'active';
    // Exhausted or missing candidates can fall through, but an explicitly targeted off model cannot.
    if (!decided && (state === 'active' || (state === 'off' && explicitModel && candidate.place.harness !== 'bro')))
      decided = true;
    return { ...candidate, state, off_by };
  });
}

function routingContext(hudHome: string, env: NodeJS.ProcessEnv, now: number) {
  const disabled = readHarnessSwitches(hudHome);
  const modelLists = readModelListCache(hudHome, now, undefined, true);
  const models = modelLists?.pi ?? [];
  const providers = new Map<string, number>();
  const byId = new Map<string, string | null>();
  for (const id of models) {
    const provider = qualifiedPiProvider(id);
    if (!provider) continue;
    providers.set(provider, (providers.get(provider) ?? 0) + 1);
    const bare = id.slice(provider.length + 1);
    byId.set(bare, byId.has(bare) ? null : provider);
  }
  const commands = new Map<string, boolean>();
  const has = (cmd: string) => {
    if (!commands.has(cmd)) commands.set(cmd, !!executable(cmd, env));
    return commands.get(cmd)!;
  };
  let settings: { value: PiSettings | undefined } | undefined;
  return { disabled, modelLists, providers, byId, has, exhausted: readExhausted(hudHome, now),
    settings: () => (settings ??= { value: piSettings(env) }).value };
}

export function attributePiModel(model: string | null, context: ReturnType<typeof routingContext>) {
  const settings = model === null ? context.settings() : undefined;
  const effective = model ?? settings?.model ?? null;
  const fromSettings = settings?.provider ?? qualifiedPiProvider(settings?.model);
  const provider = qualifiedPiProvider(model) ?? fromSettings ?? context.byId.get(effective ?? '') ?? null;
  return { effective, provider, fromSettings };
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
  const sources = new WeakMap<Role, { layers: RoleLayer[]; presets: ReturnType<typeof mergePresets> }>();
  function scan(): { roles: Map<string, Role>; invalid: (InvalidRole & { role?: string })[] } {
    const layers = new Map<string, RoleLayer[]>();
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
        const raw = parsed as RoleLayer['raw'];
        const definition = normalizeRole(raw, path);
        const stack = layers.get(definition.role) ?? [];
        stack.push({ file: definition, raw });
        layers.set(definition.role, stack);
      }
    };
    const info = project();
    take(join(bundled, 'roles'), false);
    take(join(hudHome, 'roles'), false);
    if (info.registered) {
      take(join(info.root, '.hud', 'roles'), true);
      const names = allowed(join(info.root, '.hud', 'project.json'));
      if (names) for (const name of layers.keys()) if (!names.has(name)) layers.delete(name);
    }
    const roles = new Map<string, Role>();
    for (const [name, stack] of layers) {
      const { file, raw } = stack.at(-1)!;
      const merged = mergePresets(stack);
      const presets = [...merged.values()].map(({ preset }) => preset);
      const selected = raw.active_preset ? merged.get(raw.active_preset)?.preset : undefined;
      let role = { ...file, presets };
      if (selected) {
        // Launch fields follow the effective chain; the winning file still owns the role metadata.
        const { role: name, instructions, idle_grace_s, source_file } = file;
        role = { role: name, instructions, idle_grace_s, source_file, presets, run: selected.run,
          can_continue: selected.run.some((p) => p.harness !== 'bro') && Boolean(raw.can_continue),
          ...primaryFields(selected.run[0]!) };
      }
      role.preset = raw.active_preset === undefined ? currentPreset(role) : selected?.name ?? null;
      if (raw.active_preset && !selected) role.preset_missing = raw.active_preset;
      sources.set(role, { layers: stack, presets: merged });
      roles.set(name, role);
    }
    return { roles, invalid };
  }
  function roles(): Map<string, Role> {
    return scan().roles;
  }
  function invalid(): InvalidRole[] {
    return scan().invalid.map(({ path, reason }) => ({ path, reason }));
  }
  /** Last invalid file that names this role; callers ask only when no valid file defines it. */
  function invalidRole(name: string): InvalidRole | undefined {
    const item = scan().invalid.filter((item) => item.role === name).at(-1);
    if (item) return { path: item.path, reason: item.reason };
  }
  function chainSource(role: Role) {
    const stored = sources.get(role);
    return role.preset && stored?.presets.get(role.preset)?.preset.run === role.run
      ? stored.presets.get(role.preset)!.path : role.source_file;
  }
  function revision(role: Role) {
    return createHash('sha256').update(JSON.stringify(sources.get(role)!.layers.map(({ file, raw }) => [file.source_file, raw]))).digest('hex');
  }
  function placeDetails(role: Role, place: RolePlace, source = chainSource(role)) {
    const piInfo =
      place.harness === 'pi' ? piRoleInfo(place.pi_role ?? role.instructions, env, read) : { pi_role_file: null, frontmatter: undefined };
    const effective = (key: 'model' | 'thinking') => {
      if (place[key] !== undefined) return { value: place[key]!, source };
      const value = frontmatterValue(piInfo.frontmatter, key);
      return { value, source: value ? piInfo.pi_role_file : null };
    };
    const model = effective('model'),
      thinking = effective('thinking');
    const state_trust =
      place.harness === 'cli'
        ? harnessDefaults(hudHome, bundled, readJson)[place.agent!]?.state_trust ?? 'advisory'
        : undefined;
    return { pi_role_file: piInfo.pi_role_file, model, thinking, state_trust };
  }
  const routing = (now = Date.now()) => routingContext(hudHome, env, now);
  function assignment(role: Role, nowMs = Date.now(), overrideModel?: string, context = routing(nowMs), choice?: ChainChoice) {
    const stored = sources.get(role);
    const layer = stored?.layers.at(-1);
    let run = role.run, preset = currentPreset(role), source = chainSource(role), canContinue = role.can_continue;
    if (choice) {
      const named = 'preset' in choice && choice.preset !== null ? stored?.presets.get(choice.preset) : undefined;
      if ('preset' in choice && choice.preset !== null && !named) throw new Error(`unknown preset: ${choice.preset}`);
      run = 'run' in choice ? choice.run : named?.preset.run ?? layer?.file.run ?? role.run;
      preset = named?.preset.name ?? null;
      if ('preset' in choice) {
        source = named?.path ?? role.source_file;
        canContinue = Boolean(layer?.raw.can_continue);
      }
    }
    const evaluated = evaluatePlaces(run.map((configured, index) => {
      const overridden = overrideModel !== undefined && configured.harness !== 'bro';
      const place = overridden ? { ...configured, model: overrideModel } : configured;
      const details = placeDetails(role, place, source);
      const pi = place.harness === 'pi' ? attributePiModel(details.model.value, context) : undefined;
      const provider = pi?.provider;
      const provider_source = !provider ? undefined : qualifiedPiProvider(details.model.value) ? (place.model === undefined ? 'pi_role' : 'model')
        : pi?.fromSettings ? 'pi_settings' : 'cache';
      if (overridden) details.model.source = 'hud_create';
      // Pi settings attribute an external default; they do not change the HUD's model argument or its existing quota key.
      const key = placeKey(place, details.model.value);
      const mark = context.exhausted.get(key);
      const switch_ids = place.harness === 'pi' ? provider ? ['pi', `pi:${provider}`] : ['pi']
        : place.harness === 'cli' ? [`cli:${place.agent}`] : [`bro:${place.tool}`];
      return { index, place, ...details, key, until: mark?.until, quota_reason: mark?.reason,
        missing: missingCommand(place, context.has), switch_ids, provider, provider_source };
    }), context.disabled, overrideModel !== undefined);
    const chosen = evaluated.find((entry) => entry.state === 'active') ?? null;
    const activeEntry = chosen ?? evaluated[0]!;
    const active = activeEntry.place;
    const { pi_role_file, model, thinking } = activeEntry;
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
      can_continue: active.harness === 'bro' ? false : canContinue,
      model: model.value,
      thinking: thinking.value,
      model_source: model.source,
      thinking_source: thinking.source,
      pi_role_file,
      agent: active.harness === 'cli' ? active.agent : undefined,
      ...(active.harness === 'cli' ? { state_trust: activeEntry.state_trust } : {}),
      accepts_options: [
        'on',
        ...((role.presets?.length ?? 0) > 0 ? ['preset'] : []),
        ...(active.harness === 'pi'
          ? ['model', 'thinking', ...piSwitches, 'pi_args']
          : active.harness === 'cli'
            ? ['model', 'thinking']
            : active.tool === 'jev-flow'
              ? ['kind']
              : []),
      ],
      available: chosen !== null,
      ...(chosen ? {} : {
        reason: evaluated.map(({ place, model, state, off_by, until, quota_reason, missing }) =>
          `${describePlace(place, model.value)}: ${state === 'off' ? `off (${off_by})` : state === 'exhausted'
            ? `${quota_reason} (until ${until})` : state === 'missing' ? `missing ${missing} on PATH` : 'not used for the explicit model override'}`
        ).join('; '),
      }),
      run,
      presets: role.presets ?? [],
      preset,
      ...(choice ? { preset_missing: undefined } : {}),
      ...(source !== role.source_file ? { chain_source_file: source } : {}),
      runs_on: chosen ? chosen.place : null,
      places: evaluated,
      exhausted: evaluated.flatMap(({ place, key, until, quota_reason }) =>
        until ? [{ place, key, until, reason: quota_reason! }] : []
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
  /** Read raw places for the existing place keys: never round-trip normalized launch options. */
  function editableRun(role: Role, named?: string): RolePlace[] {
    const { layers, presets } = sources.get(role)!;
    const layer = layers.at(-1)!;
    const name = named ?? currentPreset(role);
    const saved = name === null ? undefined : presets.get(name);
    // Legacy equality labels the file chain, but doesn't make the normalized preset its source.
    const selected = saved && (named !== undefined || saved.preset.run === role.run) ? saved : undefined;
    const raw = selected?.raw.run ?? (Array.isArray(layer.raw.run) ? layer.raw.run as RolePlace[] : [
      { harness: role.run[0]!.harness, ...Object.fromEntries(LEGACY_PLACE_KEYS.filter((key) => key in layer.raw).map((key) => [key, layer.raw[key]])) },
    ]);
    const instructions = typeof layer.raw.instructions === 'string' ? layer.raw.instructions.trim() : undefined;
    return raw.map((p, i) => {
      const configured = (selected?.preset.run ?? role.run)[i]!;
      return { ...p, harness: configured.harness,
        ...(configured.harness === 'pi' && p.pi_role === undefined && configured.pi_role !== instructions
          ? { pi_role: configured.pi_role } : {}) };
    });
  }
  function savePreset(role: Role, change: PresetChange) {
    const { layers, presets } = sources.get(role)!;
    const { file, raw } = layers.at(-1)!;
    const roleName = role.role, rolesDir = join(hudHome, 'roles');
    if (!VALID_ROLE.test(roleName)) throw new Error('invalid role name');
    const owner = dirname(file.source_file) === rolesDir;
    if (!owner && dirname(file.source_file) !== join(bundled, 'roles')) throw new Error('the project file is in force: o opens it');
    const target = owner ? file.source_file : join(rolesDir, `${roleName}.json`);
    lstatKind(rolesDir, true, rolesDir);
    if (!owner && lstatKind(target, false, target)) throw new Error('owner role path is occupied');
    if (!lstatKind(file.source_file, false, file.source_file) || !isDeepStrictEqual(json(file.source_file), raw))
      throw new Error('role changed on disk; reopen the action');
    const next = { ...raw };
    if (!owner) { delete next.presets; delete next.hidden_presets; }
    const active = currentPreset(role);
    if (change.op === 'select') {
      if (change.name !== null && !presets.has(change.name)) throw new Error('preset not found');
      if (raw.active_preset === change.name) return;
      next.active_preset = change.name;
    } else if (change.op === 'run' && (!raw.active_preset || active === null)) {
      if (raw.active_preset !== undefined) next.active_preset = null;
      replaceFileRun(next, change.run, file.instructions);
    } else {
      const local = [...(next.presets ?? [])];
      const saved = active === null ? undefined : presets.get(active);
      if (change.op === 'rename' || change.op === 'delete') {
        if (active === null) throw new Error('choose a named preset first');
        const at = local.findIndex((p) => p.name === active);
        if (at >= 0) local.splice(at, 1);
        const inherited = mergePresets(owner ? layers.slice(0, -1) : layers).has(active);
        if (inherited && !next.hidden_presets?.includes(active)) next.hidden_presets = [...(next.hidden_presets ?? []), active];
      }
      if (change.op === 'delete') {
        next.active_preset = null;
      } else {
        const name = change.op === 'run' ? active! : change.name;
        if (!validPresetName(name)) throw new Error('bad preset name');
        if (change.op !== 'run' && presets.has(name)) throw new Error('preset name already exists');
        // Rename the saved definition, not a legacy file chain which only compares equal to it.
        const run = change.op === 'run' ? change.run : editableRun(role, change.op === 'rename' ? active! : undefined);
        const updated = { ...(change.op === 'copy' ? undefined : saved?.raw), name, run };
        const at = local.findIndex((p) => p.name === name);
        if (at < 0) local.push(updated);
        else local[at] = updated;
        next.active_preset = name;
      }
      if (local.length || next.presets !== undefined) next.presets = local;
    }
    if (next.can_continue === undefined && next.presets?.some((p) => p.run.some((place) => place.harness !== 'bro')))
      next.can_continue = false;
    writeRoleRecord(rolesDir, target, roleName, next, owner ? raw : null);
  }
  return { roles, invalid, invalidRole, assignment, routing, placeDetails, convention, project, projectConfigIgnored,
    revision, editableRun, savePreset };
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
  let nextInfo: ReturnType<typeof reg.assignment> | null = null;
  try { if (roleDef) nextInfo = reg.assignment(roleDef, nowMs); }
  catch (error) { if (!(error instanceof HarnessSwitchError)) throw error; }
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
  pi: { models: string[]; thinking: string[]; offline: string[] };
  cli: { agents: CliAgent[]; models: Record<CliAgent, string[]>; thinking: string[] };
  bro: {
    tools: ('jev-ask' | 'jev-aistudio' | 'jev-flow')[];
    providers: ('chatgpt' | 'gemini')[];
    kinds: ('image' | 'video')[];
    models: Record<string, string[]>;
  };
}

export const BRO_TOOLS = ['jev-ask', 'jev-aistudio', 'jev-flow'] as const;
const BRO_PROVIDERS = ['chatgpt', 'gemini'] as const;
const BRO_KINDS = ['image', 'video'] as const;
const LEGACY_PLACE_KEYS = [
  'harness', 'pi_role', 'split', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'pi_args', 'agent', 'args', 'tool', 'provider',
  'effort', 'kind', 'model', 'thinking',
];
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
function mergeLists<T extends string>(sources: unknown[], allow?: readonly T[]): T[] {
  let out: T[] = [];
  for (const source of sources) out = mergeStrings(out, source, allow);
  return out;
}
function mergeModelMaps(sources: Record<string, unknown>[], keys: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of keys) out[key] = mergeLists(sources.map((s) => s[key]));
  return out;
}
function typedRoleModels(
  hudHome: string,
  safe: (file: string) => Record<string, unknown>,
  list: (directory: string) => string[]
): { pi: string[]; cli: Record<string, string[]>; bro: Record<string, string[]> } {
  const pi: string[] = [];
  const cli: Record<string, string[]> = {};
  const bro: Record<string, string[]> = {};
  const rolesDir = join(hudHome, 'roles');
  let names: string[] = [];
  try {
    names = list(rolesDir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { pi, cli, bro };
  }
  for (const name of names) {
    const parsed = safe(join(rolesDir, name));
    const places = Array.isArray(parsed.run) ? parsed.run : [parsed];
    for (const item of places) {
      const place = asRecord(item);
      const model = typeof place.model === 'string' ? place.model.trim() : '';
      if (!model) continue;
      const harness = normalizeHarness(place.harness);
      if (harness === 'pi') pi.push(model);
      else if (harness === 'cli' && typeof place.agent === 'string' && (cliAgents as readonly string[]).includes(place.agent)) {
        (cli[place.agent] ??= []).push(model);
      } else if (harness === 'bro') {
        const key = place.tool === 'jev-ask' ? place.provider : place.tool;
        if (typeof key === 'string' && key) (bro[key] ??= []).push(model);
      }
    }
  }
  return { pi, cli, bro };
}
export function placeCatalog(
  hudHome: string,
  bundled = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url)),
  readJson: (file: string) => unknown = json,
  now = Date.now(),
  list: (directory: string) => string[] = entries,
  discovered: ModelListCache | null = readModelListCache(hudHome, now, readJson, true)
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
  const typed = typedRoleModels(hudHome, safe, list);
  const sPi = asRecord(shipped.pi),
    ePi = asRecord(extra.pi);
  const sCli = asRecord(shipped.cli),
    eCli = asRecord(extra.cli);
  const sBro = asRecord(shipped.bro),
    eBro = asRecord(extra.bro);
  const sCliModels = asRecord(sCli.models),
    eCliModels = asRecord(eCli.models);
  const dCliModels = asRecord(discovered?.cli);
  const sBroModels = asRecord(sBro.models),
    eBroModels = asRecord(eBro.models);
  const broModelKeys = [...new Set([...Object.keys(sBroModels), ...Object.keys(eBroModels), ...Object.keys(typed.bro)])];
  const offline = mergeLists<string>([sPi.models, ePi.models]);
  return {
    pi: {
      models: mergeLists([discovered?.pi, offline, typed.pi]),
      thinking: mergeLists([sPi.thinking, ePi.thinking]),
      offline,
    },
    cli: {
      agents: mergeLists<CliAgent>([sCli.agents, eCli.agents], cliAgents),
      models: mergeModelMaps([dCliModels, sCliModels, eCliModels, typed.cli], cliAgents) as Record<CliAgent, string[]>,
      thinking: mergeLists([sCli.thinking, eCli.thinking]),
    },
    bro: {
      tools: mergeLists([sBro.tools, eBro.tools], BRO_TOOLS),
      providers: mergeLists([sBro.providers, eBro.providers], BRO_PROVIDERS),
      kinds: mergeLists([sBro.kinds, eBro.kinds], BRO_KINDS),
      models: mergeModelMaps([sBroModels, eBroModels, typed.bro], broModelKeys),
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
  const next: Record<string, unknown> = { ...base, role };
  const derived = !Array.isArray(base.run) && roleReason(base) === null ? normalizeRole(base, target).instructions : undefined;
  replaceFileRun(next, run, derived);
  return writeRoleRecord(rolesDir, target, role, next);
}
function replaceFileRun(next: Record<string, unknown>, run: readonly RolePlace[], instructions?: string) {
  if (!Array.isArray(next.run) && next.harness !== undefined) {
    // A single-place file becomes a run list; keep derived instructions and remove the old place keys.
    if (next.instructions === undefined && instructions !== undefined) next.instructions = instructions;
    for (const key of LEGACY_PLACE_KEYS) delete next[key];
  }
  next.run = run;
  if (next.can_continue === undefined && run.some((p) => p && (p.harness === 'pi' || p.harness === 'cli')))
    next.can_continue = false;
}
function writeRoleRecord(rolesDir: string, target: string, role: string, next: Record<string, unknown>, expected?: Record<string, unknown> | null): string {
  const err = roleReason(next);
  if (err) throw new Error(`invalid role places: ${err}`);
  fs.mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  const temp = join(rolesDir, `.${role}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    lstatKind(rolesDir, true, rolesDir);
    const exists = lstatKind(target, false, target);
    if (expected !== undefined && (expected === null ? exists : !exists || !isDeepStrictEqual(json(target), expected)))
      throw new Error('Role changed on disk; reopen the action');
    fs.renameSync(temp, target);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* Renamed or failed before creation. */
    }
  }
  return target;
}
