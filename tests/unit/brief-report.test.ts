import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Briefer, BRIEF_SHAPE_ERROR, briefMaterial, briefSystemPrompt, reportFacts, reportText, newsSection, previousBriefSection,
  agentsPrompt, REPORT_BYTES } from '../../src/collectors/briefing.js';
import { RESULT_RAW_CHARS } from '../../src/collectors/agent-stages.js';
import { AgentLog, type AgentLogEntry } from '../../src/collectors/agent-log.js';
import { recapInput } from '../../src/collectors/recap.js';
import { dryRunText } from '../../src/collectors/brief-dry-run.js';
import { resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';
import { defaultSettings } from '../../src/settings.js';
import { looksAutomatic } from '../../src/utils/task-text.js';
import type { SmallModel, ModelRequest } from '../../src/collectors/small-model.js';
import type { RolloutParseResult } from '../../src/collectors/rollout.js';
import type { AgentStage, SubagentTree, SubagentTreeNode } from '../../src/types.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const stage = (start: number, end: number | undefined, status: AgentStage['status'], extra: Partial<AgentStage> = {}): AgentStage =>
  ({ startedAt: ago(start), ...(end !== undefined ? { endedAt: ago(end) } : {}), status, ...extra });
const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], startedAt: ago(300), ...extra });
const kid = (id: string, name: string, role: string, status: SubagentTreeNode['status'], minutes: number, extra: Partial<SubagentTreeNode> = {}) =>
  node(id, name, status, { depth: 2, role, agentPath: `/root/lead/${name}`, statusAt: ago(minutes), ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(NOW) });
const ROLES = new Set(['critic']);

/** A lead at work with subtasks, a helper that works for it, a failure, one just finished and one long finished. */
function session(): SubagentTree {
  const lead = node('lead', 'parser_lead', 'running', { role: 'team-lead', agentPath: '/root/parser_lead', stageCount: 3, turnStartedAt: ago(12),
    lastEventAt: ago(1), action: { name: 'exec', text: 'npm run bench -- --corpus 50mb', at: ago(1) },
    lastReport: { text: 'Benchmark   running\non the 50 MB corpus.', kind: 'update', at: ago(2) },
    stages: [
      stage(200, 150, 'done', { result: 'Mapped the parser: recovery lives in three places.' }),
      stage(70, 40, 'done', { by: { type: 'NEW_TASK', sender: '/root' }, result: 'Rewrote error recovery; 3 of 3 new tests pass.' }),
      stage(12, undefined, 'running', { by: { type: 'NEW_TASK', sender: '/root' }, intent: 'I will wire the streaming API through the new recovery path.',
        peers: { '/root/critic': 3, '/root': 1, '/root/parser_lead/impl_b': 2 } }),
    ],
    children: [
      kid('i1', 'impl_a', 'team-implementer', 'completed', 50),
      kid('i2', 'impl_b', 'team-implementer', 'running', 0, { statusAt: undefined, turnStartedAt: ago(5) }),
      kid('r1', 'review_a', 'team-reviewer', 'completed', 42),
      kid('c2', 'critic_b', 'team-critic', 'completed', 20, { stages: [stage(30, 20, 'done', { result: 'Boundaries hold.' })] }),
    ] });
  const critic = node('critic', 'critic', 'completed', { role: 'team-critic', agentPath: '/root/critic', statusAt: ago(25), stageCount: 1,
    peers: { '/root/parser_lead': 3 }, stages: [stage(60, 25, 'done', { by: { type: 'MESSAGE', sender: '/root/parser_lead' }, result: 'Token boundaries hold.' })] });
  const broken = node('broken', 'broken_lead', 'error', { role: 'team-lead', statusAt: ago(5), stageCount: 1, stages: [stage(20, 5, 'failed')] });
  const bench = node('bench', 'bench_lead', 'completed', { statusAt: ago(20), task: 'Benchmark the tokenizer on ASCII and CJK', stageCount: 1,
    stages: [stage(130, 20, 'done', { result: 'ASCII 1.8 GB/s, CJK 0.6 GB/s.' })] });
  const docs = node('docs', 'docs_writer', 'completed', { statusAt: ago(300), stageCount: 2,
    stages: [stage(500, 450, 'done', { result: 'Outlined the docs.' }), stage(400, 300, 'done', { result: 'Added docs/streaming.md with three examples.' })] });
  return tree([docs, lead, bench, critic, broken]);
}

