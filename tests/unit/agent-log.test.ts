import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLog, observedEntries, appendEntries, entryLanguage, inLanguage, logsIn, ENTRIES_PER_AGENT, type AgentLogEntry } from '../../src/collectors/agent-log.js';
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

test('what a model wrote is shown in the language it was written in; observed entries in any, an old entry by its text', () => {
  const en: AgentLogEntry = { at: now - 3000, kind: 'note', text: 'Checking the cache paths', lang: 'en' };
  const zh: AgentLogEntry = { at: now - 2000, kind: 'note', text: '正在核对缓存路径', lang: 'zh' };
  const old: AgentLogEntry = { at: now - 1000, kind: 'digest', text: '缓存路径已核对' };
  const seen: AgentLogEntry = { at: now - 4000, kind: 'started', text: '' };
  assert.deepEqual([en, zh, old].map(entryLanguage), ['en', 'zh', 'zh']);
  assert.ok(inLanguage(seen, 'en') && inLanguage(seen, 'zh'));
  assert.deepEqual([en, zh, old].map(entry => inLanguage(entry, 'en')), [true, false, false]);
  const logs = new Map<string, readonly AgentLogEntry[]>([['a', [seen, en, zh, old]], ['b', [zh]]]);
  assert.deepEqual([...logsIn(logs, 'en')], [['a', [seen, en]]], 'an agent with nothing left in the language is left out');
  const same = new Map<string, readonly AgentLogEntry[]>([['a', [seen, zh]]]);
  assert.equal(logsIn(same, 'zh').get('a'), same.get('a'), 'a list all in the language is the same list');
});

test('a note may name what the agent is on: the newest name in the language is its label, with its kind', () => {
  const log = new AgentLog();
  log.add('a', [{ at: now - 3000, kind: 'note', text: 'Reading the cache module', lang: 'en', label: '  Cache   audit ', taskKind: 'review' }]);
  log.add('a', [{ at: now - 2000, kind: 'note', text: '正在读缓存模块', lang: 'zh', label: '缓存审查' }]);
  log.add('a', [{ at: now - 1000, kind: 'note', text: 'Still reading', lang: 'en' }]);
  assert.deepEqual(log.label('a', 'en'), { name: 'Cache audit', kind: 'review' }, 'a note without one keeps the last name');
  assert.deepEqual(log.label('a', 'zh'), { name: '缓存审查' });
  assert.equal(log.label('b', 'en'), undefined);
  // A kind without a name is not kept, nor one that is not a kind.
  log.add('c', [{ at: now, kind: 'note', text: 'x', lang: 'en', taskKind: 'review' }]);
  log.add('d', [{ at: now, kind: 'note', text: 'y', lang: 'en', label: 'Y', taskKind: 'nonsense' as never }]);
  assert.equal(log.entries('c')[0].taskKind, undefined);
  assert.deepEqual(log.label('d', 'en'), { name: 'Y' });
  // The same note again with a new name keeps one entry and takes the name; in the other language it is another entry.
  log.add('a', [{ at: now, kind: 'note', text: 'Still reading', lang: 'en', label: 'Cache fix', taskKind: 'fix' }]);
  assert.equal(log.entries('a').length, 3);
  assert.deepEqual(log.label('a', 'en'), { name: 'Cache fix', kind: 'fix' });
  log.add('a', [{ at: now + 1, kind: 'note', text: 'Still reading', lang: 'zh' }]);
  assert.equal(log.entries('a').length, 4);
});

test('stored model summaries survive hidden observed logs, with explicit coverage metadata only', () => {
  const entries: AgentLogEntry[] = [
    {at:now,kind:'report',text:'Observed synthetic report'},
    {at:now,kind:'note',text:'Synthetic model note',lang:'en',coverageAt:now-1000,generatedAt:now},
    {at:now,kind:'note',text:'另一种语言',lang:'zh'},
  ];
  const original = new Map([['a',entries]]);
  const models = logsIn(original,'en',false);
  assert.deepEqual(models.get('a'),[entries[1]]);
  assert.equal(original.get('a')?.length,3,'filtering does not erase history');
  const clean: AgentLogEntry[] = [];
  appendEntries(clean,[entries[1]]);
  assert.equal(clean[0].coverageAt,now-1000);
  appendEntries(clean,[{at:now+1,kind:'note',text:'Synthetic model note',lang:'en'}]);
  assert.equal(clean[0].coverageAt,undefined,'periodic notes cannot inherit a stale coverage boundary');
  assert.equal(clean[0].generatedAt,undefined);
  appendEntries(clean,[{at:now+2,kind:'note',text:'Other',coverageAt:Infinity}]);
  assert.equal(clean.at(-1)?.coverageAt,undefined);
});
