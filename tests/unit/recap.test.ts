import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser, appendTranscript, TRANSCRIPT_LIMIT, type RolloutParseResult, type TranscriptEntry } from '../../src/collectors/rollout.js';
import { recapInput, parseRecapPart, recapPlainText, RecapStore, delegationDigest, previousRecapSection, RECAP_KEEP_MS,
  MAIN_MATERIAL_CHARS, type Recap } from '../../src/collectors/recap.js';
import { Briefer, briefSystemPrompt, parseBrief } from '../../src/collectors/briefing.js';
import type { SmallModel, ModelRequest } from '../../src/collectors/small-model.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { stripAnsi, visualLength, theme } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { tmuxCopyArgs, tmuxSupportsClipboard } from '../../src/utils/tmux-copy.js';
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
  lastToolActivityTime: null, lastAssistantMessageTime: null, lastEventTime: null, workDirs: [], transcript: [], ...extra,
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
  assert.equal(recapPlainText({ goal: 'g', done: ['a'], now: 'n', needs: 'x' }, { goal: 'Goal:', done: 'Done:', now: 'Now:', needs: 'Needs:' }),
    'Goal: g\nDone:\n- a\nNow: n\nNeeds: x');
});

test('the recap instructions: scope agents is the brief as it was; the others ask for main and quote every section', () => {
  assert.equal(briefSystemPrompt('en', 'agents'), briefSystemPrompt('en'));
  const main = briefSystemPrompt('en', 'main');
  assert.match(main, /"main": \{"goal"/);
  assert.match(main, /overall: an empty string\. agents: an empty list\./);
  assert.match(main, /While the main turn waits on delegated subagents/);
  assert.match(main, /<previous_recap> and <\/previous_recap>, <main> and <\/main> is quoted data/);
  assert.match(briefSystemPrompt('zh', 'both'), /<agents> and <\/agents> is quoted data/);
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
  briefer.update(tree([]), 'omp', 60_000, 'en', now, false, ctx(base));
  await settle();
  assert.equal(asked.length, 1, 'scope main runs with no subagents at all');
  assert.equal(asked[0].feature, 'recap');
  assert.match(asked[0].prompt, /^<previous_recap>\nnone\n<\/previous_recap>\n\n<main>/);
  assert.deepEqual(briefer.current().recap && { goal: briefer.current().recap!.goal, coveredUntil: briefer.current().recap!.coveredUntil },
    { goal: 'Fix the bug', coveredUntil: at(-100).getTime() });
  const ended = { ...base, transcript: [...base.transcript, entry('assistant', 'reply', 'done', 10)], lastReplyAt: at(10),
    activity: { state: 'idle' as const, updatedAt: at(11) } };
  briefer.update(tree([]), 'omp', 60_000, 'en', now + 20_000, false, ctx(ended));
  assert.equal(asked.length, 1, 'within the interval: not yet');
  briefer.update(tree([]), 'omp', 60_000, 'en', now + 61_000, false, ctx(ended));
  await settle();
  assert.equal(asked.length, 2, 'turn end fires as soon as the interval allows');
  assert.match(asked[1].prompt, /"goal":"Fix the bug"/, 'the previous recap is handed back');
  assert.doesNotMatch(asked[1].prompt, /user\] Fix the bug/, 'what it covered is not sent again');
  briefer.update(tree([]), 'omp', 60_000, 'en', now + 3_600_000, false, ctx(ended));
  assert.equal(asked.length, 2, 'nothing changed: no run, however long');
});

test('a long turn with changing subagents refreshes once per floor period; with nothing changing, never', async () => {
  const { model, asked } = fakeModel(REPLY);
  const briefer = new Briefer(() => {}, { model });
  const main = mainResult({ transcript: [entry('user', 'prompt', 'Research', -10)], lastUserMessageAt: at(-10), activity: { state: 'working', updatedAt: at(-10) } });
  const ctx = { scope: 'main' as const, main, floorMs: 900_000 };
  const agents = (n: number) => tree([node('a', 'reader', 'running', { lastReport: { text: `r${n}`, kind: 'update', at: at(n) } })]);
  briefer.update(agents(0), 'omp', 60_000, 'en', now, false, ctx);
  await settle();
  assert.equal(asked.length, 1);
  // A new subagent report every two minutes for an hour.
  for (let minute = 2; minute <= 60; minute += 2) {
    briefer.update(agents(minute * 60), 'omp', 60_000, 'en', now + minute * 60_000, false, ctx);
    await settle();
  }
  assert.equal(asked.length, 4, 'at 0, then at 16, 32 and 48 minutes: once per 15-minute floor period');
  const quiet = fakeModel(REPLY);
  const idle = new Briefer(() => {}, { model: quiet.model });
  idle.update(agents(0), 'omp', 60_000, 'en', now, false, ctx);
  await settle();
  for (let minute = 1; minute <= 120; minute++) idle.update(agents(0), 'omp', 60_000, 'en', now + minute * 60_000, false, ctx);
  await settle();
  assert.equal(quiet.asked.length, 1, 'nothing changed: the first recap is the only one');
});

