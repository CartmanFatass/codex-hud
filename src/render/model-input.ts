/** Pure picker input: every pi provider in one list; Enter returns the chosen model to its caller. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { MODEL_ID_MAX } from '../roles/model-discovery.js';
import { qualifiedPiProvider } from '../roles/roster.js';
import { placeItem, placeModels, type ModelLists, type PlaceFact, type RoleFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
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
  const role = data?.roles.find((r) => r.role === input.role), place = input.sheetPlace;
  return data && role && place?.harness === 'pi' && role.source !== 'project' ? { place, lists: data.models, presets: role.presets, preset: role.preset } : undefined;
}

export const pickerHints = (input: ModelInput) => `↑↓ pick  ⏎ set  ${input.text ? 'esc clear' : 'esc cancel'}  ^R refresh`;

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
  const unset: PickEntry = { id: 'default', label: t('default'), model: defaultId, value: '', current: isDefault,
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
    if (!pin.current || preset.name !== pick.preset) {
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

/** The picker owns keys and its viewport. Outside clicks still go through the existing panel routing. */
export function modelInputEvent(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome | undefined {
  const open = state.projectInput!, next: MonitorState = { ...state, projectInput: { ...open } };
  const typed = next.projectInput!, done = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const pane = ctx.frame?.panes.find((p) => p.id === 'preview') ?? ctx.frame?.panes.find((p) => p.id === 'agents');
  const query = pane?.rows.find((r) => r.modelPick && r.item === placeItem(open.role, open.index));
  const pick = query?.modelPick, window = query?.modelWindow;
  if (!pick || !window) {
    next.projectInput = undefined;
    return input.type === 'key' ? done() : undefined;
  }
  const view = pickView(pick, typed, window.wide);
  const set = (entry = view.selected) => {
    if (entry?.value === undefined) {
      if (window.wide && entry?.current) next.projectInput = undefined;
      return done();
    }
    next.projectInput = undefined;
    return done({ type: 'model-picked', value: entry.value });
  };
  if (input.type === 'mouse') {
    if (input.button !== 'left') {
      typed.scroll = Math.max(0, Math.min(window.max, window.first + (input.button === 'wheel-down' ? 3 : -3)));
      typed.clicked = undefined;
      return done();
    }
    if (!pane || input.x < pane.x || input.x >= pane.x + pane.width || input.y < pane.y || input.y >= pane.y + pane.height) {
      // The wide picker fills the panel, but only the left column has hit targets.
      if (window.wide) { typed.clicked = undefined; return done(); }
      return;
    }
    const hit = monitorRowAt(pane, input.x, input.y)?.modelHit;
    if (hit && 'entry' in hit) {
      const entry = view.entries.find((e) => e.id === hit.entry);
      if (entry && typed.clicked === entry.id && view.selected?.id === entry.id) return set(entry);
      typed.pick = typed.clicked = hit.entry;
      typed.scroll = window.first;
    } else {
      typed.clicked = undefined;
      if (hit && 'provider' in hit) {
        const group = view.groups.find((g) => g.provider === hit.provider);
        if (!group) return done();
        typed.groups = { ...typed.groups, [group.provider]: !group.open };
        const changed = pickView(pick, typed, window.wide);
        if (typed.pick && !changed.entries.some((entry) => entry.id === typed.pick)) typed.pick = undefined;
        typed.scroll = window.first;
      }
    }
    return done();
  }
  const filter = (text: string) => Object.assign(typed, { text, pick: undefined, groups: undefined, scroll: undefined, clicked: undefined });
  if (input.text !== undefined) filter([...typed.text, ...input.text].slice(0, MODEL_ID_MAX).join(''));
  else if (input.key === 'backspace') filter([...typed.text].slice(0, -1).join(''));
  else if (['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(input.key)) {
    const step = input.key === 'up' ? -1 : input.key === 'page-up' ? -5 : input.key === 'page-down' ? 5 : 1;
    const at = input.key === 'home' ? 0 : input.key === 'end' ? view.entries.length - 1 : view.entries.indexOf(view.selected!) + step;
    typed.pick = view.entries[Math.max(0, Math.min(view.entries.length - 1, at))]?.id;
    typed.scroll = typed.clicked = undefined;
  } else if (input.key === 'enter') return set();
  else if (input.key === 'model-refresh') return done({ type: 'refresh-models' });
  else if (input.key === 'escape' && typed.text) filter('');
  else if (input.key === 'escape' || input.key === 'close') next.projectInput = undefined;
  return done();
}