const report = (t: SubagentTree, logs?: Map<string, AgentLogEntry[]>, budget?: number) =>
  reportText(reportFacts(t, logs, ROLES, NOW)!, t, logs, ROLES, NOW, budget);

test('the report lists each agent the main session started, those that need a look first, a helper after its lead', () => {
  const text = report(session());
  const lines = text.split('\n');
  assert.equal(lines[0], '<directions>');
  assert.equal(lines.at(-1), '</directions>');
  assert.deepEqual(lines.filter(line => line.startsWith('- ')).map(line => line.slice(2).split(/[ :]/)[0]),
    ['broken_lead', 'parser_lead', 'critic', 'bench_lead', 'docs_writer']);
  assert.match(text, /- parser_lead \[team-lead\]: stage 3, running 12m\n/);
  assert.match(text, /  assigned by: NEW_TASK from the main session\n/);
  assert.match(text, /  took on \(its own words, its first update of the stage\): I will wire the streaming API through the new recovery path\.\n/);
  assert.match(text, /  latest update \(2m ago\): Benchmark running on the 50 MB corpus\.\n/);
  assert.match(text, /  doing now: npm run bench -- --corpus 50mb \(for 1m\)\n/);
  assert.match(text, /  last result \(stage 2, done 40m ago\): Rewrote error recovery; 3 of 3 new tests pass\.\n/);
  assert.match(text, /  earlier result \(stage 1, 2\.5h ago\): Mapped the parser/);
  assert.match(text, /  subtasks: team-critic 1 done · team-implementer 1 done, 1 running · team-reviewer 1 done\n/);
  assert.match(text, /  important subtask critic_b \[team-critic\]: done 20m ago; returned: Boundaries hold\.\n/, 'a role named in the setting');
  assert.doesNotMatch(text, /important subtask impl_/, 'routine subtasks are only counted');
  assert.match(text, /  messages this stage from: critic ×3\n/, 'not the main session, not its own subtasks');
  assert.match(text, /- critic \[team-critic\]: finished 25m ago after 1 stage\n  works for: parser_lead\n  assigned by: MESSAGE from parser_lead\n  result \(stage 1, done 25m ago\): Token boundaries hold\.\n/);
  assert.match(text, /- bench_lead: finished 20m ago after 1 stage\n  task: Benchmark the tokenizer on ASCII and CJK\n  result \(stage 1, done 20m ago\)/,
    'a task from a user-role message stands in for the agent\'s own words');
  assert.match(text, /- broken_lead \[team-lead\]: failed 5m ago in stage 1\n  stage 1 failed 5m ago with no answer\n/);
  assert.match(text, /- docs_writer: finished 5\.0h ago after 2 stages\n  last result: Added docs\/streaming\.md with three examples\.\n<\/directions>$/,
    'long finished: its last answer and nothing more');
});

test('a long answer goes as its digest, else its head and tail; a failed subtask puts its lead first', () => {
  const long = `Opening ${'x'.repeat(3000)} closing words`;
  const t = tree([node('lead', 'lead', 'running', { stageCount: 2, stages: [stage(60, 30, 'done', { result: long }), stage(30, undefined, 'running')],
    children: [kid('s1', 'scout_a', 'team-scout', 'error', 3)] }), node('calm', 'calm', 'running', { stageCount: 1, stages: [stage(10, undefined, 'running')] })]);
  const cut = report(t);
  assert.match(cut, /last result \(stage 1, done 30m ago\): Opening x+ \[…\] x+ closing words/);
  assert.ok(cut.split('\n').find(line => line.includes('last result'))!.length < RESULT_RAW_CHARS + 80);
  const logs = new Map<string, AgentLogEntry[]>([['lead', [{ at: ago(30).getTime(), kind: 'digest', text: 'Found the race · Basis: read cache.ts' }]],
    ['s1', [{ at: ago(3).getTime(), kind: 'cause', text: 'The fixture file is missing' }]]]);
  const digested = report(t, logs);
  assert.match(digested, /last result \(stage 1, done 30m ago, a model-written digest of a long answer\): Found the race · Basis: read cache\.ts/);
  assert.match(digested, /important subtask scout_a \[team-scout\]: failed 3m ago; cause \(model-written\): The fixture file is missing/);
  assert.equal(digested.split('\n')[1].startsWith('- lead'), true, 'a failed subtask makes its lead need a look');
});

