/**
 * The pictures in the READMEs, drawn from made-up data: a fictional project
 * (parser-kit) with its agents, worktrees and diff, so no real session, path
 * or task reaches a published picture. Run with
 * `node dist-test/tests/fixtures/readme-demo.js <dir>` after
 * `npm run build:test`: it writes each scene as the panel's ANSI rows
 * (`<scene>.ansi`) and prints the status card that docs/reference*.md quote.
 * docs/fig/*.png are these rows drawn cell by cell in MesloLGS NF, in the
 * Catppuccin Mocha colours, as a terminal draws them.
 *
 * The clock is pinned, as in samples.ts, so a scene does not depend on when it
 * was drawn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderMonitor, initialMonitorState, handleMonitorInput, type MonitorData, type MonitorState } from '../../src/render/monitor.js';
import { displayConfig, setDisplayConfig, LOOKS, type LookName } from '../../src/render/hud-config.js';
import { setLanguage, type Language } from '../../src/render/i18n.js';
import { statusCard, sessionState } from '../../src/render/status-block.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { fitModules } from '../../src/render/layout/engine.js';
import { stripAnsi, theme } from '../../src/render/colors.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { GitChangedFile, GitChanges } from '../../src/collectors/git-changes.js';
import type { Recap } from '../../src/collectors/recap.js';
import type { WorktreeInfo, WorktreeStatus, WorktreesSnapshot } from '../../src/collectors/worktrees.js';
import type { AgentTaskKind, HudData, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { makeHudData, makeContextUsage, makeTokenUsage } from './hud-data.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000);
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const TEXT = {
  en: {
    labels: ['Tokenizer benchmark', 'Fix CJK splitting', 'Review the cache', 'Streaming API docs', 'Dependency audit', 'Allocation profile'],
    tasks: ['Benchmark the tokenizer on the 50 MB corpus and report throughput per script',
      'Fix the tokenizer splitting surrogate pairs in CJK text, with regression tests',
      'Review the LRU cache for races under concurrent readers',
      'Document the streaming tokenizer API with examples',
      'Audit the dependencies for known vulnerabilities',
      'Profile allocations in the hot path'],
    reports: ['ASCII 1.8 GB/s, CJK 0.6 GB/s so far', 'Patched next_char; 14 of 16 new tests pass',
      'Two of 48 cache tests time out under 8 readers', 'Added docs/streaming.md with three examples',
      'No vulnerable packages; three are outdated', '82% of allocations come from slice copies'],
    notes: ['The CJK path is the bottleneck', 'Close: two edge cases left', 'A lock is held across await'],
    goal: 'Make the tokenizer twice as fast without breaking CJK text',
    done: ['Streaming API merged', 'Benchmarks set up on the 50 MB corpus', 'Dependency audit clean'],
    now: 'Waiting on the CJK fix and the cache review',
    subjects: ['Add the streaming tokenizer API', 'Fix surrogate pairs split in CJK text', 'Bench: 50 MB corpus'],
  },
  zh: {
    labels: ['分词器基准测试', '修复中日韩切分', '审查缓存并发', '流式接口文档', '依赖安全审计', '分配热点分析'],
    tasks: ['在 50 MB 语料上测分词器吞吐，按文字分别报告',
      '修复中日韩文本中代理对被切开的问题，并补回归测试',
      '审查 LRU 缓存在并发读时的竞态',
      '为流式分词接口写文档和示例',
      '审计依赖中的已知漏洞',
      '分析热路径上的内存分配'],
    reports: ['目前 ASCII 1.8 GB/s，中日韩 0.6 GB/s', '已修补 next_char；新测试 16 个过了 14 个',
      '8 个并发读时 48 个缓存测试有 2 个超时', '已新增 docs/streaming.md，含三个示例',
      '没有存在漏洞的包；三个版本较旧', '82% 的分配来自切片复制'],
    notes: ['瓶颈在中日韩路径', '接近完成，还剩两个边界情况', '有把锁跨 await 持有'],
    goal: '把分词器提速一倍，同时不破坏中日韩文本',
    done: ['流式接口已合并', '基准测试已在 50 MB 语料上搭好', '依赖审计无问题'],
    now: '等待中日韩修复和缓存审查',
    subjects: ['新增流式分词接口', '修复中日韩文本代理对被切开', '基准：50 MB 语料'],
  },
} as const;

const DIFF = ['Unstaged', 'diff --git a/src/tokenizer.ts b/src/tokenizer.ts', 'index 3f2a1c0..9be41d7 100644',
  '--- a/src/tokenizer.ts', '+++ b/src/tokenizer.ts',
  '@@ -88,14 +88,22 @@ export class Tokenizer {',
  '   /** The next character, as a whole code point. */',
  '   private nextChar(): string {',
  '-    const ch = this.text[this.pos];',
  '-    this.pos += 1;',
  '-    return ch;',
  '+    const code = this.text.codePointAt(this.pos);',
  "+    if (code === undefined) return '';",
  '+    // A surrogate pair is one character: never split it between two tokens.',
  '+    const ch = String.fromCodePoint(code);',
  '+    this.pos += ch.length;',
  '+    return ch;',
  '   }',
  '@@ -131,6 +139,9 @@ export class Tokenizer {',
  '   private isWordChar(ch: string): boolean {',
  '-    return /\\w/.test(ch);',
  '+    return /[\\p{L}\\p{N}_]/u.test(ch);',
  '   }'];

