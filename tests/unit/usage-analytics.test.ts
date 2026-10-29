import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsSync, { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { UsageAnalytics } from '../../src/collectors/usage-analytics.js';

process.env.TZ = 'America/Los_Angeles';
const at = (day: number, hour = 12, minute = 0, second = 0): string => new Date(2026, 9, day, hour, minute, second).toISOString();
const now = new Date(2026, 9, 29, 23, 59).getTime();
const meta = (id: string, day = 29, extra: Record<string, unknown> = {}) => ({ type: 'session_meta', timestamp: at(day, 0),
  payload: { id, timestamp: at(day, 0), ...extra } });
const context = (model: string, effort: string | null, day = 29, extra: Record<string, unknown> = {}) => ({
  type: 'turn_context', timestamp: at(day, 1), payload: { model, ...(effort ? { effort } : {}), ...extra } });
const counts = (input: number) => ({ input_tokens: input, cached_input_tokens: input / 2,
  output_tokens: input / 5, reasoning_output_tokens: input / 10, total_tokens: input * 1.2 });
const report = (input: number, last: number | null = input, day = 29, second = 0) => ({ type: 'event_msg', timestamp: at(day, 12, 0, second),
  payload: { type: 'token_count', info: { total_token_usage: counts(input), ...(last === null ? {} : { last_token_usage: counts(last) }) } } });
const started = (id: string) => ({ type: 'event_msg', timestamp: at(29, 0, 0, 1), payload: { type: 'task_started', turn_id: id } });

async function fixture(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-native-usage-'));
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const instances: UsageAnalytics[] = [];
  t.after(async () => { for (const instance of instances) instance.close(); await fs.rm(home, { recursive: true, force: true }); });
  return {
    home,
    async write(name: string, entries: unknown[], finalNewline = true) {
      const file = path.join(home, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + (finalNewline ? '\n' : ''));
      return file;
    },
    analytics(onChange?: () => void) { const a = new UsageAnalytics({ codexHome: home, onChange }); instances.push(a); return a; },
  };
}

test('construction and snapshot are memory-only and missing history is unknown', async t => {
  const f = await fixture(t);
  const a = f.analytics();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).status, 'loading');
  assert.deepEqual(await fs.readdir(f.home), ['sessions']);
  await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'unavailable');
  assert.equal(s.totals.total, null);
  assert.equal(s.totals.events, 0);
  assert.equal(s.daily[0].totals.total, null);
});

test('native subsets are not double counted and context/quota meters are ignored', async t => {
  const f = await fixture(t);
  await f.write('sessions/root.jsonl', [meta('root'), context('model-a', 'high'),
    { type: 'event_msg', timestamp: at(29), payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 90 } } } },
    { type: 'event_msg', timestamp: at(29), payload: { type: 'task_started', model_context_window: 999999 } },
    report(100), report(150, 50, 29, 1)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'ready');
  assert.deepEqual(s.totals, { input: 150, cachedInput: 75, output: 30, reasoningOutput: 15, total: 180, events: 2, threads: 1 });
  assert.equal(s.models[0].key, 'model-a');
  assert.equal(s.efforts[0].key, 'high');
});

test('re-emitted totals and quota-only interleaves do not repeat a request; equal last with advancing total survives', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), report(100), report(100, 100, 29, 1), report(100, null, 29, 2),
    report(100, 100, 29, 3), report(200, 100, 29, 4)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 200);
  assert.equal(s.totals.events, 2);
  assert.equal(s.coverage.ambiguousEvents, 0);
});

