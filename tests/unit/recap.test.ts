import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser, appendTranscript, TRANSCRIPT_LIMIT, type RolloutParseResult, type TranscriptEntry } from '../../src/collectors/rollout.js';
import { recapInput, parseRecapPart, RecapStore, delegationDigest, previousRecapSection, RECAP_KEEP_MS,
  MAIN_MATERIAL_CHARS, type Recap } from '../../src/collectors/recap.js';
import { Briefer, briefSystemPrompt, parseBrief } from '../../src/collectors/briefing.js';
import type { SmallModel, ModelRequest } from '../../src/collectors/small-model.js';
import { initialMonitorState, renderMonitor, handleMonitorInput, flowLines } from '../../src/render/monitor.js';
import { recapFields } from '../../src/render/cards.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const at = (seconds: number) => new Date(now + seconds * 1000);
const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(now) });
const entry = (role: TranscriptEntry['role'], kind: TranscriptEntry['kind'], text: string, seconds: number): TranscriptEntry =>
  ({ role, kind, text, at: at(seconds) });
const mainResult = (extra: Partial<RolloutParseResult> = {}): RolloutParseResult => ({
  session: null, toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {}, lastUpdateTime: new Date(now) }, planProgress: null,
  tokenUsage: null, rateLimits: null, pendingApproval: null, subagents: [], compactCount: 0, lastCompactTime: null,
  lastToolActivityTime: null, lastAssistantMessageTime: null, lastEventTime: null, workDirs: [], transcript: [], events: [], quotaSamples: [], ...extra,
});