interface Demo { tree: SubagentTree; log: Map<string, AgentLogEntry[]>; worktrees: WorktreesSnapshot; git: GitChanges; hud: HudData; recap: Recap }

function demo(lang: Language): Demo {
  const text = TEXT[lang];
  const agent = (i: number, name: string, status: SubagentStatus, kind: AgentTaskKind, extra: Partial<SubagentTreeNode>): SubagentTreeNode => ({
    id: id(i), name, status, depth: 1, children: [], agentPath: `/root/${name}`,
    label: text.labels[i - 1], taskKind: kind, task: text.tasks[i - 1],
    lastReport: { text: text.reports[i - 1], at: at(-40 - i * 7), kind: 'update' },
    startedAt: at(-1500 + i * 60), turnStartedAt: at(-247 - i * 31), lastEventAt: at(-4 - i), ...extra,
  });
  const nodes = [
    agent(1, 'bench_tokenizer', 'running', 'experiment', { model: 'gpt-5.6-astra', effort: 'high', contextUsage: makeContextUsage(41) }),
    agent(2, 'fix_cjk_split', 'running', 'fix', { model: 'gpt-5.6-astra', effort: 'xhigh', contextUsage: makeContextUsage(63) }),
    agent(3, 'review_cache', 'error', 'review', { model: 'gpt-5.6-sol', effort: 'medium', contextUsage: makeContextUsage(38), statusAt: at(-95) }),
    agent(4, 'streaming_docs', 'completed', 'writing', { model: 'gpt-5.6-sol', effort: 'low', contextUsage: makeContextUsage(22), statusAt: at(-35) }),
    agent(5, 'audit_deps', 'completed', 'research', { model: 'gpt-5.6-luna', effort: 'low', contextUsage: makeContextUsage(17), statusAt: at(-140) }),
    agent(6, 'profile_alloc', 'completed', 'research', { model: 'gpt-5.6-astra', effort: 'medium', contextUsage: makeContextUsage(57), statusAt: at(-170) }),
  ];
  const tree: SubagentTree = { rootId: id(99), nodes, totalCount: nodes.length, updatedAt: new Date(NOW) };
  const log = new Map(nodes.map((node, i): [string, AgentLogEntry[]] => [node.id, [
    { at: node.startedAt!.getTime(), kind: 'started', text: '' },
    { at: node.lastReport!.at.getTime(), kind: 'report', text: node.lastReport!.text },
    ...(text.notes[i] ? [{ at: NOW - 20_000, kind: 'note' as const, text: text.notes[i] }] : []),
    ...(node.status === 'completed' ? [{ at: node.statusAt!.getTime(), kind: 'finished' as const, text: '' }] : []),
    ...(node.status === 'error' ? [{ at: node.statusAt!.getTime(), kind: 'failed' as const, text: '' }] : []),
  ]]));
  const worktree = (dir: string, branch: string, subject: string, status: Omit<WorktreeStatus, 'branch' | 'ahead' | 'behind' | 'conflicts'>): WorktreeInfo =>
    ({ path: dir, branch, bare: false, detached: false, observedAt: NOW, subject, status: { branch, ahead: 0, behind: 0, conflicts: 0, ...status } });
  const worktrees: WorktreesSnapshot = { sourcePath: '/work/parser-kit', updatedAt: NOW, entries: [
    worktree('/work/parser-kit', 'main', text.subjects[0], { changed: 4, staged: 0, unstaged: 2, untracked: 2 }),
    worktree('/work/parser-kit-fix-cjk', 'fix-cjk', text.subjects[1], { changed: 2, staged: 1, unstaged: 1, untracked: 0 }),
    worktree('/work/parser-kit-bench', 'bench', text.subjects[2], { changed: 0, staged: 0, unstaged: 0, untracked: 0 }),
  ] };
  const file = (filePath: string, index: string, worktreeStatus: string, added: number | null, removed: number | null): GitChangedFile =>
    ({ path: filePath, index, worktree: worktreeStatus, added, removed, binary: false, conflict: false });
  const git: GitChanges = { root: '/work/parser-kit', branch: 'main', ahead: 2, behind: 0, files: [
    file('src/tokenizer.ts', '.', 'M', 24, 8), file('src/cache.ts', '.', 'M', 3, 1),
    file('tests/cjk-split.test.ts', '?', '?', null, null), file('bench/corpus/', '?', '?', null, null),
  ] };
  const base = makeHudData();
  const started = at(-2 * 3600 - 840);
  const hud = makeHudData({
    project: { ...base.project, cwd: '/work/parser-kit', projectName: 'parser-kit' },
    git: { branch: 'main', isDirty: true, isGitRepo: true, ahead: 2, behind: 0, modified: 2, added: 0, deleted: 0, untracked: 2 },
    session: { ...base.session!, id: id(99), cwd: '/work/parser-kit', rolloutPath: '/work/rollout.jsonl', startTime: started },
    sessionStart: started,
    activity: { state: 'working', updatedAt: at(-2), turnStartedAt: at(-201) },
    tokenUsageAt: at(-6),
    contextUsage: makeContextUsage(56), tokenUsage: makeTokenUsage(246000, 272000),
    rateLimits: { plan_type: 'pro',
      primary: { used_percent: 34, window_minutes: 300, resets_at: Math.floor((NOW + 9_000_000) / 1000) },
      secondary: { used_percent: 61, window_minutes: 10080, resets_at: Math.floor((NOW + 300_000_000) / 1000) } },
    toolActivity: { totalCalls: 41, callsByType: { Read: 18, Bash: 15, Edit: 8 }, lastUpdateTime: at(-12), recentCalls: [
      { id: 'c1', name: 'Read', timestamp: at(-90), status: 'completed', duration: 120, target: 'src/tokenizer.ts' },
      { id: 'c2', name: 'Bash', timestamp: at(-60), status: 'completed', duration: 4200, target: 'npm test' },
      { id: 'c3', name: 'Edit', timestamp: at(-12), status: 'running', target: 'src/tokenizer.ts' }] },
    subagents: nodes.map(node => ({ id: node.id, name: node.name, status: node.status, startedAt: node.startedAt!,
      model: node.model, effort: node.effort, lastActivityAt: node.lastEventAt })),
    subagentTree: tree,
  });
  const recap: Recap = { goal: text.goal, done: [...text.done], now: text.now, needs: '', at: NOW - 180_000, coveredUntil: NOW,
    sessionId: id(99), language: lang };
  return { tree, log, worktrees, git, hud, recap };
}

