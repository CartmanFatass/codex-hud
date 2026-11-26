import type { MainTab } from './main-tabs.js';
import { filterScope } from './filter.js';
import {
  CONTROL_FOLDS, HARNESS_OFF, controlRoleItem, controlRoleOf,
  type ExpDetail, type InspectorState, type MonitorState, type ProjectView, type SubpageState,
} from './monitor-state.js';

export const RELOAD_SCHEMA_VERSION = 2;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)
    ? value as Record<string, unknown> : undefined;
const fields = (value: unknown) => object(value) ?? {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const offset = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (value: unknown): string[] | undefined => {
  const list = value instanceof Set ? [...value] : value;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : undefined;
};
function rowPlace(value: unknown) {
  const { cursor, scroll } = fields(value);
  return { cursor: text(cursor), scroll: offset(scroll) ?? 0 };
}
function projectView(value: unknown): ProjectView {
  const { kind, index, request } = fields(value);
  switch (kind) {
    case 'progress': return { kind };
    case 'waiting': return typeof request === 'string' ? { kind, index: offset(index) ?? -1, request } : { kind: 'hub' };
    case 'projects-list': return fields(value).from === 'execution' ? { kind, from: 'execution' } : { kind };
    case 'tickets': case 'tree': case 'docs': return { kind };
    default: return { kind: 'hub' };
  }
}
function savedPages(value: unknown) {
  const pages = fields(value);
  return Object.fromEntries(['progress', 'tickets', 'tree', 'docs'].flatMap((key) =>
    object(pages[key]) ? [[key, rowPlace(pages[key])]] : []));
}
function inspectorPlace(value: unknown): InspectorState | undefined {
  const raw = fields(value), { kind, laneId, workerId } = fields(raw.target);
  if (raw.kind === 'inspector' && kind === 'worker' && typeof laneId === 'string' && typeof workerId === 'string' && workerId.startsWith('thin-job:'))
    return { kind: 'inspector', target: { kind, laneId, workerId }, ...rowPlace(raw) };
}
function subpagePlace(value: unknown): SubpageState | undefined {
  const raw = fields(value);
  if (raw.kind === 'jobs') return { kind: 'jobs', ...rowPlace(raw) };
  if (raw.kind === 'native-inspector') return { kind: 'native-inspector', ...rowPlace(raw), back: inspectorPlace(raw.back) };
  return inspectorPlace(raw);
}
function expDetail(value: unknown): ExpDetail | undefined {
  if (value === 'anthropic-api' || value === 'openai-api' || value === 'codex-help' || value === 'proxy-status') return value;
}
function mainTab(value: unknown): MainTab {
  return value === 'exp' ? 'control' : value === 'project' || value === 'execution' || value === 'control' ? value : 'home';
}

/** Project only the live fields; old Split and card state is not restored. */
function projectReloadState(value: unknown) {
  const raw = fields(value), project = fields(raw.project), control = fields(raw.control);
  const roles = fields(control.roles), harnesses = fields(control.harnesses), exp = fields(raw.exp), help = object(raw.help);
  const modelPrevious: Record<string, string> = Object.fromEntries(Object.entries(fields(control.modelPrevious))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const oldExecutionPage = raw.activeTab === 'project' && fields(project.view).kind === 'execution';
  const activeTab = oldExecutionPage ? 'execution' as const : mainTab(raw.activeTab);
  return {
    activeTab, selectedProject: text(raw.selectedProject), subpage: activeTab === 'home' ? subpagePlace(raw.subpage) : undefined,
    help: help && { scroll: offset(help.scroll) }, home: { scroll: rowPlace(raw.home).scroll }, jobs: rowPlace(raw.jobs),
    project: { view: projectView(project.view), fromProjectsList: !oldExecutionPage && project.fromProjectsList === true,
      nav: oldExecutionPage ? rowPlace(undefined) : rowPlace(project.nav),
      savedPages: savedPages(project.savedPages), folded: strings(project.folded) ?? [], filterQuery: text(project.filterQuery) || undefined },
    execution: rowPlace(oldExecutionPage ? project.nav : raw.execution),
    control: { subTab: raw.activeTab === 'exp' || control.subTab === 'resources' ? 'resources' as const
      : control.subTab === 'harnesses' ? 'harnesses' as const : 'roles' as const,
      roles: { nav: rowPlace(roles.nav), folded: strings(roles.folded) ?? [...CONTROL_FOLDS] },
      harnesses: { nav: rowPlace(harnesses.nav), folded: strings(harnesses.folded) ?? [HARNESS_OFF] }, modelPrevious },
    exp: { ...rowPlace(exp), detail: expDetail(exp.detail) },
  };
}
export type ReloadStateV2 = ReturnType<typeof projectReloadState>;

export function serializeReloadState(state: MonitorState): ReloadStateV2 {
  const filter = state.project.filter;
  return projectReloadState({ ...state, project: { ...state.project, filterQuery: filter?.editing === false ? filter.query : undefined } });
}
function hydrate(raw: ReloadStateV2): MonitorState {
  const { project, execution, control, exp, subpage } = raw;
  const { filterQuery, ...projectPlace } = project;
  const nav = <P extends { cursor?: string }>(place: P) => ({ ...place, revealed: place.cursor });
  return { activeTab: raw.activeTab, selectedProject: raw.selectedProject,
    subpage: subpage && nav(subpage), help: raw.help, home: raw.home, jobs: nav(raw.jobs),
    project: { ...projectPlace, nav: nav(project.nav), folded: new Set(project.folded), filter: filterQuery ? { query: filterQuery, editing: false } : undefined },
    execution: nav(execution),
    control: { subTab: control.subTab, modelPrevious: control.modelPrevious,
      roles: { nav: nav(control.roles.nav), folded: new Set(control.roles.folded) },
      harnesses: { nav: nav(control.harnesses.nav), folded: new Set(control.harnesses.folded) } },
    exp: nav(exp),
  };
}

// Only the known v1 Set slots recognize the old panelSet sentinel.
const legacySet = (value: unknown) => strings(fields(value).panelSet);
function legacyNav(value: unknown) {
  const old = fields(value);
  return { cursor: old.projectCursor, scroll: old.projectScroll };
}
function legacyControlView(value: unknown, nested: boolean) {
  const old = fields(value);
  return nested ? { nav: old.nav, folded: legacySet(old.folded) } : { nav: legacyNav(old), folded: legacySet(old.projectFolded) };
}

/** Pre-S4 flat state (including the older Skills and Project/Control locations). */
function migrateV1ToV2(old: Record<string, unknown>): MonitorState {
  const nestedControl = object(old.control), control = fields(old.control), scroll = fields(old.scroll);
  let activeTab = mainTab(old.mainTab);
  let roles = legacyControlView(nestedControl ? control.roles : old.controlNav, !!nestedControl);
  const oldControlPage = old.projectPage === 'control';
  const folds = legacySet(old.projectFolded) ?? [];
  const flatNav = legacyNav(old);
  if (oldControlPage) {
    if (activeTab === 'project') activeTab = 'control';
    const cursor = text(old.projectCursor)?.replace('project:fold:role:', 'project:role:');
    const role = controlRoleOf(cursor);
    const renamed = cursor === 'split:radar' ? 'project:fold:usage' : cursor === 'split:files' ? 'project:fold:files' : role ? controlRoleItem(role) : cursor;
    const folded = CONTROL_FOLDS.filter((key) => (key !== 'healthy' || !role) &&
      (!['files', 'agents'].includes(key) || old.projectFolded === undefined || folds.includes(key)));
    roles = { nav: { ...flatNav, cursor: renamed }, folded };
  }
  const page = old.projectPage;
  const restored = hydrate(projectReloadState({
    activeTab: old.mainTab === 'exp' ? 'exp' : activeTab, selectedProject: old.projectRoot,
    subpage: old.focus === 'details' ? { kind: 'inspector', target: old.boardInspect, cursor: old.inspectCursor, scroll: scroll.details } : undefined,
    help: old.help === true ? { scroll: old.helpScroll } : undefined,
    project: { view: { kind: page ?? (old.projectList === true ? 'projects-list' : 'hub'), index: old.projectWait },
      fromProjectsList: !oldControlPage && old.projectBack, nav: oldControlPage ? undefined : flatNav, savedPages: old.projectSaved,
      folded: oldControlPage ? [] : activeTab === 'home' ? folds.filter((id) => !/^(task|ledger):/.test(id)) : folds },
    control: { roles, subTab: nestedControl ? control.subTab : old.controlHarnesses === true ? 'harnesses' : 'roles',
      harnesses: legacyControlView(nestedControl ? control.harnesses : old.controlHarnessNav, !!nestedControl),
      modelPrevious: nestedControl ? control.modelPrevious : old.modelPrevious },
    exp: old.exp ?? old.expPage,
  }));
  const query = text(old.filterQuery);
  if (!old.filterOpen && query && filterScope(restored) && (old.focus === undefined || old.focus === 'agents'))
    restored.project.filter = { query, editing: false };
  return restored;
}

export type PanelPlace = {
  state: MonitorState;
  settings: { selected: number; offset: number } | null;
  openedAt?: number;
};
function settingsPlace(value: unknown): PanelPlace['settings'] {
  const view = fields(value), selected = offset(view.selected), at = offset(view.offset);
  return selected === undefined || at === undefined ? null : { selected, offset: at };
}
export function serializePanelPlace(place: PanelPlace): string {
  // Do not reuse the old `state`/`settings` keys: old builds would hydrate incompatible state or open Settings on rollback.
  return JSON.stringify({ schemaVersion: RELOAD_SCHEMA_VERSION, stateV2: serializeReloadState(place.state),
    settingsView: settingsPlace(place.settings), openedAt: offset(place.openedAt) });
}

export function deserializePanelPlace(json: string): (Omit<PanelPlace, 'state'> & { state?: MonitorState }) | undefined {
  let raw: Record<string, unknown> | undefined;
  try { raw = object(JSON.parse(json)); } catch { return; }
  if (!raw) return;
  const openedAt = offset(raw.openedAt), version = raw.schemaVersion;
  const current = version === RELOAD_SCHEMA_VERSION, old = version === undefined || version === 0 || version === 1;
  const state = object(current ? raw.stateV2 : old ? raw.state : undefined);
  if (!state) return openedAt === undefined ? undefined : { openedAt, settings: null };
  return { state: current ? hydrate(projectReloadState(state)) : migrateV1ToV2(state),
    settings: settingsPlace(current ? raw.settingsView : raw.settings), openedAt };
}