test('resumed copies in sessions and archived_sessions deduplicate while keeping their new tail', async t => {
  const f = await fixture(t);
  const first = [meta('root'), context('a', 'low'), report(100)];
  await f.write('sessions/a.jsonl', first);
  await f.write('archived_sessions/a-copy.jsonl', [...first, report(150, 50, 29, 1)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 150);
  assert.equal(s.totals.events, 2);
  assert.equal(s.totals.threads, 1);
  assert.equal(s.coverage.filesIndexed, 2);
});

test('copied parent history is excluded and an explicit owner turn boundary preserves independent equal-token events', async t => {
  const f = await fixture(t);
  const parentReport = report(100, 100, 28);
  await f.write('sessions/root.jsonl', [meta('root', 28), context('parent-model', 'low', 28), parentReport]);
  await f.write('sessions/child.jsonl', [meta('child', 29, { parent_thread_id: 'root', session_id: 'root', agent_role: 'reviewer' }),
    started('own-turn'), meta('root', 28), context('parent-model', 'low', 28), parentReport,
    context('child-model', 'high', 29, { turn_id: 'own-turn' }), report(100)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: '7d', nowMs: now, rootId: 'root' });
  assert.equal(s.totals.input, 200);
  assert.equal(s.totals.threads, 2);
  assert.equal(s.tasks[0].self.input, 100);
  assert.equal(s.tasks[0].descendants.input, 100);
  assert.deepEqual(s.models.map(x => x.key).sort(), ['child-model', 'parent-model']);
  assert.equal(s.roles.find(x => x.key === 'reviewer')?.totals.input, 100);
});

test('foreign copied metadata with no provable own-turn boundary stays ambiguous', async t => {
  const f = await fixture(t);
  await f.write('sessions/root.jsonl', [meta('root'), report(100)]);
  await f.write('sessions/child.jsonl', [meta('child', 29, { parent_thread_id: 'root' }), meta('root', 28),
    context('possibly-copied', 'high'), report(100), report(200, 100, 29, 1)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'partial');
  assert.equal(s.totals.input, 100);
  assert.equal(s.coverage.ambiguousEvents, 2);
});

test('an owner metadata boundary restores a fork tail without replacing its role or parent', async t => {
  const f = await fixture(t);
  await f.write('sessions/root.jsonl', [meta('root'), report(100)]);
  await f.write('sessions/child.jsonl', [meta('child', 29, { parent_thread_id: 'root', agent_role: 'worker' }),
    meta('root', 28, { agent_role: 'other' }), report(100, 100, 28), meta('child'), context('own', 'low'), report(50)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now, rootId: 'root' });
  assert.equal(s.totals.input, 150);
  assert.equal(s.roles.find(r => r.key === 'worker')?.totals.input, 50);
  assert.equal(s.roles.some(r => r.key === 'other'), false);
});

test('nested delegation, unresolved parents, and a user fork have distinct task ownership', async t => {
  const f = await fixture(t);
  await f.write('sessions/root.jsonl', [meta('root'), report(100)]);
  await f.write('sessions/child.jsonl', [meta('child', 29, { source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_role: 'worker' } } } }), report(50)]);
  await f.write('sessions/grandchild.jsonl', [meta('grandchild', 29, { parent_thread_id: 'child' }), report(20)]);
  await f.write('sessions/orphan.jsonl', [meta('orphan', 29, { parent_thread_id: 'missing' }), report(30)]);
  await f.write('sessions/fork.jsonl', [meta('fork', 29, { forked_from_id: 'root', session_id: 'root', thread_source: 'user' }), report(40)]);
  const a = f.analytics(); await a.refresh();
  const all = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(all.totals.input, 240);
  assert.equal(all.coverage.unresolvedParents, 1);
  assert.deepEqual(all.tasks.map(x => x.rootId).sort(), ['fork', 'root']);
  const scoped = a.snapshot({ period: 'today', nowMs: now, rootId: 'root' });
  assert.equal(scoped.totals.input, 170);
  assert.equal(scoped.tasks[0].self.input, 100);
  assert.equal(scoped.tasks[0].descendants.input, 70);
});

test('native root hints can retain a known root subtotal while missing intermediate parents stay partial', async t => {
  const f = await fixture(t);
  await f.write('sessions/child.jsonl', [meta('child', 29, { parent_thread_id: 'missing', session_id: 'root', thread_source: 'subagent' }), report(50)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now, rootId: 'root' });
  assert.equal(s.status, 'partial');
  assert.equal(s.tasks[0].self.total, null);
  assert.equal(s.tasks[0].descendants.input, 50);
});

test('cycles and conflicting owner metadata cannot manufacture a root', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('a', 29, { parent_thread_id: 'b' }), report(10)]);
  await f.write('sessions/b.jsonl', [meta('b', 29, { parent_thread_id: 'a' }), report(20)]);
  await f.write('sessions/c.jsonl', [meta('c', 29, { parent_thread_id: 'a' }), report(30)]);
  await f.write('sessions/c-copy.jsonl', [meta('c', 29, { parent_thread_id: 'b' }), report(30)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 60);
  assert.equal(s.tasks.length, 0);
  assert.equal(s.coverage.unresolvedParents, 3);
});

