/**
 * The Control plane's two halves: what it shows of where each role runs (`controlFacts`, read-only, for the collector)
 * and what a key there does (`editPlaces` / `editPreset` write the owner role or clear a quota mark).
 * The next `hud_create` reads the same files, so what the page shows is
 * what that call uses.
 */
import * as fs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_MODELS_CATALOG } from '../models/catalog.js';
import { cliAgents } from './cli-kinds.js';
import { isModelToken, modelSourceStatus, type ModelListCache } from './model-discovery.js';
import { placeKey } from './exhausted.js';
import {
  attributePiModel,
  clearExhausted,
  currentPreset,
  validPresetName,
  harnessDefaults,
  BRO_TOOLS,
  evaluatePlaces,
  qualifiedPiProvider,
  placeCatalog,
  roleRegistry,
  type PresetChange,
  type HarnessDefault,
  type PlaceCatalog,
  type PlaceState,
  type Role,
  type RolePlace,
} from './roster.js';

type Registry = ReturnType<typeof roleRegistry>;
const BUNDLED = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url));

export type { PlaceState };
export interface PlaceFact {
  harness: RolePlace['harness'];
  /** `pi`, an agent (`agy`), or a browser place (`chatgpt`, `gemini`, `aistudio`, `flow`). */
  label: string;
  model: string | null;
  thinking: string | null;
  inheritedThinking?: boolean;
  kind?: 'image' | 'video';
  /** `active` is where the next `hud_create` runs. A real quota mark can coexist with `off`. */
  state: PlaceState;
  until?: number;
  offBy?: string;
  missing?: string;
  /** null = an unattributable pi provider; undefined = not a pi place. */
  provider?: string | null;
  piModel?: {
    current: string | null;
    isDefault: boolean;
    defaultId: string | null;
    defaultSource?: 'from pi role' | 'from pi settings';
    defaultOff: boolean;
    defaultUntil?: number;
  };
}
export interface RoleFact {
  role: string;
  /** The role file in force; `o` opens it. */
  path: string;
  /** Whose file that is: the shipped `default`, `yours` under `$HUD_HOME/roles`, or the `project`'s. */
  source: 'default' | 'yours' | 'project';
  /** `project` roles come from the project's own `.hud/roles`, which wins and is never written here. */
  group: 'roles' | 'project' | 'browser';
  optionalEnabled?: boolean;
  places: PlaceFact[];
  /** Null means the file chain; legacy equality can supply a displayed name. */
  preset?: string | null;
  presets?: { name: string; next: string | null; offBy?: string; places?: PlaceFact[] }[];
  fileChain?: PlaceFact[];
  chainPath?: string;
  missingPreset?: string;
  revision?: string;
  editor?: { places: DraftPlace[]; targets: DraftPlace[] };
}
export interface DraftPlace {
  raw: RolePlace;
  fact: PlaceFact;
  defaultModel?: string | null;
  defaultProvider?: string | null;
  defaultThinking?: string | null;
}
export interface HarnessFact {
  name: string;
  ok: boolean;
}
export interface HarnessSwitchFact {
  id: string;
  name: string;
  group: 'runner' | 'cli' | 'browser' | 'provider';
  off: boolean;
  present: boolean;
  runnerOff?: boolean;
  models?: number;
  sites?: readonly string[];
  uses: { role: string; preset: string | null; index: number; next: string | null; switchedNext: string | null }[];
}
/** The enabled pi groups, and the separate CLI/browser catalogs the picker works from. */
export interface ModelLists {
  pi: string[];
  piFacts?: ModelListCache['piFacts'];
  piExhausted?: Record<string, number>;
  piStatus?: { fetchedAt?: number; failed: boolean; offline: boolean; empty: boolean; runnerOff: boolean };
  cliStatus?: Partial<Record<'agy' | 'grok', ReturnType<typeof modelSourceStatus>>>;
  cli: Record<string, string[]>;
  bro: Record<string, string[]>;
  editor?: {
    off: string[];
    quota: Record<string, number>;
    piThinking: string[];
    cliThinking: string[];
    broThinking?: string[];
    flowKinds: NonNullable<RolePlace['kind']>[];
  };
}
export interface ControlFacts {
  roles: RoleFact[];
  harnesses: HarnessFact[];
  harnessSwitches: HarnessSwitchFact[];
  models: ModelLists;
}

