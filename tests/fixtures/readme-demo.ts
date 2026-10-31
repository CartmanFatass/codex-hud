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
import { TIMELINE_STYLES, type TimelineStyle } from '../../src/render/monitor-timeline.js';
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
import type { AgentStage, AgentTaskKind, HudData, SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorkbenchEvent } from '../../src/render/workbench-state.js';
import type { RolloutParseResult } from '../../src/collectors/rollout.js';
import { WorkbenchHistory } from '../../src/collectors/workbench-events.js';
import { makeHudData, makeContextUsage, makeTokenUsage } from './hud-data.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000);
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** One agent of the demo: its text in a language, and when things happened, in seconds from NOW. */
interface Spec {
  name: string; role?: string; kind?: AgentTaskKind; label?: string; task: string; report?: string; note?: string;
  status: SubagentStatus; start: number; end?: number;
  /** Its stages: start, end (none while running) and what it returned or, running, said it would do. */
  stages?: Array<{ start: number; end?: number; status?: 'done' | 'failed'; said?: string; by?: string }>;
  action?: string; cause?: string; peers?: Record<string, number>; kids?: Spec[];
}

/**
 * Two directions at work, each an L1 lead with its subtasks; a helper L1
 * advising one of them; a review that just failed; and three one-off L1s
 * that finished. The critics' role is the one the demo names as mattering.
 */