test('daily local-calendar ranges and model/effort changes never use the final model for older events', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root', 28), context('old', 'high', 28), report(100, 100, 28),
    context('new', null), report(150, 50)]);
  const a = f.analytics(); await a.refresh();
  const today = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(today.totals.input, 50);
  assert.equal(today.models[0].key, 'new');
  assert.equal(today.efforts[0].key, null);
  const week = a.snapshot({ period: '7d', nowMs: now });
  assert.equal(week.totals.input, 150);
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily.at(-2)?.day, '2026-10-28');
  assert.equal(week.daily.at(-2)?.totals.input, 100);
  assert.equal(week.daily.at(-1)?.totals.input, 50);
  assert.equal(week.daily[0].totals.input, null);
  assert.equal(a.snapshot({ period: '30d', nowMs: now }).daily.length, 30);
});

test('range boundaries use local midnight and queries exclude later events even within one day', async t => {
  const f = await fixture(t);
  const early = report(100); early.timestamp = new Date(2026, 9, 29, 0, 0, 1).toISOString();
  await f.write('sessions/a.jsonl', [meta('root', 28), report(50, 50, 28), early, report(150, 50, 29, 1)]);
  const a = f.analytics(); await a.refresh();
  const beforeNoon = new Date(2026, 9, 29, 11).getTime();
  assert.equal(a.snapshot({ period: 'today', nowMs: beforeNoon }).totals.input, 100);
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 150);
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.range.startMs, new Date(2026, 9, 29).getTime());
  assert.equal(s.range.timeZone, 'America/Los_Angeles');
});

test('first cumulative-only report is a baseline, not a lifetime charge to its timestamp', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root', 1), context('current', 'high'), report(100, null)]);
  const a = f.analytics(); await a.refresh();
  let s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, null);
  assert.equal(s.status, 'unavailable');
  assert.equal(s.coverage.ambiguousEvents, 1);
  await f.write('sessions/a.jsonl', [meta('root', 1), context('current', 'high'), report(100, null), report(150, null, 29, 1)]);
  await a.refresh(); s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 50);
  assert.equal(s.status, 'partial');
  assert.equal(s.totals.events, 1);
});

test('counter resets keep explicit last-request evidence but expose a gap', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), report(100), report(200, 100, 29, 1), report(50, 50, 29, 2)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 250);
  assert.equal(s.status, 'partial');
  assert.equal(s.coverage.ambiguousEvents, 1);
});

test('missing components stay null while known fields remain useful partial evidence', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), { type: 'event_msg', timestamp: at(29), payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: 100, output_tokens: 20 }, last_token_usage: { input_tokens: 100, output_tokens: 20 } } } }]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'partial');
  assert.equal(s.totals.total, 120);
  assert.equal(s.totals.cachedInput, null);
  assert.equal(s.totals.reasoningOutput, null);
});

test('invalid numbers, impossible subsets and invalid timestamps never become fabricated zeros', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), { type: 'event_msg', timestamp: at(29), payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: '100', output_tokens: -20 },
    last_token_usage: { input_tokens: 10, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 99 } } } },
    { ...report(100), timestamp: 'invalid' }]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 10);
  assert.equal(s.totals.cachedInput, null);
  assert.equal(s.totals.reasoningOutput, null);
  assert.equal(s.totals.total, 30);
  assert.equal(s.status, 'partial');
  assert.ok(s.coverage.ambiguousEvents >= 1);
});

test('malformed, oversized, and unfinished lines do not hide later valid evidence', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), '{broken', JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(2 * 1024 * 1024) } }), report(100), '{torn'], false);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 100);
  assert.equal(s.status, 'partial');
  assert.equal(s.coverage.malformedLines, 3);
  await f.write('sessions/a.jsonl', [meta('root'), report(50)], false);
  await a.refresh();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 50);
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).coverage.malformedLines, 0);
});