const FIRST = ['imp', 'frontier-imp', 'reviewer', 'sonic', 'oracle', 'pro', 'flow'];
const rank = (role: string) => (FIRST.includes(role) ? FIRST.indexOf(role) : FIRST.length);
export function placeLabel(place: RolePlace): string {
  if (place.harness === 'pi') return 'pi';
  if (place.harness === 'cli') return place.agent ?? 'cli';
  if (place.tool === 'jev-ask') return place.provider ?? 'jev-ask';
  return place.tool === 'jev-aistudio' ? 'aistudio' : 'flow';
}
export function placeDestination(place: Pick<PlaceFact, 'label' | 'harness' | 'provider'>): string {
  return place.harness === 'pi' && place.provider ? `pi/${place.provider}` : place.label;
}
const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const projectPinned = (registry: Registry, role: Role) => {
  const info = registry.project();
  return info.registered && inside(join(info.hud_dir, 'roles'), role.source_file);
};

/** Every role with each place's state, and which harnesses this machine has. */
export function controlFacts(
  registry: Registry,
  hudHome: string,
  now: number,
  readJson?: (file: string) => unknown,
  list?: (directory: string) => string[]
): ControlFacts {
  const roles: RoleFact[] = [];
  const context = registry.routing(now), { disabled, has, providers } = context;
  const { modelLists } = context;
  const catalog = placeCatalog(hudHome, BUNDLED, readJson, now, list, modelLists);
  const table = harnessDefaults(hudHome, BUNDLED, readJson);
  const referenced = new Set(providers.keys());
  const uses = new Map<string, HarnessSwitchFact['uses']>();
  const destination = (p?: { place: RolePlace; provider?: string | null }) =>
    p ? placeDestination({ ...p.place, label: placeLabel(p.place), provider: p.provider }) : null;
  for (const role of registry.roles(true).values()) {
    const pinned = projectPinned(registry, role);
    const identity = {
      role: role.role, path: role.source_file,
      source: pinned ? 'project' : inside(join(hudHome, 'roles'), role.source_file) ? 'yours' : 'default',
      group: pinned ? 'project' : role.run.every((p) => p.harness === 'bro') ? 'browser' : 'roles',
      ...(role.optionalEnabled === undefined ? {} : { optionalEnabled: role.optionalEnabled }),
    } satisfies Omit<RoleFact, 'places'>;
    if (role.optionalEnabled === false) {
      roles.push({ ...identity, places: [] });
      continue;
    }
    const assigned = registry.assignment(role, now, undefined, context);
    const toFact = (entry: (typeof assigned.places)[number], collect = true): PlaceFact => {
      const { place, model, thinking, provider, state, until, missing, off_by } = entry;
      if (collect && provider) referenced.add(provider);
      let piModel: PlaceFact['piModel'];
      if (place.harness === 'pi') {
        const fallback = place.model === undefined ? model : registry.placeDetails(role, { ...place, model: undefined }).model;
        const { effective, provider: defaultProvider } = attributePiModel(fallback.value, context);
        const id = (value: string | null, provider?: string | null) =>
          value && provider && !qualifiedPiProvider(value) ? `${provider}/${value}` : value;
        const defaultId = id(effective, defaultProvider);
        const defaultMark = context.exhausted.get(placeKey({ harness: 'pi' }, fallback.value));
        piModel = {
          current: place.model === undefined ? defaultId : id(model.value, provider),
          isDefault: place.model === undefined,
          defaultId,
          ...(defaultId ? { defaultSource: fallback.value ? 'from pi role' : 'from pi settings' } : {}),
          defaultOff: disabled.has('pi') || (!!defaultProvider && disabled.has(`pi:${defaultProvider}`)),
          ...(defaultMark ? { defaultUntil: Date.parse(defaultMark.until) } : {}),
        };
      }
      return {
        harness: place.harness, label: placeLabel(place), model: model.value, thinking: thinking.value, state,
        ...(thinking.value && place.thinking === undefined ? { inheritedThinking: true } : {}),
        ...(piModel ? { piModel } : {}),
        ...(place.kind ? { kind: place.kind } : {}),
        ...(provider === undefined ? {} : { provider }),
        ...(until ? { until: Date.parse(until) } : {}),
        ...(off_by ? { offBy: off_by } : {}),
        ...(missing ? { missing } : {}),
      };
    };
    const places = assigned.places.map((entry) => toFact(entry));
    for (const { run } of role.presets ?? []) for (const place of run) {
      const provider = place.harness === 'pi' ? qualifiedPiProvider(place.model) : undefined;
      if (provider) referenced.add(provider);
    }
    const next = destination(assigned.places.find((p) => p.state === 'active'));
    for (const id of new Set(assigned.places.flatMap((p) => p.switch_ids))) {
      const changed = new Set(disabled);
      if (!changed.delete(id)) changed.add(id);
      const switched = evaluatePlaces(assigned.places, changed).find((p) => p.state === 'active');
      const list = uses.get(id) ?? [];
      list.push({ role: role.role, preset: assigned.preset, index: assigned.places.findIndex((p) => p.switch_ids.includes(id)),
        next, switchedNext: destination(switched) });
      uses.set(id, list);
    }
    const editorPlace = (raw: RolePlace, fact: PlaceFact): DraftPlace => {
      if (raw.harness !== 'pi') return { raw, fact };
      const defaults = registry.placeDetails(role, { ...raw, model: undefined, thinking: undefined });
      return { raw, fact, defaultModel: defaults.model.value, defaultThinking: defaults.thinking.value,
        defaultProvider: attributePiModel(defaults.model.value, context).provider };
    };
    const editor = pinned ? undefined : {
      places: registry.editableRun(role).map((raw, i) => editorPlace(raw, places[i]!)),
      targets: harnessOptions(role, table, catalog, BUNDLED).map((raw) => editorPlace(raw,
        toFact(registry.assignment(role, now, undefined, context, { run: [raw] }).places[0]!, false))),
    };
    roles.push({
      ...identity,
      editor,
      places,
      preset: assigned.preset,
      missingPreset: assigned.preset_missing,
      chainPath: assigned.chain_source_file,
      revision: registry.revision(role),
      presets: (role.presets ?? []).map(({ name, run }) => {
        const reviewed = run === role.run ? assigned : registry.assignment(role, now, undefined, context, { preset: name });
        return { name, next: destination(reviewed.places.find((p) => p.state === 'active')),
          places: reviewed === assigned ? places : reviewed.places.map((entry) => toFact(entry)),
          ...(reviewed.places.every((p) => p.state === 'off') ? { offBy: [...new Set(reviewed.places.map((p) => p.off_by))].join(' ') } : {}) };
      }),
      fileChain: role.presets?.some((p) => p.run === role.run)
        ? registry.assignment(role, now, undefined, context, { preset: null }).places.map((entry) => toFact(entry)) : places,
    });
  }
  roles.sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role));
  const sites = { 'jev-ask': ['chatgpt', 'gemini'], 'jev-aistudio': ['argon'], 'jev-flow': ['flow'] };
  const ids = new Set(['pi', ...[...cliAgents].sort().map((id) => `cli:${id}`), ...BRO_TOOLS.map((id) => `bro:${id}`),
    ...[...referenced].sort().map((id) => `pi:${id}`), ...disabled]);
  const harnessSwitches: HarnessSwitchFact[] = [...ids].map((id) => {
    const colon = id.indexOf(':'), prefix = id.slice(0, colon);
    const name = id.slice(colon + 1), group = id === 'pi' ? 'runner' : prefix === 'cli' ? 'cli' : prefix === 'bro' ? 'browser' : 'provider';
    const present = group === 'provider' ? providers.has(name) : group === 'runner' ? has('pi')
      : group === 'cli' ? cliAgents.includes(name as (typeof cliAgents)[number]) && has(name)
      : BRO_TOOLS.includes(name as (typeof BRO_TOOLS)[number]) && has(name);
    return { id, name, group, off: disabled.has(id), present, uses: uses.get(id) ?? [],
      ...(group === 'provider' ? { models: providers.get(name), runnerOff: disabled.has('pi') } : {}),
      ...(group === 'browser' ? { sites: sites[name as keyof typeof sites] } : {}),
    };
  });
  return {
    roles,
    models: {
      pi: disabled.has('pi') ? [] : (modelLists?.pi ?? catalog.pi.offline).filter((id) => {
        const provider = qualifiedPiProvider(id);
        return !!provider && isModelToken(id) && !disabled.has(`pi:${provider}`);
      }),
      piFacts: modelLists?.piFacts,
      piExhausted: Object.fromEntries([...context.exhausted].flatMap(([key, mark]) =>
        key.startsWith('pi:') ? [[key.slice(3), Date.parse(mark.until)]] : [])),
      piStatus: { ...modelSourceStatus(modelLists, 'pi'), offline: modelLists?.pi === undefined,
        empty: modelLists?.pi?.length === 0, runnerOff: disabled.has('pi') },
      cliStatus: { agy: modelSourceStatus(modelLists, 'agy'), grok: modelSourceStatus(modelLists, 'grok') },
      cli: catalog.cli.models, bro: catalog.bro.models,
      editor: { off: [...disabled], quota: Object.fromEntries([...context.exhausted].map(([id, mark]) => [id, Date.parse(mark.until)])),
        piThinking: catalog.pi.thinking, cliThinking: catalog.cli.thinking, broThinking: [...SHIPPED_MODELS_CATALOG.harnesses.bro.thinking], flowKinds: catalog.bro.kinds },
    },
    harnessSwitches,
    harnesses: [
      { name: 'pi', ok: has('pi') },
      ...catalog.cli.agents.map((name) => ({ name, ok: has('herdr') && has(name) })),
      ...catalog.bro.tools.map((name) => ({ name, ok: has(name) })),
    ],
  };
}

