import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadGraph } from '../../dist/workflows/graph.js';
import { advance } from '../../dist/workflows/engine.js';
import { settlement } from '../../dist/workflows/policy.js';

const roles = new Map(['sonic','imp','pro','flow','off','browser','council'].map(name => [name, { optionalEnabled: name !== 'off', run: [
  { harness: 'pi' }, ...(name === 'browser' ? [{ harness: 'bro' }] : []),
] }]));
const job = { kind: 'job', role: 'sonic', task: 'sample' };
const graph = (steps, opts = {}) => loadGraph({ version: 1, name: 'example', steps }, 'json', { roles, ...opts });
const batch = (role, count) => ({ kind: 'batch', role, items: Array.from({ length: count }, () => ({ task: 'sample' })) });

test('one validator refuses invalid keys, refs, cycles, options, roles, scale and shell strings', () => {
  for (const steps of [ {}, { a: { ...job, max_parallel: 2 } }, { a: { ...job, role: 'off' } }, { a: { ...job, role: 'unknown' } },
    { a: { ...job, needs: ['missing'] } }, { a: { ...job, needs: ['b'] }, b: { ...job, needs: ['a'] } },
    { a: job, b: { ...job, from: ['a'] } }, { a: { ...job, from: Array(17).fill('q') } },
    { a: job, b: { ...job, needs: ['a'], when: { step: 'a', is: 'yes' } } },
    { a: { kind: 'check', run: 'a | b' } }, { a: { kind: 'check', use: 'lint', run: ['lint'] } },
    { a: batch('imp',513) }, { a: { ...batch('imp',1), max_parallel: 0 } }, { a: { ...batch('imp',1), items: [{ kind: 'batch' }] } },
    Object.fromEntries(Array.from({ length: 33 }, (_, k) => [`s${k}`, job])),
  ]) assert.throws(() => graph(steps), /invalid_workflow/);
  const source = readFileSync(new URL('../../packages/hud-mcp/workflows/batch.toml', import.meta.url), 'utf8');
  const inputs = { roles, bindings: { role: 'sonic', max_parallel: 2 }, manifest: { role: 'sonic', count: 3, bytes: 72, cap: 4 } };
  const plan = loadGraph(source, 'toml', inputs);
  assert.equal(plan.steps.items.max_parallel, 2); assert.equal(plan.steps.items.role, 'sonic');
  assert.throws(() => loadGraph(source, 'toml', { ...inputs, manifest: { ...inputs.manifest, cap: 2 } }), /reserved slots/);
  assert.throws(() => loadGraph(source, 'toml', { roles }), /missing parameter/);
  assert.equal(graph({ a: { kind: 'batch', role: 'sonic', items: '{list}' } }, { bindings: { list: [{ task: 'sample' }] } }).steps.a.items[0].task, 'sample');
  assert.throws(() => graph({ a: batch('imp',1) }, { caps: { imp: 2 } }), /reserved slots/);
  assert.deepEqual(loadGraph(JSON.stringify({ version: 1, name: 'batch', policy: { breaker: 'rate' }, steps: {
    items: { kind: 'batch', role: 'sonic', manifest: 'manifest.json', max_parallel: 2 },
  } }), 'json', inputs), plan);
});

test('cost is the maximum across the plan, including fallback places and exact large-batch boundaries', () => {
  for (const role of ['pro','flow','browser']) assert.equal(graph({ a: job, b: { ...job, needs: ['a'], role } }).cost, 'costly');
  const council = graph({ a: { kind: 'council', task: 'sample' } });
  assert.equal(council.cost, 'costly'); assert.deepEqual(council.cost_reasons, ['a: council']);
  for (const [role, n] of [['sonic',50],['imp',12]]) {
    assert.equal(graph({ a: batch(role,n) }).cost, 'cheap'); assert.equal(graph({ a: batch(role,n+1) }).cost, 'costly');
  }
  for (const [bytes,cost] of [[2**21,'cheap'],[2**21+1,'costly']]) assert.equal(graph({ a: batch('sonic',1) }, { inputBytes: () => bytes }).cost, cost);
});

const initial = g => ({ flow: 'w0000000000000001', state: 'working', epoch: 0, settled: 0, streak: 0, failures: 0, notices: {},
  steps: Object.fromEntries(Object.keys(g.steps).map(id => [id, { state: 'waiting' }])) });
test('DAG schedules fake executors after prerequisites; optional failures and unselected branches do not block joins', async () => {
  const g = graph({ last: { ...job, needs: ['selected','notselected','scout'], from: ['root'] },
    selected: { ...job, needs: ['ask'], when: { step: 'ask', is: 'go' } }, notselected: { ...job, needs: ['ask'], when: { step: 'ask', is: 'stop' } },
    ask: { kind: 'handback', needs: ['root'], ask: 'Go?', options: ['go','stop'] }, root: job, scout: { ...job, optional: true } });
  const run = initial(g), trace = [];
  const tick = id => {
    trace.push(id);
    if (id === 'root' && trace.length === 1) return { state: 'running', effect: async () => assert.equal(run.steps.root.state, 'running') };
    if (id === 'ask') run.steps.ask.answer = 'go'; // fake executor provides the answer
    return id === 'scout' ? { state: 'failed', reason: 'missing' } : { state: 'done' };
  };
  await advance(g, run, tick).effect(); assert.deepEqual(trace, ['root']);
  advance(g, run, tick); assert.deepEqual(trace, ['root','root','ask','selected','scout','last']);
  assert.equal(run.steps.notselected.state, 'skipped'); assert.equal(run.state, 'completed');
  assert.deepEqual(Object.keys(run.notices), ['failure-0-scout']);
});
test('required fake step failure pauses once; rate, first and none share one settlement window', () => {
  const g = graph({ a: job, b: { ...job, needs: ['a'] } }), run = initial(g);
  const tick = () => ({ state: 'failed', reason: 'x'.repeat(400) });
  advance(g, run, tick); advance(g, run, tick);
  assert.equal(run.reason.length, 300); assert.equal(run.state, 'paused'); assert.equal(run.steps.b.state, 'waiting');
  assert.deepEqual(Object.keys(run.notices), ['pause-0']);
  assert.deepEqual(run.handback, { step: 'a', choices: ['resume','retry_failed','stop'] });
  for (const [mode, expected] of [['none',['failure', undefined]], ['first',['pause','pause']], ['rate',['failure','pause']]]) {
    const window = { settled: 0, streak: 0, failures: 0 };
    assert.deepEqual([1,2].map(n => settlement(window,mode,'sample',n)), expected);
  }
});
