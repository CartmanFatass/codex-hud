import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLog, observedEntries, appendEntries, ENTRIES_PER_AGENT, type AgentLogEntry } from '../../src/collectors/agent-log.js';
import { Briefer, NOTES_INTERVAL_MS, agentNotesSystemPrompt } from '../../src/collectors/briefing.js';
import type { SmallModel, ModelRequest } from '../../src/collectors/small-model.js';
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

function fakeModel(reply: string): { model: SmallModel; asked: ModelRequest[] } {
  const asked: ModelRequest[] = [];
  const model = {
    configure() {},
    submit(request: ModelRequest) { asked.push(request); return { result: Promise.resolve({ ok: true as const, text: reply }), cancel() {} }; },
  } as unknown as SmallModel;
  return { model, asked };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('notes are asked for just the agents with news since their last note, at most once a minute', async () => {
  const { model, asked } = fakeModel('{"overall":"fine","agents":[{"agent":"reader","attention":false,"note":"reading the parser"},'
    + '{"agent":"writer","attention":false,"note":"drafting"}]}');
  // Notes are stamped with the wall clock when written: news must come after one and before the next.
  const fresh = async () => { const at = Date.now() + 1; await new Promise(resolve => setTimeout(resolve, 5)); return new Date(at); };
  const log = new AgentLog();
  const briefer = new Briefer(() => {}, { model, log });
  const reader = node('a', 'reader', 'running', { turnStartedAt: new Date(now - 60_000), lastReport: { text: 'one', kind: 'update', at: new Date(now - 1000) } });
  const writer = node('b', 'writer', 'running', { turnStartedAt: new Date(now - 60_000) });
  const agents = (r: SubagentTreeNode) => tree([r, writer]);
  log.observe(agents(reader));
  briefer.update(agents(reader), 'omp', 300_000, 'en', now);
  await settle();
  assert.equal(asked.length, 1, 'the brief itself');
  assert.equal(asked[0].feature, 'brief');
  assert.equal(log.latest('a', new Set(['note']))?.text, 'reading the parser', 'the brief\'s line lands in the agent\'s log');

  const updated = { ...reader, lastReport: { text: 'two', kind: 'update' as const, at: await fresh() } };
  log.observe(agents(updated));
  briefer.update(agents(updated), 'omp', 300_000, 'en', now + 10_000);
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].feature, 'notes');
  assert.equal(asked[1].system, agentNotesSystemPrompt('en'));
  assert.match(asked[1].prompt, /- reader:/);
  assert.doesNotMatch(asked[1].prompt, /- writer:/, 'an agent with nothing new is not asked about');

  const third = { ...reader, lastReport: { text: 'three', kind: 'update' as const, at: await fresh() } };
  log.observe(agents(third));
  briefer.update(agents(third), 'omp', 300_000, 'en', now + 20_000);
  await settle();
  assert.equal(asked.length, 2, 'within a minute of the last notes: wait');
  briefer.update(agents(third), 'omp', 300_000, 'en', now + 10_000 + NOTES_INTERVAL_MS);
  await settle();
  assert.equal(asked.length, 3);
  briefer.update(agents(third), 'omp', 300_000, 'en', now + 10_000 + 3 * NOTES_INTERVAL_MS);
  await settle();
  assert.equal(asked.length, 3, 'a note newer than the news: nothing to ask');
  briefer.update(agents(third), 'omp', 300_000, 'en', now + 10_000 + 4 * NOTES_INTERVAL_MS, true);
  assert.equal(asked.length, 3, 'paused: no notes either');
});
