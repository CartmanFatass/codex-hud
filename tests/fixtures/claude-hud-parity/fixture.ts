import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export const NOW = Date.parse('2026-01-02T12:00:00Z');
export const OWNER_CONFIG = {
  lineLayout: 'compact',
  showSeparators: false,
  display: {
    showTools: false,
    showAgents: true,
    showTodos: true,
    showDuration: true,
    showConfigCounts: true,
    showSkills: true,
    showEffortLevel: true,
  },
  gitStatus: { enabled: true, showDirty: true, showAheadBehind: true, showFileStats: false },
};
export const SCENARIOS = [
  'idle',
  'agents-todos',
  'dirty-git',
  'config-skills',
  'narrow',
  'sparse',
  'quota-critical',
  'completed',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export function parityFixture(home: string, scenario: Scenario) {
  const cwd = join(home, 'project'),
    claude = join(home, '.claude'),
    hud = join(home, 'hud'),
    file = join(home, 'transcript.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(hud, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HUD_HOME: hud,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: claude,
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Synthetic',
        GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic',
        GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-02T11:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-02T11:00:00Z',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  const records: object[] = [
    { type: 'user', timestamp: '2026-01-02T11:56:00Z', message: { content: 'Synthetic session' } },
  ];
  const tool = (name: string, id: string, input: object) =>
    records.push({
      type: 'assistant',
      timestamp: '2026-01-02T11:59:30Z',
      message: { content: [{ type: 'tool_use', name, id, input }] },
    });
  if (scenario === 'agents-todos' || scenario === 'narrow' || scenario === 'completed') {
    tool('Agent', 'agent-one', {
      subagent_type: 'Explore',
      model: 'claude-haiku-4-5-20251001',
      description: 'Inspect synthetic files',
    });
    tool('TodoWrite', 'todo-one', {
      todos: [
        { content: 'Read fixtures', status: 'completed' },
        { content: 'Implement synthetic feature', status: 'in_progress' },
      ],
    });
    if (scenario === 'completed') {
      records.push({
        type: 'user',
        timestamp: '2026-01-02T11:59:50Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'agent-one', content: 'Done' }] },
        toolUseResult: { resolvedModel: 'claude-sonnet-4-5-20250929' },
      });
      tool('TodoWrite', 'todo-two', {
        todos: [
          { content: 'Read fixtures', status: 'completed' },
          { content: 'Implement synthetic feature', status: 'completed' },
        ],
      });
    }
  }
  if (scenario === 'config-skills') {
    fs.writeFileSync(join(claude, 'CLAUDE.md'), '# Synthetic user instructions\n');
    fs.mkdirSync(join(claude, 'rules'));
    fs.writeFileSync(join(claude, 'rules', 'one.md'), 'Rule');
    fs.writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ mcpServers: { shared: {} }, hooks: { SessionStart: [], Stop: [] } })
    );
    fs.writeFileSync(
      claude + '.json',
      JSON.stringify({ mcpServers: { shared: {}, disabled: {} }, disabledMcpServers: ['disabled'] })
    );
    fs.mkdirSync(join(cwd, '.claude', 'rules', 'nested'), { recursive: true });
    fs.writeFileSync(join(cwd, 'CLAUDE.md'), '# Project');
    fs.writeFileSync(join(cwd, 'CLAUDE.local.md'), 'Local');
    fs.writeFileSync(join(cwd, '.claude', 'rules', 'nested', 'two.md'), 'Rule');
    fs.writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { shared: {} }, hooks: { PreToolUse: [] } })
    );
    fs.writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { extra: {}, disabled: {} } }));
    fs.writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ disabledMcpjsonServers: ['disabled'], hooks: { Stop: [] } })
    );
    for (const [i, skill] of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'alpha'].entries())
      tool('Skill', 'skill-' + i, { skill });
  }
  if (scenario === 'dirty-git') {
    git(['init', '-b', 'main']);
    fs.writeFileSync(join(cwd, 'base'), 'base');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    git(['checkout', '-b', 'upstream']);
    fs.writeFileSync(join(cwd, 'upstream'), 'upstream');
    git(['add', '.']);
    git(['commit', '-m', 'upstream']);
    git(['checkout', 'main']);
    fs.writeFileSync(join(cwd, 'local'), 'local');
    git(['add', '.']);
    git(['commit', '-m', 'local']);
    git(['branch', '--set-upstream-to=upstream']);
    fs.writeFileSync(join(cwd, 'base'), 'dirty');
    fs.writeFileSync(join(cwd, 'untracked'), 'untracked');
  }
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(join(hud, 'config.json'), JSON.stringify({ unrelated: 'keep', statusline: OWNER_CONFIG }), {
    mode: 0o600,
  });
  const input: Record<string, unknown> =
    scenario === 'sparse'
      ? {}
      : {
          cwd,
          transcript_path: file,
          model: { display_name: 'Opus 4.5', id: 'claude-opus-4-5' },
          effort: { level: 'high' },
          context_window: { used_percentage: 42, context_window_size: 200000 },
        };
  if (scenario === 'quota-critical') {
    input.context_window = {
      used_percentage: 92,
      context_window_size: 200000,
      current_usage: { input_tokens: 2000, cache_read_input_tokens: 180000 },
    };
    input.rate_limits = {
      five_hour: { used_percentage: 35, resets_at: (NOW + 90 * 60000) / 1000 },
      seven_day: { used_percentage: 88, resets_at: (NOW + 2 * 86400000) / 1000 },
      model_scoped: [{ display_name: 'Fable', utilization: 50, resets_at: new Date(NOW + 3600000).toISOString() }],
    };
  }
  return { home, cwd, claude, hud, file, env, input, width: scenario === 'narrow' ? 36 : 120, git };
}
