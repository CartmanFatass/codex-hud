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
import type { ProjectPage } from './project-view.js';
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
  mainTab?: 'home' | 'project';
  /** The Project page that is open; unset is the hub. Cursor and scroll below belong to it (or to the hub). */
  projectPage?: ProjectPage;
  projectCursor?: string;
  projectScroll?: number;
  /** Where each page the owner left was, so opening it again finds the same row and scroll. */
  projectSaved?: Partial<Record<ProjectPage, { cursor?: string; scroll: number }>>;
  projectFolded?: ReadonlySet<string>;
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
  keys?: boolean;
  cardStallMinutes?: number;
  /** A settled card folds to one row after this, and leaves Home after the hide time (Settings). */
  cardFoldMinutes?: number;
  cardHideMinutes?: number;
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
}
export interface MonitorRect {
  id: MonitorPane;
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
export interface MonitorControl {
  kind:
    | 'board-home'
    | 'board-project'
    | 'board-back'
    | 'board-pick'
    | 'board-activate'
    | 'board-inspect'
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
  helpPage?: { count: number; total: number };
}
export interface MonitorData {
  hud?: HudData & HudDelegationData;
  tree: SubagentTree;
  workboard?: WorkboardSnapshot;
  project?: ProjectSnapshot;
  /** The project's own name, for the hub's top row. */
  projectName?: string;
  prefix?: string;
  state: MonitorState;
  width: number;
  height: number;
  worktrees?: WorktreesSnapshot | null;
  nowMs?: number;
  notice?: string | null;
  error?: string | null;
  publicationNotice?: string | null;
  modelEnabled?: boolean;
  loading?: boolean;
  linkNames?: boolean;
  mouse?: boolean;
  embedded?: boolean;
}
export interface MonitorContext {
  tree: SubagentTree;
  nowMs?: number;
  frame?: MonitorFrame;
  navigationOverlay?: boolean;
  standalone?: boolean;
}
export interface MonitorOutcome {
  state: MonitorState;
  close: boolean;
  action?:
    | { type: 'settings' }
    | { type: 'open-files'; files: string[] }
    | { type: 'brief-toggle' };
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
  return { cardStallMinutes: settings.cardStallMinutes, cardFoldMinutes: settings.cardFoldMinutes, cardHideMinutes: settings.cardHideMinutes };
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
  return { ...state, tree: { ...state.tree }, scroll: { ...state.scroll }, modes: { ...state.modes } };
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
