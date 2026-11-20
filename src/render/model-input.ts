/** Pure picker input: every pi provider in one list; Enter emits the existing role edit. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { MODEL_ID_MAX } from '../roles/model-discovery.js';
import { qualifiedPiProvider } from '../roles/roster.js';
import { placeItem, placeModels, type ModelLists, type PlaceFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorContext, MonitorOutcome, MonitorState } from './monitor.js';
import { t } from './i18n.js';

export type ModelInput = NonNullable<MonitorState['projectInput']>;
export interface ModelPick {
  place: PlaceFact;
  lists: ModelLists;
}
interface PickEntry {
  label: string;
  /** What Enter sets: a model ID, empty to unset, or absent for the read-only current reference. */
  value?: string;
  provider?: string;
  current?: boolean;
}

/** Pi always opens, even when discovery returned nothing. */
export const pickable = (pick: ModelPick) =>
  pick.place.harness === 'pi' || (placeModels(pick.place, pick.lists)?.length ?? 0) > 1;
export function pickOf(data: ProjectSnapshot | undefined, input: ModelInput): ModelPick | undefined {
  const role = data?.roles.find((r) => r.role === input.role), place = role?.places[input.index];
  return data && role && place && role.source !== 'project' && placeModels(place, data.models) ? { place, lists: data.models } : undefined;
}

export function pickView(pick: ModelPick, input: ModelInput) {
  const { place, lists } = pick, typed = input.text.trim(), needle = typed.toLowerCase();
  const pi = place.harness === 'pi', currentId = place.piModel?.current ?? place.model;
  const isDefault = place.piModel?.isDefault ?? !place.model;
  const counts = new Map<string, number>();
  const entries: PickEntry[] = [];
  const currentFact = !pi || !currentId ? undefined : place.state === 'off' || lists.piStatus?.runnerOff ? 'off'
    : !qualifiedPiProvider(currentId) ? 'unknown' : undefined;
  if (!needle && currentId && (currentFact === 'off' || currentFact === 'unknown' && !isDefault))
    entries.push({ label: currentId, current: true });
  if (!needle && !place.piModel?.defaultOff && !(pi && lists.piStatus?.runnerOff))
    entries.push({ label: t('default'), value: '', current: isDefault });
  const ids = (placeModels(place, lists) ?? []).filter((id) => id.toLowerCase().includes(needle));
  const matches = pi ? [...new Set(ids)].map((value) => {
    const slash = value.indexOf('/');
    return { value, provider: value.slice(0, slash), label: value.slice(slash + 1) };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || a.label.localeCompare(b.label))
    : ids.map((value) => ({ value, label: value, provider: undefined }));
  for (const match of matches) {
    if (match.provider) counts.set(match.provider, (counts.get(match.provider) ?? 0) + 1);
    entries.push({ ...match, current: (!pi || !isDefault) && match.value === currentId });
  }
  const current = entries.findIndex((entry) => entry.current);
  const at = entries.length ? Math.min(entries.length - 1, input.pick ?? (needle ? 0 : Math.max(0, current))) : -1;
  // Non-pi pickers retain their catalog and custom typed values.
  const free = !pi && !entries.length && typed ? typed : undefined;
  return { entries, counts, at, total: matches.length, currentId, currentFact, free };
}

/** Every key belongs to the picker while open; a click elsewhere leaves it. */
export function modelInputKey(state: MonitorState, input: Extract<WorkbenchInput, { type: 'key' }>, ctx: MonitorContext): MonitorOutcome {
  const open = state.projectInput!, next: MonitorState = { ...state, projectInput: { ...open } };
  const typed = next.projectInput!, done = (action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const pick = ctx.frame?.workboard?.rows.find((r) => r.modelPick && r.item === placeItem(open.role, open.index))?.modelPick;
  if (!pick) {
    next.projectInput = undefined;
    return done();
  }
  const view = pickView(pick, typed);
  if (input.text !== undefined) {
    typed.text = [...typed.text, ...input.text].slice(0, MODEL_ID_MAX).join('');
    typed.pick = undefined;
  } else if (input.key === 'backspace') {
    typed.text = [...typed.text].slice(0, -1).join('');
    typed.pick = undefined;
  } else if (['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(input.key)) {
    const step = input.key === 'up' ? -1 : input.key === 'page-up' ? -5 : input.key === 'page-down' ? 5 : 1;
    const at = input.key === 'home' ? 0 : input.key === 'end' ? view.entries.length - 1 : view.at + step;
    typed.pick = view.entries.length ? Math.max(0, Math.min(view.entries.length - 1, at)) : undefined;
  } else if (input.key === 'enter') {
    const value = view.entries[view.at]?.value ?? view.free;
    if (value !== undefined) {
      next.projectInput = undefined;
      return done({ type: 'role-edit', role: open.role, index: open.index, op: 'model', value });
    }
  } else if (input.key === 'model-refresh') {
    return done({ type: 'refresh-models' });
  } else if (input.key === 'escape' && typed.text) {
    typed.text = '';
    typed.pick = undefined;
  } else if (input.key === 'escape' || input.key === 'close') next.projectInput = undefined;
  return done();
}