test('rotation, archive moves, and confirmed source deletion replace a generation coherently', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/a.jsonl', [meta('root'), report(100)]);
  const a = f.analytics(); await a.refresh();
  await fs.mkdir(path.join(f.home, 'archived_sessions'));
  await fs.rename(file, path.join(f.home, 'archived_sessions/a.jsonl'));
  await a.refresh();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 100);
  await f.write('sessions/a.jsonl', [meta('other'), report(50)]);
  await a.refresh();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 150);
  await fs.rm(path.join(f.home, 'sessions'), { recursive: true });
  await fs.rm(path.join(f.home, 'archived_sessions'), { recursive: true });
  await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'unavailable');
  assert.equal(s.totals.input, null);
  assert.equal(s.coverage.filesDiscovered, 0);
  const restarted = f.analytics(); await restarted.refresh();
  assert.equal(restarted.snapshot({ period: 'today', nowMs: now }).totals.input, null);
});

test('unchanged source files are reused across restarts; corrupt private indexes recover from source', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root', 29, { instructions: 'SYNTHETIC_SECRET_PROMPT' }), report(100)]);
  const a = f.analytics(); await a.refresh();
  const indexDir = path.join(f.home, 'hud/usage-index');
  const indexes = await fs.readdir(indexDir);
  assert.equal(indexes.length, 1);
  const index = path.join(indexDir, indexes[0]);
  assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(indexDir)).mode & 0o777, 0o700);
  assert.equal((await fs.readFile(index, 'utf8')).includes('SYNTHETIC_SECRET_PROMPT'), false);
  const original = fsSync.createReadStream;
  let reads = 0;
  fsSync.createReadStream = ((...args: Parameters<typeof original>) => { reads++; return original(...args); }) as typeof original;
  syncBuiltinESMExports();
  try {
    const second = f.analytics(); await second.refresh();
    assert.equal(reads, 0);
    assert.equal(second.snapshot({ period: 'today', nowMs: now }).totals.input, 100);
    await fs.writeFile(index, '{corrupted');
    const third = f.analytics(); await third.refresh();
    assert.equal(reads, 1);
    assert.equal(third.snapshot({ period: 'today', nowMs: now }).totals.input, 100);
  } finally { fsSync.createReadStream = original; syncBuiltinESMExports(); }
});

test('a transient directory read failure retains explicitly labelled in-memory evidence', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), report(100)]);
  const a = f.analytics(); await a.refresh();
  const original = fs.readdir;
  fs.readdir = (async (...args: unknown[]) => {
    if (args[0] === path.join(f.home, 'sessions')) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return (original as (...args: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fs.readdir;
  try { await a.refresh(); } finally { fs.readdir = original; }
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'partial');
  assert.equal(s.totals.input, 100);
  assert.equal(s.coverage.filesIndexed, 0);
  assert.equal(s.coverage.filesUnreadable, 1);
  assert.match(s.message!, /retained index evidence/);
});

test('refresh is single-flight, yields during large files, and publishes no half-built snapshot', async t => {
  const f = await fixture(t);
  const entries: unknown[] = [meta('root')];
  for (let i = 1; i <= 3000; i++) {
    const item = report(i * 10, 10); item.timestamp = new Date(new Date(at(29, 12)).getTime() + i).toISOString(); entries.push(item);
  }
  await f.write('sessions/a.jsonl', entries);
  let changes = 0;
  const a = f.analytics(() => { changes++; });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const first = a.refresh();
  assert.equal(a.refresh(), first);
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).status, 'loading');
  await first; clearTimeout(timer);
  assert.equal(timerRan, true);
  assert.equal(changes, 1);
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 30000);
  const active = a.refresh(); a.close(); await active;
  assert.equal(changes, 1);
});

test('inherited counters remain baselines across a proven own-turn boundary, including cumulative-only tails', async t => {
  const f = await fixture(t);
  await f.write('sessions/child.jsonl', [meta('child'), started('own'), meta('parent', 28),
    report(100, 100, 28), context('own', 'high', 29, { turn_id: 'own' }),
    report(100, null), report(150, null, 29, 1)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 50);
  assert.equal(s.totals.events, 1);
  assert.equal(s.models[0].key, 'own');
});

test('a foreign context cannot steal ownership or teach an own turn id; owner thread markers restore it', async t => {
  const f = await fixture(t);
  const tagged = report(150, 50, 29, 1);
  Object.assign(tagged.payload, { thread_id: 'child' });
  await f.write('sessions/child.jsonl', [meta('child'),
    { ...started('foreign-turn'), payload: { type: 'task_started', turn_id: 'foreign-turn', thread_id: 'parent' } },
    context('copied', 'low', 29, { thread_id: 'parent' }), report(100),
    context('still-copied', 'high', 29, { turn_id: 'foreign-turn' }), report(100, 100, 29, 1),
    tagged, context('own-model', 'high'), report(200, 50, 29, 2)]);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 100);
  assert.equal(s.coverage.ambiguousEvents, 2);
  assert.equal(s.models.find(x => x.key === 'own-model')?.totals.input, 50);
  assert.equal(s.models.some(x => x.key === 'copied' || x.key === 'still-copied'), false);
});