/** The models a place can be given (its harness's merged list); a Flow place has none, it picks a kind. */
export function placeModels(place: PlaceFact, lists: ModelLists): string[] | undefined {
  if (place.harness === 'pi') return lists.pi;
  if (place.harness === 'cli') return lists.cli[place.label] ?? [];
  return place.label === 'flow' ? undefined : lists.bro[place.label === 'aistudio' ? 'jev-aistudio' : place.label] ?? [];
}

/** A place's row id on the Control plane page: the role and the place's index in its run list. */
export const placeItem = (role: string, index: number) => `project:role:${role}:${index}`;

export type PlaceOp = 'preset' | 'clear';
export interface PlaceEdit {
  role: string;
  /** The place under the cursor: 0 is the primary, the rest are fallbacks in order. */
  index: number;
  op: PlaceOp;
  /** Which way presets cycle; forward when absent. */
  step?: 1 | -1;
  revision?: string;
}
/** `message` is a panel word (through `t()`); `reason` is the system's own text. `index` is where the cursor goes. */
export interface EditOutcome {
  ok: boolean;
  message?: string;
  reason?: string;
  index?: number;
  preset?: string | null;
}
export type PresetEdit = { role: string; revision?: string } & PresetChange;
export function editPreset(hudHome: string, cwd: string, env: NodeJS.ProcessEnv, edit: PresetEdit, bundled = BUNDLED): EditOutcome {
  try {
    const registry = roleRegistry(hudHome, cwd, env, undefined, undefined, bundled);
    const role = registry.roles().get(edit.role);
    if (!role) return { ok: false, message: 'role not found' };
    if (projectPinned(registry, role)) return { ok: false, message: 'the project file is in force: o opens it' };
    if (edit.revision !== undefined && edit.revision !== registry.revision(role))
      return { ok: false, message: 'Role changed on disk; reopen the action' };
    if (edit.op !== 'select' && edit.op !== 'delete' && edit.op !== 'run') {
      if (!validPresetName(edit.name)) return { ok: false, message: 'bad preset name' };
      if (role.presets?.some((p) => p.name === edit.name)) return { ok: false, message: 'preset name already exists' };
    }
    registry.savePreset(role, edit);
    return { ok: true, preset: edit.op === 'run' ? undefined : edit.op === 'delete' ? null : edit.name };
  } catch (error) {
    return { ok: false, message: 'could not save the change', reason: error instanceof Error ? error.message : String(error) };
  }
}

