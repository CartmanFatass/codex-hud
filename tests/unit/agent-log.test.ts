import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLog, observedEntries, appendEntries, ENTRIES_PER_AGENT, type AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root-1'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(now) });

test('observed entries come from the rollout times only; no time, no entry', () => {
  assert.deepEqual(observedEntries(node('a', 'x', 'running')), []);
  assert.deepEqual(observedEntries(node('a', 'x', 'completed', { turnStartedAt: new Date(now - 60_000), statusAt: new Date(now),
    lastReport: { text: 'Found  it', kind: 'reply', at: new Date(now - 1000) } })).map(e => [e.kind, e.at, e.text]),
  [['started', now - 60_000, ''], ['finished', now, ''], ['report', now - 1000, 'Found  it']]);
  assert.deepEqual(observedEntries(node('a', 'x', 'error', { statusAt: new Date(now) })).map(e => e.kind), ['failed']);
});

test('the log only grows: the same state again adds nothing, a new turn adds a start, and it is bounded', () => {
  const log = new AgentLog();
  const worker = node('a', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) });
  assert.equal(log.observe(tree([worker])), true);
  assert.equal(log.observe(tree([worker])), false, 'polling never invents an entry');
  const done = { ...worker, status: 'completed' as const, statusAt: new Date(now) };
  assert.equal(log.observe(tree([done])), true);
  const again = { ...done, status: 'running' as const, turnStartedAt: new Date(now + 60_000) };
  log.observe(tree([again]));
  assert.deepEqual(log.entries('a').map(e => e.kind), ['started', 'finished', 'started']);
  const list: AgentLogEntry[] = [];
  appendEntries(list, Array.from({ length: ENTRIES_PER_AGENT + 5 }, (_, i) => ({ at: now + i, kind: 'report' as const, text: `r${i}` })));
  assert.equal(list.length, ENTRIES_PER_AGENT);
  assert.equal(list[0].text, 'r5', 'the oldest go first');
  log.observe(tree([], 'root-2'));
  assert.deepEqual(log.entries('a'), [], 'another session starts from its own log');
});

test('the log is saved per session, 0600, and read back by the next panel', (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agent-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new AgentLog(dir);
  log.observe(tree([node('a', 'worker', 'running', { turnStartedAt: new Date(now) })]));
  log.add('a', [{ at: now + 5, kind: 'note', text: 'reading', attention: true }]);
  log.flush();
  assert.equal(fs.statSync(path.join(dir, 'root-1.json')).mode & 0o777, 0o600);
  const next = new AgentLog(dir);
  next.attach('root-1');
  assert.deepEqual(next.entries('a'), [{ at: now, kind: 'started', text: '' }, { at: now + 5, kind: 'note', text: 'reading', attention: true }]);
  next.attach('root-2');
  assert.deepEqual(next.entries('a'), []);
});

test('the same note said again moves the one already there up to now instead of adding a copy', () => {
  const list: AgentLogEntry[] = [];
  appendEntries(list, [{ at: 1000, kind: 'started', text: '' }, { at: 2000, kind: 'note', text: 'Reading the parser' }]);
  assert.equal(appendEntries(list, [{ at: 62_000, kind: 'note', text: 'Reading the parser' }]), true, 'it still counts as news: the note is as of now');
  assert.deepEqual(list.filter(entry => entry.kind === 'note'), [{ at: 62_000, kind: 'note', text: 'Reading the parser' }]);
  appendEntries(list, [{ at: 122_000, kind: 'note', text: 'Found the race' }]);
  appendEntries(list, [{ at: 182_000, kind: 'note', text: 'Reading the parser' }]);
  assert.deepEqual(list.filter(entry => entry.kind === 'note').map(entry => entry.text),
    ['Reading the parser', 'Found the race', 'Reading the parser'], 'only a repeat of the newest note is folded');
});
