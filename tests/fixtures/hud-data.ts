/**
 * Deterministic HudData factories for unit tests.
 *
 * Every timestamp is fixed so renders are reproducible. Callers that need a
 * live-looking clock pass `nowMs` explicitly rather than reading Date.now().
 */

import type {
  ContextUsage,
  HudData,
  PlanProgress,
  RateLimitSnapshot,
  SubagentInfo,
  SubagentStatus,
  SubagentTree,
  SubagentTreeNode,
  ToolActivity,
  ToolCall,
  TokenUsageInfo,
} from '../../src/types.js';


export const FIXED_NOW = new Date('2026-03-01T12:00:00.000Z');

export function at(offsetSeconds: number): Date {
  return new Date(FIXED_NOW.getTime() + offsetSeconds * 1000);
}

export function makeContextUsage(percent: number, total = 272000): ContextUsage {
  const used = Math.round(total * (percent / 100));
  return {
    used,
    total,
    percent,
    inputTokens: Math.round(used * 0.6),
    outputTokens: Math.round(used * 0.2),
    cachedTokens: Math.round(used * 0.2),
    compactCount: 0,
  };
}

export function makeTokenUsage(totalTokens = 84000, contextWindow = 272000): TokenUsageInfo {
  return {
    total_token_usage: {
      input_tokens: Math.round(totalTokens * 0.7),
      cached_input_tokens: Math.round(totalTokens * 0.5),
      output_tokens: Math.round(totalTokens * 0.3),
      total_tokens: totalTokens,
    },
    last_token_usage: {
      input_tokens: 4000,
      cached_input_tokens: 3000,
      output_tokens: 900,
      total_tokens: 4900,
    },
    model_context_window: contextWindow,
  };
}

export function makeRateLimits(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    primary: { used_percent: 61, window_minutes: 300, resets_at: Math.floor(at(4980).getTime() / 1000) },
    secondary: { used_percent: 23, window_minutes: 10080, resets_at: Math.floor(at(320000).getTime() / 1000) },
    plan_type: 'pro',
    ...overrides,
  };
}

export function makePlanProgress(): PlanProgress {
  return {
    steps: [
      { step: 'Read the collectors', status: 'completed' },
      { step: 'Add the layout engine', status: 'completed' },
      { step: 'Backfill tests', status: 'in_progress' },
      { step: 'Update the docs', status: 'pending' },
      { step: 'Measure the baseline', status: 'pending' },
    ],
    todos: [],
    completedSteps: 2,
    totalSteps: 5,
    completedTodos: 0,
    totalTodos: 0,
    lastUpdate: at(-30),
  };
}

export function makeToolActivity(): ToolActivity {
  const calls: ToolCall[] = [
    { id: 'c1', name: 'Read', timestamp: at(-90), status: 'completed', duration: 120, target: 'src/render/header.ts' },
    { id: 'c2', name: 'Bash', timestamp: at(-60), status: 'error', duration: 4200, target: 'npm test' },
    { id: 'c3', name: 'Edit', timestamp: at(-12), status: 'running', target: 'src/types.ts' },
  ];
  return {
    recentCalls: calls,
    totalCalls: 27,
    callsByType: { Read: 14, Bash: 9, Edit: 4 },
    lastUpdateTime: at(-12),
  };
}

export function makeSubagents(): SubagentInfo[] {
  return [
    { id: 'agent-aaa1', name: 'explorer', status: 'running', startedAt: at(-300), model: 'gpt-5.6-astra', effort: 'high', lastActivityAt: at(-3) },
    { id: 'agent-bbb2', name: 'reviewer', status: 'completed', startedAt: at(-600), model: 'gpt-5.6-sol', effort: 'medium', lastActivityAt: at(-120) },
    { id: 'agent-ccc3', name: '代码审查员', status: 'error', startedAt: at(-500), model: 'gpt-5.6-luna', effort: 'low', lastActivityAt: at(-200) },
  ];
}

/**
 * Build a tree literally rather than through `buildSubagentTree`, which scans
 * the machine's real rollout directory. Tests must not depend on whatever
 * sessions the developer happens to have on disk.
 */
