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
};

/** Owns the timers, single-flight flags and adaptive collection epoch, not the snapshots. */
export function createCollectionScheduler(refreshMs: number, host: CollectionHost) {
  const worktreeCollector = new WorktreeCollector();
  let collectTimer: ReturnType<typeof setTimeout> | undefined;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let gitTimer: ReturnType<typeof setInterval> | undefined;
  let collectEvery = 0;
  let collectClock = 0;
  let adaptive = createAdaptivePollState(refreshMs);
  let collectionEpoch = 0;
  let collecting = false;
  let collectingGit = false;
  let gitAgain = false;

  const invalidate = () => {
    adaptive = forceAdaptivePoll(adaptive);
    collectionEpoch++;
  };
  const collect = async (force = false) => {
    if (force) invalidate();
    if (host.isClosed() || collecting) return;
    const ready = await host.pollReload();
    if (host.isClosed()) return;
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
    if (epoch === collectionEpoch) {
      adaptive = recordAdaptivePoll(adaptive, host.observation());
      if (collectTimer) clearTimeout(collectTimer);
      let due = adaptive.nextDueAt;
      if (adaptive.intervalMs === collectEvery)
        due += (collectEvery - ((due - collectClock) % collectEvery)) % collectEvery;
      if (!host.isClosed()) collectTimer = setTimeout(() => void collect(), Math.max(1, due - Date.now()));
    } else if (!host.isClosed()) void collect(true);
  };
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = (refreshMs: number) => {
    if (host.isClosed() || (collectTimer && collectEvery === refreshMs)) return;
    if (collectTimer) clearTimeout(collectTimer);
    collectEvery = refreshMs;
    collectClock = Date.now();
    adaptive = createAdaptivePollState(collectEvery);
    collectTimer = setTimeout(() => void collect(), collectEvery);
  };
  const scheduleRepaint = () => {
    if (host.isClosed()) return;
    repaintTimer = setTimeout(() => {
      host.repaint();
      scheduleRepaint();
    }, host.repaintDelay());
  };
  const refreshGit = async () => {
    if (host.isClosed()) return;
    if (collectingGit) {
      gitAgain = true;
      return;
    }
    if (!host.isWorkingTreeOpen()) return;
    collectingGit = true;
    const candidates = host.worktreeSources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await timeAsync('git.worktrees', () => worktreeCollector.refresh(candidates));
      if (host.isClosed()) return;
      if (requestKey !== JSON.stringify(host.worktreeSources())) {
        gitAgain = true;
        return;
      }
      host.onWorktrees(snapshot);
    } catch (err) {
      if (host.isClosed() || requestKey !== JSON.stringify(host.worktreeSources())) return;
      host.onWorktreeError(err);
      host.onWorktrees({ sourcePath: null, entries: [], updatedAt: Date.now(), error: 'Worktree read failed' });
    } finally {
      collectingGit = false;
      if (gitAgain && !host.isClosed()) {
        gitAgain = false;
        void refreshGit();
      }
    }
  };
  return {
    collect, armCollect, refreshGit, invalidate,
    start(refreshMs: number) {
      void collect();
      void refreshGit();
      armCollect(refreshMs);
      scheduleRepaint();
      gitTimer = setInterval(() => void refreshGit(), 3000);
    },
    stop() {
      if (gitTimer) clearInterval(gitTimer);
      if (collectTimer) clearTimeout(collectTimer);
      if (repaintTimer) clearTimeout(repaintTimer);
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
