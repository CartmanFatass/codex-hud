import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLog } from '../../src/collectors/agent-log.js';
import { ProgressSummarizer, progressTargets, PROGRESS_COOLDOWN_MS, PROGRESS_RETRY_MS, PROGRESS_NOTE_CHARS } from '../../src/collectors/progress-summary.js';
import type { ModelRequest, ModelResult, SmallModel } from '../../src/collectors/small-model.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const NOW = 1_800_000_000_000;
function node(id = 'lead', overrides: Partial<SubagentTreeNode> = {}): SubagentTreeNode {
  return { id, name: id, status: 'running', depth: 1, children: [], turnStartedAt: new Date(NOW - 1000),
    lastReport: { at: new Date(NOW - 500), text: 'Reading synthetic parser tests.', kind: 'update' }, ...overrides };
}
function tree(nodes = [node()], rootId = 'root'): SubagentTree {
  return { rootId, nodes, totalCount: nodes.length, updatedAt: new Date(NOW) };
}
class FakeModel {
  requests: Array<{ request: ModelRequest; finish: (result: ModelResult) => void; cancelled: boolean }> = [];
  cache = new Map<string, string>();
  submit(request: ModelRequest) {
    let finish!: (result: ModelResult) => void;
    const result = new Promise<ModelResult>(resolve => { finish = resolve; });
    const item = { request, finish: (reply: ModelResult) => {
      if (reply.ok && request.cacheKey) this.cache.set(request.cacheKey, reply.text);
      finish(reply);
    }, cancelled: false };
    this.requests.push(item);
    const cached = this.cache.get(request.cacheKey ?? '');
    if (cached) finish({ ok: true, text: cached, cached: true });
    // Intentionally resolve even after cancellation: tests exercise hostile late completions.
    return { result, cancel: () => { item.cancelled = true; } };
  }
}
function setup() {
  const model = new FakeModel();
  const log = new AgentLog();
  const summary = new ProgressSummarizer(model as unknown as SmallModel, log);
  const update = (t = tree(), now = NOW, on = true, language: 'en' | 'zh' = 'en', targets: ReadonlySet<string> = new Set(['lead'])) => {
    log.observe(t);
    summary.update({ tree: t, now, on, language, targets });
  };
  return { model, log, summary, update };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }
const notes = (log: AgentLog, id = 'lead') => log.entries(id).filter(entry => entry.kind === 'note');

test('progressTargets follows exact visible summary IDs without implicitly adding hidden descendants', () => {
  const t = tree([node('lead', { status: 'completed', children: [
    node('done', { status: 'completed', children: [node('deep', { depth: 3 })] }),
    node('pending', { status: 'starting' }), node('review', { kind: 'guardian' }),
    node('unknown', { status: 'unknown' }), node('failed', { status: 'error' }),
  ] }), node('closed', { children: [node('hidden')] })]);
  assert.deepEqual([...progressTargets(t, new Set(['lead']))], []);
  assert.deepEqual([...progressTargets(t, new Set(['deep', 'pending', 'review', 'failed']))], ['deep', 'pending', 'review']);
  assert.deepEqual([...progressTargets(t, new Set(['deep']))], ['deep']);
  assert.deepEqual([...progressTargets(tree(), new Set(['lead']))], ['lead']);
});

test('on demand sends bounded public facts, not private fields or sealed payloads; stamps snapshot language/time', async () => {
  const { model, log, summary, update } = setup();
  const n = node('lead', { task: 'gAAAAAsealed', charge: 'Synthetic charge '.repeat(100),
    action: { name: 'exec_command', text: 'Running synthetic unit tests.', at: new Date(NOW - 100) },
    stages: [{ turnId: 'turn', startedAt: new Date(NOW - 1000), status: 'running', intent: 'Testing parser progress.', result: 'NEVER FINAL' }],
    children: [node('kid'), node('done', { status: 'completed' })] });
  Object.assign(n, { reasoning: 'NEVER REASONING', latest: 'NEVER UNKNOWN CHANNEL' });
  log.attach('root');
  log.add('lead', [{ at: NOW - 50, kind: 'note', text: 'Unrelated recent global note.', lang: 'en' },
    ...Array.from({ length: 8 }, (_, i) => ({ at: NOW - 400 + i, kind: 'report' as const, text: 'public '.repeat(200) + i }))]);
  update(tree([n]));
  assert.equal(model.requests.length, 1);
  const request = model.requests[0].request;
  assert.equal(request.feature, 'progress');
  assert.equal(request.thinking, 'low');
  assert.ok(request.cacheKey);
  assert.match(request.system, /plain English/);
  assert.match(request.system, /exactly one short sentence/);
  assert.doesNotMatch(request.prompt, /gAAAAA|NEVER|Unrelated recent global/);
  const data = JSON.parse(request.prompt.split('\n')[1]);
  assert.equal(data.publicReports.length, 4);
  assert.ok(data.publicReports.every((report: {text: string}) => Array.from(report.text).length <= 600));
  assert.ok(Array.from(data.charge).length <= 300);
  assert.deepEqual(data.descendantStates, { active: 1, completed: 1, failed: 0, unknown: 0 });
  assert.equal(summary.state().get('lead')?.running, true);
  model.requests[0].finish({ ok: true, text: 'Synthetic note. '.repeat(100) });
  await settle();
  const note = notes(log).at(-1)!;
  assert.equal(note.at, NOW);
  assert.equal(note.lang, 'en');
  assert.ok(Array.from(note.text).length <= PROGRESS_NOTE_CHARS);
  assert.equal(note.text, 'Synthetic note.', 'a verbose reply is kept as one sentence');
  assert.equal(summary.state().get('lead')?.running, false);
});

