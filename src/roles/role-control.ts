/**
 * The Control plane's two halves: what it shows of where each role runs (`controlFacts`, read-only, for the collector)
 * and what a key there does (`editPlaces`, the panel's one write: `$HUD_HOME/roles/<role>.json` through `writeRolePlaces`,
 * and `exhausted.json` through `clearExhausted`). The next `hud_create` reads the same files, so what the page shows is
 * what that call uses.
 */
import * as fs from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearExhausted,
  harnessDefaults,
  placeAvailable,
  placeCatalog,
  roleRegistry,
  writeRolePlaces,
  type HarnessDefault,
  type PlaceCatalog,
  type Role,
  type RolePlace,
} from './roster.js';

type Registry = ReturnType<typeof roleRegistry>;
const BUNDLED = fileURLToPath(new URL('../../packages/hud-mcp/', import.meta.url));

export type PlaceState = 'active' | 'standby' | 'exhausted' | 'missing';
export interface PlaceFact {
  harness: RolePlace['harness'];
  /** `pi`, an agent (`agy`), or a browser place (`chatgpt`, `gemini`, `aistudio`, `flow`). */
  label: string;
  model: string | null;
  thinking: string | null;
  kind?: 'image' | 'video';
  /** `active` is where the next `hud_create` runs; `exhausted` carries `until`. */
  state: PlaceState;
  until?: number;
}
export interface RoleFact {
  role: string;
  /** The role file in force: Enter and `o` open it. */
  path: string;
  /** Whose file that is: the shipped `default`, `yours` under `$HUD_HOME/roles`, or the `project`'s. */
  source: 'default' | 'yours' | 'project';
  /** `project` roles come from the project's own `.hud/roles`, which wins and is never written here. */
  group: 'roles' | 'project' | 'browser';
  places: PlaceFact[];
}
export interface HarnessFact {
  name: string;
  ok: boolean;
}
export interface ControlFacts {
  roles: RoleFact[];
  harnesses: HarnessFact[];
  /** pi role definitions behind the pi places (their model and thinking defaults). */
  piRoleFiles: string[];
}

const FIRST = ['imp', 'reviewer', 'sonic', 'architect', 'oracle', 'pro', 'flow'];
const rank = (role: string) => (FIRST.includes(role) ? FIRST.indexOf(role) : FIRST.length);
export function placeLabel(place: RolePlace): string {
  if (place.harness === 'pi') return 'pi';
  if (place.harness === 'cli') return place.agent ?? 'cli';
  if (place.tool === 'jev-ask') return place.provider ?? 'jev-ask';
  return place.tool === 'jev-aistudio' ? 'aistudio' : 'flow';
}
const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const projectPinned = (registry: Registry, role: Role) => {
  const info = registry.project();
  return info.registered && inside(join(info.hud_dir, 'roles'), role.source_file);
};

/** Every role with each place's state, and which harnesses this machine has. */
export function controlFacts(
  registry: Registry,
  hudHome: string,
  env: NodeJS.ProcessEnv,
  now: number,
  readJson?: (file: string) => unknown,
  list?: (directory: string) => string[]
): ControlFacts {
  const roles: RoleFact[] = [];
  const piRoleFiles = new Set<string>();
  const none = new Map();
  for (const role of registry.roles().values()) {
    const assigned = registry.assignment(role, now);
    const places = role.run.map((place): PlaceFact => {
      const details = registry.placeDetails(role, place);
      if (details.pi_role_file) piRoleFiles.add(details.pi_role_file);
      const mark = assigned.exhausted.find((e) => e.place === place);
      const state: PlaceState = mark
        ? 'exhausted'
        : !placeAvailable(place, env, none, details.model.value)
          ? 'missing'
          : place === assigned.runs_on
            ? 'active'
            : 'standby';
      return {
        harness: place.harness,
        label: placeLabel(place),
        model: details.model.value,
        thinking: details.thinking.value,
        ...(place.kind ? { kind: place.kind } : {}),
        state,
        ...(mark ? { until: Date.parse(mark.until) } : {}),
      };
    });
    const pinned = projectPinned(registry, role);
    roles.push({
      role: role.role,
      path: role.source_file,
      source: pinned ? 'project' : inside(join(hudHome, 'roles'), role.source_file) ? 'yours' : 'default',
      group: pinned ? 'project' : role.run.every((p) => p.harness === 'bro') ? 'browser' : 'roles',
      places,
    });
  }
  roles.sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role));
  const catalog = placeCatalog(hudHome, BUNDLED, readJson, now, list);
  const has = (place: RolePlace) => placeAvailable(place, env, none, null);
  return {
    roles,
    piRoleFiles: [...piRoleFiles],
    harnesses: [
      { name: 'pi', ok: has({ harness: 'pi' }) },
      ...catalog.cli.agents.map((name) => ({ name, ok: has({ harness: 'cli', agent: name }) })),
      ...catalog.bro.tools.map((name) => ({ name, ok: has({ harness: 'bro', tool: name }) })),
    ],
  };
}