export function node(
  id: string,
  name: string,
  status: SubagentStatus,
  extra: Partial<SubagentTreeNode> = {}
): SubagentTreeNode {
  return {
    id,
    name,
    status,
    depth: extra.depth ?? 1,
    children: extra.children ?? [],
    startedAt: extra.startedAt ?? at(-300),
    model: extra.model,
    effort: extra.effort,
    lastActivityAt: extra.lastActivityAt,
    lastEventAt: extra.lastEventAt ?? extra.lastActivityAt,
  };
}

export function treeOf(nodes: SubagentTreeNode[], rootId = 'root-session-id'): SubagentTree {
  const count = (items: SubagentTreeNode[]): number =>
    items.reduce((sum, item) => sum + 1 + count(item.children), 0);
  return { rootId, nodes, totalCount: count(nodes), updatedAt: FIXED_NOW };
}

export function makeSubagentTree(agents: SubagentInfo[] = makeSubagents()): SubagentTree {
  return treeOf(
    agents.map((agent) =>
      node(agent.id, agent.name, agent.status, {
        model: agent.model,
        effort: agent.effort,
        startedAt: agent.startedAt,
        lastActivityAt: agent.lastActivityAt,
      })
    )
  );
}

/** A three-level tree, for navigation and folding. */
export function makeNestedTree(): SubagentTree {
  return treeOf([
    node('a1', 'explorer', 'running', {
      model: 'gpt-5.6-astra',
      effort: 'high',
      lastActivityAt: at(-3),
      children: [
        node('a1b1', 'reader', 'completed', { depth: 2, lastActivityAt: at(-200) }),
        node('a1b2', 'writer', 'error', {
          depth: 2,
          lastActivityAt: at(-40),
          children: [node('a1b2c1', 'linter', 'unknown', { depth: 3 })],
        }),
      ],
    }),
    node('a2', 'reviewer', 'completed', { model: 'gpt-5.6-sol', effort: 'medium', lastActivityAt: at(-600) }),
    node('a3', 'ghost', 'unknown', {}),
  ]);
}

export function makeHudData(overrides: Partial<HudData> = {}): HudData {
  const base: HudData = {
    config: {
      model: 'gpt-5.6-astra',
      model_reasoning_effort: 'xhigh',
      model_provider: 'openai',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      mcp_servers: {
        alpha: { enabled: true, command: ['node', 'alpha.js'] },
        beta: { enabled: true, url: 'http://localhost:3000' },
      },
    },
    git: {
      branch: 'main',
      isDirty: true,
      isGitRepo: true,
      ahead: 2,
      behind: 0,
      modified: 3,
      added: 1,
      deleted: 0,
      untracked: 2,
    },
    project: {
      cwd: '/home/fires/codex/codex-hud',
      projectName: 'codex-hud',
      agentsMdCount: 1,
      hasCodexDir: true,
      instructionsMdCount: 0,
      rulesCount: 0,
      mcpCount: 2,
      configsCount: 2,
      extensionsCount: 2,
      workMode: 'development',
    },
    sessionStart: at(-1800),
    session: {
      id: 'root-session-id-0123456789',
      rolloutPath: '/home/fires/.codex/sessions/2026/03/01/rollout-root.jsonl',
      startTime: at(-1800),
      cwd: '/home/fires/codex/codex-hud',
      cliVersion: '0.52.0',
      model: 'gpt-5.6-astra',
      reasoningEffort: 'xhigh',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      collaborationMode: 'default',
      modelProvider: 'openai',
    },
    contextUsage: makeContextUsage(42),
    tokenUsage: makeTokenUsage(),
    rateLimits: makeRateLimits(),
    subagents: makeSubagents(),
    subagentTree: makeSubagentTree(),
    toolActivity: makeToolActivity(),
    planProgress: makePlanProgress(),
    displayMode: 'single',
  };
  return { ...base, ...overrides };
}

/** The widths every layout test must survive. */
export const TEST_WIDTHS = [40, 60, 80, 100, 120, 160] as const;
