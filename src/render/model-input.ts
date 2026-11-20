/** Pure picker input: every pi provider in one list; Enter returns the chosen model to its caller. */
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
}

export function pickOf(data: ProjectSnapshot | undefined, input: ModelInput): ModelPick | undefined {
  const role = data?.roles.find((r) => r.role === input.role), place = input.place;
  return data && role && place?.harness === 'pi' && role.source !== 'project' ? { place, lists: data.models, presets: role.presets, preset: role.preset } : undefined;
}

export function pickView(pick: ModelPick, input: ModelInput, wide = false) {
  const { place, lists, presets } = pick, typed = input.text.trim(), needle = typed.toLowerCase();
  const currentId = place.piModel?.current ?? place.model;
  const isDefault = place.piModel?.isDefault ?? !place.model;
  const reference = (model: string, p: PlaceFact): PickEntry => {
    const fact = p.state === 'off' || lists.piStatus?.runnerOff ? 'off'
      : !qualifiedPiProvider(model) ? 'unknown' : undefined;
    return { id: `pin:${model}`, label: model, model, fact, until: p.until ?? lists.piExhausted?.[model],
      value: fact ? undefined : model };
  };
  const current = currentId ? { ...reference(currentId, place), current: true } : undefined;
  const canUnset = !place.piModel?.defaultOff && !lists.piStatus?.runnerOff;
  const defaultId = place.piModel?.defaultId ?? undefined;
  const provider = qualifiedPiProvider(defaultId);
  const unsetLabel = defaultId ? t(place.piModel?.defaultSource === 'from pi role' ? "role's model ({model})" : "pi's model ({model})", {
    model: provider ? defaultId.slice(provider.length + 1) : defaultId,
  }) : t('clear');
  const unset: PickEntry = { id: 'default', label: unsetLabel, model: defaultId, value: '', current: isDefault,
    fact: defaultId && !qualifiedPiProvider(defaultId) ? 'unknown' : undefined, until: place.piModel?.defaultUntil };
  const pins = new Map<string, PickEntry>();
  if (!needle && current) pins.set(current.model!, isDefault && canUnset ? unset : current);
  if (!needle) for (const preset of presets ?? []) for (const p of preset.places ?? []) {
    if (p.harness !== place.harness || p.label !== place.label) continue;
    const id = p.piModel?.current ?? p.model;
    if (!id) continue;
    const pin = pins.get(id) ?? reference(id, p);
    if (pin.fact === 'off' && !pin.current) continue;
    // The current row already names the selected place's own preset in its detail strip.
    if (preset.name !== 'default' && (!pin.current || preset.name !== pick.preset)) {
      pin.tags ??= [];
      if (!pin.tags.includes(preset.name)) pin.tags.push(preset.name);
    }
    pins.set(id, pin);
  }
  const groups = new Map<string, { provider: string; open: boolean; entries: PickEntry[] }>();
  const ids = [...new Set((placeModels(place, lists) ?? []).filter((id) => id.toLowerCase().includes(needle)))];
  for (const value of ids) {
    const entry: PickEntry = { id: `model:${value}`, label: value, model: value, value,
      current: !isDefault && value === currentId, until: lists.piExhausted?.[value] };
    const slash = value.indexOf('/'), provider = value.slice(0, slash);
    let group = groups.get(provider);
    if (!group) {
      const open = input.groups && Object.hasOwn(input.groups, provider) ? input.groups[provider] : wide || !!needle;
      group = { provider, open, entries: [] };
      groups.set(provider, group);
    }
    group.entries.push({ ...entry, label: value.slice(slash + 1) });
  }
  const byProvider = [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || (a.provider < b.provider ? -1 : 1));
  for (const group of byProvider) group.entries.sort((a, b) => a.label.localeCompare(b.label));
  const fallback = !needle && canUnset && !(current && isDefault) ? unset : undefined;
  const pinned = [...pins.values()];
  const entries = [...pinned, ...byProvider.flatMap((g) => g.open ? g.entries : []), ...(fallback ? [fallback] : [])];
  const selected = entries.find((entry) => entry.id === input.pick) ?? (!needle ? entries.find((entry) => entry.current) : undefined)
    ?? entries[0];
  return { entries, pinned, groups: byProvider, fallback, selected, current, total: ids.length };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** One viewport in painted rows (including headers), shared by rendering and input. */
export function pickerListWindow(list: MonitorRow[], input: ModelInput, size: number, wide = false) {
  const max = Math.max(0, list.length - size), at = list.findIndex((row) => row.item === 'project:pick');
  let first = clamp(input.scroll ?? 0, 0, max);
  if (at >= 0 && size) first = clamp(first, Math.max(0, at - size + 1), at);
  const entries = list.flatMap(({ modelHit }, row) => modelHit && 'entry' in modelHit ? [{ id: modelHit.entry, row }] : []);
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
  const filter = (text: string) => Object.assign(typed, { text, pick: undefined, groups: undefined, scroll: undefined });
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
  const view = pickView(pick, typed, window.wide), index = entries.findIndex(({ id }) => id === view.selected?.id);
  const set = (entry: PickEntry | undefined) => {
    if (entry?.value === undefined) return window.wide && entry?.current ? close() : done();
    next.projectInput = undefined;
    return done({ type: 'model-picked', value: entry.value });
  };
  if (input.type === 'mouse') {
    if (input.button === 'left') {
      const hit = monitorRowAt(pane, input.x, input.y)?.modelHit;
      if (hit && 'entry' in hit) return set(view.entries.find((e) => e.id === hit.entry));
      if (hit && 'provider' in hit) {
        const group = view.groups.find((g) => g.provider === hit.provider)!;
        typed.groups = { ...typed.groups, [group.provider]: !group.open };
        if (group.open && group.entries.some(({ id }) => id === typed.pick)) typed.pick = undefined;
        typed.scroll = first;
      }
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
  if (input.key === 'home') at = 0;
  else if (input.key === 'end') at = entries.length - 1;
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