const row = (type: string, payload: object, seconds: number) => JSON.stringify({ timestamp: at(seconds).toISOString(), type, payload }) + '\n';
const user = (text: string, seconds: number) => row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, seconds);
const said = (text: string, phase: string, seconds: number) =>
  row('response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] }, seconds);

test('the transcript keeps the newest public entries across batches, strips injected context and never reads reasoning', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  fs.writeFileSync(file, row('session_meta', { id: 'S', timestamp: at(0).toISOString(), cwd: '/r' }, 0)
    + user('# AGENTS.md instructions for /r\n\nrules', 1) + user('<environment_context>x</environment_context>', 2)
    + user('Fix the parser', 3) + row('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'secret' }] }, 4)
    + said('Looking at it', 'commentary', 5) + said('private', 'analysis', 6));
  let result = (await parser.parse())!;
  assert.deepEqual(result.transcript.map(e => [e.role, e.kind, e.text]),
    [['user', 'prompt', 'Fix the parser'], ['assistant', 'update', 'Looking at it']]);
  assert.equal(result.firstUserMessage?.text, 'Fix the parser');
  assert.equal(result.lastUserMessageAt?.getTime(), at(3).getTime());
  assert.equal(result.lastReplyAt, undefined, 'commentary is not a final reply');

  let more = '';
  for (let i = 0; i < TRANSCRIPT_LIMIT; i++) more += said(`step ${i}`, 'commentary', 10 + i);
  more += said('Done: parser fixed', 'final_answer', 40);
  fs.appendFileSync(file, more);
  result = (await parser.parse())!;
  assert.equal(result.transcript.length, TRANSCRIPT_LIMIT);
  assert.equal(result.transcript.at(-1)?.kind, 'reply');
  assert.equal(result.transcript[0].text, 'step 1');
  assert.equal(result.transcriptDroppedAt?.getTime(), at(10).getTime(), 'the newest entry let go is remembered');
  assert.equal(result.firstUserMessage?.text, 'Fix the parser', 'the first request outlives the buffer');
  assert.equal(result.lastUserMessageAt?.getTime(), at(3).getTime());
  assert.equal(result.lastReplyAt?.getTime(), at(40).getTime());

  fs.writeFileSync(file, row('session_meta', { id: 'S', timestamp: at(0).toISOString(), cwd: '/r' }, 0) + user('again', 50));
  result = (await parser.parse())!;
  assert.deepEqual(result.transcript.map(e => e.text), ['again'], 'a truncated file starts the buffer over');
});

test('appendTranscript keeps the newest and the time of the newest let go', () => {
  const many = Array.from({ length: TRANSCRIPT_LIMIT + 2 }, (_, i) => entry('assistant', 'update', `e${i}`, i));
  const { entries, droppedAt } = appendTranscript([], many);
  assert.equal(entries.length, TRANSCRIPT_LIMIT);
  assert.equal(droppedAt?.getTime(), at(1).getTime());
});

test('recap material: only what is new since the last recap, facts, and a delegation digest with no task or report text', () => {
  const main = mainResult({
    transcript: [entry('user', 'prompt', 'Research the cache bug', 10), entry('assistant', 'update', 'Delegating to two agents', 20),
      entry('assistant', 'reply', 'Both agents are running', 30)],
    firstUserMessage: entry('user', 'prompt', 'Research the cache bug', 10),
    activity: { state: 'working', updatedAt: at(5), turnStartedAt: at(-1500) },
    planProgress: { steps: [{ step: 'Reproduce', status: 'completed' }, { step: 'Fix', status: 'in_progress' }], completedSteps: 1, totalSteps: 2, lastUpdate: at(0) },
    pendingApproval: { kind: 'exec', callId: 'c1', since: at(-60), summary: 'npm test' }, compactCount: 2,
  });
  const agents = tree([node('a', 'reader', 'running', { turnStartedAt: at(-1500), task: 'SECRET TASK', lastReport: { text: 'SECRET REPORT', kind: 'update', at: at(-10) } }),
    node('b', 'writer', 'completed', { statusAt: at(-120) })]);
  const input = recapInput(main, agents, { goal: 'g', done: [], now: 'n', coveredUntil: at(15).getTime() }, now)!;
  assert.match(input.section, /^<main>\n/);
  assert.match(input.section, /turn running 25m/);
  assert.match(input.section, /plan 1\/2 steps done:\n  \[completed\] Reproduce\n  \[in_progress\] Fix/);
  assert.match(input.section, /compacted 2 times/);
  assert.match(input.section, /waiting on the person for command approval: npm test/);
  assert.match(input.section, /reader: running, turn running 25m/);
  assert.match(input.section, /writer: completed, finished 2m ago/);
  assert.doesNotMatch(input.section, /SECRET/, 'scope main sends no subagent task or report text');
  assert.doesNotMatch(input.section, /Research the cache bug/, 'covered entries are not sent again');
  assert.match(input.section, /assistant commentary\] Delegating/);
  assert.match(input.section, /assistant final reply\] Both agents/);
  assert.equal(input.newestAt, at(30).getTime());
  assert.deepEqual(delegationDigest(tree([]), now), []);

  const fresh = recapInput(main, agents, null, now)!;
  assert.match(fresh.section, /user\] Research the cache bug/);
  assert.equal(previousRecapSection(null), '<previous_recap>\nnone\n</previous_recap>');
  assert.equal(recapInput(mainResult(), agents, null, now), null, 'nothing said yet: nothing to recap');
});

test('recap material says when entries were lost, and stays within its budget', () => {
  const long = 'x'.repeat(600);
  const transcript = Array.from({ length: TRANSCRIPT_LIMIT }, (_, i) => entry('assistant', 'update', long, 100 + i));
  const lost = recapInput(mainResult({ transcript, transcriptDroppedAt: at(99) }), tree([]), { goal: 'g', done: [], now: 'n', coveredUntil: at(50).getTime() }, now)!;
  assert.match(lost.section, /\(earlier entries omitted\)/);
  assert.ok(lost.section.length <= MAIN_MATERIAL_CHARS, String(lost.section.length));
  const short = recapInput(mainResult({ transcript: [entry('user', 'prompt', 'hi', 100)], transcriptDroppedAt: at(40) }), tree([]),
    { goal: 'g', done: [], now: 'n', coveredUntil: at(50).getTime() }, now)!;
  assert.doesNotMatch(short.section, /omitted/, 'what was let go had been folded in already');
});

