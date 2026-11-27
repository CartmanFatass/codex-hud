import { createAdaptivePollState, forceAdaptivePoll, recordAdaptivePoll, type AdaptivePollObservation } from '../collectors/adaptive-poll.js';
import { WorktreeCollector, type WorktreesSnapshot } from '../collectors/worktrees.js';
import { nextRepaintDelay, msUntilAgeChanges, msUntilCountdownChanges, finishedAt } from '../render/monitor.js';
import { resolveResetTime } from '../render/quota.js';
import type { HudData, SubagentTreeNode } from '../types.js';
import { timeAsync } from '../utils/profile.js';
import { walkNodes } from './agent-context.js';

type CollectionHost = {
  isClosed(): boolean;
  pollReload(): Promise<boolean>;
  restart(): Promise<void>;
  collectStep(): Promise<void>;
  observation(): AdaptivePollObservation;
  repaint(): void;
  repaintDelay(): number;
  isWorkingTreeOpen(): boolean;
  worktreeSources(): Parameters<WorktreeCollector['refresh']>[0];
  onWorktrees(snapshot: WorktreesSnapshot): void;
  onWorktreeError(error: unknown): void;
  /** When docked in herdr, probes whether the dock is currently collapsed (hidden). */
  isHidden?: () => Promise<boolean>;
  /** Called once when transitioning from collapsed back to shown. */
  onShow?: () => void;
};

/** Owns the timers, single-flight flags and adaptive collection epoch, not the snapshots. */
export function createCollectionScheduler(refreshMs: number, host: CollectionHost) {
  const worktreeCollector = new WorktreeCollector();
  let collectTimer: ReturnType<typeof setTimeout> | undefined;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let gitTimer: ReturnType<typeof setInterval> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let collectEvery = refreshMs;
  let collectClock = 0;
  let adaptive = createAdaptivePollState(refreshMs);
  let collectionEpoch = 0;
  let collecting = false;
  let collectingGit = false;
  let gitAgain = false;
  let paused = false;
  let probing = false;

  const invalidate = () => {
    adaptive = forceAdaptivePoll(adaptive);
    collectionEpoch++;
  };
  const clearWorkTimers = () => {
    if (gitTimer) { clearInterval(gitTimer); gitTimer = undefined; }
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = undefined; }
    if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = undefined; }
  };
  const scheduleResumeProbe = () => {
    if (!paused || host.isClosed() || resumeTimer || !host.isHidden) return;
    const delay = Math.max(50, Math.min(250, collectEvery || refreshMs));
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      void probeResume();
    }, delay);
  };
  const pause = () => {
    if (paused || host.isClosed()) return;
    paused = true;
    clearWorkTimers();
    scheduleResumeProbe();
  };
  const resume = () => {
    if (!paused || host.isClosed()) return;
    paused = false;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
    host.onShow?.();
    void runCollect(true, true);
    void refreshGit();
    scheduleRepaint();
    gitTimer = setInterval(() => void refreshGit(), 3000);
  };
  const probeResume = async () => {
    if (!paused || host.isClosed() || probing || !host.isHidden) return;
    probing = true;
    let hidden = true;
    try {
      hidden = await host.isHidden();
    } catch {
      hidden = false;
    } finally {
      probing = false;
    }
    if (host.isClosed() || !paused) return;
    if (hidden) scheduleResumeProbe();
    else resume();
  };
  const runCollect = async (force = false, skipHiddenCheck = false) => {
    if (force) invalidate();
    if (host.isClosed() || collecting) return;
    if (paused) {
      if (force) void probeResume();
      return;
    }
    if (!skipHiddenCheck && host.isHidden) {
      let hidden = false;
      try { hidden = await host.isHidden(); } catch { hidden = false; }
      if (host.isClosed()) return;
      if (hidden) {
        pause();
        return;
      }
      if (paused || collecting) return;
    }
    const ready = await host.pollReload();
    if (host.isClosed() || paused) return;
    if (ready) {
      await host.restart();
      return;
    }
    if (collecting) return;
    const epoch = collectionEpoch;
    await timeAsync('collect', async () => {
      collecting = true;
      try {
        await host.collectStep();
      } finally {
        collecting = false;
      }
    });
    if (host.isClosed() || paused) return;
    if (epoch === collectionEpoch) {
      adaptive = recordAdaptivePoll(adaptive, host.observation());
      if (collectTimer) clearTimeout(collectTimer);
      let due = adaptive.nextDueAt;
      if (adaptive.intervalMs === collectEvery)
        due += (collectEvery - ((due - collectClock) % collectEvery)) % collectEvery;
      collectTimer = setTimeout(() => void runCollect(), Math.max(1, due - Date.now()));
    } else void runCollect(true);
  };
  const collect = (force = false) => runCollect(force, false);
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = (nextRefreshMs: number) => {
    if (host.isClosed()) return;
    if (paused) {
      collectEvery = nextRefreshMs;
      return;
    }
    if (collectTimer && collectEvery === nextRefreshMs) return;
    if (collectTimer) clearTimeout(collectTimer);
    collectEvery = nextRefreshMs;
    collectClock = Date.now();
    adaptive = createAdaptivePollState(collectEvery);
    collectTimer = setTimeout(() => void runCollect(), collectEvery);
  };
  const scheduleRepaint = () => {
    if (host.isClosed() || paused) return;
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = undefined;
      if (host.isClosed() || paused) return;
      host.repaint();
      scheduleRepaint();
    }, host.repaintDelay());
  };
  const refreshGit = async () => {
    if (host.isClosed() || paused) return;
    if (collectingGit) {
      gitAgain = true;
      return;
    }
    if (!host.isWorkingTreeOpen()) return;
    if (host.isHidden) {
      let hidden = false;
      try { hidden = await host.isHidden(); } catch { hidden = false; }
      if (host.isClosed()) return;
      if (hidden) {
        pause();
        return;
      }
      if (paused || collectingGit || !host.isWorkingTreeOpen()) return;
    }
    collectingGit = true;
    const candidates = host.worktreeSources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await timeAsync('git.worktrees', () => worktreeCollector.refresh(candidates));
      if (host.isClosed() || paused) return;
      if (requestKey !== JSON.stringify(host.worktreeSources())) {
        gitAgain = true;
        return;
      }
      host.onWorktrees(snapshot);
    } catch (err) {
      if (host.isClosed() || paused || requestKey !== JSON.stringify(host.worktreeSources())) return;
      host.onWorktreeError(err);
      host.onWorktrees({ sourcePath: null, entries: [], updatedAt: Date.now(), error: 'Worktree read failed' });
    } finally {
      collectingGit = false;
      if (gitAgain && !host.isClosed() && !paused) {
        gitAgain = false;
        void refreshGit();
      }
    }
  };
  return {
    collect, armCollect, refreshGit, invalidate,
    isPaused: () => paused,
    wake: () => { if (paused) void probeResume(); },
    start(nextRefreshMs: number) {
      void runCollect();
      void refreshGit();
      armCollect(nextRefreshMs);
      scheduleRepaint();
      gitTimer = setInterval(() => void refreshGit(), 3000);
    },
    stop() {
      clearWorkTimers();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
    },
  };
}