test('clocks are not news; commentary, the action and routine subtasks wait for the floor; stages and failures do not', () => {
  const base = session();
  const facts = reportFacts(base, undefined, ROLES, NOW)!;
  const later = reportFacts(base, undefined, ROLES, NOW + 600_000)!;
  assert.equal(later.fingerprint, facts.fingerprint, 'time passing changes nothing');
  assert.equal(later.floorFingerprint, facts.floorFingerprint);
  const lead = base.nodes[1];
  const variants: Array<[string, Partial<SubagentTreeNode>, 'floor' | 'fast']> = [
    ['commentary', { lastReport: { text: 'new', kind: 'update', at: ago(0) } }, 'floor'],
    ['the action', { action: { name: 'exec', text: 'npm test', at: ago(0) } }, 'floor'],
    ['a routine subtask finishing', { children: lead.children.map(child => child.id === 'i2' ? { ...child, status: 'completed' as const, statusAt: ago(0) } : child) }, 'floor'],
    ['a stage ending', { stages: [...lead.stages!.slice(0, 2), { ...lead.stages![2], status: 'done', endedAt: ago(0), result: 'ok' }] }, 'fast'],
    ['a subtask failing', { children: lead.children.map(child => child.id === 'i2' ? { ...child, status: 'error' as const, statusAt: ago(0) } : child) }, 'fast'],
    ['an important subtask moving on', { children: lead.children.map(child => child.id === 'c2' ? { ...child, status: 'running' as const } : child) }, 'fast'],
  ];
  for (const [what, change, kind] of variants) {
    const changed = tree(base.nodes.map(n => n.id === 'lead' ? { ...n, ...change } : n));
    const next = reportFacts(changed, undefined, ROLES, NOW)!;
    assert.equal(next.fingerprint !== facts.fingerprint, kind === 'fast', `${what}: fast`);
    assert.notEqual(next.floorFingerprint, facts.floorFingerprint, `${what}: floor`);
  }
  const flagged = new Map<string, AgentLogEntry[]>([['i1', [{ at: NOW, kind: 'note', text: 'look', attention: true }]]]);
  assert.equal(reportFacts(base, flagged, ROLES, NOW)!.fingerprint, facts.fingerprint, 'a brief\'s own flag is not news for the next one');
});