test('commentary changes only the floor fingerprint; a request, a reply, a plan step or an approval change both', () => {
  const base = mainResult({ transcript: [entry('user', 'prompt', 'go', 10)], lastUserMessageAt: at(10), activity: { state: 'working', updatedAt: at(10) } });
  const first = recapInput(base, tree([]), null, now)!;
  const commentary = recapInput({ ...base, transcript: [...base.transcript, entry('assistant', 'update', 'working', 20)] }, tree([]), null, now + 5000)!;
  assert.equal(commentary.fingerprint, first.fingerprint);
  assert.notEqual(commentary.floorFingerprint, first.floorFingerprint);
  const agentMoved = recapInput(base, tree([node('a', 'x', 'completed', { statusAt: at(30) })]), null, now)!;
  assert.equal(agentMoved.fingerprint, first.fingerprint);
  assert.notEqual(agentMoved.floorFingerprint, first.floorFingerprint);
  for (const changed of [{ lastReplyAt: at(30) }, { lastUserMessageAt: at(40) }, { activity: { state: 'idle' as const, updatedAt: at(50) } },
    { pendingApproval: { kind: 'exec' as const, since: at(5) } },
    { planProgress: { steps: [], completedSteps: 1, totalSteps: 2, lastUpdate: at(0) } }]) {
    assert.notEqual(recapInput({ ...base, ...changed }, tree([]), null, now)!.fingerprint, first.fingerprint, JSON.stringify(changed));
  }
});

test('a recap reply is read tolerantly; a reply without a valid main keeps nothing of it', () => {
  assert.deepEqual(parseRecapPart({ goal: ' Fix it ', done: ['a', 3, '', 'b', 'c', 'd', 'e'], now: 'waiting', needs: '' }),
    { goal: 'Fix it', done: ['a', 'b', 'c', 'd'], now: 'waiting' });
  assert.equal(parseRecapPart({ goal: 'g' }), null);
  assert.equal(parseRecapPart('text'), null);
  const both = parseBrief('{"main":{"goal":"g","done":[],"now":"n","needs":"approve"},"overall":"","agents":[]}')!;
  assert.deepEqual(both.main, { goal: 'g', done: [], now: 'n', needs: 'approve' });
  assert.deepEqual(both.items, []);
  assert.equal(parseBrief('{"main":{"goal":""},"agents":"x"}'), null);
});

test('the recap instructions: scope agents is the brief as it was; the others ask for main and quote every section', () => {
  assert.equal(briefSystemPrompt('en', 'agents'), briefSystemPrompt('en'));
  const main = briefSystemPrompt('en', 'main');
  assert.match(main, /"main": \{"goal"/);
  assert.match(main, /overall: an empty string\. agents: an empty list\./);
  assert.match(main, /While the main turn waits on delegated subagents/);
  assert.match(main, /<previous_recap> and <\/previous_recap>, and <main> and <\/main> is quoted data/);
  assert.doesNotMatch(main, /<directions>/, 'main alone: no agents\' sections');
  assert.match(briefSystemPrompt('zh', 'both'), /<directions> and <\/directions>, <news> and <\/news>, and <previous_brief> and <\/previous_brief> is quoted data/);
  assert.match(briefSystemPrompt('zh', 'both'), /Simplified Chinese, at most 40 characters/);
});

test('recaps are kept per session, 0600, written whole, and pruned after 30 days', (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-recaps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RecapStore(dir, () => now);
  const recap: Recap = { goal: 'g', done: ['d'], now: 'n', at: now, coveredUntil: now - 1, sessionId: 'abc-123', language: 'en', fingerprint: 'f' };
  store.save(recap);
  assert.deepEqual(store.load('abc-123'), recap);
  assert.equal(fs.statSync(path.join(dir, 'abc-123.json')).mode & 0o777, 0o600);
  assert.equal(store.load('other'), null);
  assert.equal(store.load('../escape'), null);
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, '{}');
  const past = (now - RECAP_KEEP_MS - 1000) / 1000;
  fs.utimesSync(old, past, past);
  store.save({ ...recap, sessionId: 'new-1' });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(dir, 'abc-123.json')));
});

