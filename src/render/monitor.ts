/** Pure Home, Project and retained passive pages. No legacy Agents layout. */
import type { HudData, SubagentTree } from '../types.js';
import type { WorktreesSnapshot } from '../collectors/worktrees.js';
import type { WorkBatch, WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { buildWorkboard } from '../collectors/workboard.js';
import { renderWorkboardFrame } from './work-view.js';
import type { ProjectItem, ProjectSnapshot } from '../collectors/project-board.js';
import type { HomePortfolio } from '../collectors/home-portfolio.js';
import type { TodayFacts } from '../collectors/home-cards.js';
import type { ScheduleItem } from '../collectors/schedule.js';
import type { ProjectOverview } from '../collectors/project-visits.js';
import type { ModelLists, PlaceEdit, PresetEdit, RoleFact } from '../roles/role-control.js';
import { initialHomeTab, initialProjectTab, initialControlTab, type MonitorState, type ObjectiveTarget } from './monitor-state.js';
export type { MonitorState } from './monitor-state.js';
import type { ModelPick } from './model-input.js';
import type { MainTab } from './main-tabs.js';
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

// `agents` is the internal main viewport id, not a separate pane or tab.
export type MonitorPane = 'agents' | 'details';
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
  modelHit?: { entry: string };
  modelWindow?: { first: number; max: number; size: number; entries: { id: string; row: number }[]; wide?: boolean };
  harnessOff?: boolean;
  roleFact?: RoleFact;
  homeTarget?: { root: string; index?: number; request?: string };
  waitingTarget?: { index: number; request: string };
  objectiveTarget?: ObjectiveTarget;
  objectiveEvidence?: { root: string; text: string };
  advisorCopy?: { root: string; session: string; skill: string; path: string };
  commit?: { cwd: string; hash: string };
  /** The row of a fixed batch on the Jobs page: `X` there acts on the whole batch. */
  batch?: WorkBatch;
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
/** A project the tab can show; `overview` is read only while the Projects list is open. */
export interface ProjectChoice { root: string; name: string; overview?: ProjectOverview }
export interface MonitorControl {
  kind:
    | `board-${MainTab}`
    | 'board-back'
    | 'board-jobs'
    | 'board-native'
    | 'control-roles'
    | 'control-harnesses'
    | 'control-resources'
    | 'control-open-file'
    | 'control-model'
    | 'role-toggle'
    | 'council-grant'
    | 'model-cancel'
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
    | 'help';
  item?: string;
  x: number;
  y: number;
  width: number;
}
export interface MonitorFrame {
  workboard?: {
    snapshot: WorkboardSnapshot;
    targets: ReadonlyMap<string, WorkTarget>;
    rows: MonitorRow[];
  };
  lines: string[];
  panes: MonitorRect[];
  controls: MonitorControl[];
  /** Cursor/scroll reconciliation for these rows; the supplied state is not changed. */
  state: MonitorState;
  /** Set when there is more than one project to switch between: the panel's own first. */
  projects?: ProjectChoice[];
  helpPage?: { count: number; maxOffset: number };
  expData?: ExpData;
  controlModels?: ModelLists;
  controlNow?: number;
  /** Root whose Project rows are painted (may lag the requested Project root). */
  projectDisplayRoot?: string;
}
export interface MonitorData {
  hud?: HudData;
  /** Only available while the native Inspector is open. */
  tree?: SubagentTree;
  workboard?: WorkboardSnapshot;
  /** Whether the calling pane's HUD job collection is complete. */
  jobsObserved?: boolean;
  homeWaiting?: readonly ProjectItem[];
  homePortfolio?: HomePortfolio;
  homeToday?: TodayFacts;
  openSchedule?: readonly ScheduleItem[];
  project?: ProjectSnapshot;
  projectDisplayRoot?: string;
  projectWaiting?: number;
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
  error?: string | null;
  publicationNotice?: string | null;
  linkNames?: boolean;
  mouse?: boolean;
}
export interface MonitorContext {
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
    | { type: 'git-show'; cwd: string; hash: string }
    | ({ type: 'open-objective-evidence' } & NonNullable<MonitorRow['objectiveEvidence']>)
    /** A key on a Control plane place; the panel applies it to the role files and reads them again. */
    | ({ type: 'role-edit' } & PlaceEdit)
    | ({ type: 'preset-edit'; modelIndex?: number } & PresetEdit)
    | { type: 'model-picked'; value: string }
    | { type: 'harness-switch'; id: string; off: boolean }
    | { type: 'council-grant' }
    | { type: 'role-switch'; role: string; enabled: boolean }
    | { type: 'accept-all' }
    | { type: 'request-retry'; home: string; jobId: string }
    | { type: 'copy-advisor'; root: string; session: string; skill: string; path: string }
    | { type: 'refresh-models' }
    /** Owner micro-actions on a HUD job (spec §2.2): focus/hide its herdr tab, answer its open question, stop it. */
    | { type: 'focus-job-tab' | 'hide-job-tab'; dir: string }
    | { type: 'answer-job'; home: string; jobId: string; qid: string; answer: string; role: string | null }
    | { type: 'stop-job'; dir: string }
    | { type: 'batch-control'; flow: string; control: 'pause' | 'resume' | 'stop' }
    /** `w` on Home or Project: the panel writes the shown project's HTML review board and opens it. */
    | { type: 'export-board' };
}
export function initialMonitorState(): MonitorState {
  return { activeTab: 'home', home: initialHomeTab(), project: initialProjectTab(), control: initialControlTab(),
    jobs: { scroll: 0 }, exp: { scroll: 0 } };
}
export function renderMonitor(input: MonitorData): MonitorFrame {
  const now = input.nowMs ?? Date.now();
  const board = input.workboard ?? buildWorkboard({ rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) });
  return renderWorkboardFrame(input, input.state, board, now);
}
