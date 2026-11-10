import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { displayTarget } from '../../src/integrations/panel/receipt.js';
import { renderStatuslineSession } from '../../src/render/statusline-session.js';
import { once } from 'node:events';
import { readProcess } from '../../src/core/run/process.js';
import {
  readRoleSummary,
  roleSummaryPath,
  decodeRoleSummary,
  summarizeWorkboard,
  RoleSummaryPublisher,
  WORK_STATES,
  type RoleSummary,
} from '../../src/roles/role-summary.js';
import { renderRoleSummary } from '../../src/render/role-summary.js';
import { visualLength } from '../../src/render/colors.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import type { OwnerWorker, WorkboardSnapshot } from '../../src/collectors/workboard-types.js';
import { saveJson } from '../../src/integrations/panel/receipt.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { renderMonitor, initialMonitorState } from '../../src/render/monitor.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';
import { isolatePanelHerdr } from '../fixtures/panel-isolation.js';

const ROOT = 'synthetic-source/main';
const NOW = Date.now();
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-role-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv & { HOME: string; HUD_HOME: string; CODEX_HOME: string; CLAUDE_CONFIG_DIR: string } = {
    ...process.env,
    HOME: join(dir, 'home'),
    HUD_HOME: join(dir, 'hud'),
    CODEX_HOME: join(dir, 'codex'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
  };
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'HUD_SETTINGS_PATH', 'CODEX_HUD_SETTINGS_PATH']) delete env[k];
  for (const name of ['home', 'hud', 'codex', 'claude']) fs.mkdirSync(join(dir, name), { mode: 0o700 });
  const fakeCalls = isolatePanelHerdr(env, dir);
  const producer = { generation: 'synthetic-generation', process: readProcess(process.pid)!.stamp };
  const summary: RoleSummary = {
    schema: 1,
    root: ROOT,
    producer,
    observedAt: NOW,
    coverage: 'complete',
    counts: { 'needs-you': 2, 'in-progress': 1, 'awaiting-acceptance': 3, stalled: 4, done: 9 },
    sources: [{ id: 'workboard', revision: 'revision-1', at: NOW }],
  };
  const file = roleSummaryPath(env, ROOT);
  const write = (value: unknown = summary) => saveJson(file, value);
  return { dir, env, producer, summary, file, write, fakeCalls };
}
function board(now = NOW): WorkboardSnapshot {
  const workers: OwnerWorker[] = ['waiting_orchestrator', 'working', 'idle_grace', 'unknown', 'closed'].map(
    (state, i) => ({
      id: `worker-${i}`,
      laneId: 'lane',
      harness: 'pi',
      role: 'implementer',
      task: 'Synthetic task',
      model: null,
      effort: null,
      state,
      startedAt: now - 1000,
      settledAt: null,
      phase: null,
      homeNeedsHuman: false,
      humanEndedAt: null,
      stale: state === 'unknown',
      evidence: [],
      work: {
        episode: `worker-${i}`,
        activityAt: now - 1000,
        activityBasis: 'producer',
        signature: state,
        phases: [],
        request: i === 0,
        failed: false,
        result: i === 2 || i === 4,
        facadeClosed: i === 4,
      },
    })
  );
  return {
    revision: 'synthetic-revision',
    workers,
    lanes: [],
    decisions: [],
    coverage: { incomplete: false, workspace: null, diagnostics: [] },
  };
}
test('role statusline shows only a fresh exact root, unavailable bytes unchanged and narrow output bounded', (t) => {
  const f = setup(t);
  const input = {
    session_id: 'main-statusline',
    model: { display_name: 'Synthetic Claude' },
    context_window: { used_percentage: 12 },
    cost: { total_cost_usd: 0 },
  };
  const root = displayTarget('claude', input.session_id, f.env.CLAUDE_CONFIG_DIR).root;
  const file = roleSummaryPath(f.env, root);
  const run = (width = 80, value = input) => {
    const result = spawnSync(process.execPath, [resolve('bin/hud-statusline'), '--width', String(width)], {
      env: f.env,
      input: JSON.stringify(value),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const baseline = run();
  assert.equal(baseline, renderStatuslineSession(input, 80) + '\n');
  saveJson(file, { ...f.summary, root, observedAt: Date.now() });
  assert.ok(run().includes('2 needs you'));
  saveJson(file, { ...f.summary, root, observedAt: Date.now() - 60001 });
  assert.equal(run(), baseline);
  saveJson(file, { ...f.summary, root: 'wrong/root', observedAt: Date.now() });
  assert.equal(run(), baseline);
  saveJson(file, { ...f.summary, root, observedAt: Date.now() });
  assert.equal(run(80, { ...input, session_id: 'other-session' }), baseline);
  for (const width of [1, 5, 10, 30])
    for (const line of run(width).trimEnd().split('\n')) assert.ok(visualLength(line) <= width);
});
test('role summary producer distinguishes empty incomplete, partial workers, and complete empty snapshots', (t) => {
  const f = setup(t);
  const b = board();
  const empty = { ...b, workers: [], lanes: [], coverage: { ...b.coverage, incomplete: true } };
  assert.equal(summarizeWorkboard(ROOT, f.producer, empty, NOW, 10).coverage, 'unavailable');
  const publisher = new RoleSummaryPublisher(f.env, f.producer);
  t.after(() => publisher.dispose());
  publisher.publish(ROOT, empty, NOW, 10);
  assert.deepEqual(readRoleSummary(f.env, ROOT, { nowMs: NOW }), { state: 'unavailable', counts: null });
  assert.equal(
    summarizeWorkboard(ROOT, f.producer, { ...b, coverage: { ...b.coverage, incomplete: true } }, NOW, 10).coverage,
    'partial'
  );
  const complete = summarizeWorkboard(
    ROOT,
    f.producer,
    { ...empty, coverage: { ...empty.coverage, incomplete: false } },
    NOW,
    10
  );
  assert.equal(complete.coverage, 'complete');
  assert.ok(Object.values(complete.counts).every((n) => n === 0));
  publisher.invalidate();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(publisher.publish(ROOT, b, NOW + 1, 10), true, 'recovery may publish again');
});
test('role summary valid zero and partial coverage stay distinct from unavailable', (t) => {
  const f = setup(t);
  f.write({
    ...f.summary,
    coverage: 'partial',
    counts: { 'needs-you': 0, 'in-progress': 0, 'awaiting-acceptance': 0, stalled: 0, done: 0 },
  });
  const zero = readRoleSummary(f.env, ROOT, { nowMs: NOW });
  assert.equal(zero.state, 'available');
  assert.equal(renderRoleSummary(zero, 80), '');
  f.write({ ...f.summary, coverage: 'partial' });
  const partial = readRoleSummary(f.env, ROOT, { nowMs: NOW });
  assert.equal(partial.state, 'available');
  assert.match(renderRoleSummary(partial, 100), /Work \(partial\):/);
});
test('role summary round trip, exact root, bounded private path and control sanitation', (t) => {
  const f = setup(t);
  f.write({ ...f.summary, sources: [{ id: 'a\x1b[31m\n', revision: '\x00\x85revision', at: NOW }] });
  const result = readRoleSummary(f.env, ROOT, { nowMs: NOW });
  assert.equal(result.state, 'available');
  if (result.state !== 'available') return;
  assert.deepEqual(result.summary.counts, f.summary.counts);
  assert.doesNotMatch(JSON.stringify(result.summary.sources), /\\u001b|\\n|\\u0000|\x85/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(resolve(f.file, '..')).mode & 0o777, 0o700);
  assert.ok(f.file.startsWith(join(f.env.HUD_HOME, 'display', 'role-summary')));
  assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME), []);
  assert.equal(decodeRoleSummary(f.summary).root, ROOT);
});
for (const variant of [
  'oversize',
  'symlink',
  'ancestor-symlink',
  'json',
  'schema',
  'root',
  'future',
  'expired',
  'dead',
  'coverage',
  'counts',
  'missing',
] as const) {
  test(`role summary ${variant} is unavailable, never zero`, (t) => {
    const f = setup(t);
    f.write();
    switch (variant) {
      case 'oversize':
        fs.writeFileSync(f.file, ' '.repeat(16385));
        break;
      case 'symlink':
        fs.renameSync(f.file, f.file + '.real');
        fs.symlinkSync(f.file + '.real', f.file);
        break;
      case 'ancestor-symlink': {
        const parent = resolve(f.file, '..');
        fs.renameSync(parent, parent + '.real');
        fs.symlinkSync(parent + '.real', parent);
        break;
      }
      case 'json':
        fs.writeFileSync(f.file, '{');
        break;
      case 'schema':
        f.write({ ...f.summary, schema: 2 });
        break;
      case 'root':
        f.write({ ...f.summary, root: 'other/main' });
        break;
      case 'future':
        f.write({ ...f.summary, observedAt: NOW + 1 });
        break;
      case 'expired':
        f.write({ ...f.summary, observedAt: NOW - 60000 });
        break;
      case 'dead':
        f.write({ ...f.summary, producer: { ...f.producer, process: { ...f.producer.process, proc_start: '0' } } });
        break;
      case 'coverage':
        f.write({ ...f.summary, coverage: 'unavailable' });
        break;
      case 'counts':
        f.write({ ...f.summary, counts: { ...f.summary.counts, stalled: -1 } });
        break;
      case 'missing':
        fs.unlinkSync(f.file);
        break;
    }
    const result = readRoleSummary(f.env, ROOT, { nowMs: NOW });
    assert.deepEqual(result, { state: 'unavailable', counts: null });
    assert.equal(renderRoleSummary(result, 80), '');
  });
}
test('role summary atomic replacement never exposes partial temp and pins a consistent opened document across root switch', (t) => {
  const f = setup(t);
  f.write();
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: any, opts: any) => {
    if (String(file).endsWith('.tmp')) {
      originalWrite(file, '{', opts);
      const old = readRoleSummary(f.env, ROOT, { nowMs: NOW });
      assert.equal(old.state, 'available');
      if (old.state === 'available') assert.equal(old.summary.counts.stalled, 4);
      originalWrite(file, data, { ...opts, flag: 'w' });
    } else originalWrite(file, data, opts);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  saveJson(f.file, { ...f.summary, counts: { ...f.summary.counts, stalled: 7 } });
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const originalRead = fs.readSync;
  let switched = false;
  t.mock.method(fs, 'readSync', (...args: any[]) => {
    if (!switched) {
      switched = true;
      saveJson(f.file, { ...f.summary, root: 'other/main', counts: { ...f.summary.counts, stalled: 8 } });
    }
    return (originalRead as any)(...args);
  });
  syncBuiltinESMExports();
  const old = readRoleSummary(f.env, ROOT, { nowMs: NOW });
  assert.equal(old.state, 'available');
  if (old.state === 'available') {
    assert.equal(old.summary.root, ROOT);
    assert.equal(old.summary.counts.stalled, 7);
  }
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW }).state, 'unavailable');
});
test('role summary publisher changes only with content or heartbeat, uses P2 work projection, and clears only own document', (t) => {
  const f = setup(t);
  const b = board();
  const publisher = new RoleSummaryPublisher(f.env, f.producer);
  t.after(() => publisher.dispose());
  assert.equal(publisher.publish(ROOT, b, NOW, 10), true);
  const first = fs.statSync(f.file).ino;
  assert.equal(publisher.publish(ROOT, b, NOW + 19999, 10), false);
  assert.equal(fs.statSync(f.file).ino, first);
  assert.equal(publisher.publish(ROOT, b, NOW + 20000, 10), true);
  assert.notEqual(fs.statSync(f.file).ino, first);
  assert.deepEqual(
    summarizeWorkboard(ROOT, f.producer, b, NOW, 10).counts,
    Object.fromEntries(
      WORK_STATES.map((state) => [state, b.workers.filter((w) => projectWorkCard(w, NOW, 10).state === state).length])
    )
  );
  assert.equal(publisher.publish(ROOT, { ...b, revision: 'changed' }, NOW + 20001, 10), true);
  publisher.dispose();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(publisher.publish(ROOT, b, NOW + 21000, 10), false);
  const old = new RoleSummaryPublisher(f.env, f.producer);
  old.publish(ROOT, b, NOW, 10);
  const replacement = new RoleSummaryPublisher(f.env, { ...f.producer, generation: 'new-generation' });
  replacement.publish(ROOT, b, NOW + 1, 10);
  old.dispose();
  assert.equal(fs.existsSync(f.file), true);
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW + 60001 }).state, 'unavailable');
  replacement.dispose();
});
test('role summary crashed synthetic producer is unavailable, not current', async (t) => {
  const f = setup(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => child.kill());
  await once(child, 'spawn');
  const stamp = readProcess(child.pid!)!.stamp;
  f.write({ ...f.summary, producer: { ...f.producer, process: stamp } });
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW }).state, 'available');
  child.kill();
  await once(child, 'exit');
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW + 1 }).state, 'unavailable');
});
test('role summary and pure render do no scan, launch or network; reader ceiling and narrow widths', (t) => {
  const f = setup(t);
  f.write();
  for (const [obj, names] of [
    [fs, ['readdirSync', 'opendirSync']],
    [cp, ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']],
    [net, ['connect', 'createConnection']],
  ] as const)
    for (const name of names)
      t.mock.method(obj as any, name, () => {
        assert.fail(`forbidden ${name}`);
      });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = readRoleSummary(f.env, ROOT, { nowMs: NOW });
  assert.equal(result.state, 'available');
  for (let width = 1; width <= 150; width++) assert.ok(visualLength(renderRoleSummary(result, width)) <= width);
  const text = renderRoleSummary(result, 200);
  for (const words of ['2 needs you', '4 stalled', '3 awaiting acceptance', '1 in progress'])
    assert.ok(text.includes(words));
  assert.ok(!text.includes('done'));
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW, budgetMs: 0 }).state, 'unavailable');
  let elapsed = 0;
  assert.equal(readRoleSummary(f.env, ROOT, { nowMs: NOW, clock: () => (elapsed += 21) }).state, 'unavailable');
});
for (const scenario of ['normal', 'failure', 'unbound'])
  test(
    `role summary actual collection ${scenario} publishes outside paint and finish disposes handlers`,
    { timeout: 15000 },
    async (t) => {
      const f = setup(t);
      const child = spawn(process.execPath, [resolve('tests/fakes/panel-summary-live.mjs'), resolve('.'), scenario], {
        env: {
          ...f.env,
          CODEX_HUD_CWD: f.dir,
          CODEX_HUD_PANEL_ROOT: scenario === 'unbound' ? '' : ROOT,
          CODEX_HUD_STANDALONE_PANEL: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => child.kill('SIGKILL'));
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, stdout + stderr);
      assert.equal(JSON.parse(stdout.trim()).disposed, 1);
      assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME), []);
      const file = roleSummaryPath(f.env, ROOT);
      assert.equal(fs.existsSync(file), false, 'finish clears its cache');
    }
  );