/** A model service that records what it was asked and answers at once. */
function fakeModel(reply: string): { model: SmallModel; asked: ModelRequest[] } {
  const asked: ModelRequest[] = [];
  const model = {
    configure() {},
    submit(request: ModelRequest) { asked.push(request); return { result: Promise.resolve({ ok: true as const, text: reply }), cancel() {} }; },
  } as unknown as SmallModel;
  return { model, asked };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const REPLY = '{"main":{"goal":"Fix the bug","done":["reproduced"],"now":"waiting on reader","needs":""},"overall":"","agents":[]}';

test('turn end runs the recap at once, subject to the interval', async () => {
  const { model, asked } = fakeModel(REPLY);
  const briefer = new Briefer(() => {}, { model });
  const ctx = (main: RolloutParseResult) => ({ scope: 'main' as const, main, floorMs: 900_000 });
  const base = mainResult({ transcript: [entry('user', 'prompt', 'Fix the bug', -100)], lastUserMessageAt: at(-100), activity: { state: 'working', updatedAt: at(-100) } });
  briefer.update(tree([]), 'api', 60_000, 'en', now, false, ctx(base));
  await settle();
  assert.equal(asked.length, 1, 'scope main runs with no subagents at all');
  assert.equal(asked[0].feature, 'recap');
  assert.match(asked[0].prompt, /^<previous_recap>\nnone\n<\/previous_recap>\n\n<main>/);
  assert.deepEqual(briefer.current().recap && { goal: briefer.current().recap!.goal, coveredUntil: briefer.current().recap!.coveredUntil },
    { goal: 'Fix the bug', coveredUntil: at(-100).getTime() });
  const ended = { ...base, transcript: [...base.transcript, entry('assistant', 'reply', 'done', 10)], lastReplyAt: at(10),
    activity: { state: 'idle' as const, updatedAt: at(11) } };
  briefer.update(tree([]), 'api', 60_000, 'en', now + 20_000, false, ctx(ended));
  assert.equal(asked.length, 1, 'within the interval: not yet');
  briefer.update(tree([]), 'api', 60_000, 'en', now + 61_000, false, ctx(ended));
  await settle();
  assert.equal(asked.length, 2, 'turn end fires as soon as the interval allows');
  assert.match(asked[1].prompt, /"goal":"Fix the bug"/, 'the previous recap is handed back');
  assert.doesNotMatch(asked[1].prompt, /user\] Fix the bug/, 'what it covered is not sent again');
  briefer.update(tree([]), 'api', 60_000, 'en', now + 3_600_000, false, ctx(ended));
  assert.equal(asked.length, 2, 'nothing changed: no run, however long');
});

test('a long turn with changing subagents refreshes once per floor period; with nothing changing, never', async () => {
  const { model, asked } = fakeModel(REPLY);
  const briefer = new Briefer(() => {}, { model });
  const main = mainResult({ transcript: [entry('user', 'prompt', 'Research', -10)], lastUserMessageAt: at(-10), activity: { state: 'working', updatedAt: at(-10) } });
  const ctx = { scope: 'main' as const, main, floorMs: 900_000 };
  const agents = (n: number) => tree([node('a', 'reader', 'running', { lastReport: { text: `r${n}`, kind: 'update', at: at(n) } })]);
  briefer.update(agents(0), 'api', 60_000, 'en', now, false, ctx);
  await settle();
  assert.equal(asked.length, 1);
  // A new subagent report every two minutes for an hour.
  for (let minute = 2; minute <= 60; minute += 2) {
    briefer.update(agents(minute * 60), 'api', 60_000, 'en', now + minute * 60_000, false, ctx);
    await settle();
  }
  assert.equal(asked.length, 4, 'at 0, then at 16, 32 and 48 minutes: once per 15-minute floor period');
  const quiet = fakeModel(REPLY);
  const idle = new Briefer(() => {}, { model: quiet.model });
  idle.update(agents(0), 'api', 60_000, 'en', now, false, ctx);
  await settle();
  for (let minute = 1; minute <= 120; minute++) idle.update(agents(0), 'api', 60_000, 'en', now + minute * 60_000, false, ctx);
  await settle();
  assert.equal(quiet.asked.length, 1, 'nothing changed: the first recap is the only one');
});