/** A place's row id on the Control plane page: the role and the place's index in its run list. */
export const placeItem = (role: string, index: number) => `project:role:${role}:${index}`;

export type PlaceOp = 'harness' | 'model' | 'thinking' | 'add' | 'remove' | 'up' | 'down' | 'clear';
export interface PlaceEdit {
  role: string;
  /** The place under the cursor: 0 is the primary, the rest are fallbacks in order. */
  index: number;
  op: PlaceOp;
  /** Which way `harness`, `model` and `thinking` cycle; forward when absent. */
  step?: 1 | -1;
}
/** `message` is a panel word (through `t()`); `reason` is the system's own text. `index` is where the cursor goes. */
export interface EditOutcome {
  ok: boolean;
  message?: string;
  reason?: string;
  index?: number;
}

const kindKey = (p: RolePlace) =>
  p.harness === 'cli' ? `cli:${p.agent}` : p.harness === 'bro' ? `bro:${p.tool}:${p.provider ?? ''}` : 'pi';
/** What a harness switch can rebuild without losing anything the owner typed. */
const PLAIN = new Set(['harness', 'pi_role', 'agent', 'tool', 'provider', 'model', 'thinking', 'effort', 'kind', 'split']);
const plain = (p: RolePlace) => Object.keys(p).every((k) => PLAIN.has(k)) && p.split !== true;
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
function harnessOptions(role: Role, here: RolePlace, table: Record<string, HarnessDefault>, catalog: PlaceCatalog, bundled: string): RolePlace[] {
  if (here.harness === 'bro') {
    if (here.tool === 'jev-flow') return [here];
    return Object.values(table)
      .filter((e) => e.harness === 'bro' && e.tool !== 'jev-flow')
      .map((e) => fromTable(e, { harness: 'bro', tool: e.tool, ...(e.provider ? { provider: e.provider } : {}) }));
  }
  const options: RolePlace[] = [];
  const piRole = role.run.find((p) => p.harness === 'pi')?.pi_role ?? role.instructions;
  if (piRole) options.push({ harness: 'pi', pi_role: piRole, split: false });
  const file = instructionsFile(role, bundled);
  if (file && fs.existsSync(file))
    for (const agent of catalog.cli.agents) options.push(fromTable(table[agent], { harness: 'cli', agent }));
  return options;
}
/** What the `model` key cycles: the catalog's models for this place (a Flow place's kinds). */
function modelField(place: RolePlace, catalog: PlaceCatalog): { field: 'model' | 'kind'; values: string[] } {
  if (place.harness === 'pi') return { field: 'model', values: catalog.pi.models };
  if (place.harness === 'cli') return { field: 'model', values: catalog.cli.models[place.agent!] ?? [] };
  if (place.tool === 'jev-flow') return { field: 'kind', values: catalog.bro.kinds };
  return { field: 'model', values: catalog.bro.models[place.tool === 'jev-ask' ? place.provider ?? '' : place.tool!] ?? [] };
}
/** The catalog's values, then "unset" (the role's or harness's own default), then round again. */
function cycle(values: string[], current: string | undefined, step: number): string | undefined {
  const slots = [...values, undefined];
  const at = current === undefined ? values.length : values.indexOf(current);
  return slots[(((at < 0 ? values.length : at) + step) % slots.length + slots.length) % slots.length];
}
/** The places as the owner's own role file has them (unknown keys kept), else as loaded. */
function workingRun(role: Role, hudHome: string): RolePlace[] {
  try {
    if (role.source_file === join(hudHome, 'roles', `${role.role}.json`)) {
      const parsed = JSON.parse(fs.readFileSync(role.source_file, 'utf8')) as { run?: unknown };
      if (Array.isArray(parsed.run) && parsed.run.length === role.run.length)
        return parsed.run.map((p: RolePlace, i) => ({ ...p, harness: role.run[i]!.harness }));
    }
  } catch {
    /* Fall back to the loaded places. */
  }
  return role.run.map((p) => ({ ...p }));
}

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
    // A mark is not part of a role file, so the project's file in force does not stand in the way of clearing one.
    if (edit.op === 'clear') {
      const mark = registry.assignment(role, now).exhausted.find((e) => e.place === role.run[i]);
      if (!mark) return refuse('not marked exhausted');
      clearExhausted(hudHome, mark.key, now);
      return { ok: true, index: i };
    }
    if (projectPinned(registry, role)) return refuse('the project file is in force: o opens it');
    const run = workingRun(role, hudHome), here = run[i];
    if (!here) return refuse('role not found');
    const catalog = placeCatalog(hudHome, bundled, undefined, now);
    const table = harnessDefaults(hudHome, bundled);
    let index = i;
    if (edit.op === 'harness') {
      const options = harnessOptions(role, here, table, catalog, bundled);
      if (options.length < 2) return refuse('no other harness for this role');
      if (!plain(here)) return refuse('launch options are set in the file: o opens it');
      const at = options.findIndex((o) => kindKey(o) === kindKey(here));
      run[i] = options[at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length]!;
    } else if (edit.op === 'model' || edit.op === 'thinking') {
      const { field, values } =
        edit.op === 'model'
          ? modelField(here, catalog)
          : { field: 'thinking' as const, values: here.harness === 'pi' ? catalog.pi.thinking : here.harness === 'cli' ? catalog.cli.thinking : [] };
      if (!values.length) return refuse(edit.op === 'model' ? 'no other model to pick' : 'no thinking setting here');
      // From what the page shows (the pi role's own default, say) when the file sets nothing.
      const shown = role.run[i]!, details = registry.placeDetails(role, shown);
      const current = here[field] ?? (field === 'kind' ? shown.kind : (field === 'model' ? details.model : details.thinking).value) ?? undefined;
      const next = cycle(values, current, step);
      const place: Record<string, unknown> = { ...here };
      if (next === undefined) delete place[field];
      else place[field] = next;
      run[i] = place as unknown as RolePlace;
    } else if (edit.op === 'add') {
      const used = new Set(run.map(kindKey));
      let fresh = harnessOptions(role, here, table, catalog, bundled).find((o) => !used.has(kindKey(o)));
      if (!fresh) {
        // Every harness is listed: another model on this one.
        const { field, values } = modelField(here, catalog);
        const other = values.find((v) => !run.some((p) => kindKey(p) === kindKey(here) && p[field] === v));
        if (other) fresh = { ...here, [field]: other };
      }
      if (!fresh) return refuse('no other place to add');
      run.push(fresh);
      index = run.length - 1;
    } else if (edit.op === 'remove') {
      if (run.length < 2) return refuse('keep at least one place');
      run.splice(i, 1);
      index = Math.min(i, run.length - 1);
    } else {
      const to = edit.op === 'up' ? i - 1 : i + 1;
      if (to < 0 || to >= run.length) return { ok: true, index };
      [run[i], run[to]] = [run[to]!, run[i]!];
      index = to;
    }
    writeRolePlaces(hudHome, role.role, run, bundled);
    return { ok: true, index };
  } catch (error) {
    return refuse('could not save the change', error instanceof Error ? error.message : String(error));
  }
}
