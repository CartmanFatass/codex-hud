/**
 * A Claude Code session's bar for the B10b tests and the visual baselines: the
 * design's sample fields (model, context, quota, git, activity) around a
 * delegation view model, and the bar as fitted for such a session (the
 * Codex-only `environment` field does not exist there). Synthetic data only.
 */

import { theme } from '../../src/render/colors.js';
import type { Density } from '../../src/render/hud-config.js';
import { fitModules, type FitResult } from '../../src/render/layout/engine.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import type { HudData } from '../../src/types.js';
import type { HudDelegationData } from '../../src/core/link/view-model.js';
import { NOW } from './b10b-delegation.js';
import { makeHudData, at } from './hud-data.js';

/** A Claude Code session's bar fields, as the design's samples have them. */
export function sessionData(vm: HudDelegationData['delegation'], tickMs: number): HudData & HudDelegationData {
  const turnStart = new Date(tickMs - 190_000);
  return {
    ...makeHudData({
      subagentTree: undefined,
      subagents: [],
      tokenUsage: undefined,
      session: undefined,
      contextUsage: { used: 112_300, total: 272_000, percent: 41 } as HudData['contextUsage'],
      rateLimits: {
        primary: { used_percent: 61, window_minutes: 10_080, resets_at: Math.floor(at(300_000).getTime() / 1000) },
      },
      git: {
        repo: 'parser-kit',
        branch: 'main',
        isDirty: true,
        isGitRepo: true,
        ahead: 2,
        behind: 0,
        modified: 1,
        added: 0,
        deleted: 0,
        untracked: 0,
      } as HudData['git'],
      toolActivity: undefined,
      activity: {
        state: 'working',
        turnStartedAt: turnStart,
        updatedAt: new Date(tickMs - 1000),
      } as HudData['activity'],
      outputRate: { tokensPerSecond: 38, sampledAt: new Date(tickMs - 2000) } as HudData['outputRate'],
      project: {
        cwd: '/synthetic/dev/parser-kit',
        projectName: 'parser-kit',
        agentsMdCount: 0,
        hasCodexDir: false,
        instructionsMdCount: 0,
        rulesCount: 0,
        mcpCount: 2,
        skillsCount: 9,
        configsCount: 0,
        extensionsCount: 0,
        workMode: 'development',
      } as HudData['project'],
      config: { model: 'fable-5.1', model_reasoning_effort: 'high' },
    }),
    delegation: vm,
  };
}

/** The bar as fitted for a Claude session: the Codex-only `environment` field does not exist there. */
export function fit(
  data: HudData & HudDelegationData,
  width: number,
  density: Density,
  options: { tickMs?: number; ascii?: boolean } = {}
): FitResult {
  const modules = buildBarModules(data, {
    density,
    width,
    nowMs: options.tickMs ?? NOW,
    barWidth: 10,
    ...(options.ascii === undefined ? {} : { ascii: options.ascii }),
  }).filter((module) => module.id !== 'environment');
  return fitModules(modules, { width, separator: theme.separator(' │ '), groupSeparator: '  ' });
}