test('past its budget the report gives way in order, from the bottom up, and never cuts what needs a look', () => {
  const many = Array.from({ length: 60 }, (_, i) => node(`old${i}`, `old_${i}`, 'completed', { statusAt: ago(200 + i), stageCount: 1,
    stages: [stage(300 + i, 200 + i, 'done', { result: `Result ${i} ${'r'.repeat(400)}` })] }));
  const crowded = tree([...session().nodes, ...many]);
  assert.ok(Buffer.byteLength(report(crowded, undefined, 1_000_000)) > REPORT_BYTES, 'the whole report is over the budget');
  const fitted = report(crowded);
  assert.ok(Buffer.byteLength(fitted) <= REPORT_BYTES, `${Buffer.byteLength(fitted)} bytes`);
  assert.match(fitted, /- old_59: finished/, 'an entry keeps its head while its answer can go instead');
  assert.doesNotMatch(fitted, /last result: Result 59 /, 'the bottom of the list gives way first');
  assert.match(fitted, /last result: Result 0 /, 'and only as much as the budget needs');
  assert.match(fitted, /earlier result \(stage 1/);
  const tight = report(crowded, undefined, 2500);
  assert.match(tight, /\(\d+ more agents not listed\)\n<\/directions>$/);
  assert.doesNotMatch(tight, /old_59/, 'the long finished go before what those at work are saying');
  assert.match(tight, /latest update \(2m ago\)/);

  const plain = session();
  const full = Buffer.byteLength(report(plain, undefined, 1_000_000));
  const goneAt = (pattern: RegExp) => { for (let budget = full; budget > 200; budget -= 10) if (!pattern.test(report(plain, undefined, budget))) return budget; return 0; };
  const order: Array<[string, RegExp]> = [['earlier answers', /earlier result/], ['a one-off agent\'s details', /task: Benchmark/],
    ['the long finished', /- docs_writer/], ['commentary', /latest update/], ['the subtasks named', /important subtask/],
    ['the just finished', /- bench_lead/], ['the details of those at work', /doing now/], ['those at work', /- parser_lead/]];
  const budgets = order.map(([, pattern]) => goneAt(pattern));
  for (let i = 1; i < order.length; i++) assert.ok(budgets[i] < budgets[i - 1], `${order[i][0]} after ${order[i - 1][0]}: ${budgets}`);
  assert.match(report(plain, undefined, 100), /^<directions>\n- broken_lead \[team-lead\]: failed 5m ago in stage 1\n  stage 1 failed 5m ago with no answer\n\(4 more agents not listed\)/,
    'a failure is never cut');
});

test('the news since the previous brief: stages begun and ended, failures, and only the subtasks that matter', () => {
  const t = session();
  assert.equal(newsSection(t, null, ROLES, NOW), '<news>\nno previous brief\n</news>');
  const news = newsSection(t, ago(45).getTime(), ROLES, NOW);
  assert.equal(news, ['<news>', 'since the previous brief (45m ago):',
    '- 40m ago: parser_lead finished stage 2',
    '- 25m ago: critic finished stage 1',
    '- 20m ago: critic_b (subtask of parser_lead) finished stage 1',
    '- 20m ago: bench_lead finished stage 1',
    '- 20m ago: broken_lead started stage 1',
    '- 12m ago: parser_lead started stage 3, NEW_TASK from the main session',
    '- 5m ago: broken_lead failed stage 1',
    '</news>'].join('\n'));
  assert.match(newsSection(t, NOW, ROLES, NOW), /nothing new/);
});

test('the previous brief: its line on the whole and each listed agent\'s newest note', () => {
  const t = session();
  const facts = reportFacts(t, undefined, ROLES, NOW)!;
  assert.equal(previousBriefSection(facts, undefined, undefined), '<previous_brief>\nnone\n</previous_brief>');
  const logs = new Map<string, AgentLogEntry[]>([
    ['lead', [{ at: 1, kind: 'note', text: 'old note' }, { at: 2, kind: 'note', text: 'wiring streaming' }, { at: 3, kind: 'report', text: 'x' }]],
    ['c2', [{ at: 2, kind: 'note', text: 'verdict in', attention: true }]],
  ]);
  assert.equal(previousBriefSection(facts, logs, 'Parser work is on track.'), `<previous_brief>\n${JSON.stringify({ overall: 'Parser work is on track.', agents: [
    { agent: 'parser_lead', attention: false, note: 'wiring streaming' }, { agent: 'critic_b', attention: true, note: 'verdict in' }] })}\n</previous_brief>`);
  const prompt = agentsPrompt(facts, t, { logs, roles: ROLES, since: ago(45).getTime(), overall: 'Parser work is on track.', now: NOW });
  assert.deepEqual(prompt.split('\n').filter(line => /^<\/?[a-z_]+>$/.test(line)),
    ['<directions>', '</directions>', '<news>', '</news>', '<previous_brief>', '</previous_brief>']);
});

function fakeModel(replies: string[]): { model: SmallModel; asked: ModelRequest[] } {
  const asked: ModelRequest[] = [];
  const model = {
    configure() {},
    submit(request: ModelRequest) {
      asked.push(request);
      const text = replies[Math.min(asked.length - 1, replies.length - 1)];
      return { result: Promise.resolve({ ok: true as const, text }), cancel() {} };
    },
  } as unknown as SmallModel;
  return { model, asked };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('notes come with the brief alone: an agent the reply leaves out keeps its note, and the next run carries the news and the brief', async () => {
  const { model, asked } = fakeModel([
    '{"overall":"Parser work is on track.","agents":[{"agent":"parser_lead","attention":false,"note":"wiring streaming"},{"agent":"bench_lead","attention":false,"note":"numbers in"}]}',
    '{"overall":"Streaming is in.","agents":[{"agent":"parser_lead","attention":false,"note":"streaming done"}]}',
  ]);
  const log = new AgentLog();
  const briefer = new Briefer(() => {}, { model, log });
  const t = session();
  briefer.update(t, 'omp', 300_000, 'en', NOW);
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].feature, 'brief');
  assert.equal(asked[0].system, briefSystemPrompt('en'));
  assert.match(asked[0].prompt, /<news>\nno previous brief\n<\/news>\n\n<previous_brief>\nnone\n<\/previous_brief>$/);
  const note = (id: string) => log.latest(id, new Set(['note']))?.text;
  assert.deepEqual([note('lead'), note('bench')], ['wiring streaming', 'numbers in']);

  const lead = t.nodes[1];
  const talking = tree(t.nodes.map(n => n === lead ? { ...lead, lastReport: { text: 'still going', kind: 'update', at: new Date(NOW + 60_000) } } : n));
  briefer.update(talking, 'omp', 300_000, 'en', NOW + 300_000);
  assert.equal(asked.length, 1, 'commentary alone waits for the floor');
  const ended = tree(t.nodes.map(n => n === lead ? { ...lead, stages: [...lead.stages!.slice(0, 2), { ...lead.stages![2], status: 'done' as const,
    endedAt: new Date(NOW + 200_000), result: 'Streaming wired.' }] } : n));
  briefer.update(ended, 'omp', 300_000, 'en', NOW + 300_000);
  await settle();
  assert.equal(asked.length, 2, 'a stage that ended: at once, the interval past');
  assert.match(asked[1].prompt, /<news>\nsince the previous brief \(5m ago\):\n- 2m ago: parser_lead finished stage 3\n<\/news>/);
  assert.match(asked[1].prompt, /"overall":"Parser work is on track\."/);
  assert.match(asked[1].prompt, /\{"agent":"bench_lead","attention":false,"note":"numbers in"\}/);
  assert.deepEqual([note('lead'), note('bench')], ['streaming done', 'numbers in'], 'left out: the note stays');
  assert.equal(briefer.current().overall, 'Streaming is in.');

  const quiet = tree(ended.nodes.map(n => n.id === 'lead' ? { ...n, lastReport: { text: 'tidying', kind: 'update' as const, at: new Date(NOW + 400_000) } } : n));
  briefer.update(quiet, 'omp', 300_000, 'en', NOW + 300_000 + 15 * 60_000 - 1);
  assert.equal(asked.length, 2);
  briefer.update(quiet, 'omp', 300_000, 'en', NOW + 300_000 + 15 * 60_000);
  await settle();
  assert.equal(asked.length, 3, 'the floor: fifteen minutes by default');
});

