import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialMonitorState } from '../render/monitor.js';
import { CONTROL_FOLDS, activeFilter, controlRoleItem, controlRoleOf, emptySplitNav, homeAnchor, homeCursor, homeTarget, onlyTry, projectPage,
  type ClassicSplitNav, type ControlTabState, type ControlViewState, type ExpTabState, type MonitorState, type ProjectTabState, type ProjectView, type ViewPrefs } from '../render/monitor-state.js';
import type { MainTab } from '../render/main-tabs.js';
import type { WorkTarget } from '../collectors/workboard-types.js';
import type { HudSettings } from '../settings.js';
import { installationRoot } from '../cli/compat.js';

const PLACE = 'HUD_PANEL_RELOAD_PLACE', SUPERVISED = 'HUD_PANEL_RELOAD_SUPERVISED', RESTART = 75;
type Place = { state: MonitorState; settings: { selected: number; offset: number } | null; widthOverride?: number | null; openedAt?: number };
// S3 changes only the in-memory state. This remains the flat S2 wire format.
type LegacyNav = { projectCursor?: string; projectScroll?: number; projectFolded?: ReadonlySet<string>; boardRevealed?: string;
  splitFocus?: 'preview'; splitList?: string; splitSub?: string; splitScroll?: number; splitListScroll?: number; splitFor?: string };
type LegacyState = Partial<ViewPrefs> & LegacyNav & {
  mainTab?: MainTab | 'skills';
  projectPage?: ReturnType<typeof projectPage> | 'control';
  projectRoot?: string;
  projectList?: boolean;
  projectBack?: boolean;
  projectWait?: number;
  projectTry?: ReturnType<typeof onlyTry>;
  projectSaved?: ProjectTabState['savedPages'];
  homeTarget?: WorkTarget;
  homeScroll?: number;
  boardExpanded?: ReadonlySet<string>;
  boardToggled?: ReadonlySet<string>;
  boardFolded?: ReadonlySet<string>;
  boardNewest?: string;
  boardAnchor?: string;
  boardInspect?: WorkTarget;
  inspectCursor?: string;
  tree?: { selectedId?: string | null; showAll?: boolean };
  focus?: 'agents' | 'changes' | 'details';
  modes?: MonitorState['modes'];
  scroll?: { changes?: number; details?: number };
  help?: boolean;
  helpScroll?: number;
  splitCursor?: string;
  filterQuery?: string;
  filterOpen?: boolean;
  control?: ControlTabState;
  exp?: Omit<ExpTabState, 'revealed'>;
  controlNav?: LegacyNav;
  controlHarnessNav?: LegacyNav;
  controlHarnesses?: boolean;
  controlHarnessNotice?: { id: string; off: boolean };
  controlPresetNotice?: { role: string; name: string | null } | { role: string; index: number; model: string | null };
  modelPrevious?: ControlTabState['modelPrevious'];
  expPage?: Partial<ExpTabState> & { edit?: unknown };
};

function readNav({ projectCursor, projectScroll, boardRevealed, splitFocus, splitList, splitSub, splitScroll, splitListScroll, splitFor }: LegacyNav): ClassicSplitNav {
  return { cursor: projectCursor, scroll: projectScroll ?? 0, revealed: boardRevealed,
    split: { focus: splitFocus ?? 'list', listCursor: splitList, previewCursor: splitSub,
      previewScroll: splitScroll ?? 0, listScroll: splitListScroll ?? 0, previewFor: splitFor } };
}
function restoreNav(view: ControlViewState, legacy: LegacyNav | undefined): void {
  if (!legacy) return;
  view.nav = readNav(legacy);
  view.folded = legacy.projectFolded ?? view.folded;
}

