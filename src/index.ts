/**
 * Codex HUD - Main entry point
 * Phase 3: Redesigned with claude-hud style rendering
 */

import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import { readCodexConfig } from './collectors/codex-config.js';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { collectGitStatus } from './collectors/git.js';
import { collectProjectInfo } from './collectors/project.js';
import { PaneRuntimeStateCollector } from './collectors/pane-runtime-state.js';
import { SessionFinder } from './collectors/session-finder.js';
import { RolloutParser } from './collectors/rollout.js';
import { buildSubagentTree } from './collectors/subagent-tree.js';
import { createParseQueue } from './utils/parse-queue.js';
import { tmuxFocusPaneArgs, tmuxForwardKeyArgs } from './utils/hud-input.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import { renderToStdout, cleanupRenderer } from './render/index.js';
import { buildContextUsage } from './collectors/context-usage.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import type {
  HudData,
  HudDisplayMode,
  CodexConfig,
} from './types.js';

// Session start time
const SESSION_START = new Date();

// Refresh interval in milliseconds
const REFRESH_INTERVAL = 1000;

// Current working directory for the HUD
const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => {
  try {
    return fs.realpathSync(HUD_CWD);
  } catch {
    return HUD_CWD;
  }
})();

// Optional HUD session start time (for session isolation)
const HUD_SESSION_START = (() => {
  const raw = process.env.CODEX_HUD_SESSION_START;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1_000_000_000_000 ? new Date(parsed) : new Date(parsed * 1000);
})();

// Track if we're running
let isRunning = true;

const displayMode: HudDisplayMode = 'single';

// Phase 2: Session and rollout tracking
const sessionFinder = new SessionFinder(HUD_CWD_REAL, (session) => {
  // When session changes, update rollout path
  if (session) {
    rolloutParser.setRolloutPath(session.path);
    hudFileWatcher.setRolloutPath(session.path);
    return;
  }

  rolloutParser.setRolloutPath(null);
  hudFileWatcher.setRolloutPath(null);
}, HUD_SESSION_START);

// Off unless CODEX_HUD_NOTIFY=1. Codex notifies on its own, and two pop-ups
// for one event is worse than none.
const notifier = new Notifier(resolveNotifierOptions());

const rolloutParser = new RolloutParser(10);
const hudFileWatcher = new HudFileWatcher();
const paneRuntimeStateCollector =
  process.platform === 'win32' ? new PaneRuntimeStateCollector() : null;

// Cached data that gets updated by watchers
let cachedHudData: HudData | null = null;
let configNeedsRefresh = false;
const parseRolloutSafely = createParseQueue(() => rolloutParser.parse());

// Cached sync data. The 1s render tick stays (timers and elapsed displays
// need it), but the expensive collectors behind it are invalidated by
// signature instead of rerun unconditionally:
//   - config re-reads only when the file watcher fires (or on first run)
//   - git subprocess + project scans run on a slower 3s cadence
let cachedConfig: CodexConfig | null = null;
let cachedSyncData: Pick<HudData, 'git' | 'project'> | null = null;
const SYNC_REFRESH_MS = 3000;
let lastSyncAt = 0;

/**
 * Collect all HUD data (synchronous parts)
 */
function collectSyncData(): Omit<HudData, 'toolActivity' | 'planProgress' | 'tokenUsage' | 'session' | 'contextUsage' | 'rateLimits' | 'subagents' | 'subagentTree'> {
  try { applyDisplaySettings(runtimeSettings()); } catch { /* Keep last valid display settings. */ }
  if (cachedConfig === null || configNeedsRefresh) {
    cachedConfig = readCodexConfig();
    configNeedsRefresh = false;
  }

  const now = Date.now();
  if (!cachedSyncData || now - lastSyncAt >= SYNC_REFRESH_MS) {
    cachedSyncData = {
      git: collectGitStatus(HUD_CWD),
      project: collectProjectInfo(HUD_CWD, cachedConfig),
    };
    lastSyncAt = now;
  }

  return {
    config: cachedConfig,
    git: cachedSyncData.git,
    project: cachedSyncData.project,
    sessionStart: SESSION_START,
  };
}

/**
 * Collect all HUD data including async rollout parsing
 */
async function collectData(): Promise<HudData> {
  const syncData = collectSyncData();

  // Check for active session
  let session = sessionFinder.getCurrentSession();
  let stale = false;
  try { session = sessionFinder.check(); } catch { stale = true; }

  // Re-parse the current rollout every refresh tick. The parser is incremental,
  // so this keeps runtime session state fresh even if file watcher events are
  // missed on Windows.
  let rolloutData = rolloutParser.getCached();
  if (session) {
    try { rolloutData = await parseRolloutSafely(); } catch { stale = true; }
  }

  const runtimeSession = paneRuntimeStateCollector?.collect() ?? undefined;

  // Build context usage from token usage if available
  // Matches codex "context window left" calculation based on last_token_usage.
  const contextUsage = buildContextUsage(
    rolloutData?.tokenUsage ?? undefined,
    rolloutData?.compactCount,
    rolloutData?.lastCompactTime
  );

  const rootId = rolloutData?.session?.id ?? session?.sessionId ?? '';
  const subagentTree = rootId
    ? buildSubagentTree(rootId, rolloutData?.subagents ?? [])
    : { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };

  const hudData: HudData = {
    ...syncData,
    activity: rolloutData?.activity,
    tokenUsageAt: rolloutData?.tokenUsageAt,
    stale,
    session: rolloutData?.session ?? undefined,
    runtimeSession,
    toolActivity: rolloutData?.toolActivity ?? undefined,
    planProgress: rolloutData?.planProgress ?? undefined,
    tokenUsage: rolloutData?.tokenUsage ?? undefined,
    outputRate: rolloutData?.outputRate,
    contextUsage,
    rateLimits: rolloutData?.rateLimits ?? undefined,
    subagents: rolloutData?.subagents ?? [],
    subagentTree,
    displayMode,
  };

  cachedHudData = hudData;
  return hudData;
}