test('role summary same collected panel snapshot is painted, with no publication during paint', async (t) => {
  const f = r5Fixture(t);
  f.receipt(f.association(1));
  const p = new PanelJobPipeline(f.home, ROOT_R5, { now: f.now, herdr: async () => '{"result":{"agents":[]}}' });
  t.after(() => p.dispose());
  for (let i = 0; i < 12; i++) await p.refresh();
  const composed = p.compose(f.emptyTree(), null, f.now());
  const snapshot = p.workboard(composed.tree, composed.legacy);
  const publisher = new RoleSummaryPublisher(
    { HUD_HOME: f.home },
    { generation: 'fixture', process: readProcess(process.pid)!.stamp }
  );
  t.after(() => publisher.dispose());
  publisher.publish(ROOT_R5, snapshot, f.now(), 10);
  const file = roleSummaryPath({ HUD_HOME: f.home }, ROOT_R5);
  const before = fs.readFileSync(file, 'utf8');
  const state = initialMonitorState();
  state.mainTab = 'work';
  renderMonitor({ tree: composed.tree, workboard: snapshot, state, nowMs: f.now(), width: 110, height: 40 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const doc = JSON.parse(before);
  for (const workState of WORK_STATES)
    assert.equal(
      doc.counts[workState],
      snapshot.workers.filter((w) => projectWorkCard(w, f.now(), state.cardStallMinutes).state === workState).length
    );
  const source = fs.readFileSync(new URL('../../../src/tree-page.ts', import.meta.url), 'utf8');
  const renderBody = source.slice(source.indexOf('  const render = () =>'), source.indexOf('  const collect ='));
  assert.ok(!renderBody.includes('roleSummary?.publish('), 'publication must not move into paint');
  assert.ok(source.includes('roleSummary?.publish('), 'collection owns publication');
});
