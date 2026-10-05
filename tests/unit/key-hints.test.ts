import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, renderMonitor, type MonitorData, type MonitorState } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorktreesSnapshot } from '../../src/collectors/worktrees.js';
import type { GitChanges } from '../../src/collectors/git-changes.js';
import type { WorkbenchEvent } from '../../src/render/workbench-state.js';

/**
 * Outside the settings page and the help, nothing on screen tells the reader
 * to press a key, and no line only says that something is empty, done, clean
 * or still loading: the bar's buttons, the counts and the status card say it.
 */
const KEY_HINT =
  /按\s*\S|\bpress\b|\b(Esc|Enter|Tab|Space|PgUp|PgDn|Ctrl\+|Shift\+|F12)\b|(^|\s)[a-z,?] (shows?|back|pause|toggles?|opens?|to)\b|; [a-z]\b/i;
const PLACEHOLDER = new RegExp(
  [
    'All finished',
    '全部已完成',
    'No subagents',
    '还没有 subagent',
    'No matching agents',
    '没有匹配',
    'Reading session',
    'Reading worktrees',
    'Reading selected',
    'Reading diff',
    '正在读取',
    'No events yet',
    '还没有事件',
    'Working tree clean',
    '工作树干净',
    'No worktrees recorded',
    '没有工作树记录',
    'No selected (worktree|file)',
    '未选择',
    'Select an? (agent|worktree)',
    '选择一个',
    'Status unknown',
    '状态未知',
  ].join('|')
);

const now = Date.parse('2026-10-04T10:00:00Z');
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const node = (
  i: number,
  name: string,
  status: SubagentTreeNode['status'],
  extra: Partial<SubagentTreeNode> = {}
): SubagentTreeNode => ({
  id: id(i),
  name,
  status,
  depth: 1,
  children: [],
  startedAt: new Date(now - 3_600_000),
  turnStartedAt: new Date(now - 600_000),
  lastEventAt: new Date(now - 5000),
  task: `Task for ${name}`,
  ...extra,
});
const live: SubagentTree = {
  rootId: 'root',
  nodes: [
    node(1, 'reader', 'running'),
    node(2, 'writer', 'error', { statusAt: new Date(now - 60_000) }),
    node(3, 'auditor', 'completed', { statusAt: new Date(now - 30_000) }),
  ],
  totalCount: 3,
  updatedAt: new Date(now),
};
/** Every agent finished long ago: the linger window put them all away. */
const finished: SubagentTree = {
  rootId: 'root',
  nodes: [4, 5].map((i) => node(i, `old_${i}`, 'completed', { statusAt: new Date(now - 6 * 3_600_000) })),
  totalCount: 2,
  updatedAt: new Date(now),
};
const empty: SubagentTree = { rootId: 'root', nodes: [], totalCount: 0, updatedAt: new Date(now) };
const worktrees: WorktreesSnapshot = {
  sourcePath: '/repo',
  updatedAt: now,
  entries: [
    {
      path: '/repo',
      branch: 'main',
      bare: false,
      detached: false,
      observedAt: now,
      status: { changed: 3, staged: 1, unstaged: 1, untracked: 1, conflicts: 0, branch: 'main', ahead: 0, behind: 0 },
    },
    {
      path: '/repo/.git/launch/912d078ebb934b7b8d1a2cd31cc06082',
      branch: null,
      bare: false,
      detached: true,
      locked: '',
      observedAt: now,
      status: {
        changed: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        branch: null,
        ahead: null,
        behind: null,
      },
    },
  ],
};
const file = (path: string, index: string, worktree: string) => ({
  path,
  index,
  worktree,
  added: 1,
  removed: 0,
  binary: false,
  conflict: false,
});
const git: GitChanges = {
  root: '/repo',
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [file('src/a.ts', 'M', '.'), file('docs/b.md', '.', 'M'), file('new.txt', '?', '?')],
};
const clean: GitChanges = { root: '/repo', branch: 'main', ahead: 0, behind: 0, files: [] };
const event = (i: number, kind: WorkbenchEvent['kind'], extra: Partial<WorkbenchEvent> = {}): WorkbenchEvent => ({
  id: String(i),
  at: new Date(now - i * 60_000),
  title: '',
  detail: [],
  status: 'completed',
  kind,
  ...extra,
});
const timeline: WorkbenchEvent[] = [
  event(1, 'turn-finished'),
  event(2, 'turn-finished'),
  event(3, 'tool-failed', { status: 'error', subject: 'exec' }),
  event(4, 'agent-finished', { subject: 'auditor', agentId: id(3) }),
  event(9, 'agent-started', { subject: 'auditor', agentId: id(3) }),
  event(10, 'agent-started', { subject: 'reader', agentId: id(1) }),
  event(11, 'approval-requested', { subject: 'rm -rf build' }),
  event(12, 'compacted'),
  event(13, 'quota', { threshold: 80, windowMinutes: 300 }),
];
const status: MonitorData['status'] = () => ({
  tone: 'needs',
  busy: true,
  alerts: ['! 1 agent failed'],
  state: '▸ exec · 33m51s',
  rate: '',
  tasks: '',
  model: '☀',
  age: '2h',
  context: { percent: 61, tail: '246K' },
  place: 'proj · main',
  project: 'proj',
  branch: '· main',
  quota: { percent: 20, window: '7d', spent: '', text: '7d 20%' },
  others: '',
  forecast: '',
  reset: '',
  cache: '',
});
const everyPane = (extra: Partial<MonitorState>): MonitorState => ({
  ...initialMonitorState(),
  modes: { agents: 'open', worktrees: 'open', changes: 'open', details: 'open', timeline: 'open' },
  ...extra,
});

