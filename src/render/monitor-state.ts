/** Panel tab state, transient overlays, and the live input/reload policy. */
import type { ExpAccount, ExpEdit } from '../exp-config.js';
import type { DraftPlace, PlaceFact, RoleFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { filterScope } from './filter.js';
import type { WorkTarget } from '../collectors/workboard-types.js';
import type { TryTarget } from '../collectors/try-records.js';
import type { HudSettings } from '../settings.js';
import type { MainTab } from './main-tabs.js';
import type { PresetInput } from './preset-input.js';

export interface SplitNav {
  focus: 'list' | 'preview';
  listCursor?: string;
  listScroll: number;
  previewCursor?: string;
  previewScroll: number;
  previewFor?: string;
}

export interface ClassicSplitNav {
  /** The acting row, whether in Classic, the Split list, or the Split preview. */
  cursor?: string;
  scroll: number;
  /** Classic and Split share the reveal marker within this view. */
  revealed?: string;
  split: SplitNav;
}

export const emptySplitNav = (): SplitNav => ({ focus: 'list', listScroll: 0, previewScroll: 0 });
export const emptyClassicSplitNav = (cursor?: string): ClassicSplitNav => ({ cursor, scroll: 0, split: emptySplitNav() });

export interface ViewFilter { query: string; editing: boolean }
export type HomeCursor = { kind: 'work'; target: WorkTarget } | { kind: 'anchor'; item: string; fallbackTarget?: WorkTarget };
export interface HomeTabState {
  cursor?: HomeCursor;
  scroll: number;
  revealed?: string;
  showAll: boolean;
  expanded: ReadonlySet<string>;
  toggled: ReadonlySet<string>;
  foldedLanes: ReadonlySet<string>;
  expandedTasks: ReadonlySet<string>;
  newestCard?: string;
  split: SplitNav;
  trySelection?: ReadonlyMap<string, TryTarget>;
  filter?: ViewFilter;
}
export const homeTarget = ({ cursor }: HomeTabState) => cursor?.kind === 'anchor' ? cursor.fallbackTarget : cursor?.target;
export const homeAnchor = ({ cursor }: HomeTabState) => cursor?.kind === 'anchor' ? cursor.item : undefined;
export const homeCursor = (target?: WorkTarget, anchor?: string): HomeCursor | undefined =>
  anchor ? { kind: 'anchor', item: anchor, fallbackTarget: target } : target ? { kind: 'work', target } : undefined;
export const initialHomeTab = (): HomeTabState => ({ scroll: 0, showAll: false, expanded: new Set(), toggled: new Set(),
  foldedLanes: new Set(), expandedTasks: new Set(), split: emptySplitNav() });

export type ProjectSubPage = 'progress' | 'tickets' | 'tree' | 'docs';
export type ProjectView = { kind: 'projects-list' } | { kind: 'hub' }
  | { kind: 'progress'; onlyTry?: { cursor?: string; scroll: number } }
  | { kind: 'tickets' } | { kind: 'tree' } | { kind: 'docs' } | { kind: 'waiting'; index: number };
export interface ProjectTabState {
  view: ProjectView;
  fromProjectsList: boolean;
  nav: ClassicSplitNav;
  savedPages: Readonly<Partial<Record<ProjectSubPage, { cursor?: string; scroll: number }>>>;
  folded: ReadonlySet<string>;
  trySelection?: ReadonlyMap<string, TryTarget>;
  filter?: ViewFilter;
}
export const initialProjectTab = (): ProjectTabState => ({ view: { kind: 'hub' }, fromProjectsList: false,
  nav: emptyClassicSplitNav(), savedPages: {}, folded: new Set() });
export const onlyTry = (view: ProjectView) => view.kind === 'progress' ? view.onlyTry : undefined;
export const projectPage = (view: ProjectView): ProjectSubPage | 'waiting' | undefined => {
  switch (view.kind) {
    case 'hub': case 'projects-list': return undefined;
    case 'progress': case 'tickets': case 'tree': case 'docs': case 'waiting': return view.kind;
    default: return assertNever(view);
  }
};

export type SubpageState = { kind: 'inspector'; target: WorkTarget; cursor?: string; scroll: number; selectedNodeId?: string; revealed?: string }
  | { kind: 'changes'; scroll: number };
export interface HelpOverlay { scroll?: number }
export type ViewPrefs = Pick<HudSettings, 'experiments' | 'panelLayout' | 'projectLayout' | 'acceptance' | 'cardStallMinutes' | 'cardFoldMinutes' | 'cardHideMinutes'> & { splitRatio?: number };
export interface MonitorState {
  activeTab: MainTab;
  selectedProject?: string;
  home: HomeTabState;
  project: ProjectTabState;
  control: ControlTabState;
  exp: ExpTabState;
  prefs: ViewPrefs;
  overlay?: OverlayState;
  subpage?: SubpageState;
  help?: HelpOverlay;
  /** Changes reopens at its last scroll position. */
  lastChangesScroll: number;
}
export const activeTabState = (state: MonitorState) => state.activeTab === 'project' ? state.project : state.activeTab === 'home' ? state.home : undefined;
export const activeFilter = (state: MonitorState) => activeTabState(state)?.filter;

export interface ControlViewState {
  nav: ClassicSplitNav;
  folded: ReadonlySet<string>;
}

export type ControlNotice =
  | { kind: 'preset'; role: string; name: string | null }
  | { kind: 'model'; role: string; index: number; model: string | null }
  | { kind: 'harness'; id: string; off: boolean };

export interface ControlTabState {
  subTab: 'roles' | 'harnesses';
  roles: ControlViewState;
  harnesses: ControlViewState;
  notice?: ControlNotice;
  modelPrevious: Readonly<Record<string, string>>;
}

export const CONTROL_FOLDS = ['healthy', 'usage', 'files', 'agents'] as const;
export const HARNESS_OFF = 'harness-off';
export const harnessFold = `project:fold:${HARNESS_OFF}`;
export const controlRoleOf = (item?: string) => /^project:role:([^:]+)(?::\d+)?$/.exec(item ?? '')?.[1];
export const controlRoleItem = (role: string) => `project:role:${role}`;

export function initialControlView(subTab: ControlTabState['subTab']): ControlViewState {
  return { nav: emptyClassicSplitNav(),
    folded: new Set(subTab === 'roles' ? CONTROL_FOLDS : [HARNESS_OFF]) };
}

export function initialControlTab(): ControlTabState {
  return { subTab: 'roles', roles: initialControlView('roles'), harnesses: initialControlView('harnesses'), modelPrevious: {} };
}

/** Input edits only the active Control view. */
export function copyControlTab(control: ControlTabState): ControlTabState {
  const view = control[control.subTab];
  return { ...control, [control.subTab]: { ...view, nav: { ...view.nav, split: { ...view.nav.split } } } };
}

export type ExpDetail = ExpAccount | 'codex-help' | 'proxy-status';

export interface ExpTabState {
  detail?: ExpDetail;
  cursor?: string;
  scroll: number;
  revealed?: string;
  notice?: 'Saved' | 'Could not save EXP setting' | 'Invalid value';
}

export interface ModelPickerState {
  text: string;
  pick?: string;
  otherOpen?: boolean;
  scroll?: number;
  place: PlaceFact;
}

export type ChainField = 'target' | 'model' | 'kind' | 'thinking' | 'effort' | 'done';
export type ChainSheet = {
  kind: 'sheet';
  index: number;
  place?: DraftPlace;
  field: ChainField;
  error?: string;
  input?: { kind: 'choice'; text: string; at: number } | { kind: 'pi-model-picker'; picker: ModelPickerState };
};
type ChainPlaces = { kind: 'places' };
export type ChainSubMode = ChainPlaces | ChainSheet
  | { kind: 'quick-model'; index: number; picker: ModelPickerState }
  | { kind: 'confirm-leave'; leave: WorkbenchInput; resume: ChainPlaces | ChainSheet };

export interface ExpEditDraft {
  text: string;
  pick: number;
  clicked?: boolean;
  preview?: Extract<ExpEdit, { field: 'grant' | 'renewal' | 'calibration' }>;
}

export type OverlayState =
  | { kind: 'confirm-stop'; jobId: string; role: string; dir: string }
  | { kind: 'control-preset'; sheet: PresetInput }
  | { kind: 'control-quick-model'; role: RoleFact; index: number; picker: ModelPickerState }
  | { kind: 'control-chain'; role: RoleFact; at: number; draft?: { name?: string; run: DraftPlace[] }; error?: string; mode: ChainSubMode }
  | { kind: 'control-harness-add'; text: string; pick?: string }
  | { kind: 'exp-edit'; entryId: string; draft: ExpEditDraft };

function assertNever(_value: never): never { throw new Error('Unhandled panel state'); }

export function closeSubpage(state: MonitorState): MonitorState {
  const subpage = state.subpage;
  switch (subpage?.kind) {
    case undefined: return state;
    case 'changes': return { ...state, lastChangesScroll: subpage.scroll, subpage: undefined };
    case 'inspector': return { ...state, subpage: undefined };
    default: return assertNever(subpage);
  }
}
export function openSubpage(state: MonitorState, subpage: SubpageState): MonitorState {
  return { ...closeSubpage(state), subpage };
}
export function transitionTab(state: MonitorState, tab: MainTab): MonitorState {
  const activeTab = tab === 'exp' && !state.prefs.experiments ? 'home' : tab;
  const base = closeSubpage(state);
  // The Projects list is a layer above the hub, not a destination when entering from Home.
  const resetList = state.activeTab !== 'control' && activeTab !== 'control';
  const project = state.project;
  return { ...base, activeTab, overlay: undefined, control: { ...state.control, notice: undefined },
    home: state.activeTab === 'home' ? { ...state.home, filter: activeTab === 'home' ? state.home.filter : undefined, trySelection: undefined } : state.home,
    project: { ...project, ...(state.activeTab === 'project' && activeTab !== 'project' ? { filter: undefined, trySelection: undefined } : {}),
      ...(resetList ? { view: project.view.kind === 'projects-list' ? { kind: 'hub' } : project.view, fromProjectsList: false } : {}) } };
}

export function switchProject(state: MonitorState, selectedProject?: string): MonitorState {
  if (selectedProject === state.selectedProject) return state;
  const { view, nav } = state.project;
  return { ...state, selectedProject, overlay: state.overlay?.kind === 'control-harness-add' ? state.overlay : undefined,
    project: { ...initialProjectTab(), view: view.kind === 'progress' ? { kind: 'progress' } : view,
      nav: emptyClassicSplitNav(nav.cursor === 'project:switch' ? nav.cursor : undefined) },
    control: { ...state.control, roles: initialControlView('roles'), notice: undefined } };
}

/** Save a page's place and restore it on re-entry. Waiting goes back to the same item on the hub. */
export function transitionProjectView(state: MonitorState, view: ProjectView, options: { cursor?: string; fromProjectsList?: boolean } = {}): MonitorState {
  const project = state.project, from = projectPage(project.view), saved = { ...project.savedPages };
  if (from && from !== 'waiting') saved[from] = (state.prefs.panelLayout === 'classic' ? onlyTry(project.view) : undefined) ??
    { cursor: project.nav.cursor, scroll: project.nav.scroll };
  const page = projectPage(view), kept = page && page !== 'waiting' && !options.cursor ? saved[page] : undefined;
  const cursor = options.cursor ?? kept?.cursor ?? (view.kind === 'hub' && from
    ? project.view.kind === 'waiting' ? `project:wait:${project.view.index}` : `project:page:${from}` : undefined);
  return { ...state, project: { ...project, view, savedPages: saved, trySelection: undefined,
    filter: project.view.kind === view.kind ? project.filter : undefined,
    fromProjectsList: options.fromProjectsList ?? project.fromProjectsList,
    nav: { ...project.nav, cursor, scroll: kept?.scroll ?? 0, revealed: kept?.cursor } } };
}

export function viewPrefs(settings: HudSettings): ViewPrefs {
  const { experiments, panelLayout, projectLayout, acceptance, cardStallMinutes, cardFoldMinutes, cardHideMinutes } = settings;
  return { experiments, panelLayout, projectLayout, acceptance, cardStallMinutes, cardFoldMinutes, cardHideMinutes };
}
export function applyViewPrefs(state: MonitorState, settings: HudSettings): MonitorState {
  const prefs = { ...viewPrefs(settings), splitRatio: state.prefs.splitRatio };
  let next = reconcileMonitor({ ...state, prefs });
  const layout = prefs.panelLayout !== state.prefs.panelLayout;
  const acceptance = prefs.acceptance !== state.prefs.acceptance;
  const projectDisplay = prefs.projectLayout !== state.prefs.projectLayout || acceptance;
  if (layout || acceptance) next = { ...next, home: { ...next.home, trySelection: undefined,
    ...(layout ? { cursor: undefined, scroll: 0, revealed: undefined, split: emptySplitNav() } : {}) } };
  if (layout || projectDisplay) {
    const project = next.project;
    next = { ...next, project: { ...project, view: project.view.kind === 'progress' ? { kind: 'progress' } : project.view,
      nav: emptyClassicSplitNav(), trySelection: undefined } };
  }
  return next;
}

export function reconcileMonitor(state: MonitorState): MonitorState {
  if (state.prefs.experiments) return state;
  const activeTab = state.activeTab === 'exp' ? 'home' : state.activeTab;
  const exp = state.exp.detail || state.exp.cursor || state.exp.scroll || state.exp.notice || state.exp.revealed ? { scroll: 0 } : state.exp;
  const overlay = state.overlay?.kind === 'exp-edit' ? undefined : state.overlay;
  return activeTab === state.activeTab && exp === state.exp && overlay === state.overlay ? state : { ...state, activeTab, exp, overlay };
}

export function hasUnsavedDraft(state: MonitorState): boolean {
  const overlay = state.overlay;
  switch (overlay?.kind) {
    case undefined:
    case 'confirm-stop': return false;
    case 'control-chain': return !!overlay.draft || overlay.mode.kind !== 'places';
    case 'control-preset': return overlay.sheet.mode !== 'list' || overlay.sheet.text.length > 0;
    case 'control-quick-model':
    case 'control-harness-add':
    case 'exp-edit': return true;
    default: return assertNever(overlay);
  }
}

export function blocksReload(state: MonitorState): boolean {
  if (activeFilter(state)?.editing) return true;
  const overlay = state.overlay;
  // Browsing the chain does not carry a draft; reload returns to its role row.
  return !!overlay && (overlay.kind !== 'control-chain' || hasUnsavedDraft(state));
}

export function acceptsRawText(state: MonitorState): boolean {
  if (state.help) return false;
  if (activeFilter(state)?.editing) return true;
  const overlay = state.overlay;
  switch (overlay?.kind) {
    case undefined: return false;
    case 'control-chain': {
      const mode = overlay.mode;
      switch (mode.kind) {
        case 'places':
        case 'confirm-leave': return false;
        case 'quick-model': return true;
        case 'sheet': return mode.input !== undefined;
        default: return assertNever(mode);
      }
    }
    case 'control-preset': return overlay.sheet.mode !== 'delete';
    case 'confirm-stop': // An unnamed key must cancel the prompt too.
    case 'control-quick-model':
    case 'control-harness-add':
    case 'exp-edit': return true;
    default: return assertNever(overlay);
  }
}

export function acceptsMonitorInput(state: MonitorState | undefined, input: WorkbenchInput): boolean {
  if (input.type !== 'key' || input.key) return true;
  if (!state || !input.text || state.help) return false;
  if (acceptsRawText(state)) return true;
  if (state.overlay) return false;
  if (input.text === '/') return filterScope(state) !== undefined;
  return input.text === 'g' && (state.subpage?.kind === 'inspector' || (!state.subpage && state.activeTab === 'home'));
}

/** Drop inert leading text. An admitted event can change the view or open an editor;
 * check the rest of the batch against each new state as it is applied. */
export function filterBatchInputs(state: MonitorState | undefined, inputs: WorkbenchInput[]): WorkbenchInput[] {
  const first = inputs.findIndex((input) => acceptsMonitorInput(state, input));
  return first === 0 ? inputs : first < 0 ? [] : inputs.slice(first);
}
