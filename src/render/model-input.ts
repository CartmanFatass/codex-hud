/**
 * The Control plane's model picker. `m` on a place opens it over the page: pi asks for the provider first and then lists that
 * provider's models (curated: `roles/model-curation.ts`), another harness lists its models at once. Typing filters the list
 * live (substring, case-insensitive), the arrows pick, Enter opens a provider or sets the model, Esc cancels, Tab shows every
 * provider and model instead of the curated ones. Pure: the place and its lists ride on the rows (`MonitorRow.modelPick`),
 * the write is the panel's `role-edit` action.
 */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { curateModels } from '../roles/model-curation.js';
import { MODEL_ID_MAX, placeItem, placeModels, type ModelLists, type PlaceFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { t } from './i18n.js';

export type ModelInput = NonNullable<MonitorState['projectInput']>;
export interface ModelPick {
  place: PlaceFact;
  lists: ModelLists;
}
export interface PickEntry {
  label: string;
  /** What Enter sets (a provider name at the provider level, a full model id at the model level). */
  value?: string;
  count?: number;
  current?: boolean;
  /** The "default" row: no model of its own, so the role's or harness's default. */
  unset?: boolean;
}
export interface PickView {
  level: 'provider' | 'model';
  entries: PickEntry[];
  /** The picked entry, -1 when there is none. */
  at: number;
  /** What Enter sets when no entry matches the typed text: the text as a model id (on pi within the provider, or whole as `provider/model`). */
  free?: string;
}

/** `m` opens the picker where there is something to choose: always on pi (providers first), else with more than one model listed. */
export const pickable = (pick: ModelPick) =>
  pick.place.harness === 'pi' || (placeModels(pick.place, pick.lists)?.length ?? 0) > 1;
/** The picker's place and lists for the open input, from the snapshot; none once the role or place is gone or is the project's own. */
export function pickOf(data: ProjectSnapshot | undefined, input: ModelInput): ModelPick | undefined {
  const role = data?.roles.find((r) => r.role === input.role), place = role?.places[input.index];
  return data && role && place && role.source !== 'project' && placeModels(place, data.models) ? { place, lists: data.models } : undefined;
}

const nameIn = (id: string, provider: string) => (provider && id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id);
/** The entries the picker shows now: the level, the filtered rows and which one is picked (the current model's until the arrows or typing move it). */
export function pickView(pick: ModelPick, input: ModelInput): PickView {
  const { place, lists } = pick, needle = input.text.trim().toLowerCase();
  const has = (e: PickEntry) => !needle || (e.value ?? e.label).toLowerCase().includes(needle);
  const unset: PickEntry[] = needle ? [] : [{ label: t('default'), unset: true, current: !place.model }];
  let level: PickView['level'] = 'model', entries: PickEntry[];
  if (place.harness === 'pi') {
    const groups = curateModels(lists.pi, lists.include, place.model ? [place.model] : [], !!input.all);
    const group = groups.find((g) => g.provider === input.provider);
    if (group)
      entries = [...unset, ...group.models.map((id) => ({ label: nameIn(id, group.provider), value: id, current: id === place.model })).filter(has)];
    else {
      level = 'provider';
      entries = groups.map((g) => ({ label: g.provider || t('other'), value: g.provider, count: g.models.length,
        current: !!place.model && g.models.includes(place.model) })).filter(has);
    }
  } else
    entries = [...unset, ...(placeModels(place, lists) ?? []).map((id) => ({ label: id, value: id, current: id === place.model })).filter(has)];
  const current = entries.findIndex((e) => e.current), typed = input.text.trim();
  // A filter nothing matches is a model the lists do not know yet: set as typed (on pi, within the provider; at the providers only a whole `provider/model`).
  const free = entries.length || !typed ? undefined : level === 'provider' ? (typed.includes('/') ? typed : undefined)
    : place.harness === 'pi' && !typed.includes('/') && input.provider ? `${input.provider}/${typed}` : typed;
  return { level, entries, at: entries.length ? Math.min(entries.length - 1, input.pick ?? (needle ? 0 : Math.max(0, current))) : -1, ...(free ? { free } : {}) };
}

/** A key while the picker is open: every key is the picker's (`q` is a letter in the filter); a click elsewhere leaves it. */
export function modelInputKey(state: MonitorState, input: Extract<WorkbenchInput, { type: 'key' }>, ctx: MonitorContext): MonitorOutcome {
  const open = state.projectInput!, next: MonitorState = { ...state, projectInput: { ...open } };
  const typed = next.projectInput!, done = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const pick = ctx.frame?.workboard?.rows.find((r) => r.modelPick && r.item === placeItem(open.role, open.index))?.modelPick;
  const reset = () => { typed.pick = undefined; };
  const back = () => { typed.provider = undefined; typed.text = ''; reset(); };
  if (!pick) {
    next.projectInput = undefined;
    return done();
  }
  const view = pickView(pick, typed), entry = view.entries[view.at];
  if (input.text !== undefined) {
    if ([...typed.text].length < MODEL_ID_MAX) typed.text += input.text;
    reset();
  } else if (input.key === 'backspace') {
    if (!typed.text && view.level === 'model' && pick.place.harness === 'pi') back();
    else typed.text = [...typed.text].slice(0, -1).join('');
    reset();
  } else if (input.key === 'tab') {
    typed.all = !typed.all;
    reset();
  } else if (input.key === 'left' && view.level === 'model' && pick.place.harness === 'pi') back();
  else if (['up', 'down', 'page-up', 'page-down'].includes(input.key)) {
    const step = input.key === 'up' ? -1 : input.key === 'page-up' ? -5 : input.key === 'page-down' ? 5 : 1;
    typed.pick = view.entries.length ? Math.max(0, Math.min(view.entries.length - 1, view.at + step)) : undefined;
  } else if (input.key === 'enter' || (input.key === 'right' && view.level === 'provider' && entry)) {
    if (view.level === 'provider' && entry) { typed.provider = entry.value ?? ''; typed.text = ''; reset(); }
    else {
      const value = entry ? (entry.unset ? '' : entry.value) : view.free;
      if (value !== undefined) {
        next.projectInput = undefined;
        return done({ type: 'role-edit', role: open.role, index: open.index, op: 'model', value });
      }
    }
  } else if (input.key === 'escape' || input.key === 'close') next.projectInput = undefined;
  return done();
}
