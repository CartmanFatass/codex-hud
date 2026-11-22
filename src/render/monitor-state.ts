/** Panel tab state, transient overlays, and the live input/reload policy. */
import type { ExpAccount, ExpEdit } from '../exp-config.js';
import type { DraftPlace, PlaceFact, RoleFact } from '../roles/role-control.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { filterScope } from './filter.js';
import type { MonitorState } from './monitor.js';
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
  return { nav: { scroll: 0, split: { focus: 'list', listScroll: 0, previewScroll: 0 } },
    folded: new Set(subTab === 'roles' ? CONTROL_FOLDS : [HARNESS_OFF]) };
}

export function initialControlTab(): ControlTabState {
  return { subTab: 'roles', roles: initialControlView('roles'), harnesses: initialControlView('harnesses'), modelPrevious: {} };
}

/** The active view may reconcile its navigation while painting or handling input. */
export function copyControlTab(control: ControlTabState): ControlTabState {
  const view = control[control.subTab];
  return { ...control, [control.subTab]: { ...view, nav: { ...view.nav, split: { ...view.nav.split } } } };
}

export type ExpDetail = ExpAccount | 'codex-help' | 'proxy-status';

export interface ExpTabState {
  detail?: ExpDetail;
  cursor?: string;
  scroll: number;
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

function assertNever(_value: never): never { throw new Error('Unhandled panel overlay mode'); }

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
  if (state.filterOpen) return true;
  const overlay = state.overlay;
  // Browsing the chain does not carry a draft; reload returns to its role row.
  return !!overlay && (overlay.kind !== 'control-chain' || hasUnsavedDraft(state));
}

export function acceptsRawText(state: MonitorState): boolean {
  if (state.help) return false;
  if (state.filterOpen) return true;
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
  return input.text === 'g' && (state.focus === 'details' || (state.focus === 'agents' && state.mainTab === 'home'));
}

/** Drop inert leading text. An admitted event can change the view or open an editor;
 * check the rest of the batch against each new state as it is applied. */
export function filterBatchInputs(state: MonitorState | undefined, inputs: WorkbenchInput[]): WorkbenchInput[] {
  const first = inputs.findIndex((input) => acceptsMonitorInput(state, input));
  return first === 0 ? inputs : first < 0 ? [] : inputs.slice(first);
}