test('no public progress evidence means no call or fabricated placeholder; inactive nodes do not request', () => {
  const { model, summary, update } = setup();
  update(tree([node('lead', { lastReport: undefined, task: 'An assignment only.' })]));
  assert.equal(model.requests.length, 0);
  assert.equal(summary.state().get('lead')?.reason, 'no-evidence');
  for (const status of ['unknown', 'completed', 'error'] as const) update(tree([node('lead', { status, lastReport: undefined })]));
  assert.equal(model.requests.length, 0);
  update(tree([node('lead', { lastReport: { at: new Date(NOW - 2000), text: 'Old turn report.', kind: 'reply' } })]));
  assert.equal(model.requests.length, 0);
});

test('unchanged input ignores clocks/tokens, dedups pending and visibility changes, and cached restart does not duplicate note', async () => {
  const { model, log, summary, update } = setup();
  update();
  update(tree([node('lead', { lastEventAt: new Date(NOW + 100), contextUsage: { used: 9, total: 10, percent: 90, inputTokens: 9, outputTokens: 1, cachedTokens: 0, compactCount: 0 } })]), NOW + 100);
  assert.equal(model.requests.length, 1);
  model.requests[0].finish({ ok: true, text: 'Reading parser tests.' });
  await settle();
  update(tree(), NOW + 100_000, true, 'en', new Set());
  update(tree(), NOW + 200_000);
  assert.equal(model.requests.length, 1);
  const restarted = new ProgressSummarizer(model as unknown as SmallModel, log);
  restarted.update({ tree: tree(), targets: new Set(['lead']), on: true, language: 'en', now: NOW + 300_000 });
  await settle();
  assert.equal(notes(log).length, 1);
  assert.equal(model.requests[0].request.cacheKey, model.requests[1].request.cacheKey);
  summary.stop(); restarted.stop();
});

test('frequent new reports do not starve a same-turn snapshot; refresh observes 60 second cooldown', async () => {
  const { model, log, update } = setup();
  update();
  const changed = tree([node('lead', { lastReport: { at: new Date(NOW + 100), text: 'Now running synthetic tests.', kind: 'update' } })]);
  update(changed, NOW + 100);
  assert.equal(model.requests[0].cancelled, false);
  update(changed, NOW + 200);
  update(changed, NOW + 300);
  assert.equal(model.requests.length, 1);
  model.requests[0].finish({ ok: true, text: 'Reading synthetic parser tests.' });
  await settle();
  assert.equal(notes(log).length, 1);
  assert.equal(notes(log)[0].at, NOW);
  update(changed, NOW + PROGRESS_COOLDOWN_MS - 1);
  assert.equal(model.requests.length, 1);
  update(changed, NOW + PROGRESS_COOLDOWN_MS);
  assert.equal(model.requests.length, 2);
  model.requests[1].finish({ ok: true, text: 'Running synthetic tests.' });
  await settle();
  assert.equal(notes(log)[1].at, NOW + PROGRESS_COOLDOWN_MS);
});

