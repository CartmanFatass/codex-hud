/**
 * Codex HUD - Main entry point
 * Phase 3: Redesigned with claude-hud style rendering
 */

import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { PaneRuntimeStateCollector } from './collectors/pane-runtime-state.js';
import { SessionFinder } from './collectors/session-finder.js';
import { HudStatus } from './collectors/hud-status.js';
import { RolloutParser } from './collectors/rollout.js';
import { createParseQueue } from './utils/parse-queue.js';
import { fileSignature } from './utils/file-signature.js';
import { tmuxFocusPaneArgs, tmuxForwardKeyArgs } from './utils/hud-input.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import { renderToStdout, cleanupRenderer, currentStatusBar } from './render/index.js';
import { colors } from './render/colors.js';
import { buildSnapshot, SnapshotWriter } from './snapshot.js';
import { displayConfig } from './render/hud-config.js';
import { hasFreshComm } from './render/subagent-chip.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import type { RolloutParseResult } from './collectors/rollout.js';
import type { HudData } from './types.js';

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

// Phase 2: Session and rollout tracking
const sessionFinder = new SessionFinder(HUD_CWD_REAL, (session) => {
  // When session changes, update rollout path
  resetRolloutSignature();
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

// The same tick that draws the bar also publishes what it drew, so a click,
// a script or another pane can read the state the reader is looking at.
const snapshotWriter = new SnapshotWriter();

const rolloutParser = new RolloutParser(10);
const hudFileWatcher = new HudFileWatcher();
const paneRuntimeStateCollector =
  process.platform === 'win32' ? new PaneRuntimeStateCollector() : null;

// Cached data that gets updated by watchers
let cachedHudData: HudData | null = null;
let configNeedsRefresh = false;
const parseRolloutSafely = createParseQueue(() => rolloutParser.parse());

// Size/mtime/inode of the rollout as of the last parse. Reset when the session
// changes, since the parser starts a new file from offset 0.
let lastParsedRollout: string | null = null;

function resetRolloutSignature(): void {
  lastParsedRollout = null;
}

/**
 * Parse the rollout unless it is byte-for-byte where the last parse left it.
 * An unreadable file counts as changed so a transient error still surfaces.
 */
async function parseRolloutIfChanged(rolloutPath: string): Promise<RolloutParseResult | null> {
  const signature = fileSignature(rolloutPath);
  const cached = rolloutParser.getCached();
  if (cached && signature !== null && signature === lastParsedRollout) {
    return cached;
  }
  // Recorded before the parse: an append that lands mid-parse leaves the
  // signature different afterwards, so the next tick parses again.
  lastParsedRollout = signature;
  try {
    return await parseRolloutSafely();
  } catch (error) {
    // A failed read must not be remembered as "already parsed", or the tick
    // would stop retrying until the file happened to change again.
    lastParsedRollout = null;
    throw error;
  }
}

// The config, project scan and git status behind the bar, each on its own
// cadence; shared with the tree panel, which shows the same fields while it
// replaces the bar (see collectors/hud-status.ts).
const hudStatus = new HudStatus(HUD_CWD, () => repaintCached());

/**
 * Collect all HUD data including async rollout parsing
 */
async function collectData(): Promise<HudData> {
  try { applyDisplaySettings(runtimeSettings()); } catch { /* Keep last valid display settings. */ }
  if (configNeedsRefresh) {
    hudStatus.invalidateConfig();
    configNeedsRefresh = false;
  }

  // Check for active session
  let session = sessionFinder.getCurrentSession();
  let stale = false;
  try { session = sessionFinder.check(); } catch { stale = true; }

  // Re-parse the current rollout only when the file actually moved. The parser
  // is incremental, but reaching that conclusion still costs an open, a read
  // and a close of a file that grows to tens of megabytes; one stat answers
  // the same question. The tick remains the fallback when a watcher event is
  // missed (always, on Windows, where watches are unreliable).
  let rolloutData = rolloutParser.getCached();
  if (session) {
    try { rolloutData = await parseRolloutIfChanged(session.path); } catch { stale = true; }
  }

  const hudData = hudStatus.build({
    rollout: rolloutData,
    sessionId: session?.sessionId,
    stale,
    runtimeSession: paneRuntimeStateCollector?.collect() ?? undefined,
  });
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
    syncFastRenderLoop(data);
    // Notifications and the state file run on the collection tick, not the
    // faster repaint.
    notifier.update(data);
    try {
      snapshotWriter.write(buildSnapshot(data, currentStatusBar(data)));
    } catch {
      // A state file nobody can write is not a reason to stop drawing.
    }
  } catch (error) {
    console.error('Render error:', error);
  }

  // Schedule next render
  setTimeout(mainLoop, REFRESH_INTERVAL);
}

function repaintCached(): void {
  if (!isRunning || !cachedHudData) {
    return;
  }
  try {
    renderToStdout(cachedHudData, targetHudPaneHeight(cachedHudData));
  } catch {
    // between-collection repaints are best-effort
  }
}

/**
 * The traffic marker in the expanded tree rows is the only element that
 * animates, and it only exists above one row. A compact pane (the default,
 * and currently the only height) or reduced motion therefore has nothing to
 * animate, and the 250ms repaint is pure wakeup cost.
 */
function needsAnimationFrames(data: HudData | null): boolean {
  if (!data) {
    return false;
  }
  if (displayConfig().motion === 'reduced') {
    return false;
  }
  if (targetHudPaneHeight(data) <= 1) {
    return false;
  }
  return (data.subagentTree?.nodes ?? []).some((node) => hasFreshComm(node));
}

let fastRenderTimer: NodeJS.Timeout | null = null;

/**
 * Start or stop the between-collection repaint. Kept as a loop rather than
 * removed: the moment a subagent exchange goes live in a tall pane, the next
 * collection tick turns it back on.
 */
function syncFastRenderLoop(data: HudData | null): void {
  const wanted = needsAnimationFrames(data);
  if (wanted && !fastRenderTimer) {
    fastRenderTimer = setInterval(() => {
      if (!isRunning || !needsAnimationFrames(cachedHudData)) {
        return;
      }
      repaintCached();
    }, HUD_FAST_RENDER_MS);
    return;
  }
  if (!wanted && fastRenderTimer) {
    clearInterval(fastRenderTimer);
    fastRenderTimer = null;
  }
}

/**
 * Handle graceful shutdown
 */
function shutdown(): void {
  isRunning = false;

  // Clean up watchers
  syncFastRenderLoop(null);
  // A snapshot of a HUD that is no longer running would read as live.
  snapshotWriter.remove();
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
      const session = sessionFinder.check();
      if (session) void parseRolloutIfChanged(session.path).catch(() => {});
    } catch { /* The next collection displays a failed read without an unhandled rejection. */ }
  });

  hudFileWatcher.start();
  sessionFinder.start(5000); // Check for session changes every 5 seconds

  // Do not write logs to stdout: the compact pane is one line, so a startup
  // log would hide the status header after F12 restore. The first read of a
  // long rollout takes seconds; a dim line says so rather than a blank bar.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H' + colors.dim(' codex-hud · reading session…'));
  }
  await mainLoop();
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
