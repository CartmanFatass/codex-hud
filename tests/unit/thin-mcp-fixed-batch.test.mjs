import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cachedReportSignature, writeReportMeta } from '../../dist/roles/report-meta.js';
import { JOB_RETENTION_MS, pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { join } from 'node:path';
import test from 'node:test';
import { batchIndex, failuresByReason, settleItem } from '../../dist/mcp/batch-state.js';
import { fixture, taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';

const read = path => JSON.parse(fs.readFileSync(path));
function setup(f, presets, cap = 4) {
  const run = name => [{ harness: 'pi', pi_role: 'sonic', model: `synthetic/${name}` }];
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles/sonic.json'), JSON.stringify({ role: 'sonic', can_continue: false, instructions: 'sonic', run: run(presets[0]), active_preset: presets[0], presets: presets.map(name => ({ name, run: run(name) })) }));
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, sonicPlacement: 'even', sonicEvenPool: presets, roleCaps: { sonic: cap } }));
  fs.writeFileSync(join(f.env.HOME, 'hold-sonic'), '');
  const release = (id, fail = false) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    if (fail) fs.writeFileSync(join(dir, 'fail-sonic'), '');
    fs.writeFileSync(join(dir, 'release-sonic'), '');
  };
  return { release, index: id => batchIndex(f.env.HUD_HOME, id), job: id => read(join(f.env.HUD_HOME, 'jobs', id, 'job.json')) };
}

test('fixed batch measures named inputs once, gates on every pinned pilot, reserves capacity and yields to the ordinary queue', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  const { release, index, job } = setup(f, ['alpha','beta','gamma']);
  const briefs = ['Read `chunk.txt`.','Read chunk.txt','Read `chunk.txt` twice: `chunk.txt`.','Read `chunk.txt` in full and report the labelled files.'];
  fs.writeFileSync(join(f.root, 'chunk.txt'), '字'.repeat(50));
  const items = briefs.map((brief, k) => { const brief_file = `part-${k}.md`; fs.writeFileSync(join(f.root, brief_file), brief); return { brief_file }; });
  const args = { role: 'sonic', items, cwd: f.root, package: 'labels', max_parallel: 10 };
  const { flow, scale } = await f.call('hud_create', args);
  const snapshot = () => index(flow);
  assert.match(flow, /^b[0-9a-f]{16}$/);
  assert.equal((await f.call('hud_create', args)).flow, flow);
  const sizes = briefs.map(s => Buffer.byteLength(s)+150).sort((a,b) => a-b);
  assert.deepEqual(scale, { role: 'sonic', cap: 4, max_parallel: 2, count: 4, presets: ['alpha','beta','gamma'], input_bytes: { max: sizes[3], median: (sizes[1]+sizes[2])/2, total: sizes.reduce((a,b)=>a+b) } });
  const assigned = () => snapshot().items.filter(i => i.job);
  await until(() => assigned().length === 2, t.signal);
  assert.deepEqual(assigned().map(i => job(i.job).route.preset), ['beta','gamma']);
  const interactive = async n => f.call('hud_create', { role: 'sonic', task: `Immediate lookup ${n}` });
  const one = await interactive(1), two = await interactive(2), queued = await interactive(3);
  assert.ok(!one.queued && !two.queued && queued.queued);
  release(assigned()[0].job);
  await until(() => job(queued.job).used_place, t.signal);
  assert.equal(assigned().length, 2, 'queued lookup took the free slot, not the waiting pilot');
  release(one.job);
  await until(() => assigned().length === 3, t.signal);
  assert.ok(assigned().every(i => i.pilot));
  release(two.job); release(queued.job);
  for (const i of assigned()) release(i.job);
  await until(() => assigned().length === 4, t.signal);
  assert.ok(assigned().filter(i => i.pilot).every(i => i.state === 'done' && i.report_path));
  release(assigned().find(i => !i.pilot).job);
  await until(() => snapshot().batch.state === 'completed', t.signal);
  const result = await f.call('hud_read', { job: flow });
  assert.deepEqual(result.totals, { done: 4, running: 0, failed: 0, waiting: 0 });
  assert.deepEqual(read(result.result_index).items, result.items);
  for (const i of result.items) {
    assert.ok(fs.statSync(i.report_path).isFile()); assert.equal(job(i.job).batch_flow, flow);
    assert.equal(i.brief_file, items[i.item-1].brief_file);
  }
  const memberLine = line => result.items.some(i => line.startsWith(i.job));
  assert.ok(!result.changes?.some(memberLine));
  await until(() => result.changes?.some(l => l.startsWith(flow) && l.includes('list unread reports')) || f.commands().some(c => c.args.some(a => a.includes(`${flow} batch:`) && a.includes('list unread reports'))), t.signal);
  assert.ok(!(await f.call('hud_read', { job: flow })).changes?.some(l => l.startsWith(flow)));
});