test('no key hints and no placeholder lines in any pane, on the bar or on the status card', () => {
  const previous = setDisplayConfig({});
  try {
    for (const lang of ['en', 'zh'] as const) {
      setLanguage(lang);
      for (const theme of ['terminal', 'none'] as const) {
        for (const [glyphs, icons] of [
          ['both', 'nerd'],
          ['both', 'text'],
          ['text', 'text'],
        ] as const) {
          {
            setDisplayConfig({ theme, glyphs, icons });
            for (const style of ['rich', 'compact'] as const) {
              for (const [name, tree] of [
                ['live', live],
                ['finished', finished],
                ['empty', empty],
              ] as const) {
                for (const showAll of [false, true]) {
                  for (const [preview, statusLevel] of [
                    ['agent', 'full'],
                    ['worktree', 'status'],
                    ['file', 'min'],
                  ] as const) {
                    {
                      const state = everyPane({
                        style,
                        preview,
                        statusLevel,
                        focus: 'details',
                        tree: { ...initialMonitorState().tree, showAll, lingerMs: 180_000 },
                      });
                      for (const width of [32, 36, 56]) {
                        for (const [paused, changes] of [
                          [false, git],
                          [true, clean],
                        ] as const) {
                          const frame = renderMonitor({
                            tree,
                            state,
                            width,
                            height: 60,
                            nowMs: now,
                            git: changes,
                            worktrees,
                            diff: ['@@ -1 +1 @@', '-old', '+new'],
                            timeline: tree === live ? timeline : [],
                            status,
                            session: () => ({ text: '▸ 33m51s', attention: false }),
                            brief: { text: 'the brief says this', at: now - 60_000, paused },
                          });
                          const text = frame.lines.map(stripAnsi).join('\n');
                          const where = `${lang} ${theme} ${glyphs} ${icons} ${style} ${name} ${showAll} ${preview} ${statusLevel} ${width} ${paused}`;
                          assert.doesNotMatch(text, KEY_HINT, `${where}\n${text}`);
                          assert.doesNotMatch(text, PLACEHOLDER, `${where}\n${text}`);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } finally {
    setLanguage('en');
    setDisplayConfig(previous);
  }
});

test('with every agent put away, the agents area is empty: no line says so', () => {
  for (const lang of ['en', 'zh'] as const) {
    setLanguage(lang);
    try {
      for (const style of ['rich', 'compact'] as const) {
        const state = { ...initialMonitorState(), style, tree: { ...initialMonitorState().tree, lingerMs: 180_000 } };
        const frame = renderMonitor({ tree: finished, state, width: 36, height: 20, nowMs: now });
        const agents = frame.panes.find((p) => p.id === 'agents')!;
        const rows = frame.lines.slice(agents.y, agents.y + agents.height).map(stripAnsi);
        assert.ok(
          rows.slice(1).every((row) => row.trim() === ''),
          `${lang} ${style}:\n${rows.join('\n')}`
        );
      }
    } finally {
      setLanguage('en');
    }
  }
});