const TEXT = {
  en: {
    agents: (): Spec[] => [
      { name: 'tokenizer_speed', role: 'team-lead', kind: 'experiment', label: 'Tokenizer speed', status: 'running', start: -10800,
        task: 'Make the tokenizer twice as fast on the 50 MB corpus, a stage at a time, each result reviewed',
        report: 'Surrogate-pair tests in; re-running the benchmark', note: 'B03 is down to the surrogate-pair tests',
        action: 'npm run bench -- --corpus 50mb', peers: { '/root/perf_advisor': 2 },
        stages: [
          { start: -10700, end: -8400, said: 'B01: the SIMD scan takes ASCII from 1.8 to 3.1 GB/s; CJK is unchanged, next_char is the bottleneck', by: '/root' },
          { start: -8100, end: -4800, said: 'B02: a lookup table takes CJK from 0.6 to 1.4 GB/s; the critic passed it on condition of surrogate-pair tests', by: '/root' },
          { start: -4500, said: 'Adding the surrogate-pair tests, then the benchmark on every script', by: '/root' }],
        kids: [
          { name: 'b01_impl_simd', role: 'team-implementer', task: 'Implement the SIMD scan', status: 'completed', start: -10500, end: -9300, stages: [{ start: -10500, end: -9300, said: 'SIMD scan and its benchmark in; all tests pass' }] },
          { name: 'b01_review', role: 'team-reviewer', task: 'Review the SIMD scan', status: 'completed', start: -9200, end: -8700, stages: [{ start: -9200, end: -8700, said: 'No blocking issues' }] },
          { name: 'b02_impl_cjk_table', role: 'team-implementer', task: 'Put the CJK classes in a lookup table', status: 'completed', start: -7900, end: -6000, stages: [{ start: -7900, end: -6000, said: 'Lookup table in, with 12 new tests' }] },
          { name: 'b02_result_critic', role: 'team-critic', task: 'Judge the B02 result', status: 'completed', start: -5900, end: -5000, stages: [{ start: -5900, end: -5000, said: 'Passes once surrogate-pair edge cases have tests' }] },
          { name: 'b03_bench_scout', role: 'team-scout', task: 'Find corpus files with surrogate pairs', status: 'completed', start: -4400, end: -3500, stages: [{ start: -4400, end: -3500, said: 'Four corpus files hold surrogate pairs' }] },
          { name: 'b03_review_harness', role: 'team-reviewer', task: 'Review the benchmark harness', status: 'error', start: -3300, end: -2400, stages: [{ start: -3300, end: -2400, status: 'failed' }],
            cause: 'The review harness timed out on the 50 MB corpus' },
          { name: 'b03_impl_surrogate', role: 'team-implementer', task: 'Keep surrogate pairs whole', status: 'running', start: -1500, report: 'Surrogate split fixed; adding edge tests', stages: [{ start: -1500 }] }] },
      { name: 'fix_cjk_split', role: 'team-lead', kind: 'fix', label: 'CJK correctness', status: 'running', start: -10300,
        task: 'Fix the tokenizer splitting surrogate pairs in CJK text, with regression tests',
        report: 'Three vertical samples in; looking for Japanese ones', note: 'Close: vertical punctuation left', action: 'rg -n vertical corpus/',
        stages: [
          { start: -10200, end: -6600, said: 'Split fix merged: 16 of 16 regression tests pass; vertical punctuation is not covered yet', by: '/root' },
          { start: -3000, said: 'Collecting vertical text for the punctuation cases', by: '/root' }],
        kids: [
          { name: 'impl_split_fix', role: 'team-implementer', task: 'Fix the split', status: 'completed', start: -9800, end: -7800, stages: [{ start: -9800, end: -7800, said: '16 new tests pass' }] },
          { name: 'review_split_fix', role: 'team-reviewer', task: 'Review the split fix', status: 'completed', start: -7700, end: -7000, stages: [{ start: -7700, end: -7000, said: 'No blocking issues' }] },
          { name: 'vertical_scout', role: 'team-scout', task: 'Find vertical CJK text', status: 'running', start: -2400, report: 'Three vertical samples so far', stages: [{ start: -2400 }] }] },
      { name: 'review_cache', role: 'team-reviewer', kind: 'review', label: 'Review the cache', status: 'error', start: -1100, end: -95,
        task: 'Review the LRU cache for races under concurrent readers', report: 'Two of 48 cache tests time out under 8 readers',
        note: 'A lock is held across await', stages: [{ start: -1100, end: -95, status: 'failed', by: '/root' }] },
      { name: 'perf_advisor', role: 'team-advisor', kind: 'research', label: 'Performance advice', status: 'running', start: -6000,
        task: 'Advise the tokenizer work on where the time goes', report: 'The code-point classes fit in the L1 cache',
        peers: { '/root/tokenizer_speed': 3 },
        stages: [
          { start: -6000, end: -4300, said: 'Next: cache the code-point classes; expect about 20% more', by: '/root/tokenizer_speed' },
          { start: -1800, said: 'Checking whether the lookup table stays in the L1 cache', by: '/root/tokenizer_speed' }] },
      { name: 'streaming_docs', kind: 'writing', label: 'Streaming API docs', status: 'completed', start: -1500, end: -35,
        task: 'Document the streaming tokenizer API with examples', report: 'Added docs/streaming.md with three examples',
        stages: [{ start: -1400, end: -35, said: 'Added docs/streaming.md with three examples', by: '/root' }] },
      { name: 'audit_deps', kind: 'research', label: 'Dependency audit', status: 'completed', start: -2000, end: -140,
        task: 'Audit the dependencies for known vulnerabilities', report: 'No vulnerable packages; three are outdated',
        stages: [{ start: -1900, end: -140, said: 'No vulnerable packages; three are outdated', by: '/root' }] },
      { name: 'profile_alloc', kind: 'research', label: 'Allocation profile', status: 'completed', start: -2600, end: -170,
        task: 'Profile allocations in the hot path', report: '82% of allocations come from slice copies',
        stages: [{ start: -2500, end: -170, said: '82% of allocations come from slice copies', by: '/root' }] },
      { name: 'setup_bench', kind: 'experiment', label: 'Benchmark setup', status: 'completed', start: -10600, end: -9000,
        task: 'Set up the benchmark on the 50 MB corpus', report: 'Benchmark runs in 40 s per script',
        stages: [{ start: -10600, end: -9000, said: 'Benchmark runs in 40 s per script', by: '/root' }] },
    ],
    turns: [[-10320, 'Three directions out: tokenizer speed, CJK correctness and the cache review; the audit runs on its own'],
      [-4700, 'B02 checked: tokenizer speed goes on to B03, with the critic\'s condition'],
      [-1680, 'CJK stage 1 is merged; vertical punctuation is its second stage']] as Array<[number, string]>,
    goal: 'Make the tokenizer twice as fast without breaking CJK text',
    done: ['Streaming API merged', 'Benchmarks set up on the 50 MB corpus', 'Dependency audit clean'],
    now: 'Waiting on the CJK fix and the cache review',
    subjects: ['Add the streaming tokenizer API', 'Fix surrogate pairs split in CJK text', 'Bench: 50 MB corpus'],
  },
  zh: {
    agents: (): Spec[] => [
      { name: 'tokenizer_speed', role: 'team-lead', kind: 'experiment', label: '分词器提速', status: 'running', start: -10800,
        task: '在 50 MB 语料上把分词器提速一倍，分阶段推进，每阶段的结果都经过评审',
        report: '代理对测试已补上，正在重跑基准', note: 'B03 只剩代理对测试', action: 'npm run bench -- --corpus 50mb', peers: { '/root/perf_advisor': 2 },
        stages: [
          { start: -10700, end: -8400, said: 'B01：SIMD 扫描把 ASCII 从 1.8 提到 3.1 GB/s；中日韩没变，瓶颈在 next_char', by: '/root' },
          { start: -8100, end: -4800, said: 'B02：查表把中日韩从 0.6 提到 1.4 GB/s；评审有条件通过，要求补代理对测试', by: '/root' },
          { start: -4500, said: '先补代理对测试，再对所有文字跑基准', by: '/root' }],
        kids: [
          { name: 'b01_impl_simd', role: 'team-implementer', task: '实现 SIMD 扫描', status: 'completed', start: -10500, end: -9300, stages: [{ start: -10500, end: -9300, said: 'SIMD 扫描和基准已合入，测试全过' }] },
          { name: 'b01_review', role: 'team-reviewer', task: '评审 SIMD 扫描', status: 'completed', start: -9200, end: -8700, stages: [{ start: -9200, end: -8700, said: '无阻塞问题' }] },
          { name: 'b02_impl_cjk_table', role: 'team-implementer', task: '把中日韩字符类改成查表', status: 'completed', start: -7900, end: -6000, stages: [{ start: -7900, end: -6000, said: '查表已实现，新增 12 个测试' }] },
          { name: 'b02_result_critic', role: 'team-critic', task: '评判 B02 的结果', status: 'completed', start: -5900, end: -5000, stages: [{ start: -5900, end: -5000, said: '补上代理对边界测试即可通过' }] },
          { name: 'b03_bench_scout', role: 'team-scout', task: '找含代理对的语料', status: 'completed', start: -4400, end: -3500, stages: [{ start: -4400, end: -3500, said: '有 4 个语料文件含代理对' }] },
          { name: 'b03_review_harness', role: 'team-reviewer', task: '评审基准脚本', status: 'error', start: -3300, end: -2400, stages: [{ start: -3300, end: -2400, status: 'failed' }],
            cause: '评审脚本在 50 MB 语料上超时' },
          { name: 'b03_impl_surrogate', role: 'team-implementer', task: '保持代理对完整', status: 'running', start: -1500, report: '代理对切分已修，正在补边界测试', stages: [{ start: -1500 }] }] },
      { name: 'fix_cjk_split', role: 'team-lead', kind: 'fix', label: '中日韩正确性', status: 'running', start: -10300,
        task: '修复中日韩文本中代理对被切开的问题，并补回归测试',
        report: '已收集 3 份竖排样本，还在找日文的', note: '接近完成，只剩竖排标点', action: 'rg -n vertical corpus/',
        stages: [
          { start: -10200, end: -6600, said: '切分修复已合入：16 个回归测试全过；竖排标点还没覆盖', by: '/root' },
          { start: -3000, said: '收集竖排文本，覆盖标点情况', by: '/root' }],
        kids: [
          { name: 'impl_split_fix', role: 'team-implementer', task: '修复切分', status: 'completed', start: -9800, end: -7800, stages: [{ start: -9800, end: -7800, said: '16 个新测试全过' }] },
          { name: 'review_split_fix', role: 'team-reviewer', task: '评审切分修复', status: 'completed', start: -7700, end: -7000, stages: [{ start: -7700, end: -7000, said: '无阻塞问题' }] },
          { name: 'vertical_scout', role: 'team-scout', task: '找竖排中日韩文本', status: 'running', start: -2400, report: '目前有 3 份竖排样本', stages: [{ start: -2400 }] }] },
      { name: 'review_cache', role: 'team-reviewer', kind: 'review', label: '审查缓存并发', status: 'error', start: -1100, end: -95,
        task: '审查 LRU 缓存在并发读时的竞态', report: '8 个并发读时 48 个缓存测试有 2 个超时',
        note: '有把锁跨 await 持有', stages: [{ start: -1100, end: -95, status: 'failed', by: '/root' }] },
      { name: 'perf_advisor', role: 'team-advisor', kind: 'research', label: '性能顾问', status: 'running', start: -6000,
        task: '为分词器提速指出时间花在哪里', report: '码点类别表放得进 L1 缓存', peers: { '/root/tokenizer_speed': 3 },
        stages: [
          { start: -6000, end: -4300, said: '下一步：缓存码点类别，预计再快约 20%', by: '/root/tokenizer_speed' },
          { start: -1800, said: '核对查表是否一直留在 L1 缓存里', by: '/root/tokenizer_speed' }] },
      { name: 'streaming_docs', kind: 'writing', label: '流式接口文档', status: 'completed', start: -1500, end: -35,
        task: '为流式分词接口写文档和示例', report: '已新增 docs/streaming.md，含三个示例',
        stages: [{ start: -1400, end: -35, said: '已新增 docs/streaming.md，含三个示例', by: '/root' }] },
      { name: 'audit_deps', kind: 'research', label: '依赖安全审计', status: 'completed', start: -2000, end: -140,
        task: '审计依赖中的已知漏洞', report: '没有存在漏洞的包；三个版本较旧',
        stages: [{ start: -1900, end: -140, said: '没有存在漏洞的包；三个版本较旧', by: '/root' }] },
      { name: 'profile_alloc', kind: 'research', label: '分配热点分析', status: 'completed', start: -2600, end: -170,
        task: '分析热路径上的内存分配', report: '82% 的分配来自切片复制',
        stages: [{ start: -2500, end: -170, said: '82% 的分配来自切片复制', by: '/root' }] },
      { name: 'setup_bench', kind: 'experiment', label: '搭建基准测试', status: 'completed', start: -10600, end: -9000,
        task: '在 50 MB 语料上搭建基准测试', report: '每种文字的基准跑 40 秒',
        stages: [{ start: -10600, end: -9000, said: '每种文字的基准跑 40 秒', by: '/root' }] },
    ],
    turns: [[-10320, '派出三个方向：分词器提速、中日韩正确性和缓存审查；依赖审计单独跑'],
      [-4700, 'B02 已核对：分词器提速进入 B03，带上评审的条件'],
      [-1680, '中日韩第一阶段已合入；竖排标点作为第二阶段']] as Array<[number, string]>,
    goal: '把分词器提速一倍，同时不破坏中日韩文本',
    done: ['流式接口已合并', '基准测试已在 50 MB 语料上搭好', '依赖审计无问题'],
    now: '等待中日韩修复和缓存审查',
    subjects: ['新增流式分词接口', '修复中日韩文本代理对被切开', '基准：50 MB 语料'],
  },
};

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

