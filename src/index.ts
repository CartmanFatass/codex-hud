/**
 * Codex HUD - Main entry point
 * Renders the single-line Codex status bar onto herdr's bottom pane strip
 * (or to stdout when run directly outside a strip launcher).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStamp } from '../scripts/dist-lock.mjs';
import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import { getHudDisplayHome, getHudHome } from './hud-home.js';
import { SessionFinder } from './collectors/session-finder.js';
import { HudStatus } from './collectors/hud-status.js';
import { useTreeScanStore, flushTreeScans } from './collectors/subagent-tree.js';
import { TreeScanStore } from './collectors/tree-scan-store.js';
import { RolloutParser } from './collectors/rollout.js';
import { createParseQueue } from './utils/parse-queue.js';
import { fileSignature } from './utils/file-signature.js';
import {
  createAdaptivePollState,
  adaptivePollDue,
  forceAdaptivePoll,
  recordAdaptivePoll,
} from './collectors/adaptive-poll.js';
import { collectionObservation } from './utils/collection-observation.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import { renderToStdout, renderStatusBarLine, cleanupRenderer, currentStatusBar } from './render/index.js';
import { colors } from './render/colors.js';
import { buildSnapshot, SnapshotWriter } from './snapshot.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import { BarNoticeTracker } from './collectors/bar-notices.js';
import { readEvenQuotaNotices } from './collectors/even-quota.js';
import { readAdvisorNotice } from './collectors/advisor-shadow.js';
import { readMachineWork } from './collectors/work-summary-snapshot.js';
import { collectLocalLoad } from './collectors/local-load.js';
import { startProfiling, stopProfiling, time, timeAsync } from './utils/profile.js';
import { BAR_RELOAD_EXIT_CODE, PaneStripClient } from './strip-bar.js';
import type { RolloutParseResult } from './collectors/rollout.js';
import type { HudData } from './types.js';

// Refresh interval in milliseconds
const REFRESH_INTERVAL = 1000;
const HUD_PANE_HEIGHT = 1;

function parsePositivePid(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function runBar(): Promise<void> {
  let adaptive = createAdaptivePollState(REFRESH_INTERVAL);
  let collectionEpoch = 0;
  const wakeCollection = () => {
    adaptive = forceAdaptivePoll(adaptive);
    collectionEpoch++;
  };

  const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
  const HUD_CWD_REAL = (() => {
    try {
      return fs.realpathSync(HUD_CWD);
    } catch {
      return HUD_CWD;
    }
  })();

  const HUD_SESSION_START = (() => {
    const raw = process.env.CODEX_HUD_SESSION_START;
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed > 1_000_000_000_000 ? new Date(parsed) : new Date(parsed * 1000);
  })();

  const stripPaneId = (process.env.CODEX_HUD_STRIP_PANE ?? '').trim();
  const stripMode = Boolean(stripPaneId);
  const initialStripWidth = (() => {
    const parsed = Number(process.env.CODEX_HUD_STRIP_WIDTH);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 80;
  })();
  const parentPid = parsePositivePid(process.env.CODEX_HUD_PARENT_PID);
  const codexPid = parsePositivePid(process.env.CODEX_HUD_CODEX_PID);
  const initialBuildStamp = buildStamp();

  let isRunning = true;
  let shuttingDown = false;
  let tickTimer: NodeJS.Timeout | null = null;
  let cachedHudData: HudData | null = null;
  let configNeedsRefresh = false;
  let lastParsedRollout: string | null = null;

  const rolloutParser = new RolloutParser(10);
  const hudFileWatcher = new HudFileWatcher();
  const parseRolloutSafely = createParseQueue(() => rolloutParser.parse());

  const resetRolloutSignature = () => {
    lastParsedRollout = null;
  };

  const sessionFinder = new SessionFinder(
    HUD_CWD_REAL,
    (session) => {
      wakeCollection();
      resetRolloutSignature();
      if (session) {
        rolloutParser.setRolloutPath(session.path);
        hudFileWatcher.setRolloutPath(session.path);
        return;
      }
      rolloutParser.setRolloutPath(null);
      hudFileWatcher.setRolloutPath(null);
    },
    HUD_SESSION_START
  );

  // Off unless CODEX_HUD_NOTIFY=1. In pane-strip mode, never deliver via tmux.
  const notifier = new Notifier({
    ...resolveNotifierOptions(),
    ...(stripMode ? { deliver: () => {} } : {}),
  });
  const notices = new BarNoticeTracker();
  const hudHome = getHudHome();
  const snapshotWriter = new SnapshotWriter();

  const stripClient = stripMode
    ? new PaneStripClient({
        paneId: stripPaneId,
        position: 'bottom',
        initialWidth: initialStripWidth,
        onWidthChange: () => repaintCached({ force: true }),
        onPaneGone: () => {
          void shutdown(0, false);
        },
      })
    : null;

  function renderCurrent(data: HudData, opts: { force?: boolean; nowMs?: number } = {}): void {
    const nowMs = opts.nowMs ?? Date.now();
    if (stripClient) {
      const line = time('render', () => renderStatusBarLine(data, stripClient.width, nowMs));
      void stripClient.push(line, { force: opts.force, nowMs });
      return;
    }
    renderToStdout(data, HUD_PANE_HEIGHT);
  }

  function repaintCached(opts: { force?: boolean } = {}): void {
    if (!isRunning || !cachedHudData) return;
    try {
      renderCurrent(cachedHudData, { force: opts.force, nowMs: Date.now() });
    } catch {
      // Between-collection repaints are best-effort.
    }
  }

  const hudStatus = new HudStatus(HUD_CWD, () => repaintCached());

  async function parseRolloutIfChanged(rolloutPath: string): Promise<RolloutParseResult | null> {
    const signature = fileSignature(rolloutPath);
    const cached = rolloutParser.getCached();
    if (cached && signature !== null && signature === lastParsedRollout) {
      return cached;
    }
    lastParsedRollout = signature;
    try {
      return await parseRolloutSafely();
    } catch (error) {
      lastParsedRollout = null;
      throw error;
    }
  }

  async function collectData(): Promise<HudData> {
    try {
      const settings = runtimeSettings();
      applyDisplaySettings(settings);
      notifier.configure(resolveNotifierOptions(process.env, settings));
    } catch {
      /* Keep last valid display settings. */
    }
    if (configNeedsRefresh) {
      hudStatus.invalidateConfig();
      configNeedsRefresh = false;
    }

    let session = sessionFinder.getCurrentSession();
    let stale = false;
    const health = hudStatus.health;
    try {
      session = await sessionFinder.check();
    } catch (error) {
      stale = true;
      health.fail('session', error);
    }

    let rolloutData = rolloutParser.getCached();
    if (session) {
      try {
        rolloutData = await parseRolloutIfChanged(session.path);
      } catch (error) {
        stale = true;
        health.fail('rollout', error);
      }
    }
    if (!stale) {
      health.bind(Boolean(session));
      health.read();
    }

    const hudData = hudStatus.build({
      rollout: rolloutData,
      sessionId: session?.sessionId,
      stale,
    });
    cachedHudData = hudData;
    return hudData;
  }

  async function shutdown(exitCode = 0, clearStrip = true): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    isRunning = false;
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }

    if (clearStrip) {
      snapshotWriter.remove();
    }
    flushTreeScans();
    stopProfiling();
    sessionFinder.stop();
    await hudFileWatcher.stop().catch(() => {});
    if (stripClient) {
      await stripClient.stop({ clear: clearStrip }).catch(() => {});
    } else {
      cleanupRenderer();
    }
    process.exit(exitCode);
  }

  async function mainLoop(): Promise<void> {
    if (!isRunning) return;

    if (stripMode) {
      if ((parentPid && !isPidAlive(parentPid)) || (codexPid && !isPidAlive(codexPid))) {
        await shutdown(0, true);
        return;
      }
      // Hot-reload after `npm run build` without clearing the strip or restarting Codex.
      const nextStamp = buildStamp();
      if (initialBuildStamp && nextStamp && nextStamp !== initialBuildStamp) {
        await shutdown(BAR_RELOAD_EXIT_CODE, false);
        return;
      }
    }

    await timeAsync('tick', async () => {
      const scopeKey = sessionFinder.getCurrentSession()?.sessionId ?? '';
      const now = Date.now();
      if (!adaptivePollDue(adaptive, scopeKey, now)) {
        if (cachedHudData) {
          cachedHudData.evenQuota = readEvenQuotaNotices(hudHome, HUD_CWD_REAL, now);
          cachedHudData.advisor = readAdvisorNotice(
            hudHome,
            { session: scopeKey || undefined, projectRoot: HUD_CWD_REAL },
            now
          );
          cachedHudData.work = readMachineWork(hudHome, now);
          cachedHudData.localLoad = collectLocalLoad(hudHome, now);
        }
        repaintCached();
        return;
      }
      const epoch = collectionEpoch;
      try {
        const data = await collectData();
        data.notices = notices.observe(data, Date.now());
        const sampledAt = Date.now();
        data.evenQuota = readEvenQuotaNotices(hudHome, HUD_CWD_REAL, sampledAt);
        data.advisor = readAdvisorNotice(
          hudHome,
          { session: data.session?.id, projectRoot: HUD_CWD_REAL },
          sampledAt
        );
        data.work = readMachineWork(hudHome, sampledAt);
        data.localLoad = collectLocalLoad(hudHome, sampledAt);
        renderCurrent(data, { nowMs: sampledAt });
        notifier.update(data);
        try {
          const width = stripClient?.width;
          time('snapshot.write', () =>
            snapshotWriter.write(buildSnapshot(data, currentStatusBar(data, width, sampledAt), sampledAt))
          );
        } catch {
          // A state file nobody can write is not a reason to stop drawing.
        }
        if (epoch === collectionEpoch) {
          adaptive = recordAdaptivePoll(adaptive, {
            scopeKey: data.session?.id ?? '',
            nowMs: Date.now(),
            ...collectionObservation(data, data.subagentTree),
            succeeded: !data.stale && data.health?.sessionBound === true,
          });
        }
      } catch (error) {
        wakeCollection();
        hudStatus.health.fail('status', error);
        if (!stripMode) console.error('Render error:', error);
      }
    });

    if (isRunning) {
      tickTimer = setTimeout(() => {
        void mainLoop();
      }, REFRESH_INTERVAL);
    }
  }

  const onSignal = () => {
    void shutdown(0, true);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  startProfiling('bar');
  useTreeScanStore(new TreeScanStore(path.join(getHudDisplayHome(), 'scan')));

  if (stripClient) {
    stripClient.start();
  } else {
    process.stdin.on('close', onSignal);
    process.stdin.resume();
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H' + colors.dim(' codex-hud · reading session…'));
    }
  }

  hudFileWatcher.onConfigChange(() => {
    wakeCollection();
    configNeedsRefresh = true;
  });

  hudFileWatcher.onRolloutChange(() => {
    wakeCollection();
    void sessionFinder
      .check()
      .then((session) => {
        if (session) return parseRolloutIfChanged(session.path);
      })
      .catch(() => {
        /* The next collection reports failed reads. */
      });
  });

  hudFileWatcher.start();
  sessionFinder.start(5000);

  await mainLoop();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBar().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