for (const mode of ['off/pause', 'hidden', 'stop', 'language', 'root', 'turn', 'assignment', 'completed'] as const) {
  test(`${mode} prevents late completion from committing`, async () => {
    const { model, log, summary, update } = setup();
    update();
    if (mode === 'off/pause') update(tree(), NOW + 1, false);
    else if (mode === 'hidden') update(tree(), NOW + 1, true, 'en', new Set());
    else if (mode === 'stop') summary.stop();
    else if (mode === 'language') update(tree(), NOW + 1, true, 'zh');
    else if (mode === 'root') update(tree([node()], 'other-root'), NOW + 1);
    else if (mode === 'turn') update(tree([node('lead', { turnStartedAt: new Date(NOW + 1) })]), NOW + 1);
    else if (mode === 'assignment') update(tree([node('lead', { task: 'New synthetic assignment.' })]), NOW + 1);
    else update(tree([node('lead', { status: 'completed' })]), NOW + 1);
    assert.equal(model.requests[0].cancelled, true);
    model.requests[0].finish({ ok: true, text: 'STALE' });
    await settle();
    assert.equal(notes(log).length, 0);
    if (mode === 'language' || mode === 'root') assert.equal(model.requests.length, 2);
  });
}

test('errors/refusals show state and retry only after ten minutes; blank replies also fail', async () => {
  const { model, summary, update } = setup();
  update();
  model.requests[0].finish({ ok: false, error: 'Synthetic cap reached', refused: true });
  await settle();
  assert.equal(summary.state().get('lead')?.phase, 'error');
  assert.equal(summary.state().get('lead')?.reason, 'retry');
  assert.equal(summary.state().get('lead')?.error, 'Progress summary failed');
  update(tree(), NOW + PROGRESS_RETRY_MS - 1);
  assert.equal(model.requests.length, 1);
  update(tree(), NOW + PROGRESS_RETRY_MS);
  assert.equal(model.requests.length, 2);
  model.requests[1].finish({ ok: true, text: '   ' });
  await settle();
  assert.equal(summary.state().get('lead')?.error, 'Progress summary failed');
});

test('three queued agents at most; completed requests free slots for remaining targets', async () => {
  const { model, update } = setup();
  const t = tree(Array.from({ length: 5 }, (_, i) => node(`agent-${i}`)));
  const targets = new Set(t.nodes.map(n => n.id));
  update(t, NOW, true, 'en', targets);
  assert.equal(model.requests.length, 3);
  model.requests[0].finish({ ok: true, text: 'Reading tests.' });
  await settle();
  update(t, NOW + 1, true, 'en', targets);
  assert.equal(model.requests.length, 4);
});

test('diagnoses remain available without evidence, for non-live/hidden subjects and explicit off reasons', () => {
  const { model, summary } = setup();
  const t = tree([node('lead',{lastReport:undefined}),node('settled',{status:'completed'}),node('hidden')]);
  const targets = new Set(['lead','settled']);
  summary.update({tree:t,targets,on:true,language:'en',now:NOW});
  assert.equal(summary.state().get('lead')?.reason,'no-evidence');
  assert.equal(summary.state().get('settled')?.reason,'not-live');
  assert.equal(summary.state().get('hidden')?.reason,'summary-hidden');
  for (const offReason of ['off','paused','progress-disabled'] as const) {
    summary.update({tree:t,targets,on:false,offReason,language:'en',now:NOW});
    assert.ok([...summary.state().values()].every(state=>state.phase==='blocked' && state.reason===offReason && !state.running));
  }
  assert.equal(model.requests.length,0);
});

test('concurrency cap and cooldown are authoritative, and failure state never reflects backend material', async () => {
  const { model, summary, update } = setup();
  const t = tree(Array.from({length:4},(_,i)=>node(`agent-${i}`)));
  const targets = new Set(t.nodes.map(n=>n.id));
  update(t,NOW,true,'en',targets);
  assert.equal(summary.state().get('agent-3')?.reason,'concurrency-cap');
  assert.equal(summary.state().get('agent-3')?.running,false);
  model.requests[0].finish({ok:false,error:'Bearer synthetic-secret http://private.invalid RAW_INPUT'});
  await settle();
  assert.equal(summary.state().get('agent-0')?.reason,'retry');
  assert.doesNotMatch(JSON.stringify([...summary.state()]),/synthetic-secret|private.invalid|RAW_INPUT/);
  model.requests[1].finish({ok:true,text:'Reading tests.'});
  await settle();
  const changed = {...t,nodes:t.nodes.map(n=>n.id==='agent-1' ? {...n,lastReport:{at:new Date(NOW+500),kind:'update' as const,text:'Running synthetic checks.'}} : n)};
  update(changed,NOW+500,true,'en',targets);
  assert.equal(summary.state().get('agent-1')?.reason,'cooldown');
  assert.equal(summary.state().get('agent-1')?.retryAt,NOW+PROGRESS_COOLDOWN_MS);
});
