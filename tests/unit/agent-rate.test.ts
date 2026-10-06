/**
 * A subagent's output rate, and what a card shows at work and at rest.
 *
 * The rate is read from the agent's rollout as the main session's is taken;
 * it stands while the agent works and its newest report is recent, and the
 * summary adds up every running agent's. A card at work keeps its note
 * whole; a card at rest is one line; the agent's own words and its sealed
 * task's stand-in are the Inspector's, uncut.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { readAgentTokens, resetAgentContextCache } from '../../src/collectors/agent-context.js';
import { initialMonitorState, renderMonitor, monitorSettings, agentRate, RATE_FRESH_MS, type MonitorState } from '../../src/render/monitor.js';
import { defaultSettings } from '../../src/settings.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-04T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const agent = (i: number, name: string, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id: id(i), name, status: 'running', depth: 1, children: [], startedAt: new Date(now - 600_000), turnStartedAt: new Date(now - 181_000),
    lastEventAt: new Date(now - 5000), ...extra });
const tree = (nodes: SubagentTreeNode[]): SubagentTree => ({ rootId: 'root', nodes, totalCount: nodes.length, updatedAt: new Date(now) });
const rich = (extra: Partial<MonitorState> = {}): MonitorState => ({ ...initialMonitorState(), style: 'rich', ...extra });
const rate = (tokensPerSecond: number, ago = 20_000) => ({ tokensPerSecond, sampleMs: 30_000, sampledAt: new Date(now - ago) });

const tokenCount = (output: number, at: number) => `${JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: {
  model_context_window: 272_000, last_token_usage: { input_tokens: 50_000, output_tokens: 100, total_tokens: 50_100 },
  total_token_usage: { output_tokens: output, total_tokens: output * 10 } } } })}\n`;
const turnStarted = (at: number) => `${JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started' } })}\n`;

async function withRollout(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hud-agent-rate-'));
  resetAgentContextCache();
  try { await run(path.join(dir, 'rollout.jsonl')); } finally {
    resetAgentContextCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
/** Append and move the mtime on, as a rollout that grew looks. */
async function grow(file: string, text: string, tick: number): Promise<void> {
  await fs.appendFile(file, text);
  const at = new Date(Date.now() + tick * 1000);
  await fs.utimes(file, at, at);
}

test('an agent\'s rollout gives its rate as the main session\'s is taken, reading only what was appended', async () => {
  await withRollout(async (file) => {
    const t0 = now - 120_000;
    await fs.writeFile(file, tokenCount(1000, t0) + tokenCount(1600, t0 + 20_000));
    const first = await readAgentTokens(file);
    assert.equal(first.rate?.tokensPerSecond, 30, '600 tokens in 20 s');
    assert.ok(first.usage, 'the context fill from the same reports');

    // A report appended later: the rate runs on from what was read before.
    await grow(file, tokenCount(2800, t0 + 60_000), 5);
    const second = await readAgentTokens(file);
    assert.equal(second.rate?.tokensPerSecond, 30, '1200 tokens in the 40 s since the window\'s baseline');
    assert.equal(second.rate?.sampledAt.getTime(), t0 + 60_000);

    // A new turn begins it afresh: the idle gap is not counted as slow writing.
    await grow(file, turnStarted(t0 + 100_000) + tokenCount(2900, t0 + 105_000), 10);
    assert.equal((await readAgentTokens(file)).rate?.tokensPerSecond, 20, '100 tokens in the 5 s since the turn began');

    // A rollout replaced by a shorter one is read from its tail again.
    await fs.writeFile(file, tokenCount(10, t0) + tokenCount(110, t0 + 10_000));
    const later = new Date(Date.now() + 20_000);
    await fs.utimes(file, later, later);
    assert.equal((await readAgentTokens(file)).rate?.tokensPerSecond, 10);
  });
});

test('a rate stands while the agent works this turn and its newest report is recent', () => {
  const live = agent(1, 'worker', { outputRate: rate(42) });
  assert.equal(agentRate(live, now), 42);
  assert.equal(agentRate({ ...live, status: 'completed' }, now), undefined, 'finished');
  assert.equal(agentRate({ ...live, outputRate: rate(42, RATE_FRESH_MS) }, now), undefined, 'its newest report too old');
  assert.equal(agentRate({ ...live, turnStartedAt: new Date(now - 10_000) }, now), undefined, 'from an earlier turn');
  assert.equal(agentRate({ ...live, lastEventAt: new Date(now - 6 * 60_000) }, now), undefined, 'quiet');
});

