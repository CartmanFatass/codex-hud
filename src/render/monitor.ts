/** Pure Home, Project and retained passive pages. No legacy Agents layout. */
import type { HudData, SubagentTree } from '../types.js';
import type { DelegationViewModel, HudDelegationData } from '../core/link/view-model.js';
import type { WorktreesSnapshot } from '../collectors/worktrees.js';
import type { HudSettings } from '../settings.js';
import { initialPanelState, type PanelState } from './panel-state.js';
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { buildWorkboard } from '../collectors/workboard.js';
import { renderWorkboardFrame } from './work-view.js';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ProjectOverview } from '../collectors/project-visits.js';
import type { ProjectPage } from './project-view.js';
import type { ModelLists, PlaceEdit, PlaceFact, PresetEdit, RoleFact } from '../roles/role-control.js';
import type { PresetInput } from './preset-input.js';
import type { ChainInput, QuickModelInput } from './chain-input.js';
import type { ModelPick } from './model-input.js';
import type { BackupSkill } from '../collectors/backup-skills.js';
import type { TryAction, TryTarget } from '../collectors/try-records.js';
import { mainTabOf, type MainTab } from './main-tabs.js';
import type { ControlNavigation } from './control-navigation.js';
import type { ExpPage } from './exp-view.js';
import type { ExpData, ExpEdit } from '../exp-config.js';
export { monitorText, plainText, fit, pair, flowLines, squeeze, diffRows } from './monitor-text.js';
export {
  iconic,
  agoText,
  age,
  nodeStatus,
  TURN_CLOCKS,
  QUIET_MS,
  FRESH_FINISH_MS,
  isLive,
  isQuiet,
  turnClock,
  nextRepaintDelay,
  msUntilAgeChanges,
  msUntilCountdownChanges,
  finishedAt,
  agentPaint,
  writtenAge,
  agentRate,
  rateText,
  RATE_FRESH_MS,
} from './monitor-labels.js';
export { CONTEXT_METER_WIDTH, contextLine, METER_MIN, meterText, meterRow, type EdgeMeter } from './monitor-meter.js';
export { monitorRowAt, monitorItemAt, handleMonitorInput } from './monitor-input.js';