/** Repaint on the next visible clock boundary, at least once a minute. */
export function computeRepaintDelay(now: number, nodes: SubagentTreeNode[], data: HudData | null | undefined, settingsOpen: boolean) {
  const activity = data?.activity;
  const anchor = activity?.state === 'working' ? activity.turnStartedAt?.getTime() : undefined;
  if (settingsOpen) return nextRepaintDelay(now, anchor);
  let live = activity?.state === 'working';
  if (!live)
    walkNodes(nodes, (node) => {
      if (node.status === 'running' || node.status === 'starting') live = true;
    });
  if (live) return nextRepaintDelay(now, anchor);
  let wait = 60_000;
  const consider = (ms: number) => {
    if (ms > 0 && ms < wait) wait = ms;
  };
  const ageAt = (at?: Date) => {
    if (at && Number.isFinite(at.getTime())) consider(msUntilAgeChanges(at.getTime(), now));
  };
  walkNodes(nodes, (node) => {
    ageAt(finishedAt(node));
    ageAt(node.startedAt);
    ageAt(node.turnStartedAt);
    ageAt(node.lastEventAt);
    ageAt(node.statusAt);
  });
  ageAt(data?.session?.startTime);
  ageAt(data?.sessionStart);
  // How long it has been idle, on the bar and the status card.
  if (activity?.state === 'idle') ageAt(activity.updatedAt);
  for (const window of [data?.rateLimits?.primary, data?.rateLimits?.secondary]) {
    if (!window) continue;
    const target = resolveResetTime(window, now);
    if (target) consider(msUntilCountdownChanges(target.getTime(), now));
  }
  return Math.min(60_000, Math.max(1, wait));
}