test('a reply that is not the JSON asked for is asked for once more; twice wrong, the last brief stays', async () => {
  const t = session();
  const { model, asked } = fakeModel(['Sure! Here is the brief: everything is fine.', '{"overall":"Fixed.","agents":[]}']);
  const briefer = new Briefer(() => {}, { model });
  briefer.update(t, 'omp', 300_000, 'en', NOW);
  await settle(); await settle();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].system, asked[0].system, 'the same instructions');
  assert.match(asked[1].prompt, /<reply>\nSure! Here is the brief: everything is fine\.\n<\/reply>/);
  assert.equal(briefer.current().overall, 'Fixed.');
  assert.equal(briefer.current().error, undefined);

  const wrong = fakeModel(['{"overall":"First."}'.replace('}', ',"agents":[]}'), 'still prose', 'prose again']);
  const kept = new Briefer(() => {}, { model: wrong.model });
  kept.update(t, 'omp', 300_000, 'en', NOW);
  await settle();
  assert.equal(kept.current().overall, 'First.');
  kept.update(tree(t.nodes.slice(1)), 'omp', 300_000, 'en', NOW + 300_000);
  await settle(); await settle();
  assert.equal(wrong.asked.length, 3);
  assert.equal(kept.current().overall, 'First.', 'the last brief stays');
  assert.equal(kept.current().error, BRIEF_SHAPE_ERROR);
  assert.equal(kept.current().running, false);
});

const mainResult = (extra: Partial<RolloutParseResult> = {}): RolloutParseResult => ({
  session: null, toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {}, lastUpdateTime: new Date(NOW) }, planProgress: null,
  tokenUsage: null, rateLimits: null, pendingApproval: null, subagents: [], compactCount: 0, lastCompactTime: null,
  lastToolActivityTime: null, lastAssistantMessageTime: null, lastEventTime: null, workDirs: [], transcript: [], events: [], quotaSamples: [], ...extra,
});

