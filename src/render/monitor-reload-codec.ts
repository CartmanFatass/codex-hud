import { targetKey, type WorkTarget } from '../collectors/workboard-types.js';
import type { MainTab } from './main-tabs.js';
import { filterScope } from './filter.js';
import {
  CONTROL_FOLDS, HARNESS_OFF, controlRoleItem, controlRoleOf, homeCursor,
  type ClassicSplitNav, type ExpDetail, type HomeCursor, type MonitorState, type ProjectView,
  type SplitNav, type ViewFilter, type ViewPrefs,
} from './monitor-state.js';

export const RELOAD_SCHEMA_VERSION = 2;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)
    ? value as Record<string, unknown> : undefined;
const fields = (value: unknown) => object(value) ?? {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const offset = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (value: unknown): string[] | undefined => {
  const list = value instanceof Set ? [...value] : value;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : undefined;
};

function workTarget(value: unknown): WorkTarget | undefined {
  const { kind, laneId, workerId, decisionId } = fields(value);
  if (typeof laneId !== 'string') return;
  if (kind === 'lane') return { kind, laneId };
  if (kind === 'worker' && typeof workerId === 'string') return { kind, laneId, workerId };
  if (kind === 'decision' && typeof decisionId === 'string') return { kind, laneId, decisionId };
}
function homePlace(value: unknown): HomeCursor | undefined {
  const { kind, item, target, fallbackTarget } = fields(value);
  if (kind === 'anchor' && typeof item === 'string') return { kind, item, fallbackTarget: workTarget(fallbackTarget) };
  if (kind === 'work') return homeCursor(workTarget(target));
}
function splitPlace(value: unknown): SplitNav {
  const split = fields(value);
  return { focus: split.focus === 'preview' ? 'preview' : 'list', listCursor: text(split.listCursor), listScroll: offset(split.listScroll) ?? 0,
    previewCursor: text(split.previewCursor), previewScroll: offset(split.previewScroll) ?? 0, previewFor: text(split.previewFor) };
}
function rowPlace(value: unknown) {
  const { cursor, scroll } = fields(value);
  return { cursor: text(cursor), scroll: offset(scroll) ?? 0 };
}
function classicSplitPlace(value: unknown) {
  return { ...rowPlace(value), split: splitPlace(fields(value).split) };
}
function projectView(value: unknown): ProjectView {
  const { kind, index } = fields(value);
  switch (kind) {
    case 'progress': return { kind };
    case 'waiting': return { kind, index: offset(index) ?? -1 };
    case 'projects-list': case 'tickets': case 'tree': case 'docs': return { kind };
    default: return { kind: 'hub' };
  }
}
function savedPages(value: unknown) {
  const pages = fields(value);
  return Object.fromEntries(['progress', 'tickets', 'tree', 'docs'].flatMap((key) =>
    object(pages[key]) ? [[key, rowPlace(pages[key])]] : []));
}
function subpagePlace(value: unknown) {
  const { kind, target, cursor, scroll, selectedNodeId } = fields(value);
  if (kind === 'changes') return { kind, scroll: offset(scroll) ?? 0 } as const;
  const work = workTarget(target);
  if (kind === 'inspector' && work) return { kind, target: work, cursor: text(cursor), scroll: offset(scroll) ?? 0, selectedNodeId: text(selectedNodeId) } as const;
}
function expDetail(value: unknown): ExpDetail | undefined {
  if (value === 'anthropic-api' || value === 'openai-api' || value === 'codex-help' || value === 'proxy-status') return value;
}
function mainTab(value: unknown): MainTab {
  return value === 'project' || value === 'control' || value === 'exp' ? value : 'home';
}

/** Project each branch explicitly, including variants and nested records. No live object reaches JSON. */
function projectReloadState(value: unknown) {
  const raw = fields(value), home = fields(raw.home), project = fields(raw.project), control = fields(raw.control);
  const roles = fields(control.roles), harnesses = fields(control.harnesses), exp = fields(raw.exp), help = object(raw.help);
  const splitRatio = finite(fields(raw.prefs).splitRatio);
  const modelPrevious: Record<string, string> = Object.fromEntries(Object.entries(fields(control.modelPrevious))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return {
    activeTab: mainTab(raw.activeTab), selectedProject: text(raw.selectedProject), subpage: subpagePlace(raw.subpage),
    lastChangesScroll: offset(raw.lastChangesScroll) ?? 0, help: help && { scroll: offset(help.scroll) },
    home: { cursor: homePlace(home.cursor), scroll: offset(home.scroll) ?? 0, showAll: home.showAll === true,
      expanded: strings(home.expanded) ?? [], toggled: strings(home.toggled) ?? [], foldedLanes: strings(home.foldedLanes) ?? [],
      split: splitPlace(home.split), filterQuery: text(home.filterQuery) || undefined },
    project: { view: projectView(project.view), fromProjectsList: project.fromProjectsList === true, nav: classicSplitPlace(project.nav),
      savedPages: savedPages(project.savedPages), folded: strings(project.folded) ?? [], filterQuery: text(project.filterQuery) || undefined },
    control: { subTab: control.subTab === 'harnesses' ? 'harnesses' as const : 'roles' as const,
      roles: { nav: classicSplitPlace(roles.nav), folded: strings(roles.folded) ?? [...CONTROL_FOLDS] },
      harnesses: { nav: classicSplitPlace(harnesses.nav), folded: strings(harnesses.folded) ?? [HARNESS_OFF] }, modelPrevious },
    exp: { ...rowPlace(exp), detail: expDetail(exp.detail) },
    prefs: { splitRatio: splitRatio !== undefined && splitRatio > 0 && splitRatio < 1 ? splitRatio : undefined },
  };
}
export type ReloadStateV2 = ReturnType<typeof projectReloadState>;

export function serializeReloadState(state: MonitorState): ReloadStateV2 {
  const kept = (filter?: ViewFilter) => filter?.editing === false ? filter.query : undefined;
  return projectReloadState({ ...state, home: { ...state.home, filterQuery: kept(state.home.filter) },
    project: { ...state.project, filterQuery: kept(state.project.filter) } });
}

/** Previously revealed cursors are derived from the saved position, not from a cached marker in the handoff. */
function revealed(split: SplitNav, cursor: string | undefined, prefs: ViewPrefs) {
  if (prefs.panelLayout === 'split' && split.focus === 'preview' && split.previewFor && split.previewCursor)
    return `${split.previewFor}|${split.previewCursor}`;
  return cursor;
}
function hydrate(raw: ReloadStateV2, basePrefs: ViewPrefs): MonitorState {
  const { home, project, control, exp, subpage, prefs } = raw;
  const viewPrefs = { ...basePrefs, splitRatio: prefs.splitRatio };
  const kept = (query?: string): ViewFilter | undefined => query ? { query, editing: false } : undefined;
  const nav = (place: ReloadStateV2['project']['nav']): ClassicSplitNav => ({ ...place, revealed: revealed(place.split, place.cursor, viewPrefs) });
  const { filterQuery: homeQuery, ...homePlace } = home, { filterQuery: projectQuery, ...projectPlace } = project;
  const homeItem = home.cursor?.kind === 'anchor' ? home.cursor.item : home.cursor && targetKey(home.cursor.target);
  return { activeTab: raw.activeTab, selectedProject: raw.selectedProject, prefs: viewPrefs,
    subpage: subpage?.kind === 'inspector' ? { ...subpage, revealed: subpage.cursor } : subpage,
    lastChangesScroll: raw.lastChangesScroll, help: raw.help,
    home: { ...homePlace, expanded: new Set(home.expanded), toggled: new Set(home.toggled), foldedLanes: new Set(home.foldedLanes),
      filter: kept(homeQuery), revealed: revealed(home.split, homeItem, viewPrefs) },
    project: { ...projectPlace, nav: nav(project.nav), folded: new Set(project.folded), filter: kept(projectQuery) },
    control: { subTab: control.subTab, modelPrevious: control.modelPrevious,
      roles: { nav: nav(control.roles.nav), folded: new Set(control.roles.folded) },
      harnesses: { nav: nav(control.harnesses.nav), folded: new Set(control.harnesses.folded) } },
    exp: { ...exp, revealed: exp.cursor },
  };
}

// Only the known v1 Set slots recognize the old panelSet sentinel.
const legacySet = (value: unknown) => strings(fields(value).panelSet);
function legacyNav(value: unknown) {
  const old = fields(value);
  return { cursor: old.projectCursor, scroll: old.projectScroll,
    split: { focus: old.splitFocus, listCursor: old.splitList, listScroll: old.splitListScroll,
      previewCursor: old.splitSub, previewScroll: old.splitScroll, previewFor: old.splitFor } };
}
function legacyControlView(value: unknown, nested: boolean) {
  const old = fields(value);
  return nested ? { nav: old.nav, folded: legacySet(old.folded) } : { nav: legacyNav(old), folded: legacySet(old.projectFolded) };
}

/** Pre-S4 flat state (including the older Skills and Project/Control locations). */
function migrateV1ToV2(old: Record<string, unknown>, basePrefs: ViewPrefs): MonitorState {
  const nestedControl = object(old.control), control = fields(old.control), tree = fields(old.tree), scroll = fields(old.scroll);
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
    roles = { nav: { ...flatNav, cursor: renamed, split: { ...flatNav.split, focus: undefined, listCursor: undefined, previewCursor: undefined } }, folded };
  }
  const page = old.projectPage, nav = oldControlPage ? undefined : flatNav;
  const homeSplit = nav && (text(old.splitFor)?.startsWith('home|') ?? (activeTab === 'home'));
  const homeFold = (id: string) => /^(task|ledger):/.test(id);
  const restored = hydrate(projectReloadState({
    activeTab, selectedProject: old.projectRoot, prefs: { splitRatio: old.splitRatio }, lastChangesScroll: scroll.changes,
    subpage: old.focus === 'changes' ? { kind: 'changes', scroll: scroll.changes } : old.focus === 'details' ?
      { kind: 'inspector', target: old.boardInspect, cursor: old.inspectCursor, scroll: scroll.details, selectedNodeId: tree.selectedId } : undefined,
    help: old.help === true ? { scroll: old.helpScroll } : undefined,
    home: { cursor: homeCursor(workTarget(old.homeTarget), text(old.boardAnchor)), scroll: old.homeScroll, showAll: tree.showAll,
      expanded: legacySet(old.boardExpanded), toggled: legacySet(old.boardToggled), foldedLanes: legacySet(old.boardFolded),
      split: { ...(homeSplit ? nav.split : undefined), listCursor: old.splitCursor } },
    project: { view: { kind: page ?? (old.projectList === true ? 'projects-list' : 'hub'), index: old.projectWait },
      fromProjectsList: !oldControlPage && old.projectBack, nav: homeSplit ? { ...nav, split: undefined } : nav, savedPages: old.projectSaved,
      folded: oldControlPage ? [] : activeTab === 'home' ? folds.filter((id) => !homeFold(id)) : folds },
    control: { roles, subTab: nestedControl ? control.subTab : old.controlHarnesses === true ? 'harnesses' : 'roles',
      harnesses: legacyControlView(nestedControl ? control.harnesses : old.controlHarnessNav, !!nestedControl),
      modelPrevious: nestedControl ? control.modelPrevious : old.modelPrevious },
    exp: old.exp ?? old.expPage,
  }), basePrefs);
  const query = text(old.filterQuery), scope = filterScope(restored);
  if (!old.filterOpen && query && scope && (old.focus === undefined || old.focus === 'agents')) {
    const tab = scope === 'home' ? restored.home : restored.project;
    tab.filter = { query, editing: false };
  }
  return restored;
}

export type PanelPlace = {
  state: MonitorState;
  settings: { selected: number; offset: number } | null;
  widthOverride?: number | null;
  openedAt?: number;
};
function settingsPlace(value: unknown): PanelPlace['settings'] {
  const view = fields(value), selected = offset(view.selected), at = offset(view.offset);
  return selected === undefined || at === undefined ? null : { selected, offset: at };
}
function width(value: unknown) {
  if (value === null) return null;
  const size = finite(value);
  return size !== undefined && size > 0 ? size : undefined;
}

export function serializePanelPlace(place: PanelPlace): string {
  // Do not reuse the old `state`/`settings` keys: old builds would hydrate incompatible state or open Settings on rollback.
  return JSON.stringify({ schemaVersion: RELOAD_SCHEMA_VERSION, stateV2: serializeReloadState(place.state),
    settingsView: settingsPlace(place.settings), openedAt: offset(place.openedAt), widthOverride: width(place.widthOverride) });
}

export function deserializePanelPlace(json: string, prefs: ViewPrefs): (Omit<PanelPlace, 'state'> & { state?: MonitorState }) | undefined {
  let raw: Record<string, unknown> | undefined;
  try { raw = object(JSON.parse(json)); } catch { return; }
  if (!raw) return;
  const openedAt = offset(raw.openedAt), version = raw.schemaVersion;
  const current = version === RELOAD_SCHEMA_VERSION, old = version === undefined || version === 0 || version === 1;
  const state = object(current ? raw.stateV2 : old ? raw.state : undefined);
  if (!state) return openedAt === undefined ? undefined : { openedAt, settings: null };
  return { state: current ? hydrate(projectReloadState(state), prefs) : migrateV1ToV2(state, prefs),
    settings: settingsPlace(current ? raw.settingsView : raw.settings), openedAt, widthOverride: width(raw.widthOverride) };
}