export const targetKey = (p: RolePlace) =>
  p.harness === 'cli' ? `cli:${p.agent}` : p.harness === 'bro' ? `bro:${p.tool}:${p.provider ?? ''}` : 'pi';
/** What a harness switch can rebuild without losing anything the owner typed. */
const PLAIN = new Set(['harness', 'pi_role', 'agent', 'tool', 'provider', 'model', 'thinking', 'effort', 'kind', 'split']);
export const replaceableTarget = (p: RolePlace) => Object.keys(p).every((k) => PLAIN.has(k)) && p.split !== true;
const instructionsFile = (role: Role, bundled: string) => {
  const name = role.instructions ?? role.role;
  return /^[A-Za-z0-9._-]+$/.test(name) ? join(bundled, 'instructions', `${name}.md`) : null;
};
function fromTable(entry: HarnessDefault | undefined, place: RolePlace): RolePlace {
  const out: Record<string, unknown> = { ...place };
  for (const key of ['model', 'thinking', 'effort', 'kind'] as const) if (entry?.[key] !== undefined) out[key] = entry[key];
  return out as unknown as RolePlace;
}
/** The places a role can run on, in the harness table's order: browser places for a browser role, else pi and each CLI it has instructions for. */
function harnessOptions(role: Role, table: Record<string, HarnessDefault>, catalog: PlaceCatalog, bundled: string): RolePlace[] {
  if (role.run.every((p) => p.harness === 'bro')) {
    const flow = role.run.every((p) => p.tool === 'jev-flow');
    return flow ? [fromTable(table.flow, { harness: 'bro', tool: 'jev-flow' })] : [
      ...catalog.bro.providers.map((provider) => fromTable(table[provider], { harness: 'bro', tool: 'jev-ask', provider })),
      fromTable(table.argon, { harness: 'bro', tool: 'jev-aistudio' }),
    ];
  }
  const options: RolePlace[] = [];
  const piRole = role.run.find((p) => p.harness === 'pi')?.pi_role ?? role.instructions ??
    role.presets?.flatMap((p) => p.run).find((p) => p.harness === 'pi')?.pi_role;
  if (piRole) options.push({ harness: 'pi', pi_role: piRole, split: false });
  const file = instructionsFile(role, bundled);
  if (file && fs.existsSync(file))
    for (const agent of catalog.cli.agents) options.push(fromTable(table[agent], { harness: 'cli', agent }));
  return options;
}
/** The same routing order as a saved chain, using the Control snapshot rather than doing I/O during paint. */
export function previewDraft(run: DraftPlace[], lists: ModelLists, now: number): PlaceFact[] {
  const { quota = {}, off = [] } = lists.editor ?? {};
  return evaluatePlaces(run.map(({ raw, fact }) => {
    const mark = quota[placeKey(raw, fact.model)];
    return { place: raw, fact, missing: fact.missing,
      switch_ids: raw.harness === 'pi' ? ['pi', ...(fact.provider ? [`pi:${fact.provider}`] : [])] : [placeSwitch(raw)],
      until: mark !== undefined && mark > now ? new Date(mark).toISOString() : undefined };
  }), new Set(off)).map(({ fact, state, off_by, until }) => ({ ...fact, state, offBy: off_by, until: until ? Date.parse(until) : undefined }));
}
export const placeSwitch = (raw: RolePlace) => raw.harness === 'pi' ? 'pi' : raw.harness === 'cli' ? `cli:${raw.agent}` : `bro:${raw.tool}`;
export function editPlaces(
  hudHome: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  edit: PlaceEdit,
  now = Date.now(),
  bundled = BUNDLED
): EditOutcome {
  const refuse = (message: string, reason?: string): EditOutcome => ({ ok: false, message, ...(reason ? { reason } : {}) });
  try {
    const registry = roleRegistry(hudHome, cwd, env, undefined, undefined, bundled);
    const role = registry.roles().get(edit.role);
    if (!role) return refuse('role not found');
    const i = edit.index, step = edit.step ?? 1;
    if (edit.revision !== undefined && edit.revision !== registry.revision(role)) return refuse('Role changed on disk; reopen the action');
    // A mark is not part of a role file, so the project's file in force does not stand in the way of clearing one.
    if (edit.op === 'clear') {
      const mark = registry.assignment(role, now).exhausted.find((e) => e.place === role.run[i]);
      if (!mark) return refuse('not marked exhausted');
      clearExhausted(hudHome, mark.key, now);
      return { ok: true, index: i };
    }
    if (projectPinned(registry, role)) return refuse('the project file is in force: o opens it');
    const presets = role.presets ?? [];
    if (!presets.length) return { ok: true, index: i };
    const at = presets.findIndex((p) => p.name === currentPreset(role));
    const next = presets[at < 0 ? (step > 0 ? 0 : presets.length - 1) : (at + step + presets.length) % presets.length]!;
    if (next.name === currentPreset(role)) return { ok: true, index: i };
    registry.savePreset(role, { op: 'select', name: next.name });
    return { ok: true, index: 0, preset: next.name };
  } catch (error) {
    return refuse('could not save the change', error instanceof Error ? error.message : String(error));
  }
}