test('with the main session in scope: the recap material, the goal set in Codex, then the agents\' sections, each quoted', () => {
  const main = mainResult({ transcript: [{ role: 'user', kind: 'prompt', text: 'Ship the streaming parser', at: ago(100) },
    { role: 'user', kind: 'prompt', text: '[hook-wait 30s] continue', at: ago(3) }], lastUserMessageAt: ago(100) });
  const goal = { objective: 'Ship streaming parsing with recovery', status: 'active' };
  const material = briefMaterial(session(), { scope: 'both', language: 'en', main, recap: null, roles: ROLES, goal, since: null, now: NOW })!;
  const { system, prompt } = material.write();
  assert.equal(material.feature, 'recap');
  assert.match(prompt, /^<previous_recap>\nnone\n<\/previous_recap>\n\n<main>\ngoal set in Codex \(active\): Ship streaming parsing with recovery\n/);
  assert.match(prompt, /\[3m ago, user, possibly automatic\] \[hook-wait 30s\] continue/);
  assert.match(prompt, /\[1\.7h ago, user\] Ship the streaming parser/);
  assert.match(prompt, /<\/main>\n\n<directions>\n/);
  for (const tag of ['previous_recap', 'main', 'directions', 'news', 'previous_brief']) assert.match(system, new RegExp(`<${tag}> and </${tag}>`), tag);
  assert.match(system, /possibly automatic/);
  const withoutGoal = recapInput(main, session(), null, NOW)!;
  assert.notEqual(withoutGoal.fingerprint, recapInput(main, session(), null, NOW, goal)!.fingerprint, 'a goal set or changed is news');
  const main2 = briefMaterial(session(), { scope: 'main', language: 'en', main, recap: null, since: null, now: NOW })!.write();
  assert.doesNotMatch(main2.prompt, /<directions>|parser_lead stage|took on/, 'main alone: no agent text');
  assert.doesNotMatch(main2.system, /<directions>/);
});

test('a bracketed user message may be a tool\'s; it is marked, and it is not a new request', () => {
  assert.equal(looksAutomatic('[hook-wait 30s] continue'), true);
  assert.equal(looksAutomatic('  [peer] lead finished'), true);
  assert.equal(looksAutomatic('Fix [the] bug'), false);
  assert.equal(looksAutomatic('[]'), false);
});

test('the dry run prints what would be sent and writes nothing', async (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-dry-run-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.CODEX_SESSIONS_PATH;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH; else process.env.CODEX_SESSIONS_PATH = previous; resetSubagentLinkCache(); });
  const now = new Date();
  const day = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  process.env.CODEX_SESSIONS_PATH = path.join(home, 'sessions');
  resetSubagentLinkCache();
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  const near = (seconds: number) => new Date(now.getTime() - 120_000 + seconds * 1000).toISOString();
  const stamp = now.toISOString().slice(0, 10);
  fs.writeFileSync(path.join(day, `rollout-${stamp}T00-00-00-00000000-0000-0000-0000-00000000aaaa.jsonl`),
    line({ timestamp: near(0), type: 'session_meta', payload: { id: '00000000-0000-0000-0000-00000000aaaa', cwd, timestamp: near(0) } })
    + line({ timestamp: near(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Map the parser' }] } }));
  fs.writeFileSync(path.join(day, `rollout-${stamp}T00-00-01-00000000-0000-0000-0000-00000000bbbb.jsonl`),
    line({ timestamp: near(2), type: 'session_meta', payload: { id: '00000000-0000-0000-0000-00000000bbbb', cwd, timestamp: near(2),
      source: { subagent: { thread_spawn: { parent_thread_id: '00000000-0000-0000-0000-00000000aaaa', agent_path: '/root/mapper', agent_role: 'team-scout' } } } } })
    + line({ timestamp: near(3), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })
    + line({ timestamp: near(4), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading the parser first.' }] } }));
  const hud = path.join(home, 'hud');
  const before = fs.readdirSync(home, { recursive: true }).sort();
  const settings = { ...defaultSettings(), briefing: 'omp' as const, language: 'en' as const };
  const result = await dryRunText({ cwd, settings, codexHome: home, hudHome: hud });
  assert.ok('text' in result, 'error' in result ? result.error : '');
  assert.match(result.text, /^# codex-hud brief --dry-run: what the panel would send now\. Nothing was sent\.\n# session 00000000-0000-0000-0000-00000000aaaa, scope agents, language en, backend omp\n/);
  assert.match(result.text, /=== instructions ===\nYou write the status brief/);
  assert.match(result.text, /=== material ===\n<directions>\n- mapper \[team-scout\]: stage 1, running/);
  assert.match(result.text, /took on \(its own words, its first update of the stage\): Reading the parser first\./);
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before, 'nothing written');
  // Every item on that can send: still only printed.
  const all = await dryRunText({ cwd, settings: { ...settings, briefMain: true, resultDigest: true }, codexHome: home, hudHome: hud });
  assert.ok('text' in all && all.text.includes('scope both') && all.text.includes('<main>'));
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before, 'nothing written');
  assert.deepEqual(await dryRunText({ cwd: path.join(home, 'elsewhere'), settings, codexHome: home, hudHome: hud }),
    { error: `No Codex session found for ${path.join(home, 'elsewhere')}` });
});