test('pilot failure pauses once; retry_failed keeps the manifest, creates a new job and gates the remainder', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  const { release, index, job } = setup(f, ['sample']);
  const { flow } = await f.call('hud_create', { role: 'sonic', max_parallel: 1, items: [{ task: 'first pilot' }, { task: 'next' }, { task: 'last' }] });
  const snapshot = () => index(flow), control = action => f.call('hud_create', { batch: flow, action });
  await until(() => snapshot().items[0].job, t.signal);
  const first = snapshot().items[0].job; release(first, true);
  await until(() => snapshot().batch.state === 'paused', t.signal);
  assert.equal(snapshot().batch.totals.waiting, 2);
  assert.match(Object.values(snapshot().batch.notices).join('\n'), /pilot failed.*×1.*action=resume/);
  assert.equal(Object.keys(snapshot().batch.notices).length, 1);
  assert.match(snapshot().items[0].reason, /exited/);
  await control('retry_failed');
  await until(() => snapshot().items[0].job && snapshot().items[0].job !== first, t.signal);
  const retry = snapshot().items[0];
  assert.equal(retry.previous[0].job, first);
  assert.equal(job(retry.job).batch_flow, flow); assert.equal(snapshot().batch.totals.waiting, 2);
  await control('pause'); release(retry.job);
  await until(() => snapshot().items[0].state === 'done', t.signal);
  assert.equal(snapshot().batch.totals.waiting, 2);
  await control('resume');
  await until(() => snapshot().items[1].job, t.signal);
  await control('stop');
  for (const i of snapshot().items) if (i.job) release(i.job);
  await until(() => { const s = snapshot(); for (const i of s.items) if (i.job && i.state === 'running') release(i.job); return !s.batch.totals.running; }, t.signal);
  assert.equal(snapshot().batch.state, 'stopped'); assert.equal(snapshot().batch.totals.waiting, 0);
  assert.equal(snapshot().items[2].state, 'cancelled'); assert.equal(snapshot().items[2].job, undefined);
});

test('20 doomed items in a task session: pilot failure wakes once, folds peers, retries all failures as new member jobs', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 });
  const { release, index } = setup(f, ['alpha', 'beta', 'gamma'], 5);
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const call = async (name, args) => {
    const result = await taskCall(rpc, name, args); assert.equal(result.resultType, 'complete');
    return JSON.parse(result.content[0].text);
  };
  const { flow } = await call('hud_create', { role: 'sonic', items: Array.from({ length: 20 }, (_, k) => ({ task: `Look up ${k}.` })) });
  const pilots = () => index(flow).items.filter(i => i.pilot);
  await until(() => pilots().every(i => i.job), t.signal);
  const originals = pilots().map(i => i.job);
  for (const j of originals) release(j, true);
  await until(() => index(flow).batch.totals.failed === 3, t.signal);
  const view = await call('hud_read', { job: flow });
  assert.equal(view.state, 'paused'); assert.equal(view.totals.waiting, 17);
  assert.deepEqual(view.failures.map(g => g.count), [3]);
  assert.equal(Object.keys(index(flow).batch.notices).length, 1);
  assert.ok(!view.changes?.some(line => originals.some(id => line.startsWith(id))));
  await call('hud_create', { batch: flow, action: 'retry_failed' });
  await until(() => pilots().every(i => i.job), t.signal);
  assert.deepEqual(pilots().map(i => i.previous[0].job), originals);
  assert.ok(pilots().every(i => !originals.includes(i.job)));
  await call('hud_create', { batch: flow, action: 'stop' });
  for (const i of pilots()) release(i.job);
  await until(() => index(flow).batch.totals.done === 3, t.signal);
  assert.equal(index(flow).batch.totals.cancelled, 17);
});

test('batch code jobs keep per-job worktrees and report-declared files in the index', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  cleanupFixture(t, { root: `${f.root}-wt` });
  const git = (...args) => execFileSync('git', args, { cwd: f.root, env: f.env });
  git('init', '-qb', 'base'); git('-c', 'user.name=Synthetic', '-c', 'user.email=s@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const { flow } = await f.call('hud_create', { role: 'imp', items: [{ task: 'first code item' }, { task: 'second item' }] });
  const index = () => batchIndex(f.env.HUD_HOME, flow);
  const roots = [];
  for (let k = 0; k < 2; k++) {
    await until(() => index().items[k].job, t.signal);
    const dir = join(f.env.HUD_HOME, 'jobs', index().items[k].job);
    roots.push(read(join(dir, 'job.json')).worktree.root);
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic code report.');
    writeReportMeta(dir, cachedReportSignature(dir), { files: [`result-${k}.txt`] });
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
  }
  await until(() => index().batch.state === 'completed', t.signal);
  const result = await f.call('hud_read', { job: flow });
  assert.deepEqual(result.items.map(i => i.files), [['result-0.txt'], ['result-1.txt']]);
  assert.equal(new Set(roots).size, 2); assert.ok(roots.every(root => root !== f.root));
  pruneLandFlows(f.env.HUD_HOME, Date.now() + JOB_RETENTION_MS + 60_000);
  await until(() => !fs.existsSync(result.result_index), t.signal);
});

test('breaker uses consecutive failures or 20% (minimum two); repeats and post-pause failures do not wake', () => {
  function events(reasons) {
    const b = { flow: 'b0000000000000000', state: 'working', epoch: 0, failures: 0, settled: 0, streak: 0, notices: {} };
    const items = reasons.map((_, k) => ({ item: k+1, job: `job${k}`, state: 'running' }));
    reasons.forEach((reason, k) => settleItem(b, items, items[k], reason));
    return { b, notices: Object.values(b.notices), groups: failuresByReason(items) };
  }
  const all = events(Array(20).fill('quota'));
  assert.equal(all.b.state, 'paused'); assert.equal(all.notices.length, 2);
  assert.match(all.notices[0], /item 1 .*quota/); assert.match(all.notices[1], /quota ×2 \(job0\)/);
  assert.deepEqual(all.groups, [{ reason: 'quota', count: 20, example: 'job0' }]);
  const consecutive = events([...Array(20), 'down', 'quota', 'third']);
  assert.equal(consecutive.b.state, 'paused'); assert.match(consecutive.notices[1], /down ×1 .*quota ×1/);
  const rate = events([undefined, 'quota', undefined, 'down']); assert.equal(rate.b.state, 'paused');
  const repeat = events([...Array(20), 'quota', undefined, 'quota', undefined, 'down']);
  assert.equal(repeat.b.state, 'working'); assert.equal(repeat.notices.length, 2);
});