const homeFold = (id: string) => /^(task|ledger):/.test(id);
function restoreState(state: LegacyState, settings?: HudSettings): MonitorState {
  const initial = initialMonitorState(settings);
  const { control, controlNav, controlHarnessNav, controlHarnesses, controlPresetNotice, controlHarnessNotice, modelPrevious, exp, expPage } = state;
  // Older builds saved Skills as a main tab; it now lives in Help.
  let activeTab = !state.mainTab || state.mainTab === 'skills' ? 'home' : state.mainTab;
  const tab = control ?? initial.control;
  if (!control) {
    tab.subTab = controlHarnesses ? 'harnesses' : 'roles';
    restoreNav(tab.roles, controlNav);
    restoreNav(tab.harnesses, controlHarnessNav);
    if (modelPrevious) tab.modelPrevious = modelPrevious;
    if (controlHarnesses && controlHarnessNotice) tab.notice = { kind: 'harness', ...controlHarnessNotice };
    else if (controlPresetNotice) tab.notice = 'index' in controlPresetNotice
      ? { kind: 'model', ...controlPresetNotice } : { kind: 'preset', ...controlPresetNotice };
  }
  if (state.projectPage === 'control') {
    const old = state.projectCursor?.replace('project:fold:role:', 'project:role:');
    const role = controlRoleOf(old), roleItem = role && controlRoleItem(role);
    const folded = new Set<string>(CONTROL_FOLDS);
    if (role) folded.delete('healthy');
    for (const key of ['files', 'agents']) if (state.projectFolded?.has && !state.projectFolded.has(key)) folded.delete(key);
    restoreNav(tab.roles, {
      projectCursor: old === 'split:radar' ? 'project:fold:usage' : old === 'split:files' ? 'project:fold:files' : roleItem ?? old,
      projectScroll: state.projectScroll, projectFolded: folded, splitScroll: state.splitScroll,
      splitListScroll: state.splitListScroll, splitFor: state.splitFor,
    });
    if (activeTab === 'project') activeTab = 'control';
    state.projectPage = state.projectList = state.projectBack = undefined;
    state.projectCursor = state.projectScroll = state.projectFolded = state.boardRevealed = undefined;
    state.splitFocus = state.splitList = state.splitSub = state.splitScroll = state.splitListScroll = state.splitFor = undefined;
  }
  const { detail, cursor, scroll = 0, notice } = exp ?? expPage ?? {};
  const nav = readNav(state), page = state.projectPage, home = initial.home, project = initial.project;
  const view: ProjectView = page === 'progress' ? { kind: page, onlyTry: state.projectTry }
    : page === 'waiting' ? { kind: page, index: state.projectWait ?? -1 }
    : page === 'tickets' || page === 'tree' || page === 'docs' ? { kind: page } : { kind: state.projectList ? 'projects-list' : 'hub' };
  const filter = state.filterQuery || state.filterOpen ? { query: state.filterQuery ?? '', editing: !!state.filterOpen } : undefined;
  const folds = state.projectFolded ?? project.folded;
  // There is only one shared preview and one task-fold set in this version of the handoff.
  const homeSplit = state.splitFor?.startsWith('home|') ?? (activeTab === 'home');
  const changes = state.scroll?.changes ?? 0, reveal = state.boardRevealed;
  const subpage = state.focus === 'changes' ? { kind: 'changes' as const, scroll: changes }
    : state.focus === 'details' && state.boardInspect ? { kind: 'inspector' as const, target: state.boardInspect,
      cursor: state.inspectCursor, selectedNodeId: state.tree?.selectedId ?? undefined, scroll: state.scroll?.details ?? 0, revealed: reveal } : undefined;
  const prefs = { ...initial.prefs, splitRatio: state.splitRatio };
  for (const key of ['experiments', 'panelLayout', 'projectLayout', 'acceptance', 'cardStallMinutes', 'cardFoldMinutes', 'cardHideMinutes'] as const) {
    const value = state[key];
    if (value !== undefined) Object.assign(prefs, { [key]: value });
  }
  return { activeTab, selectedProject: state.projectRoot, control: tab, exp: { detail, cursor, scroll, notice, revealed: activeTab === 'exp' ? reveal : undefined },
    prefs, modes: state.modes ?? initial.modes, subpage, lastChangesScroll: changes,
    help: state.help ? { scroll: state.helpScroll } : undefined,
    project: { ...project, view, fromProjectsList: !!state.projectBack, savedPages: state.projectSaved ?? project.savedPages,
      nav: { ...nav, revealed: !subpage && activeTab === 'project' ? reveal : undefined, split: homeSplit ? emptySplitNav() : nav.split },
      folded: activeTab === 'home' ? new Set([...folds].filter((id) => !homeFold(id))) : folds,
      filter: activeTab === 'project' ? filter : undefined },
    home: { ...home, cursor: homeCursor(state.homeTarget, state.boardAnchor), scroll: state.homeScroll ?? 0,
      revealed: !subpage && activeTab === 'home' ? reveal : undefined, showAll: !!state.tree?.showAll,
      expanded: state.boardExpanded ?? home.expanded, toggled: state.boardToggled ?? home.toggled,
      foldedLanes: state.boardFolded ?? home.foldedLanes, newestCard: state.boardNewest,
      split: { ...(homeSplit ? nav.split : emptySplitNav()), listCursor: state.splitCursor },
      expandedTasks: activeTab === 'home' ? new Set([...folds].filter(homeFold)) : home.expandedTasks,
      filter: activeTab === 'home' ? filter : undefined },
  };
}