test('scope agents is the brief alone: its instructions, the agents\' material and nothing of the main session, no recap', async () => {
  const { model, asked } = fakeModel('{"overall":"ok","agents":[]}');
  const briefer = new Briefer(() => {}, { model });
  const main = mainResult({ transcript: [entry('user', 'prompt', 'PRIVATE PROMPT', -10)], lastUserMessageAt: at(-10) });
  const agents = tree([node('a', 'reader', 'running', { lastReport: { text: 'r', kind: 'update', at: at(0) } })]);
  briefer.update(agents, 'api', 60_000, 'en', now, false, { scope: 'agents', main, floorMs: 900_000 });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].system, briefSystemPrompt('en'));
  assert.match(asked[0].prompt, /^<directions>\n- reader: turn running/);
  assert.doesNotMatch(asked[0].prompt, /PRIVATE PROMPT|<main>/);
  assert.equal(briefer.current().recap, undefined);
  assert.equal(briefer.current().structured, undefined);
});

test('a stored recap is shown when the panel opens, and with scope main it is not paid for again', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-recap-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = mainResult({ transcript: [entry('user', 'prompt', 'Go', -10)], lastUserMessageAt: at(-10) });
  const ctx = { scope: 'main' as const, main, floorMs: 900_000 };
  const first = fakeModel(REPLY);
  const before = new Briefer(() => {}, { model: first.model, store: new RecapStore(dir) });
  before.update(tree([]), 'api', 60_000, 'en', now, false, ctx);
  await settle();
  assert.equal(first.asked.length, 1);
  const second = fakeModel(REPLY);
  const after = new Briefer(() => {}, { model: second.model, store: new RecapStore(dir) });
  after.update(tree([]), 'api', 60_000, 'en', now + 3_600_000, false, ctx);
  await settle();
  assert.equal(after.current().recap?.goal, 'Fix the bug', 'the last recap is there at once');
  assert.equal(second.asked.length, 0, 'opening the panel again is not news');
  after.update(tree([]), 'api', 60_000, 'zh', now + 3_600_000, false, ctx);
  assert.equal(after.current().recap, undefined, 'a recap in the other language is not shown');
  await settle();
  assert.equal(second.asked.length, 1, 'and is asked for again at once');
  assert.match(second.asked[0].prompt, /"goal":"Fix the bug"/, 'with the old one as the starting point');
});

test('with scope both, opening the panel again is not paid for either, and the line on the agents comes back', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-recap-both-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = mainResult({ transcript: [entry('user', 'prompt', 'Go', -10)], lastUserMessageAt: at(-10) });
  const ctx = { scope: 'both' as const, main, floorMs: 900_000 };
  const agents = tree([node('a', 'reader', 'running', { lastReport: { text: 'r', kind: 'update', at: at(0) } })]);
  const reply = REPLY.replace('"overall":""', '"overall":"one reading"');
  const first = fakeModel(reply);
  const before = new Briefer(() => {}, { model: first.model, store: new RecapStore(dir) });
  before.update(agents, 'api', 60_000, 'en', now, false, ctx);
  await settle();
  assert.equal(first.asked.filter(request => request.feature === 'recap').length, 1);
  const second = fakeModel(reply);
  const after = new Briefer(() => {}, { model: second.model, store: new RecapStore(dir) });
  after.update(agents, 'api', 60_000, 'en', now + 3_600_000, false, ctx);
  await settle();
  assert.equal(second.asked.filter(request => request.feature === 'recap').length, 0, 'nothing changed since it was written');
  assert.equal(after.current().recap?.goal, 'Fix the bug');
  assert.equal(after.current().overall, 'one reading');
  const shown = renderMonitor({ tree: agents, state: initialMonitorState(), width: 32, height: 40, nowMs: now + 3_600_000, brief: after.current() });
  // Beside a recap the sentence repeats its Now, so the panel shows the recap alone.
  assert.ok(shown.lines.some(line => stripAnsi(line).includes('Fix the bug')), 'the restored recap is on screen');
  assert.ok(!shown.lines.some(line => stripAnsi(line).includes('one reading')), 'beside it the sentence is not repeated');
  const alone = renderMonitor({ tree: agents, state: initialMonitorState(), width: 32, height: 40, nowMs: now + 3_600_000, brief: { ...after.current(), recap: undefined } });
  assert.ok(alone.lines.some(line => stripAnsi(line).includes('one reading')), 'without one it is on screen, though no reply text came with it');
  const moved = tree([node('a', 'reader', 'completed', { lastReport: { text: 'r2', kind: 'reply', at: at(3_000) } })]);
  after.update(moved, 'api', 60_000, 'en', now + 3_700_000, false, ctx);
  await settle();
  assert.equal(second.asked.filter(request => request.feature === 'recap').length, 1, 'news since then is still asked about');
});