const ICONS: Record<LookName, 'unicode' | 'emoji' | 'nerd'> = { tab: 'unicode', band: 'unicode', tile: 'emoji', frame: 'unicode', pill: 'nerd' };

/** The panel at `width`×`height`: the agents and the worktrees, or a file's diff in the Inspector. */
function panel(lang: Language, look: LookName, width: number, height: number, scene: 'agents' | 'diff'): string[] {
  setLanguage(lang);
  setDisplayConfig({ theme: 'terminal', glyphs: 'glyph', density: 'balanced', motion: 'reduced', look, icons: ICONS[look] });
  const d = demo(lang);
  const input: Omit<MonitorData, 'state'> = { tree: d.tree, worktrees: d.worktrees, git: d.git, nowMs: NOW, width, height, agentLog: d.log,
    brief: { recap: d.recap, structured: true, text: '{}', at: d.recap.at }, prefix: 'Ctrl+]',
    status: nowMs => statusCard(d.hud, nowMs), session: nowMs => sessionState(d.hud, nowMs) };
  const first: MonitorState = { ...initialMonitorState(), style: 'rich', statusLevel: 'full', labelAsName: true };
  if (scene === 'agents') {
    const state = { ...first, modes: { ...first.modes, worktrees: 'open' as const } };
    return renderMonitor({ ...input, state: renderMonitor({ ...input, state }).state }).lines;
  }
  const changes = { ...first, modes: { ...first.modes, changes: 'open' as const }, focus: 'changes' as const, selectedFile: 'src/tokenizer.ts' };
  const frame = renderMonitor({ ...input, state: changes });
  const inspected = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { tree: d.tree, git: d.git, worktrees: d.worktrees, frame }).state;
  return renderMonitor({ ...input, state: renderMonitor({ ...input, state: inspected, diff: DIFF }).state, diff: DIFF }).lines;
}

