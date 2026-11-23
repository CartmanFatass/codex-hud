/** Panel tab state, transient overlays, and the live input/reload policy. */
import type { ExpAccount, ExpEdit } from '../exp-config.js';
import type { DraftPlace, PlaceFact, RoleFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { filterScope } from './filter.js';
import type { WorkTarget } from '../collectors/workboard-types.js';
import type { MainTab } from './main-tabs.js';
import type { PresetInput } from './preset-input.js';

export interface RowNav {
  cursor?: string;
  scroll: number;
  revealed?: string;
}
const emptyNav = (cursor?: string): RowNav => ({ cursor, scroll: 0 });
export interface ViewFilter { query: string; editing: boolean }
export type JobTarget = Extract<WorkTarget, { kind: 'worker' }>;
export interface InspectorState extends RowNav { kind: 'inspector'; target: JobTarget }
export interface JobsState extends RowNav { kind: 'jobs' }
export const initialHomeTab = (): RowNav => ({ scroll: 0 });

export type ProjectSubPage = 'progress' | 'tickets' | 'tree' | 'docs';
export type ProjectView = { kind: 'projects-list' } | { kind: 'hub' }
  | { kind: 'progress' }
  | { kind: 'tickets' } | { kind: 'tree' } | { kind: 'docs' } | { kind: 'waiting'; index: number };
export interface ProjectTabState {
  view: ProjectView;
  fromProjectsList: boolean;
  nav: RowNav;
  savedPages: Readonly<Partial<Record<ProjectSubPage, { cursor?: string; scroll: number }>>>;
  folded: ReadonlySet<string>;
  filter?: ViewFilter;
}
export const initialProjectTab = (): ProjectTabState => ({ view: { kind: 'hub' }, fromProjectsList: false,
  nav: emptyNav(), savedPages: {}, folded: new Set() });
export const projectPage = (view: ProjectView): ProjectSubPage | 'waiting' | undefined => {
  switch (view.kind) {
    case 'hub': case 'projects-list': return undefined;
    case 'progress': case 'tickets': case 'tree': case 'docs': case 'waiting': return view.kind;
    default: return assertNever(view);
  }
};

export type SubpageState = JobsState | InspectorState | (RowNav & { kind: 'native-inspector'; back?: InspectorState });
export interface HelpOverlay { scroll?: number }
export interface MonitorState {
  activeTab: MainTab;
  selectedProject?: string;
  home: RowNav;
  jobs: RowNav;
  project: ProjectTabState;
  control: ControlTabState;
  exp: ExpFormState;
  overlay?: OverlayState;
  subpage?: SubpageState;
  help?: HelpOverlay;
}
export const activeFilter = (state: MonitorState) => state.activeTab === 'project' ? state.project.filter : undefined;

export interface ControlViewState {
  nav: RowNav;
  folded: ReadonlySet<string>;
}

export type ControlNotice =
  | { kind: 'preset'; role: string; name: string | null }
  | { kind: 'model'; role: string; index: number; model: string | null }
  | { kind: 'harness'; id: string; off: boolean };

export const CONTROL_VIEWS = ['roles', 'harnesses', 'resources'] as const;
export interface ControlTabState {
  subTab: (typeof CONTROL_VIEWS)[number];
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

export function initialControlView(subTab: 'roles' | 'harnesses'): ControlViewState {
  return { nav: emptyNav(),
    folded: new Set(subTab === 'roles' ? CONTROL_FOLDS : [HARNESS_OFF]) };
}

export function initialControlTab(): ControlTabState {
  return { subTab: 'roles', roles: initialControlView('roles'), harnesses: initialControlView('harnesses'), modelPrevious: {} };
}

/** Input edits only the active Control view. */
export function copyControlTab(control: ControlTabState): ControlTabState {
  if (control.subTab === 'resources') return { ...control };
  const view = control[control.subTab];
  return { ...control, [control.subTab]: { ...view, nav: { ...view.nav } } };
}

export type ExpDetail = ExpAccount | 'codex-help' | 'proxy-status';

export interface ExpFormState {
  detail?: ExpDetail;
  cursor?: string;
  scroll: number;
  revealed?: string;
  notice?: 'Saved' | 'Could not save resource setting' | 'Invalid value';
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

export const jobsPage = (state: MonitorState): JobsState => ({ ...state.jobs, kind: 'jobs' });
export function backFromSubpage(state: MonitorState): MonitorState {
  const sub = state.subpage;
  return { ...state, subpage: sub?.kind === 'native-inspector' ? sub.back ?? jobsPage(state)
    : sub?.kind === 'inspector' ? jobsPage(state) : undefined };
}
export function transitionTab(state: MonitorState, activeTab: MainTab): MonitorState {
  const base = { ...state, subpage: undefined };
  // The Projects list is a layer above the hub, not a destination when entering from Home.
  const resetList = state.activeTab !== 'control' && activeTab !== 'control';
  const project = state.project;
  return { ...base, activeTab, overlay: undefined, control: { ...state.control, notice: undefined },
    project: { ...project, ...(state.activeTab === 'project' && activeTab !== 'project' ? { filter: undefined } : {}),
      ...(resetList ? { view: project.view.kind === 'projects-list' ? { kind: 'hub' } : project.view, fromProjectsList: false } : {}) } };
}

export function switchProject(state: MonitorState, selectedProject?: string): MonitorState {
  if (selectedProject === state.selectedProject) return state;
  const { view, nav } = state.project;
  return { ...state, selectedProject, overlay: state.overlay?.kind === 'control-harness-add' ? state.overlay : undefined,
    project: { ...initialProjectTab(), view,
      nav: emptyNav(nav.cursor === 'project:switch' ? nav.cursor : undefined) },
    control: { ...state.control, roles: initialControlView('roles'), notice: undefined } };
}

/** Save a page's place and restore it on re-entry. Waiting goes back to the same item on the hub. */
export function transitionProjectView(state: MonitorState, view: ProjectView, options: { cursor?: string; fromProjectsList?: boolean } = {}): MonitorState {
  const project = state.project, from = projectPage(project.view), saved = { ...project.savedPages };
  if (from && from !== 'waiting') saved[from] = { cursor: project.nav.cursor, scroll: project.nav.scroll };
  const page = projectPage(view), kept = page && page !== 'waiting' && !options.cursor ? saved[page] : undefined;
  const cursor = options.cursor ?? kept?.cursor ?? (view.kind === 'hub' && from
    ? project.view.kind === 'waiting' ? `project:wait:${project.view.index}` : `project:page:${from}` : undefined);
  return { ...state, project: { ...project, view, savedPages: saved,
    filter: project.view.kind === view.kind ? project.filter : undefined,
    fromProjectsList: options.fromProjectsList ?? project.fromProjectsList,
    nav: { ...project.nav, cursor, scroll: kept?.scroll ?? 0, revealed: kept?.cursor } } };
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
  return input.text === 'g' && state.subpage?.kind === 'inspector';
}

/** Drop inert leading text. An admitted event can change the view or open an editor;
 * check the rest of the batch against each new state as it is applied. */
export function filterBatchInputs(state: MonitorState | undefined, inputs: WorkbenchInput[]): WorkbenchInput[] {
  const first = inputs.findIndex((input) => acceptsMonitorInput(state, input));
  return first === 0 ? inputs : first < 0 ? [] : inputs.slice(first);
}
