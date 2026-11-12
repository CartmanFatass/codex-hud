/**
 * The status bar's data, assembled from one rollout parse.
 *
 * The bar and the tree panel each run their own session finder and rollout
 * parser; this is the part they share: the Codex config, the project scan and
 * git status, kept on their own cadences, and the HudData built from them and
 * the parse. The tree panel needs it because it replaces the bar while it is
 * open and shows the same fields at its foot.
 *
 * Git runs off the frame: `build` starts a refresh at most every few seconds
 * and always returns the last snapshot, so a slow `git status` (WSL /mnt/c)
 * never delays a repaint. `onChange` runs when a refresh lands.
 */
import * as path from 'node:path';
import { readCodexConfig } from './codex-config.js';
import { collectGitStatus } from './git.js';
import { GitTargetCache } from './git-root.js';
import { collectProjectInfo } from './project.js';
import { buildContextUsage } from './context-usage.js';
import { buildSubagentTree } from './subagent-tree.js';
import type { SubagentTree } from '../types.js';
import { HudHealth } from './hud-health.js';
import { time, timeAsync } from '../utils/profile.js';
import type { RolloutParseResult } from './rollout.js';
import { quotaForecast } from './quota-forecast.js';
import type { CodexConfig, GitStatus, HudData, ProjectInfo, SessionInfo } from '../types.js';
import { BridgeHealthReader } from './bridge-health.js';
import { getHudDisplayHome } from '../hud-home.js';

const SYNC_REFRESH_MS = 3000;

export const NO_GIT: GitStatus = {
  branch: null,
  isDirty: false,
  isGitRepo: false,
  ahead: 0,
  behind: 0,
  modified: 0,
  added: 0,
  deleted: 0,
  untracked: 0,
};

/** True when a git refresh would draw the same status the last frame already has. */
export function sameGit(a: GitStatus, b: GitStatus): boolean {
  return (
    a.branch === b.branch &&
    (a.repo ?? '') === (b.repo ?? '') &&
    a.isDirty === b.isDirty &&
    a.isGitRepo === b.isGitRepo &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.modified === b.modified &&
    a.added === b.added &&
    a.deleted === b.deleted &&
    a.untracked === b.untracked
  );
}

export interface HudStatusInput {
  rollout: RolloutParseResult | null;
  /** The session finder's answer, used before the rollout names the session. */
  sessionId?: string;
  /** The latest collection failed; the values shown are the last good ones. */
  stale: boolean;
  /** The panel has its own on-demand Project/Changes git collectors. */
  skipGit?: boolean;
  runtimeSession?: Partial<SessionInfo>;
  /**
   * The panel's tree, when this build is the second one on a tick. Passed
   * through instead of scanning the rollouts again.
   */
  tree?: SubagentTree;
}

export class HudStatus {
  /** When this HUD started; the timer falls back to it before a session is known. */
  readonly sessionStart = new Date();
  private config: CodexConfig | null = null;
  private configStale = true;
  private configAt = 0;
  private project: ProjectInfo | null = null;
  private lastSyncAt = 0;
  private git: GitStatus = NO_GIT;
  private gitInFlight = false;
  private readonly gitTargets = new GitTargetCache();
  private last: HudData | null = null;
  private readonly bridgeHealth = new BridgeHealthReader(getHudDisplayHome());
  /** Fed by the caller's collection and by the git refresh here; carried on every build. */
  readonly health = new HudHealth();

  /**
   * `configMaxAgeMs` re-reads the Codex config on a timer, for a caller with
   * no file watcher to call `invalidateConfig`.
   */
  constructor(
    private readonly cwd: string,
    private readonly onChange: () => void = () => {},
    private readonly configMaxAgeMs = Infinity
  ) {}

  /** The Codex config file changed; read it again on the next build. */
  invalidateConfig(): void {
    this.configStale = true;
  }

  current(): HudData | null {
    return this.last;
  }

  build(input: HudStatusInput): HudData {
    return time('status.build', () => this.buildNow(input));
  }

  private buildNow({ rollout, sessionId, stale, runtimeSession, tree, skipGit }: HudStatusInput): HudData {
    const now = Date.now();
    if (this.config === null || this.configStale || now - this.configAt >= this.configMaxAgeMs) {
      this.config = readCodexConfig();
      this.configStale = false;
      this.configAt = now;
    }
    if (!this.project || now - this.lastSyncAt >= SYNC_REFRESH_MS) {
      this.project = collectProjectInfo(this.cwd, this.config);
      this.lastSyncAt = now;
      if (!skipGit) this.refreshGit(rollout);
    }

    // Matches Codex's "context window left", from last_token_usage.
    const contextUsage = buildContextUsage(
      rollout?.tokenUsage ?? undefined,
      rollout?.compactCount,
      rollout?.lastCompactTime
    );
    const rootId = rollout?.session?.id ?? sessionId ?? '';
    const subagentTree =
      tree ??
      (rootId
        ? time('tree.build', () => buildSubagentTree(rootId, rollout?.subagents ?? []))
        : { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() });
    const health = this.health.current();
    const forecast = quotaForecast(rollout?.quotaSamples ?? [], now);

    this.last = {
      bridgeHealth: this.bridgeHealth.read(now),
      config: this.config,
      git: this.git,
      project: this.project,
      sessionStart: this.sessionStart,
      activity: rollout?.activity,
      tokenUsageAt: rollout?.tokenUsageAt,
      stale,
      session: rollout?.session ?? undefined,
      runtimeSession,
      toolActivity: rollout?.toolActivity ?? undefined,
      planProgress: rollout?.planProgress ?? undefined,
      tokenUsage: rollout?.tokenUsage ?? undefined,
      outputRate: rollout?.outputRate,
      contextUsage,
      pendingApproval: rollout?.pendingApproval ?? undefined,
      rateLimits: rollout?.rateLimits ?? undefined,
      subagents: rollout?.subagents ?? [],
      subagentTree,
      displayMode: 'single',
      ...(health.lastReadAt || health.lastError ? { health } : {}),
      ...(forecast ? { quotaForecast: forecast } : {}),
    };
    return this.last;
  }

  private refreshGit(rollout: RolloutParseResult | null): void {
    if (this.gitInFlight) return;
    this.gitInFlight = true;
    Promise.resolve()
      .then(async () => {
        // Not always the launch folder: a session started above its repository
        // is described by the repository it works in (see git-root.ts).
        const target = this.gitTargets.resolve(
          [this.last?.session?.cwd ?? rollout?.session?.cwd, this.cwd],
          rollout?.workDirs
        );
        if (!target) return { ...NO_GIT };
        const collected = await timeAsync('git', () => collectGitStatus(target.dir));
        return target.subRepo && collected.isGitRepo
          ? { ...collected, repo: path.basename(target.subRepo) }
          : collected;
      })
      .then((status) => {
        const same = sameGit(this.git, status);
        this.git = status;
        if (this.last) this.last.git = status;
        // An unchanged status is not a new frame. The tick already drew this one.
        if (!same) this.onChange();
      })
      .catch((error) => {
        // Keep the previous snapshot; the next build tries again.
        this.health.fail('git', error);
      })
      .finally(() => {
        this.gitInFlight = false;
      });
  }
}