function handoffState(state: MonitorState): LegacyState {
  const { activeTab, home, project, subpage, help, exp } = state;
  const inspector = subpage?.kind === 'inspector' ? subpage : undefined;
  const filter = activeFilter(state);
  const split = activeTab === 'home' || (activeTab !== 'project' && !project.nav.split.previewFor) ? home.split : project.nav.split;
  const revealed = inspector?.revealed ?? (activeTab === 'home' ? home.revealed : activeTab === 'exp' ? exp.revealed : project.nav.revealed);
  return { ...state.prefs, mainTab: activeTab, projectRoot: state.selectedProject, control: state.control,
    exp: { detail: exp.detail, cursor: exp.cursor, scroll: exp.scroll, notice: exp.notice },
    projectPage: projectPage(project.view), projectList: project.view.kind === 'projects-list' || undefined,
    projectBack: project.fromProjectsList || undefined, projectWait: project.view.kind === 'waiting' ? project.view.index : undefined,
    projectTry: onlyTry(project.view), projectSaved: project.savedPages, projectCursor: project.nav.cursor, projectScroll: project.nav.scroll,
    projectFolded: activeTab === 'home' ? new Set([...project.folded].filter((id) => !homeFold(id)).concat([...home.expandedTasks])) : project.folded,
    homeTarget: homeTarget(home), boardAnchor: homeAnchor(home), homeScroll: home.scroll,
    boardExpanded: home.expanded, boardToggled: home.toggled, boardFolded: home.foldedLanes, boardNewest: home.newestCard, boardRevealed: revealed,
    focus: inspector ? 'details' : subpage?.kind === 'changes' ? 'changes' : 'agents', modes: state.modes,
    boardInspect: inspector?.target, inspectCursor: inspector?.cursor, tree: { selectedId: inspector?.selectedNodeId ?? null, showAll: home.showAll || undefined },
    scroll: { changes: subpage?.kind === 'changes' ? subpage.scroll : state.lastChangesScroll, details: inspector?.scroll ?? 0 },
    help: !!help, helpScroll: help?.scroll,
    splitCursor: home.split.listCursor, splitFocus: split.focus === 'preview' ? 'preview' : undefined,
    splitList: split === project.nav.split ? split.listCursor : undefined, splitSub: split.previewCursor,
    splitListScroll: split.listScroll, splitScroll: split.previewScroll, splitFor: split.previewFor,
    filterQuery: filter?.query, filterOpen: filter?.editing || undefined,
  };
}