test('wrapped text fills its lines: Chinese breaks between any two characters, a Latin word stays whole, and punctuation stays with its text', () => {
  // The brief's goal: every line full but the last.
  const goal = '整理测试数据补全文档，并在版本冻结前合并本轮改动';
  assert.deepEqual(flowLines(goal, 36), ['整理测试数据补全文档，并在版本冻结前', '合并本轮改动']);
  assert.deepEqual(flowLines(goal, 28), ['整理测试数据补全文档，并在版', '本冻结前合并本轮改动']);
  // A Latin word is not split, and keeps the spaces round it.
  assert.deepEqual(flowLines('核对 A/B/C/D 基准结果与独立复核', 27), ['核对 A/B/C/D 基准结果与独立', '复核']);
  // A "，" that would start a line takes the character before it down with it.
  assert.deepEqual(flowLines('一二三四五，六七', 10), ['一二三四', '五，六七']);
  // A "「" that would end a line goes down with what it opens.
  assert.deepEqual(flowLines('一二三四「五六」七', 10), ['一二三四', '「五六」七']);
  // A last line is never one character alone: the one before it comes down too.
  assert.deepEqual(flowLines('一二三四五', 8), ['一二三', '四五']);
  assert.deepEqual(flowLines('提交 release 说明并推送到 main 分支', 33), ['提交 release 说明并推送到 main', '分支']);
  assert.deepEqual(flowLines('一二三四五。', 8), ['一二三', '四五。']);
  // A word longer than a line is split.
  assert.deepEqual(flowLines('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(flowLines('short', 27), ['short']);
  const long = `${goal} release 说明并推送到 main 分支。「下一步」等待指令，`;
  for (let width = 2; width <= 40; width++) {
    const lines = flowLines(long, width);
    assert.equal(lines.join('').replace(/ /g, ''), long.replace(/ /g, ''), `${width}: nothing lost`);
    for (const line of lines) assert.ok(visualLength(line) <= width, `${width}: ${line}`);
    if (width >= 6) for (const line of lines.slice(1)) assert.doesNotMatch(line, /^[，。」]/, `${width}: ${lines.join('|')}`);
  }
});

test('the last done item fills its lines to the full width; only its last line keeps room for the dim +N', () => {
  const recap = (item: string): Recap => ({ goal: 'g', now: 'n', done: ['a', 'b', 'Reproduced it', item], at: now, coveredUntil: now, sessionId: 's', language: 'zh' });
  const done = (item: string, width: number) => recapFields(recap(item), width).find(field => field.id === 'done')!.lines.map(stripAnsi);
  // The count takes no room from the lines before the last.
  assert.deepEqual(done('提交 release 说明并推送到 main 分支', 33), ['✓ Reproduced it', '  提交 release 说明并推送到 main', '  分支 +2']);
  // A last line too full for the count is filled again short of it; one with room keeps it.
  assert.deepEqual(done('一二三四五六七八九十甲乙丙丁戊己', 34), ['✓ Reproduced it', '  一二三四五六七八九十甲乙丙丁', '  戊己 +2']);
  assert.deepEqual(done('一二三四五六七八九十甲乙丙丁戊己', 37), ['✓ Reproduced it', '  一二三四五六七八九十甲乙丙丁戊己 +2']);
  // Cut short, the item still ends in the count.
  const cut = done('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯', 20);
  assert.equal(cut.at(-1), '  十甲乙丙丁戊 … +2');
  for (const line of cut) assert.ok(visualLength(line) <= 20, line);
});

const recapView: Recap = { goal: 'Fix the flaky cache test in the parser', done: ['Reproduced the failure', 'Found the race'],
  now: 'Waiting on reader agent', needs: 'Approve npm test', at: now - 5 * 60_000, coveredUntil: now, sessionId: 's', language: 'en' };

test('compact: the recap leads the brief area, labelled goal, done, now and needs, needs in the warning colour, all within 30 columns', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 30, nowMs: now,
    brief: { text: '{}', structured: true, at: now, recap: recapView } });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief'));
  // The header names it and its age; there is no fold switch any more.
  assert.equal(lines[rule + 1].trimEnd(), ' Main recap · 5m ago');
  // Each field a label inline, its value after it, its wrapped lines hanging
  // under the value; no blank lines between fields; needs first.
  assert.deepEqual(lines.slice(rule + 2, rule + 8).map(line => line.trimEnd()), [
    ' ! Approve npm test', ' ◎ Fix the flaky cache test in', '   the parser', ' ▸ Waiting on reader agent',
    ' ✓ Reproduced the failure', '   Found the race']);
  assert.ok(frame.lines[rule + 2].includes(theme.warning('Approve npm test')));
  assert.ok(frame.lines[rule + 2].includes(theme.warning('!')), 'the needs label is in the warning colour too');
  assert.ok(!lines.some(line => line.includes('{}')), 'a recap-only reply shows no raw text');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  assert.ok(!frame.controls.some(c => c.y === rule + 1), 'the header is not a switch');
  // r now cycles the status card; y is no key at all.
  const ctx = { tree: agents, frame };
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'reset' }, ctx).action, { type: 'status-level' });
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('ry')), [{ type: 'key', key: 'reset' }]);

  const writing = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 30, nowMs: now,
    brief: { recap: recapView, running: true } }).lines.map(stripAnsi);
  const top = writing.findIndex(line => line.startsWith('─ Brief · writing…'));
  assert.match(writing[top + 3], /^ ◎ Fix/, 'the previous recap is kept while a run is in flight');
});