interface Demo { tree: SubagentTree; log: Map<string, AgentLogEntry[]>; timeline: WorkbenchEvent[]; worktrees: WorktreesSnapshot; git: GitChanges; hud: HudData; recap: Recap }

const MODELS: Array<[string, string]> = [['gpt-5.6-astra', 'high'], ['gpt-5.6-astra', 'xhigh'], ['gpt-5.6-sol', 'medium'], ['gpt-5.6-sol', 'low'], ['gpt-5.6-luna', 'low']];

function demo(lang: Language): Demo {
  const text = TEXT[lang];
  const log = new Map<string, AgentLogEntry[]>();
  let n = 0;
  // An agent from its spec, a level `depth` down, under the task path `parent`; its log as the panel would have kept it.
  const build = (spec: Spec, depth: number, parent: string): SubagentTreeNode => {
    const agentPath = `${parent}/${spec.name}`;
    const [model, effort] = MODELS[n % MODELS.length];
    const i = ++n;
    const stages: AgentStage[] = (spec.stages ?? []).map(stage => ({
      startedAt: at(stage.start), status: stage.end === undefined ? 'running' : stage.status ?? 'done',
      ...(stage.end !== undefined ? { endedAt: at(stage.end) } : {}),
      ...(stage.said ? stage.end === undefined ? { intent: stage.said } : { result: stage.said } : {}),
      ...(stage.by ? { by: { type: stage.by === '/root' ? 'NEW_TASK' : 'MESSAGE', sender: stage.by } } : {}) }));
    const running = stages.at(-1)?.status === 'running' ? stages.at(-1) : undefined;
    const node: SubagentTreeNode = {
      id: id(i), name: spec.name, status: spec.status, depth, children: [], agentPath, role: spec.role,
      ...(depth === 1 && spec.label ? { label: spec.label } : {}), ...(spec.kind ? { taskKind: spec.kind } : {}), task: spec.task,
      ...(spec.report ? { lastReport: { text: spec.report, at: at(-40 - i * 7), kind: 'update' as const } } : {}),
      startedAt: at(spec.start), turnStartedAt: running?.startedAt ?? at(spec.stages?.at(-1)?.start ?? spec.start),
      lastEventAt: at(spec.end ?? -4 - i), ...(spec.end !== undefined ? { statusAt: at(spec.end) } : {}),
      model, effort, contextUsage: makeContextUsage([41, 63, 38, 22, 17, 57, 33][i % 7]),
      stages, stageCount: stages.length,
      ...(spec.action && spec.status === 'running' ? { action: { name: 'exec', text: spec.action, at: at(-150) } } : {}),
      ...(spec.peers ? { peers: spec.peers } : {}),
    };
    node.children = (spec.kids ?? []).map(kid => build(kid, depth + 1, agentPath));
    const entries: AgentLogEntry[] = [
      { at: node.startedAt!.getTime(), kind: 'started', text: '' },
      ...(node.lastReport ? [{ at: node.lastReport.at.getTime(), kind: 'report' as const, text: node.lastReport.text }] : []),
      ...(spec.note ? [{ at: NOW - 20_000, kind: 'note' as const, text: spec.note }] : []),
      ...(spec.status === 'completed' ? [{ at: NOW + spec.end! * 1000, kind: 'finished' as const, text: '' }] : []),
      ...(spec.status === 'error' ? [{ at: NOW + spec.end! * 1000, kind: 'failed' as const, text: '' }] : []),
      ...(spec.cause ? [{ at: NOW + spec.end! * 1000 + 30_000, kind: 'cause' as const, text: spec.cause }] : []),
    ];
    log.set(node.id, entries.sort((a, b) => a.at - b.at));
    return node;
  };
  const nodes = text.agents().map(spec => build(spec, 1, '/root'));
  const tree: SubagentTree = { rootId: id(99), nodes, totalCount: n, updatedAt: new Date(NOW) };
  // The main session's side of the timeline: its turns ending with what they told you, and a compaction.
  const main = { events: [
    ...text.turns.map(([seconds, said]) => ({ kind: 'turn-finished' as const, at: at(seconds), text: said })),
    { kind: 'compacted' as const, at: at(-6300) }],
    toolActivity: { recentCalls: [] } } as unknown as RolloutParseResult;
  const timeline = new WorkbenchHistory().timeline(tree, main, log);
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
  return { tree, log, timeline, worktrees, git, hud, recap };
}