export function readPanelPlace(settings?: HudSettings): Place | undefined {
  const raw = process.env[PLACE];
  delete process.env[PLACE];
  try {
    const place: (Omit<Place, 'state'> & { state: LegacyState }) | undefined = raw
      ? JSON.parse(raw, (_key, value) => value?.panelSet ? new Set(value.panelSet) : value) : undefined;
    if (!place) return;
    // Legacy handoffs start their lifetime when consumed.
    return { ...place, state: place.state && restoreState(place.state, settings), openedAt: place.openedAt ?? Date.now() };
  } catch { return undefined; }
}
export function encodePanelPlace(place: Place): string {
  return JSON.stringify({ ...place, state: handoffState(place.state) }, (_key, value) => value instanceof Set ? { panelSet: [...value] } : value);
}

/** One metadata probe per collection; only a quiet, loadable generation may replace this process. */
export class PanelReload {
  private seen: string;
  private attempted: string;
  private changedAt = 0;
  private busy = false;
  failed = false;
  private readonly env = { ...process.env };
  private readonly argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  // Test-only timing override; real builds must be quiet for 2s.
  private readonly quietMs: number;
  constructor(readonly entry = fileURLToPath(new URL('../tree-page.js', import.meta.url)), quietMs?: number) {
    const ms = Number(process.env.HUD_PANEL_RELOAD_QUIET_MS);
    this.quietMs = quietMs ?? (Number.isInteger(ms) && ms > 0 ? ms : 2000);
    this.seen = this.attempted = this.signature();
  }
  private signature(): string {
    try { const s = statSync(this.entry); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch { return 'missing'; }
  }
  async poll(dirty: () => boolean, now = Date.now()): Promise<boolean> {
    const signature = this.signature();
    if (signature !== this.seen) { this.seen = signature; this.changedAt = now; }
    if (this.busy || dirty() || signature === this.attempted || now - this.changedAt < this.quietMs) return false;
    this.busy = true;
    const ok = await new Promise<boolean>((resolve) => execFile(process.execPath,
      [join(installationRoot(), 'bin/hud-dist.mjs'), 'probe-panel', this.entry],
      { env: this.env, timeout: 20000 }, (error) => resolve(!error)));
    this.busy = false;
    if (this.signature() !== signature || dirty()) return false;
    this.attempted = signature;
    this.failed = !ok;
    return ok;
  }
  async restart(place: Place, finish: () => void): Promise<void> {
    // Drafts delay reload; a clean focus can be reopened from its role row. Never put raw launch options in the handoff environment.
    const saved = encodePanelPlace(place);
    const env: NodeJS.ProcessEnv = { ...this.env, [PLACE]: saved };
    if (this.env[SUPERVISED]) {
      await new Promise<void>((resolve, reject) => process.send!(saved, (err) => err ? reject(err) : resolve()));
      process.exitCode = RESTART;
      finish();
      return;
    }
    const execve = (process as typeof process & { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
    // A direct legacy launch switches to the guarded launcher on its first reload.
    const argv = process.argv[1] && resolve(process.argv[1]) === this.entry
      ? [process.execPath, ...process.execArgv, join(installationRoot(), 'bin/hud-dist.mjs'), 'panel', ...process.argv.slice(2)]
      : this.argv;
    finish();
    if (execve) execve(process.execPath, argv, env);
    // Older Node: one supervisor owns all subsequent replacements, never a chain of waiting parents.
    env[SUPERVISED] = '1';
    let code: number | null = RESTART, signal: NodeJS.Signals | null = null;
    while (code === RESTART) {
      const child = spawn(process.execPath, argv.slice(1), { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const forward = signals.map((sig) => () => { child.kill(sig); });
      signals.forEach((sig, i) => process.on(sig, forward[i]));
      child.on('message', (value) => { if (typeof value === 'string') env[PLACE] = value; });
      [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.once('error', () => resolve([1, null]));
        child.once('exit', (code, signal) => resolve([code, signal]));
      });
      signals.forEach((sig, i) => process.off(sig, forward[i]));
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  }
}