test('rich: the recap is in the status card, needs in the warning colour, every width within bounds', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const state = { ...initialMonitorState(), style: 'rich' as const };
  const status = () => ({ tone: 'working' as const, alerts: [], state: '▸', rate: '', tasks: '', model: '', age: '', place: 'proj',
    others: '', forecast: '', reset: '', cache: '' });
  for (const width of [20, 24, 30, 32, 44, 60]) {
    const frame = renderMonitor({ tree: agents, state, width, height: 40, nowMs: now, brief: { recap: recapView }, status });
    assert.ok(frame.lines.every(line => visualLength(line) <= width), `${width}`);
  }
  const frame = renderMonitor({ tree: agents, state, width: 48, height: 40, nowMs: now, brief: { recap: recapView }, status });
  const lines = frame.lines.map(stripAnsi);
  assert.match(lines[frame.statusCard!.y], /^ ! ▸/, 'the needs mark leads the band');
  assert.match(lines[frame.statusCard!.y], /~5m/, 'the brief\'s state is data at the band\'s end');
  assert.equal(lines[frame.statusCard!.y + 1].trimEnd(), '│ ! Approve npm test');
  assert.ok(frame.lines[frame.statusCard!.y + 1].includes(theme.warning('!')));
  assert.ok(!lines.some(line => /^┌ Main recap|^─ Brief/.test(line)), 'no recap card, no brief rule');
  const calm = renderMonitor({ tree: agents, state, width: 48, height: 40, nowMs: now, brief: { recap: { ...recapView, needs: '' } }, status });
  assert.ok(!calm.lines.map(stripAnsi).some(line => /^│ ! /.test(line)), 'no needs: absent');
});