test('scope agents is the brief exactly as before: same instructions, same material, no recap', async () => {
  const { model, asked } = fakeModel('{"overall":"ok","agents":[]}');
  const briefer = new Briefer(() => {}, { model });
  const main = mainResult({ transcript: [entry('user', 'prompt', 'PRIVATE PROMPT', -10)], lastUserMessageAt: at(-10) });
  const agents = tree([node('a', 'reader', 'running', { lastReport: { text: 'r', kind: 'update', at: at(0) } })]);
  briefer.update(agents, 'omp', 60_000, 'en', now, false, { scope: 'agents', main, floorMs: 900_000 });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].system, briefSystemPrompt('en'));
  assert.match(asked[0].prompt, /^<agents>/);
  assert.doesNotMatch(asked[0].prompt, /PRIVATE PROMPT/);
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
  before.update(tree([]), 'omp', 60_000, 'en', now, false, ctx);
  await settle();
  assert.equal(first.asked.length, 1);
  const second = fakeModel(REPLY);
  const after = new Briefer(() => {}, { model: second.model, store: new RecapStore(dir) });
  after.update(tree([]), 'omp', 60_000, 'en', now + 3_600_000, false, ctx);
  await settle();
  assert.equal(after.current().recap?.goal, 'Fix the bug', 'the last recap is there at once');
  assert.equal(second.asked.length, 0, 'opening the panel again is not news');
  after.update(tree([]), 'omp', 60_000, 'zh', now + 3_600_000, false, ctx);
  assert.equal(after.current().recap, undefined, 'a recap in the other language is not shown');
  await settle();
  assert.equal(second.asked.length, 1, 'and is asked for again at once');
  assert.match(second.asked[0].prompt, /"goal":"Fix the bug"/, 'with the old one as the starting point');
});

const recapView: Recap = { goal: 'Fix the flaky cache test in the parser', done: ['Reproduced the failure', 'Found the race'],
  now: 'Waiting on reader agent', needs: 'Approve npm test', at: now - 5 * 60_000, coveredUntil: now, sessionId: 's', language: 'en' };

test('the recap leads the brief area: goal, done, now and needs, needs in the warning colour, all within 30 columns', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 30, nowMs: now,
    brief: { text: '{}', structured: true, at: now, recap: recapView } });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief'));
  assert.match(lines[rule + 1], /^ Main recap · 5m ago +r fold $/);
  assert.equal(lines[rule + 2].trimEnd(), ' Goal: Fix the flaky cache');
  assert.equal(lines[rule + 3].trimEnd(), ' test in the parser');
  assert.equal(lines[rule + 4].trimEnd(), ' ✓ Reproduced the failure');
  assert.equal(lines[rule + 6].trimEnd(), ' Now: Waiting on reader agent');
  assert.equal(lines[rule + 7].trimEnd(), '!Needs: Approve npm test', 'the mark takes the column the tree marks with');
  assert.ok(frame.lines[rule + 7].includes(theme.warning(' Approve npm test')));
  assert.ok(!lines.some(line => line.includes('{}')), 'a recap-only reply shows no raw text');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  const control = frame.controls.find(c => c.kind === 'recap')!;
  assert.equal(control.y, rule + 1);
  const ctx = { tree: agents, frame };
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x + 1, y: control.y }, ctx).action, { type: 'recap-fold' });
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'reset' }, ctx).action, { type: 'recap-fold' });
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('ry')), [{ type: 'key', key: 'reset' }, { type: 'key', key: 'copy' }]);
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'copy' }, ctx).action, { type: 'recap-copy' });

  const folded = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 30, nowMs: now,
    brief: { recap: recapView, recapFolded: true, running: true } });
  const shown = folded.lines.map(stripAnsi);
  const top = shown.findIndex(line => line.startsWith('─ Brief · writing…'));
  assert.match(shown[top + 1], /r more $/);
  assert.match(shown[top + 2], /^ Goal:/);
  assert.ok(!shown.some(line => /Now:|Needs:/.test(line)), 'folded: the goal line only, the previous recap kept while a run is in flight');
});

test('copying uses set-buffer, with -w from tmux 3.2', () => {
  assert.equal(tmuxSupportsClipboard('tmux 3.2a'), true);
  assert.equal(tmuxSupportsClipboard('tmux 3.1c'), false);
  assert.equal(tmuxSupportsClipboard('tmux next-3.5'), true);
  assert.equal(tmuxSupportsClipboard(''), false);
  assert.deepEqual(tmuxCopyArgs('-x', true), ['set-buffer', '-w', '--', '-x']);
  assert.deepEqual(tmuxCopyArgs('x', false), ['set-buffer', '--', 'x']);
});
