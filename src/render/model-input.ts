/** Pure picker input: Enter returns the chosen model to its caller. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { MODEL_ID_MAX } from '../roles/model-discovery.js';
import { qualifiedPiProvider } from '../roles/roster.js';
import { placeItem, placeModels, type ModelLists, type PlaceFact, type RoleFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { monitorRowAt } from './monitor-input.js';
import { t } from './i18n.js';

export type ModelInput = NonNullable<MonitorState['projectInput']>;
export interface ModelPick {
  place: PlaceFact;
  lists: ModelLists;
  presets?: RoleFact['presets'];
  preset?: string | null;
  inUse?: Map<string, number>;
  off?: string[];
  previous?: string;
}
export interface PickEntry {
  id: string;
  label: string;
  /** What Enter sets: a model ID, empty to unset, or absent for a read-only reference. */
  value?: string;
  model?: string;
  fact?: 'off' | 'unknown';
  until?: number;
  current?: boolean;
  tags?: string[];
  was?: boolean;
}
type OtherProviders = PickEntry & { providers: string[]; count: number };
type PickRow = PickEntry | OtherProviders | { provider: string; count: number };

const previousKey = (role: RoleFact, index: number) => JSON.stringify([role.path, role.preset ?? null, index]);

/** Called only after the existing quick-save writer succeeds. Empty remembers a previously unset override. */
export function rememberModel(state: MonitorState, before: MonitorState, savedRole: RoleFact, model?: string) {
  const input = before.projectInput, role = before.controlQuickModel?.role, place = input?.place;
  if (!role || !input || !place) return;
  const old = role.editor?.places[input.index]?.raw.model;
  if (old === model) return;
  // The first write to a shipped chain can change its path, and editing a legacy chain can change its displayed preset.
  state.modelPrevious = { ...state.modelPrevious, [previousKey(savedRole, input.index)]: old ? place.piModel?.current ?? old : '' };
}

export function pickOf(data: ProjectSnapshot | undefined, input: ModelInput, previous?: MonitorState['modelPrevious']): ModelPick | undefined {
  const role = data?.roles.find((r) => r.role === input.role), place = input.place;
  if (!data || !role || !place || role.source === 'project' || (place.harness === 'bro' && place.label !== 'aistudio')) return;
  const common = { place, lists: data.models, presets: role.presets, preset: role.preset, previous: previous?.[previousKey(role, input.index)] };
  if (place.harness !== 'pi') return common;
  const inUse = new Map<string, number>();
  for (const r of data.roles) {
    // The active preset can share its chain with role.places, and the file chain may be the active chain.
    const chains = new Set([r.places, r.fileChain, ...(r.presets ?? []).map((p) => p.places)]);
    for (const chain of chains) for (const p of chain ?? []) {
      if (p.harness !== 'pi') continue;
      const id = (p.piModel?.isDefault ?? !p.model) ? p.piModel?.defaultId : p.piModel?.current ?? p.model;
      const provider = qualifiedPiProvider(id);
      if (provider) inUse.set(provider, (inUse.get(provider) ?? 0) + 1);
    }
  }
  const off = (data.harnessSwitches ?? []).filter((s) => s.group === 'provider' && s.off).map((s) => s.name).sort();
  return { ...common, inUse, off };
}

export const OTHER_PROVIDERS = 'other';
const alphabetical = (a: string, b: string) => a.localeCompare(b, 'en') || (a < b ? -1 : a > b ? 1 : 0);

/** Best position per token: start of a provider/model, then a separator, then within a word. */
function matchRank(id: string, parts: string[]) {
  const modelStart = id.indexOf('/') + 1;
  let starts = 0, boundaries = 0;
  for (const part of parts) {
    let at = id.indexOf(part);
    if (at < 0) return -1;
    if (at === 0 || id.startsWith(part, modelStart)) { starts++; continue; }
    for (; at >= 0; at = id.indexOf(part, at + 1)) {
      if ('/-._:'.includes(id[at - 1]!)) { boundaries++; break; }
    }
  }
  return starts * (parts.length + 1) + boundaries;
}