test('a card at work: its note whole, its rate beside the clock; the summary adds every running agent\'s', () => {
  const note = '整理测试数据补全文档，并把基准结果写回发布说明供后续核对一遍';
  const worker = agent(1, 'worker', { outputRate: rate(42.4), contextUsage: { percent: 34, used: 1, total: 3, inputTokens: 0, outputTokens: 0, cachedTokens: 0, compactCount: 0 },
    children: [agent(3, 'helper', { depth: 2, outputRate: rate(100) })] });
  const other = agent(2, 'other', { outputRate: rate(44) });
  const log = new Map<string, AgentLogEntry[]>([[worker.id, [{ at: now - 60_000, kind: 'report', text: 'I am taking over the tokenizer benchmark' },
    { at: now - 6000, kind: 'note', text: note }]]]);
  const lines = stripAnsi(renderMonitor({ tree: tree([worker, other]), state: rich(), width: 40, height: 40, nowMs: now, agentLog: log }).lines.join('\n')).split('\n');
  const top = lines.findIndex(line => line.includes(' worker '));
  const body = lines.slice(top + 1, lines.findIndex((line, i) => i > top && line.startsWith('└')));
  assert.ok(!body.some(line => line.includes('…')), body.join('\n'));
  const said = body.filter(line => !line.includes('general'));
  assert.equal(said.map(line => line.slice(2).trim()).join(''), note, 'the note whole, with no mark before it');
  assert.ok(!lines.some(line => line.includes('taking over')), 'not the agent\'s own words');
  assert.match(lines[top + 1 + body.length], /^└ ◷3m01s · ~42 tok\/s ─+34%─+ ▾$/);
  assert.match(lines.find(line => line.includes('▸2 run'))!, /· ~186 tok\/s/, 'the two agents and the subtask under one, together');
  // Narrow, the rate gives way before the meter does.
  const narrow = stripAnsi(renderMonitor({ tree: tree([worker]), state: rich(), width: 24, height: 40, nowMs: now }).lines.join('\n'));
  assert.ok(!/tok\/s ─/.test(narrow) && /◷3m01s ─+34%/.test(narrow), narrow);
});

test('the Inspector has what the card leaves out: the rate, and the stand-in for a sealed task, whole', () => {
  const intent = 'I am taking over the tokenizer benchmark from the parser lead and will re-run the cache checks before reporting back.';
  const node = agent(1, 'worker', { outputRate: rate(42), stages: [{ startedAt: new Date(now - 181_000), status: 'running', intent }] });
  const state = rich({ tree: { ...rich().tree, selectedId: node.id } });
  const rows = inspectorRows({ tree: tree([node]), state, width: 40, height: 40, nowMs: now } as never, state, 40, now).map(row => stripAnsi(row.text));
  assert.ok(rows.includes('Out ~42 tok/s'), rows.join('\n'));
  const at = rows.indexOf('Took on');
  assert.ok(at > 0, rows.join('\n'));
  assert.equal(rows.slice(at + 1).join(' ').startsWith(intent), true, 'wrapped, not cut');
  // With its task known, the task is the Inspector's to say, as before.
  const tasked = inspectorRows({ tree: tree([{ ...node, task: 'Check the cache' }]), state, width: 40, height: 40, nowMs: now } as never, state, 40, now);
  assert.ok(!tasked.some(row => stripAnsi(row.text) === 'Took on'));
});

test('a working card shows its newest notes, three by default, one to five by Settings; the newest in the text colour, the rest dim', () => {
  const node = agent(1, 'worker');
  const log = new Map<string, AgentLogEntry[]>([[node.id, Array.from({ length: 6 }, (_, i) => ({ at: now - 60_000 + i * 1000, kind: 'note' as const, text: `note ${i}` }))]]);
  const body = (state: MonitorState) => {
    const lines = renderMonitor({ tree: tree([node]), state, width: 40, height: 40, nowMs: now, agentLog: log }).lines;
    return lines.filter(line => /note \d/.test(stripAnsi(line)));
  };
  const three = body(rich());
  assert.deepEqual(three.map(line => stripAnsi(line).trim()), ['│ note 5', '│ note 4', '│ note 3']);
  assert.ok(!three[0].includes('\x1b[2mnote 5') && three[1].includes('\x1b[2mnote 4'), 'new from old by colour, no mark');
  assert.equal(body(rich({ cardNotes: 5 })).length, 5);
  assert.equal(body(rich({ cardNotes: 1 })).length, 1);
  assert.equal(monitorSettings({ ...defaultSettings(), cardNotes: 4 }).cardNotes, 4);
  assert.equal(defaultSettings().cardNotes, 3);
});