test('append checkpoints persist parser state and reread only the unfinished JSONL tail after prefix verification', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/a.jsonl', [meta('root'), context('old', 'low'), report(100)], false);
  const a = f.analytics(); await a.refresh();
  const indexDir = path.join(f.home, 'hud/usage-index');
  const indexFile = path.join(indexDir, (await fs.readdir(indexDir))[0]);
  const before = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.ok(before.parsed.cursor.offset < before.parsed.bytes);
  const original = fsSync.createReadStream;
  const starts: Array<number | undefined> = [];
  fsSync.createReadStream = ((...args: Parameters<typeof original>) => {
    if (args[0] === file) starts.push(typeof args[1] === 'object' ? args[1]?.start : undefined);
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await fs.appendFile(file, '\n' + [context('new', 'high'), report(150, 50, 29, 1)].map(x => JSON.stringify(x)).join('\n') + '\n');
    const restarted = f.analytics(); await restarted.refresh();
    const s = restarted.snapshot({ period: 'today', nowMs: now });
    assert.equal(s.totals.input, 150);
    assert.equal(s.totals.events, 2);
    assert.equal(s.models.find(x => x.key === 'new')?.totals.input, 50);
    assert.deepEqual(starts, [undefined, before.parsed.cursor.offset]);
    const after = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.equal(after.parsed.cursor.offset, (await fs.stat(file)).size);
    assert.equal(after.parsed.cursor.observations, 2);
  } finally { fsSync.createReadStream = original; syncBuiltinESMExports(); }
});

test('an unfinished malformed token line recovers on append without retaining its old error or text', async t => {
  const f = await fixture(t);
  const encoded = JSON.stringify(report(100));
  const split = Math.floor(encoded.length / 2);
  const file = await f.write('sessions/a.jsonl', [meta('root'), context('model-中文', 'high'), encoded.slice(0, split)], false);
  const a = f.analytics(); await a.refresh();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).coverage.malformedLines, 1);
  await fs.appendFile(file, encoded.slice(split) + '\n');
  await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'ready');
  assert.equal(s.coverage.malformedLines, 0);
  assert.equal(s.totals.input, 100);
  assert.equal(s.models[0].key, 'model-中文');
});

test('same-inode growth with a rewritten prefix falls back to a complete parse', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/a.jsonl', [meta('root'), report(100)]);
  const inode = (await fs.stat(file)).ino;
  const a = f.analytics(); await a.refresh();
  await f.write('sessions/a.jsonl', [meta('other'), context('new', 'high'), report(50), report(100, 50, 29, 1)]);
  assert.equal((await fs.stat(file)).ino, inode);
  await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.totals.input, 100);
  assert.equal(s.totals.threads, 1);
  assert.equal(s.tasks[0].rootId, 'other');
});

test('a transient individual source read failure retains prior evidence with partial coverage', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/a.jsonl', [meta('root'), report(100)]);
  const a = f.analytics(); await a.refresh();
  const original = fs.stat;
  fs.stat = (async (...args: unknown[]) => {
    if (args[0] === file) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return (original as (...args: unknown[]) => Promise<unknown>)(...args);
  }) as typeof fs.stat;
  try { await a.refresh(); } finally { fs.stat = original; }
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'partial');
  assert.equal(s.totals.input, 100);
  assert.equal(s.coverage.filesDiscovered, 1);
  assert.equal(s.coverage.filesIndexed, 0);
  assert.equal(s.coverage.filesUnreadable, 1);
});

test('large verified append refresh yields while retaining one coherent generation', async t => {
  const f = await fixture(t);
  const entries: unknown[] = [meta('root')];
  for (let i = 0; i < 20000; i++) entries.push({ type: 'response_item', payload: { text: 'synthetic '.repeat(20) } });
  entries.push(report(100));
  const file = await f.write('sessions/a.jsonl', entries);
  const a = f.analytics(); await a.refresh();
  await fs.appendFile(file, JSON.stringify(report(150, 50, 29, 1)) + '\n');
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const pending = a.refresh();
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 100);
  await pending; clearTimeout(timer);
  assert.equal(timerRan, true);
  assert.equal(a.snapshot({ period: 'today', nowMs: now }).totals.input, 150);
});

