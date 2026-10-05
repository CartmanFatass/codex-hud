/**
 * Codex HUD - Main entry point
 * Phase 3: Redesigned with claude-hud style rendering
 */

import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import * as fs from 'fs';
import * as path from 'path';
import { getHudHome } from './utils/codex-path.js';
import { spawn } from 'child_process';
import { PaneRuntimeStateCollector } from './collectors/pane-runtime-state.js';
import { SessionFinder } from './collectors/session-finder.js';
import { HudStatus } from './collectors/hud-status.js';
import { useTreeScanStore, flushTreeScans } from './collectors/subagent-tree.js';
import { TreeScanStore } from './collectors/tree-scan-store.js';
import { RolloutParser } from './collectors/rollout.js';
import { createParseQueue } from './utils/parse-queue.js';
import { fileSignature } from './utils/file-signature.js';
import { tmuxFocusPaneArgs, tmuxForwardKeyArgs } from './utils/hud-input.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import { renderToStdout, cleanupRenderer, currentStatusBar } from './render/index.js';
import { colors } from './render/colors.js';
import { buildSnapshot, SnapshotWriter } from './snapshot.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import { startProfiling, stopProfiling, time, timeAsync } from './utils/profile.js';
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
  try {
    const settings = runtimeSettings();
    applyDisplaySettings(settings);
    // Settings saved in the panel reach the notifier here; an environment
    // variable that was set still wins.
    notifier.configure(resolveNotifierOptions(process.env, settings));
    // The panel writes the session title beside the recap when the labels feature is on.
    hudStatus.titleDir = settings.agentLabels && settings.briefing !== 'off' ? path.join(getHudHome(), 'recaps') : null;
  } catch { /* Keep last valid display settings. */ }
  if (configNeedsRefresh) {
    hudStatus.invalidateConfig();
    configNeedsRefresh = false;
  }

  // Check for active session
  let session = sessionFinder.getCurrentSession();
  let stale = false;
  const health = hudStatus.health;
  try { session = sessionFinder.check(); } catch (error) { stale = true; health.fail('session', error); }

  // Re-parse the current rollout only when the file actually moved. The parser
  // is incremental, but reaching that conclusion still costs an open, a read
  // and a close of a file that grows to tens of megabytes; one stat answers
  // the same question. The tick remains the fallback when a watcher event is
  // missed (always, on Windows, where watches are unreliable).
  let rolloutData = rolloutParser.getCached();
  if (session) {
    try { rolloutData = await parseRolloutIfChanged(session.path); } catch (error) { stale = true; health.fail('rollout', error); }
  }
  // No session is a successful read too: there is nothing to show, and the
  // HUD could tell.
  if (!stale) health.read();

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
const HUD_PANE_HEIGHT = 1;

/**
 * Main render loop. Data collection runs every second. The renderer always
 * receives the pane height so rows that disappear leave no stale output behind.
 */
async function mainLoop(): Promise<void> {
  if (!isRunning) {
    return;
  }

  await timeAsync('tick', async () => {
    try {
      const data = await collectData();
      renderToStdout(data, HUD_PANE_HEIGHT);
      // Notifications and the state file run on the collection tick, not on
      // the repaint a status refresh triggers.
      notifier.update(data);
      try {
        time('snapshot.write', () => snapshotWriter.write(buildSnapshot(data, currentStatusBar(data))));
      } catch {
        // A state file nobody can write is not a reason to stop drawing.
      }
    } catch (error) {
      hudStatus.health.fail('status', error);
      console.error('Render error:', error);
    }
  });

  // Schedule next render
  setTimeout(mainLoop, REFRESH_INTERVAL);
}

function repaintCached(): void {
  if (!isRunning || !cachedHudData) {
    return;
  }
  try {
    renderToStdout(cachedHudData, HUD_PANE_HEIGHT);
  } catch {
    // between-collection repaints are best-effort
  }
}

/**
 * Handle graceful shutdown
 */
function shutdown(): void {
  isRunning = false;

  // A snapshot of a HUD that is no longer running would read as live.
  snapshotWriter.remove();
  flushTreeScans();
  stopProfiling();
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
  startProfiling('bar');
  // Started again, the bar reads only what each rollout gained since it last saved its scan.
  useTreeScanStore(new TreeScanStore(path.join(getHudHome(), 'scan')));

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