/** The status bar, working; `alert` keeps the failed agent that takes the front of the line. */
function bar(width: number, alert: boolean): string {
  setLanguage('en');
  setDisplayConfig({ theme: 'terminal', glyphs: 'both', density: 'balanced', motion: 'reduced' });
  const { hud } = demo('en');
  const calm = (status: SubagentStatus): SubagentStatus => status === 'error' ? 'running' : status;
  const shown = alert ? hud : { ...hud, subagents: hud.subagents!.map(a => ({ ...a, status: calm(a.status) })),
    subagentTree: { ...hud.subagentTree!, nodes: hud.subagentTree!.nodes.map(n => ({ ...n, status: calm(n.status) })) } };
  return fitModules(buildBarModules(shown, { nowMs: NOW, barWidth: 10 }), { width, separator: theme.separator(' │ '), groupSeparator: '  ' }).line;
}

/** The status card the reference quotes: an idle session at max effort, five days old, its weekly window nearly spent. */
function card(lang: Language, width: number): string[] {
  setLanguage(lang);
  setDisplayConfig({ theme: 'terminal', glyphs: 'glyph', density: 'balanced', motion: 'reduced', look: 'tab', icons: 'unicode' });
  const d = demo(lang);
  const started = at(-5 * 86400 - 3600);
  const hud: HudData = { ...d.hud, activity: { state: 'idle', updatedAt: at(-60) }, toolActivity: undefined, sessionStart: started,
    session: { ...d.hud.session!, model: 'gpt-5.6-sol', reasoningEffort: 'max', startTime: started },
    config: { ...d.hud.config, model: 'gpt-5.6-sol', model_reasoning_effort: 'max' },
    subagents: [], subagentTree: { ...d.tree, nodes: [] },
    rateLimits: { plan_type: 'pro', secondary: { used_percent: 99, window_minutes: 10080, resets_at: Math.floor((NOW + 114 * 3_600_000) / 1000) } } };
  const recap = { ...d.recap, done: [...TEXT[lang].done, TEXT[lang].subjects[0]] };
  const frame = renderMonitor({ tree: { ...d.tree, nodes: [] }, worktrees: d.worktrees, nowMs: NOW, width, height: 40,
    brief: { recap, structured: true, text: '{}', at: recap.at }, status: nowMs => statusCard(hud, nowMs), session: nowMs => sessionState(hud, nowMs),
    state: { ...initialMonitorState(), style: 'rich', statusLevel: 'full' } });
  const { y, height } = frame.statusCard!;
  return frame.lines.slice(y, y + height).map(line => stripAnsi(line).trimEnd());
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node dist-test/tests/fixtures/readme-demo.js <dir>');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const write = (name: string, lines: string[]) => fs.writeFileSync(path.join(out, `${name}.ansi`), `${lines.join('\n')}\n`);
const previous = displayConfig();
const previousLanguage = setLanguage('en');
try {
  for (const lang of ['en', 'zh'] as const) {
    for (const look of LOOKS) write(`agents-${lang}-${look}`, panel(lang, look, 46, 50, 'agents'));
    write(`diff-${lang}`, panel(lang, 'tab', 46, 50, 'diff'));
    console.log(`--- status card, ${lang}\n${card(lang, 66).join('\n')}`);
  }
  write('bar-120', [bar(120, false)]);
  write('bar-120-alert', [bar(120, true)]);
} finally {
  setDisplayConfig(previous);
  setLanguage(previousLanguage);
}