// Compact HUD is always a single identity line. Subagents live in the tree panel.
const HUD_PANE_MIN_HEIGHT = 1;
const HUD_PANE_MAX_HEIGHT = 1;
const HUD_FAST_RENDER_MS = 250;
let lastPaneHeight = HUD_PANE_MIN_HEIGHT;
let lastPaneResizeAt = 0;
let paneResizeCooldownUntil = 0;

function targetHudPaneHeight(_data: HudData): number {
  return HUD_PANE_MIN_HEIGHT;
}

function maybeResizeHudPane(desiredHeight: number): void {
  if (!process.env.TMUX || !process.env.TMUX_PANE) {
    return;
  }
  if (Date.now() < paneResizeCooldownUntil) {
    return;
  }
  const now = Date.now();
  // Client-attached hooks reset the pane to the wrapper's fixed height, so
  // re-assert taller panes periodically.
  const needsReassert = desiredHeight > HUD_PANE_MIN_HEIGHT && now - lastPaneResizeAt > 10_000;
  if (desiredHeight === lastPaneHeight && !needsReassert) {
    return;
  }
  const previousHeight = lastPaneHeight;
  lastPaneHeight = desiredHeight;
  lastPaneResizeAt = now;
  try {
    const child = spawn('tmux', ['resize-pane', '-t', process.env.TMUX_PANE, '-y', String(desiredHeight)], {
      stdio: 'ignore',
    });
    // Spawn failures surface asynchronously; without this handler they would
    // crash the HUD instead of being a best-effort resize.
    child.on('error', () => {
      lastPaneHeight = previousHeight;
      // Back off instead of hot-looping a failing spawn every tick.
      paneResizeCooldownUntil = Date.now() + 30_000;
    });
    child.unref();
  } catch {
    // pane resizing is best-effort
  }
}

/**
 * Main render loop. Data collection runs every second; a faster render pass
 * repaints the cached snapshot so the traffic marker animates between
 * collections. The renderer always receives the target pane height so rows
 * that disappear leave no stale output behind.
 */
async function mainLoop(): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    const data = await collectData();
    const targetHeight = targetHudPaneHeight(data);
    renderToStdout(data, targetHeight);
    maybeResizeHudPane(targetHeight);
    // Notifications run on the collection tick, not the faster repaint.
    notifier.update(data);
  } catch (error) {
    console.error('Render error:', error);
  }

  // Schedule next render
  setTimeout(mainLoop, REFRESH_INTERVAL);
}

function startFastRenderLoop(): void {
  setInterval(() => {
    if (!isRunning || !cachedHudData) {
      return;
    }
    try {
      renderToStdout(cachedHudData, targetHudPaneHeight(cachedHudData));
    } catch {
      // between-collection repaints are best-effort
    }
  }, HUD_FAST_RENDER_MS);
}

/**
 * Handle graceful shutdown
 */
function shutdown(): void {
  isRunning = false;

  // Clean up watchers
  sessionFinder.stop();
  hudFileWatcher.stop().catch(() => {
    // Ignore cleanup errors
  });

  cleanupRenderer();
  process.exit(0);
}

function spawnTmux(args: string[]): void {
  try {
    const child = spawn('tmux', args, { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort: the 1-line bar must not swallow Codex input.
  }
}

function bounceKeysToCodex(data: Buffer): void {
  const mainPane = process.env.CODEX_HUD_MAIN_PANE;
  if (!mainPane) {
    return;
  }
  const send = tmuxForwardKeyArgs(mainPane, data);
  const focus = tmuxFocusPaneArgs(mainPane);
  if (send) {
    spawnTmux(send);
  }
  if (focus) {
    spawnTmux(focus);
  }
}

function setupKeyListener(): void {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return;
  }
  process.stdin.setRawMode(true);
  process.stdin.on('data', bounceKeysToCodex);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Set up signal handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Handle stdin close (tmux pane closed)
  process.stdin.on('close', shutdown);
  process.stdin.resume();
  setupKeyListener();

  // Set up file watchers
  hudFileWatcher.onConfigChange(() => {
    configNeedsRefresh = true;
  });

  hudFileWatcher.onRolloutChange(() => {
    try {
      if (sessionFinder.check()) void parseRolloutSafely().catch(() => {});
    } catch { /* The next collection displays a failed read without an unhandled rejection. */ }
  });

  hudFileWatcher.start();
  sessionFinder.start(5000); // Check for session changes every 5 seconds
  startFastRenderLoop();

  // Do not write to stdout before the first frame: the compact pane is one
  // line, so a startup log would hide the status header after F12 restore.
  await mainLoop();
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