const ICONS: Record<LookName, 'unicode' | 'emoji' | 'nerd'> = { tab: 'unicode', band: 'unicode', tile: 'emoji', frame: 'unicode', pill: 'nerd' };

/**
 * The panel at `width`×`height`: the cards with the timeline under them, a
 * file's diff in the Inspector, or one pane zoomed: the changes, or the
 * timeline in one of its styles.
 */
function panel(lang: Language, look: LookName, width: number, height: number, scene: 'agents' | 'diff' | 'changes' | TimelineStyle,
  icons: 'unicode' | 'emoji' | 'nerd' = ICONS[look]): string[] {
  setLanguage(lang);
  setDisplayConfig({ theme: 'terminal', glyphs: 'glyph', density: 'balanced', motion: 'reduced', look, icons });
  const d = demo(lang);
  const input: Omit<MonitorData, 'state'> = { tree: d.tree, worktrees: d.worktrees, git: d.git, nowMs: NOW, width, height, agentLog: d.log, timeline: d.timeline,
    brief: { recap: d.recap, structured: true, text: '{}', at: d.recap.at }, prefix: 'Ctrl+]',
    status: nowMs => statusCard(d.hud, nowMs), session: nowMs => sessionState(d.hud, nowMs) };
  const start = initialMonitorState();
  const first: MonitorState = { ...start, tree: { ...start.tree, lingerMs: 180_000 }, style: 'rich', statusLevel: 'full', labelAsName: true,
    importantRoles: new Set(['critic']) };
  if (scene === 'agents') {
    const state = { ...first, modes: { ...first.modes, timeline: 'open' as const } };
    return renderMonitor({ ...input, state: renderMonitor({ ...input, state }).state }).lines;
  }
  if (scene === 'changes') {
    const state = { ...first, modes: { ...first.modes, changes: 'open' as const }, focus: 'changes' as const, zoom: true, selectedFile: 'src/tokenizer.ts' };
    return renderMonitor({ ...input, state: renderMonitor({ ...input, state }).state }).lines;
  }
  if (scene !== 'diff') {
    const state = { ...first, modes: { ...first.modes, timeline: 'open' as const }, focus: 'timeline' as const, zoom: true, timelineStyle: scene };
    return renderMonitor({ ...input, state: renderMonitor({ ...input, state }).state }).lines;
  }
  const changes = { ...first, modes: { ...first.modes, changes: 'open' as const }, focus: 'changes' as const, selectedFile: 'src/tokenizer.ts' };
  const frame = renderMonitor({ ...input, state: changes });
  const inspected = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { tree: d.tree, git: d.git, worktrees: d.worktrees, frame }).state;
  return renderMonitor({ ...input, state: renderMonitor({ ...input, state: inspected, diff: DIFF }).state, diff: DIFF }).lines;
}