export function pickView(pick: ModelPick, input: ModelInput) {
  const { place, lists, presets, inUse = new Map<string, number>(), previous } = pick, needle = input.text.trim().toLowerCase();
  const currentId = place.piModel?.current ?? place.model;
  const currentProvider = qualifiedPiProvider(currentId);
  const isUsed = (provider: string) => provider === currentProvider || inUse.has(provider);
  const isDefault = place.piModel?.isDefault ?? !place.model;
  const flat = place.harness !== 'pi';
  const flatOff = flat && (lists.editor?.off.includes(place.harness === 'cli' ? `cli:${place.label}` : 'bro:jev-aistudio') ?? place.state === 'off');
  const reference = (model: string, p: PlaceFact): PickEntry => {
    if (flat) return { id: `pin:${model}`, label: model, model, until: p.until,
      fact: flatOff ? 'off' : undefined, value: flatOff ? undefined : model };
    const provider = qualifiedPiProvider(model);
    const fact = p.state === 'off' || lists.piStatus?.runnerOff || (provider && pick.off?.includes(provider)) ? 'off'
      : !provider ? 'unknown' : undefined;
    return { id: `pin:${model}`, label: model, model, fact, until: p.until ?? lists.piExhausted?.[model],
      value: fact ? undefined : model };
  };
  const current = currentId ? { ...reference(currentId, place), current: true } : undefined;
  const defaultId = place.piModel?.defaultId ?? undefined;
  const provider = qualifiedPiProvider(defaultId);
  const canUnset = flat ? !flatOff : !place.piModel?.defaultOff && !lists.piStatus?.runnerOff && !(provider && pick.off?.includes(provider));
  const unsetLabel = defaultId ? t(place.piModel?.defaultSource === 'from pi role' ? "role's model ({model})" : "pi's model ({model})", {
    model: provider ? defaultId.slice(provider.length + 1) : defaultId,
  }) : t('clear');
  const unset: PickEntry = { id: 'default', label: unsetLabel, model: defaultId, value: flatOff ? undefined : '', current: isDefault,
    fact: flatOff ? 'off' : defaultId && !qualifiedPiProvider(defaultId) ? 'unknown' : undefined,
    until: flat && isDefault ? place.until : place.piModel?.defaultUntil };
  const pins = new Map<string, PickEntry>();
  if (!needle && current) pins.set(current.model!, isDefault && canUnset ? unset : current);
  if (!needle) for (const preset of presets ?? []) for (const p of preset.places ?? []) {
    if (preset.name === pick.preset || p.harness !== place.harness || p.label !== place.label) continue;
    const id = p.piModel?.current ?? p.model;
    if (!id) continue;
    const pin = pins.get(id) ?? reference(id, p);
    if (pin.fact === 'off' && !pin.current) continue;
    if (preset.name !== 'default') {
      pin.tags ??= [];
      if (!pin.tags.includes(preset.name)) pin.tags.push(preset.name);
    }
    pins.set(id, pin);
  }
  const top = [...pins.values()];
  if (!needle && previous && (previous !== currentId || isDefault)) {
    const pinned = pins.get(previous), pin = pinned?.value ? pinned : reference(previous, { ...place, state: 'standby', until: undefined });
    if (!pin.fact) {
      if (pin === pinned) pin.was = true;
      else top.push({ ...pin, was: true });
    }
  }
  if (!needle && canUnset && !isDefault) top.push({ ...unset, was: previous === '' });
  else if (!needle && !current && (canUnset || flat && isDefault)) top.unshift(unset);

  const groups = new Map<string, PickEntry[]>(), parts = needle ? needle.split(/\s+/) : [];
  const ids = new Set(placeModels(place, lists) ?? []);
  const matches: { entry: PickEntry; used: boolean; current: boolean; rank: number }[] = [];
  const pinned = flat && !needle ? new Set(top.map((entry) => entry.model)) : undefined;
  for (const value of ids) {
    if (pinned?.has(value)) continue;
    const entry: PickEntry = { id: `model:${value}`, label: value, model: value, value: flatOff ? undefined : value,
      current: value === currentId && (!!needle || !isDefault),
      fact: flatOff ? 'off' : undefined, until: flat ? value === currentId ? place.until : undefined : lists.piExhausted?.[value] };
    const slash = value.indexOf('/'), provider = value.slice(0, slash);
    if (needle || flat) {
      const rank = matchRank(value.toLowerCase(), parts);
      if (rank >= 0) matches.push({ entry, rank, used: !flat && isUsed(provider), current: !flat && provider === currentProvider });
    } else {
      const group = groups.get(provider) ?? [];
      group.push({ ...entry, label: value.slice(slash + 1) });
      groups.set(provider, group);
    }
  }
  const useCount = (p: string) => inUse.get(p) ?? 0;
  const groupRows = (providers: string[]) => providers.flatMap((provider) => {
    const entries = groups.get(provider)!.sort((a, b) => alphabetical(a.label, b.label));
    return [{ provider, count: entries.length }, ...entries];
  });
  const providers = [...groups.keys()].sort(alphabetical);
  const hasUsed = !!currentProvider || inUse.size > 0;
  const used = providers.filter((p) => !hasUsed || isUsed(p)).sort((a, b) =>
    Number(b === currentProvider) - Number(a === currentProvider) || useCount(b) - useCount(a) || alphabetical(a, b));
  const other = hasUsed ? providers.filter((p) => !isUsed(p)) : [];
  const ranked = () => matches.sort((a, b) => Number(b.used) - Number(a.used) || b.rank - a.rank ||
    Number(b.current) - Number(a.current) || alphabetical(a.entry.label, b.entry.label)).map(({ entry }) => entry);
  const rows: PickRow[] = needle ? ranked() : flat ? [...top, ...ranked()] : [
      ...top, ...groupRows(used), ...(other.length ? [
        { id: OTHER_PROVIDERS, label: '', providers: other, count: other.reduce((n, p) => n + groups.get(p)!.length, 0) },
        ...(input.otherOpen ? groupRows(other) : []),
      ] : []),
    ];
  const entries = rows.filter((row): row is PickEntry => 'id' in row);
  const selected = entries.find((entry) => entry.id === input.pick) ?? entries[0];
  return { rows, entries, selected, current, total: needle ? matches.length : ids.size, catalogCount: ids.size };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** One viewport in painted rows (including headers), shared by rendering and input. */
export function pickerListWindow(list: MonitorRow[], input: ModelInput, size: number, wide = false) {
  const max = Math.max(0, list.length - size), at = list.findIndex((row) => row.item === 'project:pick');
  let first = clamp(input.scroll ?? 0, 0, max);
  if (at >= 0 && size) first = clamp(first, Math.max(0, at - size + 1), at);
  const entries = list.flatMap(({ modelHit }, row) => modelHit ? [{ id: modelHit.entry, row }] : []);
  return { first, max, size, entries, wide };
}

/** The picker owns input; only the list and its cancel hint have click targets. */
export function modelInputEvent(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const open = state.projectInput!, next: MonitorState = { ...state, projectInput: { ...open } };
  const typed = next.projectInput!, done = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const close = () => { next.projectInput = undefined; return done(); };
  const pane = ctx.frame?.panes.find((p) => p.id === 'agents');
  const query = pane?.rows.find((r) => r.modelPick && r.item === placeItem(open.role, open.index));
  const pick = query?.modelPick, window = query?.modelWindow;
  const filter = (text: string) => Object.assign(typed, { text, pick: undefined, otherOpen: undefined, scroll: undefined });
  if (input.type === 'key') {
    if (input.text !== undefined) { filter([...typed.text, ...input.text].slice(0, MODEL_ID_MAX).join('')); return done(); }
    if (input.key === 'backspace') { filter([...typed.text].slice(0, -1).join('')); return done(); }
    if (input.key === 'model-refresh') return done({ type: 'refresh-models' });
    if (input.key === 'escape' && typed.text) { filter(''); return done(); }
    if (input.key === 'escape' || input.key === 'close') return close();
  }
  if (input.type === 'mouse' && input.button === 'left' &&
      ctx.frame?.controls.some((c) => c.kind === 'model-cancel' && input.y === c.y && input.x >= c.x && input.x < c.x + c.width)) return close();
  if (!pane || !pick || !window?.size) return done();
  const { first, max, size, entries } = window;
  const view = pickView(pick, typed), index = entries.findIndex(({ id }) => id === view.selected?.id);
  const set = (entry: PickEntry | undefined) => {
    if (entry?.id === OTHER_PROVIDERS) {
      Object.assign(typed, { otherOpen: !typed.otherOpen, pick: entry.id, scroll: first });
      return done();
    }
    if (entry?.value === undefined) return window.wide && entry?.current ? close() : done();
    next.projectInput = undefined;
    return done({ type: 'model-picked', value: entry.value });
  };
  if (input.type === 'mouse') {
    if (input.button === 'left') {
      const hit = monitorRowAt(pane, input.x, input.y)?.modelHit;
      if (hit) return set(view.entries.find((e) => e.id === hit.entry));
    } else if (index >= 0) {
      typed.scroll = clamp(first + (input.button === 'wheel-down' ? 3 : -3), 0, max);
      const edge = clamp(entries[index]!.row, typed.scroll, typed.scroll + size - 1);
      // If there are only headers in the new window, use the nearest selectable row instead.
      typed.pick = entries.reduce((best, entry) => Math.abs(entry.row - edge) < Math.abs(best.row - edge) ? entry : best).id;
    }
    return done();
  }
  if (input.key === 'enter') return set(view.selected);
  if (index < 0) return done();
  const step = input.key === 'up' || input.key === 'page-up' ? -1 : 1;
  let at = clamp(index + step, 0, entries.length - 1);
  let scroll = first;
  if (input.key === 'home') { at = 0; scroll = 0; }
  else if (input.key === 'end') { at = entries.length - 1; scroll = max; }
  else if (input.key === 'page-up' || input.key === 'page-down') {
    const delta = step * Math.max(1, size - 1), target = entries[index]!.row + delta;
    while (entries[at + step] && step * (entries[at]!.row - target) < 0) at += step;
    scroll = clamp(first + delta, 0, max);
  } else if (input.key === 'up' || input.key === 'down') {
    const row = entries[at]!.row;
    if (row < first) scroll = Math.max(0, row - 1);
    if (row >= first + size) scroll = Math.min(max, row - Math.max(0, size - 2));
  } else return done();
  typed.scroll = scroll;
  typed.pick = entries[at]!.id;
  return done();
}