// `agents` is the internal Home viewport id, not a separate pane or tab.
export const MONITOR_PANES = ['agents', 'changes', 'details'] as const;
export type MonitorPane = (typeof MONITOR_PANES)[number];
export type PaneMode = 'open' | 'closed';
export type MonitorModes = Record<MonitorPane, PaneMode>;
export interface MonitorState {
  mainTab?: MainTab;
  experiments?: boolean;
  expPage?: ExpPage;
  controlNav?: ControlNavigation;
  controlHarnesses?: boolean;
  controlHarnessNav?: ControlNavigation;
  controlHarnessAdd?: { text: string; pick?: string };
  controlHarnessNotice?: { id: string; off: boolean };
  controlPresetInput?: PresetInput;
  controlChain?: ChainInput;
  controlQuickModel?: QuickModelInput;
  controlPresetNotice?: { role: string; name: string | null } | { role: string; index: number; model: string | null };
  /** The Project page that is open; unset is the hub. Cursor and scroll below belong to it (or to the hub). */
  projectPage?: ProjectPage;
  /** The project the tab shows when it is not the panel's own; unset is the panel's own (Home always is). */
  projectRoot?: string;
  /** The Projects list is open (with several projects) instead of the hub; its cursor is `projectCursor`. */
  projectList?: boolean;
  /** The hub was opened from the Projects list, so Esc on it goes back there. */
  projectBack?: boolean;
  projectCursor?: string;
  projectScroll?: number;
  /** The waiting item (its index in STATE's list) the `waiting` page shows. */
  projectWait?: number;
  /** Progress shows only the slices in state `try`; where the full feed's cursor and scroll were, so clearing it lands there. */
  projectTry?: { cursor?: string; scroll: number };
  /** Space-marked rows in the current to-try view, before recording a decision. */
  trySelection?: ReadonlyMap<string, TryTarget>;
  /** Where each page the owner left was, so opening it again finds the same row and scroll. */
  projectSaved?: Partial<Record<ProjectPage, { cursor?: string; scroll: number }>>;
  projectFolded?: ReadonlySet<string>;
  /** Model picker on this place. Group overrides belong to the current query; the wheel moves the window, not the cursor. */
  projectInput?: { role: string; index: number; text: string; pick?: string; groups?: Record<string, boolean>; scroll?: number; clicked?: string; place?: PlaceFact };
  /** A HUD job the owner asked to stop (`X`): a one-row prompt waits for `y` or Enter, any other input cancels. */
  confirmStop?: { jobId: string; role: string; dir: string };
  homeTarget?: WorkTarget;
  homeScroll?: number;
  boardExpanded?: ReadonlySet<string>;
  boardToggled?: ReadonlySet<string>;
  boardNewest?: string;
  boardFolded?: ReadonlySet<string>;
  boardRevealed?: string;
  boardAnchor?: string;
  boardInspect?: WorkTarget;
  inspectCursor?: string;
  tree: PanelState;
  focus: MonitorPane;
  modes: MonitorModes;
  scroll: Record<MonitorPane, number>;
  preview: 'agent';
  help: boolean;
  zoom: boolean;
  helpScroll?: number;
  cardStallMinutes?: number;
  /** A settled card folds to one row after this, and leaves Home after the hide time (Settings). */
  cardFoldMinutes?: number;
  cardHideMinutes?: number;
  /** Settings → Panel → Layout; unset is Classic. */
  panelLayout?: HudSettings['panelLayout'];
  /** Settings → Panel → Project layout; unset is Timeline. */
  projectLayout?: HudSettings['projectLayout'];
  /** Split: the list's cursor (an item id), the preview's cursor while the keys are in the preview, and the preview's scroll. */
  splitCursor?: string;
  splitFocus?: 'preview';
  splitSub?: string;
  /** Where the list's cursor was while the keys are in the preview (Project has one acting cursor, `projectCursor`). */
  splitList?: string;
  splitScroll?: number;
  splitListScroll?: number;
  /** The list's share of the list-and-preview rows, set with `=` `+` `-`; unset, the list is as tall as it needs. Kept across the panel's reload. */
  splitRatio?: number;
  /** The `/` filter (`filter.ts`): what is typed, and whether keys still go to it. Cleared on leaving the view; kept across the panel's reload. */
  filterQuery?: string;
  filterOpen?: boolean;
  /** What the preview's scroll belongs to; another page or cursor row starts it at the top. */
  splitFor?: string;
}
export interface RowControl {
  kind: MonitorControl['kind'];
  item?: string;
  x: number;
  width: number;
}
export interface MonitorRow {
  text: string;
  paint?: () => string;
  item?: string;
  key?: string;
  controls?: RowControl[];
  files?: string[];
  /** On a Control plane place row (and the picker's filter row) where a model can be picked: the place and the lists to pick from. */
  modelPick?: ModelPick;
  modelHit?: { entry: string } | { provider: string };
  modelWindow?: { first: number; max: number; wide?: boolean };
  harnessOff?: boolean;
  roleFact?: RoleFact;
  tryTarget?: TryTarget;
}
export interface MonitorRect {
  id: MonitorPane | 'preview';
  x: number;
  y: number;
  width: number;
  height: number;
  offset: number;
  contentLength: number;
  rows: MonitorRow[];
  edge?: number;
  pinned?: number;
  visible?: number;
}
/** A project the tab can show; `overview` is read only while the Projects list is open. */
export interface ProjectChoice { root: string; name: string; overview?: ProjectOverview }
export interface MonitorControl {
  kind:
    | `board-${MainTab}`
    | 'board-back'
    | 'board-pick'
    | 'board-activate'
    | 'board-inspect'
    | 'control-roles'
    | 'control-harnesses'
    | 'control-open-file'
    | 'control-model'
    | 'harness-add'
    | 'harness-toggle'
    | 'harness-remove'
    | 'harness-fold'
    | 'harness-restore'
    | 'harness-back'
    | 'harness-refresh'
    | `preset-${'list' | 'copy' | 'empty' | 'rename' | 'delete' | 'next' | 'prev' | 'accept' | 'cancel'}`
    | `chain-${'add' | 'edit' | 'remove' | 'up' | 'down' | 'save' | 'back' | 'accept'}`
    | 'settings'
    | 'help'
    | 'brief';
  item?: string;
  x: number;
  y: number;
  width: number;
}
export interface MonitorFrame {
  workboard?: {
    snapshot: WorkboardSnapshot;
    targets: ReadonlyMap<string, WorkTarget>;
    selected?: WorkTarget;
    rows: MonitorRow[];
  };
  lines: string[];
  panes: MonitorRect[];
  controls: MonitorControl[];
  state: MonitorState;
  /** Set when there is more than one project to switch between: the panel's own first. */
  projects?: ProjectChoice[];
  helpPage?: { count: number; total: number };
  expData?: ExpData;
  controlModels?: ModelLists;
  controlNow?: number;
  /** Root whose Project rows are painted (may lag the requested Project root). */
  projectDisplayRoot?: string;
}
export interface MonitorData {
  hud?: HudData & HudDelegationData;
  tree: SubagentTree;
  workboard?: WorkboardSnapshot;
  project?: ProjectSnapshot;
  projectDisplayRoot?: string;
  projectWaiting?: number;
  /** Herdr confirmed the panel's own pane is zoomed for this picker opening. */
  modelPickerZoomed?: boolean;
  tryMarks?: ReadonlyMap<string, TryAction>;
  backupSkills?: BackupSkill[] | null;
  /** The shown project's own name, for the hub's top row. */
  projectName?: string;
  /** The projects `[` and `]` cycle through (the panel's own first); one or none means no switch. */
  projects?: ProjectChoice[];
  state: MonitorState;
  width: number;
  height: number;
  worktrees?: WorktreesSnapshot | null;
  expData?: ExpData;
  nowMs?: number;
  notice?: string | null;
  error?: string | null;
  publicationNotice?: string | null;
  modelEnabled?: boolean;
  loading?: boolean;
  linkNames?: boolean;
  mouse?: boolean;
}
export interface MonitorContext {
  tree: SubagentTree;
  nowMs?: number;
  frame?: MonitorFrame;
  navigationOverlay?: boolean;
}
export interface MonitorOutcome {
  state: MonitorState;
  close: boolean;
  action?:
    | { type: 'settings' }
    | { type: 'exp-save'; edit: ExpEdit }
    | { type: 'open-files'; files: string[] }
    /** A key on a Control plane place; the panel applies it to the role files and reads them again. */
    | ({ type: 'role-edit' } & PlaceEdit)
    | ({ type: 'preset-edit'; modelIndex?: number } & PresetEdit)
    | { type: 'model-picked'; value: string }
    | { type: 'harness-switch'; id: string; off: boolean }
    | { type: 'record-try'; action: TryAction; target: TryTarget }
    | { type: 'refresh-models' }
    | { type: 'brief-toggle' }
    /** Owner micro-actions on a HUD job (spec §2.2): focus its herdr tab, answer its open question, stop it. */
    | { type: 'focus-job-tab'; dir: string }
    | { type: 'answer-job'; home: string; jobId: string; qid: string; answer: string; role: string | null }
    | { type: 'stop-job'; dir: string }
    /** `w` on Home or Project: the panel writes the shown project's HTML review board and opens it. */
    | { type: 'export-board' };
}
export function initialMonitorState(): MonitorState {
  return {
    mainTab: 'home',
    tree: initialPanelState(),
    focus: 'agents',
    modes: { agents: 'open', changes: 'closed', details: 'closed' },
    scroll: { agents: 0, changes: 0, details: 0 },
    preview: 'agent',
    help: false,
    zoom: false,
    helpScroll: 0,
  };
}
export function monitorModes(settings: HudSettings): MonitorModes {
  return { agents: 'open', changes: settings.changesPane, details: settings.detailsPane };
}
export function monitorSettings(settings: HudSettings): Partial<MonitorState> {
  return { cardStallMinutes: settings.cardStallMinutes, cardFoldMinutes: settings.cardFoldMinutes, cardHideMinutes: settings.cardHideMinutes, panelLayout: settings.panelLayout, projectLayout: settings.projectLayout, experiments: settings.experiments };
}
export function monitorPreferences(state: MonitorState): Partial<HudSettings> {
  return { changesPane: state.modes.changes, detailsPane: state.modes.details };
}
export function reconcileMonitor(
  state: MonitorState,
  _tree: SubagentTree,
  _nowMs?: number,
  _delegation?: DelegationViewModel | null
): MonitorState {
  return { ...state, mainTab: mainTabOf(state), expPage: state.experiments ? state.expPage : undefined,
    tree: { ...state.tree }, scroll: { ...state.scroll }, modes: { ...state.modes } };
}
export function paneShown(state: MonitorState, id: MonitorPane): boolean {
  return state.focus === id && !state.help;
}
export function renderMonitor(input: MonitorData): MonitorFrame {
  const now = input.nowMs ?? Date.now();
  const board =
    input.workboard ??
    buildWorkboard(
      '',
      {
        revision: 0,
        lanes: [],
        coverage: { incomplete: false, diagnostics: [], workspace: null },
        cost: { entries: 0, files: 0, bytes: 0, probes: 0, enumerations: 0, parses: 0, elapsedMs: 0 },
      },
      {
        generation: 0,
        root: null,
        jobs: [],
        coverage: { entries: 0, files: 0, bytes: 0, incomplete: false, omitted: null, diagnostics: [] },
      },
      input.tree
    );
  return renderWorkboardFrame(input, reconcileMonitor(input.state, input.tree), board, now);
}