/** The status bar, working; `alert` keeps the failed agent that takes the front of the line and says, in the notice zone, that another just finished. */
function bar(width: number, alert: boolean): string {
  setLanguage('en');
  setDisplayConfig({ theme: 'terminal', glyphs: 'both', density: 'balanced', motion: 'reduced' });
  const { hud } = demo('en');
  const calm = (status: SubagentStatus): SubagentStatus => status === 'error' ? 'running' : status;
  const calmed = (node: SubagentTreeNode): SubagentTreeNode => ({ ...node, status: calm(node.status), children: node.children.map(calmed) });
  const loaded = { ...hud, project: { ...hud.project, skillsCount: 9, hooksCount: 1 },
    outputRate: hud.outputRate ?? { tokensPerSecond: 42.4, sampleMs: 4000, sampledAt: new Date(NOW - 1000) } };
  const finished = hud.subagentTree!.nodes.find(node => node.status === 'completed');
  const noticed = { ...loaded, notices: [{ kind: 'agent-done' as const, subject: finished?.name ?? 'explorer', at: new Date(NOW - 12_000) }] };
  const shown = alert ? noticed : { ...loaded, subagents: hud.subagents!.map(a => ({ ...a, status: calm(a.status) })),
    subagentTree: { ...hud.subagentTree!, nodes: hud.subagentTree!.nodes.map(calmed) } };
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
    write(`changes-${lang}`, panel(lang, 'tab', 46, 30, 'changes'));
    for (const style of TIMELINE_STYLES) write(`timeline-${lang}-${style}`, panel(lang, 'tab', 46, 40, style));
    console.log(`--- status card, ${lang}\n${card(lang, 66).join('\n')}`);
  }
  // The control bar as the reference quotes it: the tab look across the widths, and each look at 40 columns.
  const plain = (lines: string[], rows = 1) => lines.slice(0, rows).map(line => stripAnsi(line).trimEnd());
  for (const lang of ['en', 'zh'] as const) {
    const columns = lang === 'zh' ? '列' : 'columns';
    console.log(`--- control bar, ${lang}\n${[120, 56, 40, 32].map(width => `${String(width).padStart(3)} ${columns}  ${plain(panel(lang, 'tab', width, 50, 'agents'))[0]}`).join('\n')}`);
    // Nerd Font glyphs do not show in a document: the pills are quoted with the Unicode set.
    console.log(`--- looks, 40 ${columns}, ${lang}\n${LOOKS.map(look => plain(panel(lang, look, 40, 50, 'agents', look === 'pill' ? 'unicode' : ICONS[look]), look === 'frame' ? 2 : 1)
      .map((line, i) => `${(i ? '' : look).padEnd(6)} ${line}`).join('\n')).join('\n')}`);
  }
  write('bar-200', [bar(200, false)]);
  write('bar-200-alert', [bar(200, true)]);
  console.log('--- bar, en');
  for (const [width, alert] of [[200, false], [200, true], [120, true], [40, true]] as const) console.log(stripAnsi(bar(width, alert)));
} finally {
  setDisplayConfig(previous);
  setLanguage(previousLanguage);
}