test('snapshot repaints reuse aggregates between event boundaries while excluding future events', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [meta('root'), report(100), report(150, 50, 29, 10)]);
  const a = f.analytics(); await a.refresh();
  const firstMs = Date.parse(at(29, 12, 0, 2));
  const first = a.snapshot({ period: 'today', nowMs: firstMs });
  const repaint = a.snapshot({ period: 'today', nowMs: firstMs + 1000 });
  assert.equal(repaint.totals, first.totals);
  assert.equal(repaint.models, first.models);
  assert.equal(repaint.range.endMs, firstMs + 1000);
  assert.equal(repaint.totals.input, 100);
  const after = a.snapshot({ period: 'today', nowMs: Date.parse(at(29, 12, 0, 10)) });
  assert.equal(after.totals.input, 150);
  assert.notEqual(after.totals, first.totals);
});

for (const dimension of ['role', 'model', 'effort'] as const) {
  test(`conflicting duplicate ${dimension} evidence is unknown and partial regardless of file order`, async t => {
    const f = await fixture(t);
    const labels = dimension === 'role' ? ['worker', 'reviewer'] : dimension === 'model' ? ['model-a', 'model-b'] : ['low', 'high'];
    const records = (label: string) => [
      meta('root', 29, { agent_role: dimension === 'role' ? label : 'worker' }),
      context(dimension === 'model' ? label : 'model-a', dimension === 'effort' ? label : 'high'),
      report(100),
    ];
    // A third matching copy must not turn an already conflicting label back
    // into a known dimension. It is still only one token event.
    await f.write('sessions/a.jsonl', records(labels[0]));
    await f.write('sessions/b.jsonl', records(labels[1]));
    await f.write('archived_sessions/c.jsonl', records(labels[0]));
    const a = f.analytics(); await a.refresh();
    const first = a.snapshot({ period: 'today', nowMs: now });
    assert.equal(first.status, 'partial');
    assert.equal(first.coverage.ambiguousEvents, 1);
    assert.equal(first.totals.input, 100);
    assert.equal(first.totals.events, 1);
    assert.equal(first.totals.threads, 1);
    assert.deepEqual(first.roles.map(x => x.key), [dimension === 'role' ? null : 'worker']);
    assert.deepEqual(first.models.map(x => x.key), [dimension === 'model' ? null : 'model-a']);
    assert.deepEqual(first.efforts.map(x => x.key), [dimension === 'effort' ? null : 'high']);

    await f.write('sessions/a.jsonl', records(labels[1]));
    await f.write('sessions/b.jsonl', records(labels[0]));
    // The archive sorts before sessions: switch its label too, so the first
    // encountered evidence changes along with the session path ordering.
    await f.write('archived_sessions/c.jsonl', records(labels[1]));
    await a.refresh();
    const reordered = a.snapshot({ period: 'today', nowMs: now });
    assert.equal(reordered.status, first.status);
    assert.deepEqual(reordered.coverage, first.coverage);
    assert.deepEqual(reordered.totals, first.totals);
    assert.deepEqual(reordered.roles, first.roles);
    assert.deepEqual(reordered.models, first.models);
    assert.deepEqual(reordered.efforts, first.efforts);
    assert.deepEqual(reordered.tasks, first.tasks);
  });
}

test('identical duplicate role, model and effort labels stay ready without inflating usage', async t => {
  const f = await fixture(t);
  const records = [meta('root', 29, { agent_role: 'worker' }), context('model-a', 'high'), report(100)];
  await f.write('sessions/a.jsonl', records);
  await f.write('archived_sessions/a.jsonl', records);
  const a = f.analytics(); await a.refresh();
  const s = a.snapshot({ period: 'today', nowMs: now });
  assert.equal(s.status, 'ready');
  assert.equal(s.coverage.ambiguousEvents, 0);
  assert.equal(s.totals.input, 100);
  assert.equal(s.totals.events, 1);
  assert.equal(s.roles[0].key, 'worker');
  assert.equal(s.models[0].key, 'model-a');
  assert.equal(s.efforts[0].key, 'high');
});
