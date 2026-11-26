/** Unit tests for Execution metro-map data, per-station change times, legacy wave fallback, and pure 3-lane reduction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelExecution } from '../../dist/panel/execution.js';
import { reduceMetroLanes, lastChangedStationId } from '../../dist/collectors/execution-metro.js';
import { saveBatch, settleItem } from '../../dist/mcp/batch-state.js';
import { answerComposed } from '../../dist/mcp/composed-workflow.js';
import { ticketReadiness } from '../../dist/mcp/local-tickets.js';
import { resumeQueueAfterAnswer } from '../../dist/mcp/ticket-queue.js';
import { readTicketQueue } from '../../dist/mcp/ticket-queue-state.js';
import { getJobIndexCache } from '../../dist/roles/job-index-cache.js';
import { advance } from '../../dist/workflows/engine.js';

const NOW = Date.parse('2026-11-26T20:00:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const agoMs = (minutes) => NOW - minutes * 60_000;

function putJson(file, value) {
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const st = (id, state = 'working', extra = {}) => ({ id, kind: 'worker', state, ...extra });
const edge = (from, to) => ({ from, to });

test('reduceMetroLanes: empty graph, chains, fan-out and fan-in stay direct without crossings', () => {
  const empty = reduceMetroLanes({ stations: [], edges: [] });
  assert.deepEqual(empty, { lanes: 0, trunk: 0, columns: [], stations: [], edges: [], junctions: [], reduced: false });

  // Chain: 01 -> 02 -> 03 -> review -> accept
  const chain = reduceMetroLanes({
    stations: [st('01', 'done'), st('02', 'working'), st('03', 'waiting'), { id: 'review', kind: 'review', state: 'waiting' }, { id: 'accept', kind: 'accept', state: 'waiting' }],
    edges: [edge('01', '02'), edge('02', '03'), edge('03', 'review'), edge('review', 'accept')],
  });
  assert.equal(chain.lanes, 1);
  assert.equal(chain.trunk, 0);
  assert.equal(chain.columns.length, 5);
  assert.equal(chain.reduced, false);
  assert.deepEqual(chain.junctions, []);
  assert.deepEqual(chain.stations.map((s) => [s.station.id, s.column, s.lane]), [
    ['01', 0, 0], ['02', 1, 0], ['03', 2, 0], ['review', 3, 0], ['accept', 4, 0],
  ]);
  assert.equal(chain.edges.every((e) => !e.viaJunction && e.toColumn === e.fromColumn + 1), true);

  // Fan-out + Fan-in diamond: 01 -> {02, 03, 04} -> 05
  const diamond = reduceMetroLanes({
    stations: [st('01', 'done'), st('02', 'working'), st('03', 'asking'), st('04', 'lease'), st('05', 'waiting')],
    edges: [
      edge('01', '02'), edge('01', '03'), edge('01', '04'),
      edge('02', '05'), edge('03', '05'), edge('04', '05'),
    ],
  });
  assert.equal(diamond.lanes, 3);
  assert.equal(diamond.trunk, 1);
  assert.equal(diamond.reduced, false);
  assert.deepEqual(diamond.junctions, []);
  assert.deepEqual(diamond.columns.map((c) => c.map((s) => [s.station.id, s.lane])), [
    [['01', 1]],
    [['02', 0], ['03', 1], ['04', 2]],
    [['05', 1]],
  ]);
  assert.deepEqual(diamond.columns[2][0].blockers, ['02', '03', '04']);
});

test('reduceMetroLanes: skip-a-column edges merge at shared junctions keeping order and preserving blockers', () => {
  // Transitive skip: 01 -> 02 -> 03 and 01 -> 03
  const transitive = reduceMetroLanes({
    stations: [st('01', 'done'), st('02', 'working'), st('03', 'waiting', { blockers: ['01', '02'] })],
    edges: [edge('01', '02'), edge('02', '03'), edge('01', '03')],
  });
  assert.equal(transitive.reduced, true);
  assert.equal(transitive.edges.every((e) => e.toColumn === e.fromColumn + 1), true);
  assert.deepEqual(transitive.edges.map((e) => [e.from, e.to]), [['01', '02'], ['02', '03']]);
  assert.deepEqual(transitive.stations.find((s) => s.station.id === '03').blockers, ['01', '02']);

  // Non-transitive skip: 01 (c0), 02 (c0); 02 -> 03 (c1); 01 -> 04 (c2), 03 -> 04 (c2)
  const nonTransitive = reduceMetroLanes({
    stations: [
      st('01', 'done'),
      st('02', 'done'),
      st('03', 'working'),
      st('04', 'waiting', { blockers: ['01', '03'] }),
    ],
    edges: [edge('02', '03'), edge('01', '04'), edge('03', '04')],
  });
  assert.equal(nonTransitive.reduced, true);
  assert.equal(nonTransitive.edges.every((e) => e.toColumn === e.fromColumn + 1), true);
  const colOf = new Map(nonTransitive.stations.map((s) => [s.station.id, s.column]));
  assert.ok(colOf.get('01') < colOf.get('04'));
  assert.ok(colOf.get('03') < colOf.get('04'));
  assert.equal(nonTransitive.junctions.length, 1);
  assert.deepEqual(nonTransitive.junctions[0], {
    afterColumn: 0,
    lane: nonTransitive.trunk,
    incoming: ['01', '02'],
    outgoing: ['03'],
    reduced: true,
  });
  assert.equal(nonTransitive.edges.some((e) => e.from === '01' && e.to === '03' && e.viaJunction === true), true);
  assert.deepEqual(nonTransitive.stations.find((s) => s.station.id === '04').blockers, ['01', '03']);
});

test('reduceMetroLanes: avoidable crossings untangle cleanly; unavoidable crossings merge at a shared junction', () => {
  // Avoidable crossing: A->D and B->C (with C listed before D) untangles to 0 crossings.
  const untangled = reduceMetroLanes({
    stations: [st('A', 'done'), st('B', 'done'), st('C', 'working'), st('D', 'working')],
    edges: [edge('A', 'D'), edge('B', 'C')],
  });
  assert.equal(untangled.reduced, false);
  assert.deepEqual(untangled.junctions, []);
  const laneOf = new Map(untangled.stations.map((s) => [s.station.id, s.lane]));
  assert.equal(laneOf.get('A'), laneOf.get('D'));
  assert.equal(laneOf.get('B'), laneOf.get('C'));

  // Unavoidable K_{2,2} crossing: {A, B} -> {C, D}
  const k22 = reduceMetroLanes({
    stations: [st('A', 'done'), st('B', 'done'), st('C', 'working'), st('D', 'waiting')],
    edges: [edge('A', 'C'), edge('A', 'D'), edge('B', 'C'), edge('B', 'D')],
  });
  assert.equal(k22.reduced, true);
  assert.equal(k22.junctions.length, 1);
  assert.equal(k22.junctions[0].afterColumn, 0);
  assert.equal(k22.junctions[0].reduced, true);
  assert.deepEqual(new Set(k22.junctions[0].incoming), new Set(['A', 'B']));
  assert.deepEqual(new Set(k22.junctions[0].outgoing), new Set(['C', 'D']));
  assert.equal(k22.edges.every((e) => e.viaJunction === true), true);
  assert.deepEqual(k22.stations.find((s) => s.station.id === 'C').blockers, ['A', 'B']);
  assert.deepEqual(k22.stations.find((s) => s.station.id === 'D').blockers, ['A', 'B']);

  // 3-lane unavoidable crossing: A->X,Y; B->X,Z; C->Y,Z
  const k3 = reduceMetroLanes({
    stations: [st('A', 'done'), st('B', 'done'), st('C', 'done'), st('X', 'working'), st('Y', 'working'), st('Z', 'working')],
    edges: [edge('A', 'X'), edge('A', 'Y'), edge('B', 'X'), edge('B', 'Z'), edge('C', 'Y'), edge('C', 'Z')],
  });
  assert.equal(k3.lanes, 3);
  assert.equal(k3.reduced, true);
  assert.equal(k3.junctions.length, 1);
  assert.equal(k3.junctions[0].lane, 1);
  assert.deepEqual(new Set(k3.junctions[0].incoming), new Set(['A', 'B', 'C']));
  assert.deepEqual(new Set(k3.junctions[0].outgoing), new Set(['X', 'Y', 'Z']));
});

test('reduceMetroLanes: >3 parallel stations keep the 2 most urgent lanes and group the rest into a pool station', () => {
  const council5 = reduceMetroLanes({
    stations: [
      st('m1', 'done', { changedAt: agoMs(10) }),
      st('m2', 'working', { changedAt: agoMs(6) }),
      st('m3', 'done', { changedAt: agoMs(8) }),
      st('m4', 'failed', { changedAt: agoMs(5) }),
      st('m5', 'asking', { changedAt: agoMs(2) }),
      { id: 'synthesis', kind: 'synth', state: 'waiting' },
    ],
    edges: ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => edge(id, 'synthesis')),
  });
  assert.equal(council5.lanes, 3);
  assert.equal(council5.reduced, true);
  assert.equal(council5.columns[0].length, 3);
  const col0Ids = council5.columns[0].map((s) => s.station.id);
  assert.equal(col0Ids.includes('m5'), true, 'asking station keeps its own lane');
  assert.equal(col0Ids.includes('m4'), true, 'failed station keeps its own lane');
  const poolEntry = council5.columns[0].find((s) => s.station.kind === 'pool');
  assert.ok(poolEntry);
  assert.equal(poolEntry.station.count, 3);
  assert.equal(poolEntry.station.state, 'working');
  assert.deepEqual(poolEntry.station.pool, { working: 1, done: 2 });
  assert.equal(poolEntry.station.changedAt, agoMs(6));
  assert.deepEqual(new Set(poolEntry.groupedIds), new Set(['m1', 'm2', 'm3']));
  assert.deepEqual(council5.columns[1][0].blockers, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(council5.edges.length, 3);
});

test('reduceMetroLanes: repair station sits lowest in its column and damaged cycles terminate safely', () => {
  const withRepair = reduceMetroLanes({
    stations: [
      st('01', 'done'),
      st('02', 'working', { repair: { id: '02↻', round: 1, total: 2, state: 'working', changedAt: agoMs(1) } }),
      st('03', 'working'),
    ],
    edges: [edge('01', '02'), edge('01', '03')],
  });
  const col1 = withRepair.columns[1];
  assert.equal(col1.at(-1).station.id, '02', 'station with repair sits on the lowest lane');

  const cyclic = reduceMetroLanes({
    stations: [st('a', 'working'), st('b', 'working')],
    edges: [edge('a', 'b'), edge('b', 'a')],
  });
  assert.equal(cyclic.reduced, true);
  assert.equal(cyclic.stations.length, 2);
});

test('ticketReadiness retains declared blockers for ready tickets whose predecessors already landed', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'metro-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project');
  const issues = join(project, '.scratch', 'demo', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(join(issues, '01-base.md'),
    '# 01: Base\n\n**Status:** done\n**Owner try:** no\n**Live try:** none\n**Blocked by:** none\n\n**What to build:** base\n- [x] done\n');
  fs.writeFileSync(join(issues, '02-branch.md'),
    '# 02: Branch\n\n**Status:** ready-for-agent\n**Owner try:** no\n**Live try:** none\n**Blocked by:** 01\n\n**What to build:** branch\n- [ ] work\n');
  fs.writeFileSync(join(issues, '03-root.md'),
    '# 03: Root\n\n**Status:** ready-for-agent\n**Owner try:** no\n**Live try:** none\n**Blocked by:** none\n\n**What to build:** root\n- [ ] work\n');
  const res = ticketReadiness(project, getJobIndexCache(hud), 'demo', { home: hud });
  assert.deepEqual(res.tickets.map(({ ticket, blockers }) => [ticket, blockers]), [
    ['demo/02', ['demo/01']],
    ['demo/03', []],
  ]);
});

test('workflow engine records cursor changed_at on step transitions', () => {
  const g = {
    steps: {
      a: { kind: 'check', needs: [], from: [], optional: false, job: 'j1', repair: 0 },
      b: { kind: 'check', needs: ['a'], from: [], optional: false, job: 'j1', repair: 0 },
    },
    policy: { breaker: 'none' },
  };
  const run = {
    flow: 'g0000000000000001', state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0, notices: {},
    steps: { a: { state: 'waiting' }, b: { state: 'waiting' } },
  };
  advance(g, run, (id) => ({ state: id === 'a' ? 'done' : 'running' }));
  assert.equal(typeof run.steps.a.changed_at, 'string');
  assert.equal(typeof run.steps.b.changed_at, 'string');
  assert.equal(Number.isFinite(Date.parse(run.steps.a.changed_at)), true);
});

test('Execution collector projects metro stations, edges, change times, gate steps, and legacy wave fallback without rewriting old records', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;
  const addJob = (n, state, receipt = {}, statusExtra = {}) => {
    const jid = id('j', n), dir = join(hud, 'jobs', jid);
    putJson(join(dir, 'job.json'), {
      job: jid, cwd: project, project_root: project, role: 'imp', headless: true,
      dispatch_exit_code: 0, created_at: ago(40 - n), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), {
      state, started_at: ago(30 - n), ...(state === 'done' || state === 'closed' ? { settled_at: ago(15) } : {}), ...statusExtra,
    });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${receipt.ticket ?? `0${n}`}: Synthetic task ${n}\n`);
    return jid;
  };

  // New-format queue with recorded blockers, landed_at, answered_at, failed, held, and active gate+repair.
  const jLanded = addJob(1, 'done', { ticket: 'metro/01' });
  const jGate = addJob(2, 'done', { ticket: 'metro/02' });
  const jRepair = addJob(3, 'working', { ticket: 'metro/02' }, { started_at: ago(2) });
  const jAnswered = addJob(4, 'working', { ticket: 'metro/03' }, { started_at: ago(18) });
  const fGate = id('f', 2);
  putJson(join(flows, `${fGate}.json`), {
    flow: fGate, job: jGate, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/02' },
    config: { base: 'main', gate: ['build', 'unit', 'lint'], after: [], push: false },
    state: 'running', step: 'repair 1', pid: process.pid, start: '1',
    created_at: ago(14), updated_at: ago(2), step_started_at: ago(2), source_sha: 'a'.repeat(40),
    repairs: [{ step: 'gate[2]: unit', job: jRepair, outcome: 'waiting for worker' }],
    timings: [{ step: 'cherry-pick', ok: true, ms: 10 }, { step: 'gate[2]: unit', ok: false, ms: 20 }],
  });
  const qNew = id('q', 1);
  putJson(join(flows, `${qNew}.json`), {
    flow: qNew, root: project, project_root: project, feature: 'metro', pane: '', task: false, max_parallel: 3,
    created_at: ago(35), updated_at: ago(2), state: 'working',
    steps: { tickets: { state: 'running', changed_at: ago(35) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [
      { ticket: 'metro/01', path: join(project, '.scratch/metro/issues/01.md'), role: 'imp', job: jLanded, landed: true, blockers: [], landed_at: ago(20), changed_at: ago(20) },
      { ticket: 'metro/02', path: join(project, '.scratch/metro/issues/02.md'), role: 'imp', job: jGate, land: fGate, blockers: ['metro/01'] },
      { ticket: 'metro/03', path: join(project, '.scratch/metro/issues/03.md'), role: 'imp', job: jAnswered, blockers: ['metro/01'], answered_at: ago(5), changed_at: ago(5) },
      { ticket: 'metro/04', path: join(project, '.scratch/metro/issues/04.md'), role: 'imp', blockers: ['metro/01'], held: { reason: 'spec change', at: ago(8), kind: 'escalate', owner_approval: 'spec-change' }, changed_at: ago(8) },
      { ticket: 'metro/05', path: join(project, '.scratch/metro/issues/05.md'), role: 'imp', blockers: ['metro/01'], failed: { reason: 'unit failed', at: ago(7), kind: 'land' }, changed_at: ago(7) },
    ],
    blocked: [{ ticket: 'metro/06', blockers: ['02', '03'] }],
  });

  // Old/legacy queue WITHOUT blockers on TicketQueueItem, landed_at, or changed_at — must fall back to wave order and never be rewritten.
  const qOld = id('q', 2);
  const qOldPath = join(flows, `${qOld}.json`);
  putJson(qOldPath, {
    flow: qOld, root: project, project_root: project, feature: 'legacy', pane: '', task: false, max_parallel: 2,
    created_at: ago(30), updated_at: ago(6), state: 'working',
    steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [
      { ticket: '01', path: join(project, '.scratch/legacy/01.md'), role: 'imp', job: jLanded, landed: true },
      { ticket: '02', path: join(project, '.scratch/legacy/02.md'), role: 'imp', job: jAnswered },
    ],
    blocked: [{ ticket: '03', blockers: ['02'] }],
  });
  const oldRawBefore = fs.readFileSync(qOldPath, 'utf8');
  const oldStatBefore = fs.lstatSync(qOldPath);

  // Batch, council, prewalk, standalone land, and graph.json open flows.
  const b1 = id('b', 1);
  putJson(join(flows, `${b1}.json`), {
    flow: b1, cwd: project, project_root: project, pane: '', state: 'working',
    created_at: agoMs(12), updated_at: agoMs(3), pilot_changed_at: agoMs(9),
    scale: { role: 'sonic', count: 40, max_parallel: 7 },
    totals: { done: 22, failed: 1, running: 7, waiting: 10 },
  });
  putJson(join(flows, b1, 'index.json'), { items: [{ item: 1, pilot: true, state: 'done' }] });

  const jMember = addJob(10, 'working', { role: 'oracle', council: { id: id('j', 11), part: 'member' } }, { started_at: ago(6) });
  const c1 = addJob(11, 'working', {
    role: 'council', synthesizer: 'main',
    council_members: [{ preset: 'fable', failure: 'timeout' }, { preset: 'astra', job: jMember }, { preset: 'carbon' }],
  });
  putJson(join(flows, `${c1}.json`), { flow: c1, cwd: project, project_root: project, pane: '', template: 'council', state: 'working', updated_at: ago(4), steps: { council: { state: 'running' } } });

  const p1 = addJob(12, 'queued', { role: 'imp' });
  const pScout = addJob(13, 'working', { role: 'sonic', parent_job: p1, prewalk_kind: 'code' }, { started_at: ago(3) });
  putJson(join(flows, `${p1}.json`), { flow: p1, cwd: project, project_root: project, pane: '', template: 'prewalk', state: 'working', steps: { scouts: { state: 'running', changed_at: ago(4) }, target: { state: 'waiting' } } });
  putJson(join(flows, p1, 'manifest.json'), { scouts: [{ kind: 'code' }, { kind: 'docs' }] });

  const jLandSource = addJob(14, 'done', { role: 'imp' });
  const fSolo = id('f', 14);
  putJson(join(flows, `${fSolo}.json`), {
    flow: fSolo, job: jLandSource, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/solo' },
    config: { base: 'main', gate: ['build', 'unit', 'lint'], after: [], push: false },
    state: 'running', step: 'gate[3]: lint', pid: process.pid, start: '1',
    created_at: ago(11), updated_at: ago(1), step_started_at: ago(1), source_sha: 'b'.repeat(40),
    timings: [{ step: 'cherry-pick', ok: true, ms: 5 }, { step: 'gate[1]: build', ok: true, ms: 10 }, { step: 'gate[2]: unit', ok: true, ms: 10 }],
  });

  const g1 = id('g', 1);
  putJson(join(flows, `${g1}.json`), {
    flow: g1, cwd: project, project_root: project, pane: '', state: 'working', created_at: ago(16),
    steps: {
      a: { state: 'done', changed_at: ago(14) },
      b: { state: 'running', job: pScout, changed_at: ago(3) },
      c: { state: 'waiting' },
    },
  });
  putJson(join(flows, g1, 'graph.json'), {
    version: 1, name: 'demo-graph',
    steps: {
      a: { kind: 'check', needs: [] },
      b: { kind: 'job', role: 'sonic', needs: ['a'] },
      c: { kind: 'handback', needs: ['a', 'b'] },
    },
  });

  // Ended queue run: must NOT carry `metro`.
  const qEnded = id('q', 3);
  putJson(join(flows, `${qEnded}.json`), {
    flow: qEnded, root: project, project_root: project, feature: 'done-feat', pane: '', task: false, max_parallel: 1,
    created_at: ago(60), updated_at: ago(30), state: 'completed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    tickets: [{ ticket: 'done-feat/01', path: join(project, '.scratch/done-feat/01.md'), role: 'imp', job: jLanded, landed: true, blockers: [] }],
  });

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);
  const byFlow = new Map(view.runs.map((r) => [r.flow, r]));

  // 1. New queue run
  const newRun = byFlow.get(qNew);
  assert.ok(newRun?.metro);
  assert.equal(newRun.metro.waveFallback, undefined);
  assert.deepEqual(newRun.metro.stations.map((s) => [s.id, s.kind, s.state]), [
    ['metro/01', 'worker', 'done'],
    ['metro/02', 'worker', 'working'],
    ['metro/03', 'worker', 'working'],
    ['metro/04', 'worker', 'held'],
    ['metro/05', 'worker', 'failed'],
    ['metro/06', 'worker', 'waiting'],
    ['review', 'review', 'waiting'],
    ['accept', 'accept', 'waiting'],
  ]);
  // Edges preserved for started, landed, held, failed, and blocked items!
  assert.deepEqual(newRun.metro.edges, [
    { from: 'metro/01', to: 'metro/02' },
    { from: 'metro/01', to: 'metro/03' },
    { from: 'metro/01', to: 'metro/04' },
    { from: 'metro/01', to: 'metro/05' },
    { from: 'metro/02', to: 'metro/06' },
    { from: 'metro/03', to: 'metro/06' },
    { from: 'metro/04', to: 'review' },
    { from: 'metro/05', to: 'review' },
    { from: 'metro/06', to: 'review' },
    { from: 'review', to: 'accept' },
  ]);
  // Per-station change times: landed, answered, held, failed, gate+repair!
  const sById = new Map(newRun.metro.stations.map((s) => [s.id, s]));
  assert.equal(sById.get('metro/01').changedAt, agoMs(20));
  assert.equal(sById.get('metro/03').changedAt, agoMs(5), 'answered_at overrides older worker start');
  assert.equal(sById.get('metro/04').changedAt, agoMs(8));
  assert.equal(sById.get('metro/05').changedAt, agoMs(7));
  assert.deepEqual(sById.get('metro/02').gate, { index: 2, total: 3, passed: 1, state: 'failed', command: 'unit' });
  assert.equal(sById.get('metro/02').repair.id, 'metro/02↻');
  assert.equal(sById.get('metro/02').repair.round, 1);
  assert.equal(sById.get('metro/02').repair.total, 2);
  assert.equal(sById.get('metro/02').repair.changedAt, agoMs(2));
  assert.equal(newRun.metro.lastChangedId, 'metro/02↻');

  // Reduce the new queue run through reduceMetroLanes (>3 parallel: 02, 03, 04, 05 in col 1!).
  const reducedNew = reduceMetroLanes(newRun.metro);
  assert.equal(reducedNew.lanes, 3);
  assert.equal(reducedNew.reduced, true);
  assert.equal(reducedNew.columns[1].length, 3);

  // 2. Legacy queue run: wave fallback, file untouched!
  const oldRun = byFlow.get(qOld);
  assert.ok(oldRun?.metro);
  assert.equal(oldRun.metro.waveFallback, true);
  assert.deepEqual(oldRun.metro.edges, [
    { from: '01', to: '02' },
    { from: '02', to: '03' },
    { from: '03', to: 'review' },
    { from: 'review', to: 'accept' },
  ]);
  assert.equal(fs.readFileSync(qOldPath, 'utf8'), oldRawBefore, 'legacy run record must not be rewritten');
  assert.equal(fs.lstatSync(qOldPath).mtimeMs, oldStatBefore.mtimeMs);
  assert.equal(fs.lstatSync(qOldPath).ino, oldStatBefore.ino);

  // 3. Batch pool projection
  const batchRun = byFlow.get(b1);
  assert.deepEqual(batchRun.metro.stations.map((s) => [s.id, s.kind, s.state, s.changedAt]), [
    ['pilot', 'worker', 'done', agoMs(9)],
    ['pool', 'pool', 'working', agoMs(3)],
    ['summary', 'summary', 'waiting', undefined],
  ]);
  assert.deepEqual(batchRun.metro.stations[1].pool, { done: 22, working: 7, failed: 1, waiting: 10 });
  assert.equal(batchRun.metro.stations[1].count, 40);
  assert.deepEqual(batchRun.metro.edges, [{ from: 'pilot', to: 'pool' }, { from: 'pool', to: 'summary' }]);
  assert.equal(batchRun.metro.lastChangedId, 'pool');

  // 4. Council projection
  const councilRun = byFlow.get(c1);
  assert.deepEqual(councilRun.metro.stations.map((s) => [s.id, s.kind, s.state, s.label]), [
    ['member-0', 'worker', 'failed', 'fable'],
    ['member-1', 'worker', 'working', 'astra'],
    ['member-2', 'worker', 'waiting', 'carbon'],
    ['synthesis', 'synth', 'waiting', 'main'],
  ]);
  assert.deepEqual(councilRun.metro.edges, [
    { from: 'member-0', to: 'synthesis' },
    { from: 'member-1', to: 'synthesis' },
    { from: 'member-2', to: 'synthesis' },
  ]);
  assert.equal(councilRun.metro.lastChangedId, 'member-0');

  // 5. Prewalk projection
  const prewalkRun = byFlow.get(p1);
  assert.deepEqual(prewalkRun.metro.stations.map((s) => [s.id, s.kind, s.state]), [
    ['code', 'worker', 'working'],
    ['docs', 'worker', 'waiting'],
    ['target', 'worker', 'waiting'],
  ]);
  assert.deepEqual(prewalkRun.metro.edges, [
    { from: 'code', to: 'target' },
    { from: 'docs', to: 'target' },
  ]);
  assert.equal(prewalkRun.metro.lastChangedId, 'code');

  // 6. Standalone land projection (gate step 3/3 => 2 passed)
  const landRun = byFlow.get(fSolo);
  assert.deepEqual(landRun.metro.stations.map((s) => [s.id, s.kind, s.state]), [
    ['pick', 'worker', 'done'],
    ['gate', 'worker', 'working'],
    ['merge', 'worker', 'waiting'],
  ]);
  assert.deepEqual(landRun.metro.stations[1].gate, { index: 3, total: 3, passed: 2, state: 'working', command: 'lint' });
  assert.equal(landRun.metro.stations[1].changedAt, agoMs(1));
  assert.equal(landRun.metro.lastChangedId, 'gate');
  assert.equal(landRun.nodes[1][0].progress.passed, 2);

  // 7. Graph.json projection (with skip-a-column edge a -> c reduced cleanly)
  const graphRun = byFlow.get(g1);
  assert.deepEqual(graphRun.metro.stations.map((s) => [s.id, s.kind, s.state, s.changedAt]), [
    ['a', 'worker', 'done', agoMs(14)],
    ['b', 'worker', 'working', agoMs(3)],
    ['c', 'accept', 'waiting', undefined],
  ]);
  assert.deepEqual(graphRun.metro.edges, [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
  assert.equal(graphRun.metro.lastChangedId, 'b');
  const reducedGraph = reduceMetroLanes(graphRun.metro);
  assert.equal(reducedGraph.reduced, true);
  assert.deepEqual(reducedGraph.stations.find((s) => s.station.id === 'c').blockers, ['a', 'b']);

  // 8. Ended run omits metro
  assert.equal(byFlow.get(qEnded).metro, undefined);
  assert.equal(lastChangedStationId([]), undefined);
});

test('repair rounds: round two preserves round one with a distinct station id in order for queue tickets, standalone land, and reduced lanes', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-repairs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;
  const addJob = (n, state, receipt = {}, statusExtra = {}) => {
    const jid = id('j', n), dir = join(hud, 'jobs', jid);
    putJson(join(dir, 'job.json'), {
      job: jid, cwd: project, project_root: project, role: 'imp', headless: true,
      dispatch_exit_code: 0, created_at: ago(40 - n), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), {
      state, started_at: ago(30 - n), ...(state === 'done' || state === 'closed' ? { settled_at: ago(15) } : {}), ...statusExtra,
    });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${receipt.ticket ?? `0${n}`}: Synthetic repair ${n}\n`);
    return jid;
  };

  // Queue ticket in round 2 of land repair (distinct worker per round, with recorded changed_at).
  const jSrc = addJob(1, 'done', { ticket: 'rep/01' });
  const jRep1 = addJob(2, 'done', { ticket: 'rep/01' }, { started_at: ago(12), settled_at: ago(9) });
  const jRep2 = addJob(3, 'working', { ticket: 'rep/01' }, { started_at: ago(2) });
  const fQueue = id('f', 1);
  putJson(join(flows, `${fQueue}.json`), {
    flow: fQueue, job: jSrc, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/01' },
    config: { base: 'main', gate: ['build', 'unit', 'lint'], after: [], push: false },
    state: 'running', step: 'repair 2', pid: process.pid, start: '1',
    created_at: ago(18), updated_at: ago(2), step_started_at: ago(2), source_sha: 'a'.repeat(40),
    repairs: [
      { step: 'gate[2]: unit', job: jRep1, outcome: 'failed at gate[2]: unit', started_at: ago(12), changed_at: ago(6) },
      { step: 'gate[2]: unit', job: jRep2, outcome: 'waiting for worker', started_at: ago(2), changed_at: ago(2) },
    ],
    timings: [{ step: 'cherry-pick', ok: true, ms: 5 }, { step: 'gate[2]: unit', ok: false, ms: 20 }],
  });
  const qRep = id('q', 10);
  putJson(join(flows, `${qRep}.json`), {
    flow: qRep, root: project, project_root: project, feature: 'rep', pane: '', task: false, max_parallel: 2,
    created_at: ago(30), updated_at: ago(2), state: 'working',
    steps: { tickets: { state: 'running', changed_at: ago(30) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [
      { ticket: 'rep/01', path: join(project, '.scratch/rep/01.md'), role: 'imp', job: jSrc, land: fQueue, blockers: [] },
      { ticket: 'rep/02', path: join(project, '.scratch/rep/02.md'), role: 'imp', job: addJob(4, 'working', { ticket: 'rep/02' }, { started_at: ago(10) }), blockers: [] },
    ],
  });

  // Legacy standalone land flow in round 2 WITHOUT started_at/changed_at on repairs, reusing the same worker job.
  const jSolo = addJob(5, 'working', { role: 'imp' }, { started_at: ago(3) });
  const fSolo = id('f', 5);
  putJson(join(flows, `${fSolo}.json`), {
    flow: fSolo, job: jSolo, pane: '', task: false,
    wt: { root: project, main_root: project, branch: 'wt/solo' },
    config: { base: 'main', gate: ['unit', 'lint'], after: [], push: false },
    state: 'running', step: 'repair 2', pid: process.pid, start: '1',
    created_at: ago(20), updated_at: ago(3), step_started_at: ago(3), source_sha: 'b'.repeat(40),
    repairs: [
      { step: 'gate[2]: lint', job: jSolo, outcome: 'failed at gate[2]: lint' },
      { step: 'gate[2]: lint', job: jSolo, outcome: 'waiting for worker' },
    ],
    timings: [{ step: 'cherry-pick', ok: true, ms: 5 }, { step: 'gate[2]: lint', ok: false, ms: 15 }],
  });

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const byFlow = new Map(execution.view(project).runs.map((r) => [r.flow, r]));

  const qRun = byFlow.get(qRep);
  const t1 = qRun.metro.stations.find((s) => s.id === 'rep/01');
  assert.equal(t1.repairs.length, 2);
  assert.deepEqual(t1.repairs.map((r) => [r.id, r.round, r.state, r.jobId, r.changedAt]), [
    ['rep/01↻', 1, 'failed', jRep1, agoMs(6)],
    ['rep/01↻2', 2, 'working', jRep2, agoMs(2)],
  ]);
  assert.notEqual(t1.repairs[0].id, t1.repairs[1].id);
  assert.equal(t1.repairs[0].reason, 'failed at gate[2]: unit');
  assert.equal(t1.repair.id, 'rep/01↻2');
  assert.equal(qRun.tickets[0].landRepairs.length, 2);
  assert.equal(qRun.metro.lastChangedId, 'rep/01↻2');

  // Inline / reduced layout data retains both repair rounds and keeps the repaired station lowest in its column.
  const reduced = reduceMetroLanes(qRun.metro);
  const reducedT1 = reduced.columns[0].find((s) => s.station.id === 'rep/01');
  assert.equal(reduced.columns[0].at(-1).station.id, 'rep/01');
  assert.deepEqual(reducedT1.station.repairs.map((r) => r.id), ['rep/01↻', 'rep/01↻2']);

  // Legacy standalone land with reused job keeps both ordered rounds and does not copy round 2's time onto round 1.
  const soloRun = byFlow.get(fSolo);
  const gateStation = soloRun.metro.stations.find((s) => s.id === 'gate');
  assert.deepEqual(gateStation.repairs.map((r) => [r.id, r.round, r.state, r.changedAt]), [
    ['gate↻', 1, 'failed', undefined],
    ['gate↻2', 2, 'working', agoMs(3)],
  ]);
  assert.equal(soloRun.metro.lastChangedId, 'gate↻2');
  assert.deepEqual(soloRun.nodes.flat().filter((n) => n.key.startsWith('repair')).map((n) => [n.key, n.progress.index, n.state]), [
    ['repair', 1, 'failed'],
    ['repair-2', 2, 'running'],
  ]);

  // Direct lastChangedStationId check across multiple repair rounds on one station.
  assert.equal(lastChangedStationId([
    st('01', 'working', {
      changedAt: agoMs(10),
      repairs: [
        { id: '01↻', round: 1, total: 2, state: 'failed', changedAt: agoMs(5) },
        { id: '01↻2', round: 2, total: 2, state: 'working', changedAt: agoMs(1) },
      ],
    }),
  ]), '01↻2');
});

test('acceptance seat: tickets-step leads never appear as accept; accept reflects only the acceptance step and recorded seat', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-accept-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;
  const addJob = (n, role, state, extra = {}) => {
    const jid = id('j', n), dir = join(hud, 'jobs', jid);
    putJson(join(dir, 'job.json'), {
      job: jid, cwd: project, project_root: project, role, headless: true,
      dispatch_exit_code: 0, created_at: ago(25 - n),
    });
    putJson(join(dir, 'STATUS.json'), { state, started_at: ago(20 - n), ...extra });
    fs.writeFileSync(join(dir, 'brief.md'), `# Synthetic ${role} ${n}\n`);
    return jid;
  };

  const jWorker = addJob(1, 'imp', 'done', { settled_at: ago(10) });
  const jAssumpLead = addJob(2, 'lead', 'working', { started_at: ago(1) });
  const jBlockerLead = addJob(3, 'lead', 'working', { started_at: ago(1) });
  const jAcceptLead = addJob(4, 'lead', 'working', { started_at: ago(2) });
  const jEscalatedLead = addJob(5, 'lead', 'closed', { settled_at: ago(3) });

  // 1. Assumption lead active during tickets step: accept must stay waiting with no lead target.
  const qAssump = id('q', 1);
  putJson(join(flows, `${qAssump}.json`), {
    flow: qAssump, root: project, project_root: project, feature: 'seat-assump', pane: '', task: false, max_parallel: 2,
    created_at: ago(20), updated_at: ago(1), state: 'working',
    steps: { tickets: { state: 'running', changed_at: ago(20) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    active_lead: { job: jAssumpLead, kind: 'assumption', step: 'tickets', round: 0, ticket: 'seat-assump/01', worker_job: jWorker },
    tickets: [{ ticket: 'seat-assump/01', path: join(project, '.scratch/seat-assump/01.md'), role: 'imp', job: jWorker, blockers: [] }],
  });

  // 2. Blocker lead active during tickets step on a main-seated queue: accept stays main & waiting.
  const qMain = id('q', 2);
  putJson(join(flows, `${qMain}.json`), {
    flow: qMain, root: project, project_root: project, feature: 'seat-main', pane: '', task: false, max_parallel: 2,
    created_at: ago(20), updated_at: ago(1), state: 'paused', handback_to: 'main',
    steps: { tickets: { state: 'done', changed_at: ago(8) }, review: { state: 'done', changed_at: ago(5) }, accept: { state: 'asking', changed_at: ago(2) } },
    active_lead: { job: jBlockerLead, kind: 'blocker', step: 'tickets', round: 0, ticket: 'seat-main/01', worker_job: jWorker },
    tickets: [{ ticket: 'seat-main/01', path: join(project, '.scratch/seat-main/01.md'), role: 'imp', job: jWorker, landed: true, landed_at: ago(8), blockers: [] }],
  });

  // 3. Real acceptance lead active during accept step: accept binds to lead worker.
  const qLead = id('q', 3);
  putJson(join(flows, `${qLead}.json`), {
    flow: qLead, root: project, project_root: project, feature: 'seat-lead', pane: '', task: false, max_parallel: 2,
    created_at: ago(20), updated_at: ago(2), state: 'working', handback_to: 'lead',
    steps: { tickets: { state: 'done', changed_at: ago(9) }, review: { state: 'done', changed_at: ago(4) }, accept: { state: 'running', changed_at: ago(2) } },
    active_lead: { job: jAcceptLead, kind: 'accept', step: 'accept', round: 0 },
    tickets: [{ ticket: 'seat-lead/01', path: join(project, '.scratch/seat-lead/01.md'), role: 'imp', job: jWorker, landed: true, landed_at: ago(9), blockers: [] }],
  });

  // 4. Settled accept lead after escalation (active_lead cleared, decision recorded).
  const qEsc = id('q', 4);
  putJson(join(flows, `${qEsc}.json`), {
    flow: qEsc, root: project, project_root: project, feature: 'seat-esc', pane: '', task: false, max_parallel: 2,
    created_at: ago(20), updated_at: ago(3), state: 'paused', handback_to: 'lead',
    steps: { tickets: { state: 'done', changed_at: ago(9) }, review: { state: 'done', changed_at: ago(5) }, accept: { state: 'failed', changed_at: ago(3) } },
    decisions: [{ step: 'accept', kind: 'accept', job: jEscalatedLead, decision: 'escalate', reason: 'needs owner', at: ago(3) }],
    tickets: [{ ticket: 'seat-esc/01', path: join(project, '.scratch/seat-esc/01.md'), role: 'imp', job: jWorker, landed: true, landed_at: ago(9), blockers: [] }],
  });

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const byFlow = new Map(execution.view(project).runs.map((r) => [r.flow, r]));

  const rAssump = byFlow.get(qAssump);
  assert.equal(rAssump.lead, undefined);
  assert.equal(rAssump.jobIds.includes(jAssumpLead), true, 'assumption lead stays grouped with the run');
  const acceptAssump = rAssump.metro.stations.find((s) => s.id === 'accept');
  assert.equal(acceptAssump.state, 'waiting');
  assert.equal(acceptAssump.label, 'lead');
  assert.equal(acceptAssump.role, 'lead');
  assert.equal(acceptAssump.jobId, undefined);
  assert.equal(acceptAssump.execJob, undefined);
  assert.equal(acceptAssump.changedAt, undefined);
  assert.notEqual(rAssump.metro.lastChangedId, 'accept');

  const rMain = byFlow.get(qMain);
  assert.equal(rMain.lead, undefined);
  assert.equal(rMain.acceptanceSeat, 'main');
  const acceptMain = rMain.metro.stations.find((s) => s.id === 'accept');
  assert.equal(acceptMain.state, 'asking');
  assert.equal(acceptMain.label, 'main');
  assert.equal(acceptMain.role, undefined);
  assert.equal(acceptMain.jobId, undefined);
  assert.equal(acceptMain.execJob, undefined);
  assert.equal(acceptMain.changedAt, agoMs(2));

  const rLead = byFlow.get(qLead);
  assert.equal(rLead.lead.jobId, jAcceptLead);
  const acceptLead = rLead.metro.stations.find((s) => s.id === 'accept');
  assert.equal(acceptLead.state, 'working');
  assert.equal(acceptLead.label, 'lead');
  assert.equal(acceptLead.role, 'lead');
  assert.equal(acceptLead.jobId, jAcceptLead);
  assert.equal(acceptLead.execJob.target.workerId, `thin-job:${jAcceptLead}`);
  assert.equal(acceptLead.changedAt, agoMs(2));

  const rEsc = byFlow.get(qEsc);
  const acceptEsc = rEsc.metro.stations.find((s) => s.id === 'accept');
  assert.equal(acceptEsc.state, 'failed');
  assert.equal(acceptEsc.jobId, jEscalatedLead);
  assert.equal(acceptEsc.changedAt, agoMs(3));
});

test('answer times: answerComposed, main-answered queue resume, and departure qa fallback update station changedAt', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-answers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  fs.mkdirSync(project, { recursive: true });
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;

  // 1. Composed workflow answered via answerComposed: cursor.changed_at updates to answer time.
  const wFlow = id('w', 1);
  const graph = {
    version: 1, name: 'composed-answer', cost: 'cheap', cost_reasons: [], policy: { breaker: 'none' }, scale: {},
    steps: {
      build: { kind: 'check', needs: [], from: [], optional: false, job: 'x', repair: 0 },
      approve: { kind: 'handback', needs: ['build'], from: ['build'], optional: false, to: 'main', ask: 'Ship?', options: ['ship', 'hold'] },
      publish: { kind: 'check', needs: ['approve'], from: [], optional: false, job: 'x', repair: 0 },
    },
  };
  putJson(join(flows, wFlow, 'graph.json'), graph);
  const { hashComposedGraph } = await import('../../dist/workflows/composed-state.js');
  putJson(join(flows, `${wFlow}.json`), {
    flow: wFlow, pane: 'w1:p1', cwd: project, project_root: project, template: 'composed',
    hash: hashComposedGraph(project, graph), cost: 'cheap', created_at: ago(20), state: 'paused',
    epoch: 0, streak: 0, failures: 0, settled: 0, notices: {}, answers: {},
    handback: { step: 'approve', request_id: 'h-approve', ask: 'Ship?', choices: ['ship', 'hold'], refs: [] },
    steps: {
      build: { state: 'done', changed_at: ago(15) },
      approve: { state: 'asking', changed_at: ago(10) },
      publish: { state: 'waiting' },
    },
  });
  const beforeComposed = Date.now();
  const composedRes = await answerComposed(hud, 'w1:p1', { job: wFlow, request_id: 'h-approve', answer: 'ship' });
  const afterComposed = Date.now();
  assert.deepEqual(composedRes, { ok: true, written: true, answer: 'ship' });
  const savedComposed = JSON.parse(fs.readFileSync(join(flows, `${wFlow}.json`), 'utf8'));
  const composedAnswerAt = Date.parse(savedComposed.steps.approve.changed_at);
  assert.ok(composedAnswerAt >= beforeComposed && composedAnswerAt <= afterComposed, 'answerComposed records cursor changed_at');

  // 2. Main-answered queue question resume path: records answered_at, changed_at, and decision on the queue item.
  const jMainQ = id('j', 20);
  putJson(join(hud, 'jobs', jMainQ, 'job.json'), {
    job: jMainQ, cwd: project, project_root: project, role: 'imp', headless: true, dispatch_exit_code: 0, created_at: ago(25),
  });
  putJson(join(hud, 'jobs', jMainQ, 'STATUS.json'), { state: 'working', started_at: ago(20) });
  fs.writeFileSync(join(hud, 'jobs', jMainQ, 'brief.md'), '# ans/01: Main-answered ticket\n');
  const qMain = id('q', 20);
  putJson(join(flows, `${qMain}.json`), {
    flow: qMain, root: project, project_root: project, feature: 'ans', pane: '', task: false, max_parallel: 1,
    created_at: ago(25), updated_at: ago(12), state: 'paused', handback_to: 'main',
    handback: { step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'ans/01', job: jMainQ, question: 'q1' },
    steps: { tickets: { state: 'failed', changed_at: ago(12) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [{ ticket: 'ans/01', path: join(project, '.scratch/ans/01.md'), role: 'imp', job: jMainQ, blockers: [] }],
  });
  const beforeResume = Date.now();
  await resumeQueueAfterAnswer(hud, jMainQ, 'q1', '', project);
  const afterResume = Date.now();
  const updatedQueue = readTicketQueue(hud, qMain);
  const resumeAnswerAt = Date.parse(updatedQueue.tickets[0].answered_at);
  assert.ok(resumeAnswerAt >= beforeResume && resumeAnswerAt <= afterResume, 'resumeQueueAfterAnswer stamps item.answered_at');
  assert.equal(updatedQueue.tickets[0].changed_at, updatedQueue.tickets[0].answered_at);
  assert.equal(updatedQueue.decisions.some((d) => d.kind === 'question' && d.decision === 'answer' && d.ticket === 'ans/01' && d.question === 'q1'), true);

  // 3. Departure fallback: worker answered with non-default choice (`state: 'departure'` in thin-jobs) without item.answered_at.
  const jDep = id('j', 21);
  const depDir = join(hud, 'jobs', jDep);
  putJson(join(depDir, 'job.json'), {
    job: jDep, cwd: project, project_root: project, role: 'imp', headless: true, dispatch_exit_code: 0, created_at: ago(25),
  });
  putJson(join(depDir, 'STATUS.json'), { state: 'working', started_at: ago(20) });
  fs.writeFileSync(join(depDir, 'brief.md'), '# dep/01: Departure answer ticket\n');
  fs.mkdirSync(join(depDir, 'qa'), { recursive: true });
  const qPath = join(depDir, 'qa', 'q1.md');
  const aPath = join(depDir, 'qa', 'q1.answer.md');
  fs.writeFileSync(qPath, '# Question\n\nPick a retention window?\n\nOptions:\n- 1h\n- 24h\n\nDefault if unanswered: 1h\n');
  fs.writeFileSync(aPath, '24h\n');
  const depAnswerMs = Math.floor((Date.now() - 2 * 60_000) / 1000) * 1000;
  fs.utimesSync(qPath, new Date(depAnswerMs - 60_000), new Date(depAnswerMs - 60_000));
  fs.utimesSync(aPath, new Date(depAnswerMs), new Date(depAnswerMs));
  const qDep = id('q', 21);
  putJson(join(flows, `${qDep}.json`), {
    flow: qDep, root: project, project_root: project, feature: 'dep', pane: '', task: false, max_parallel: 2,
    created_at: ago(25), updated_at: ago(15), state: 'working',
    steps: { tickets: { state: 'running', changed_at: ago(25) }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [
      { ticket: 'dep/01', path: join(project, '.scratch/dep/01.md'), role: 'imp', job: jDep, blockers: [] },
      { ticket: 'dep/02', path: join(project, '.scratch/dep/02.md'), role: 'imp', blockers: ['dep/01'] },
    ],
  });

  const collectNow = Date.now() + 5_000;
  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, collectNow);
  const byFlow = new Map(execution.view(project).runs.map((r) => [r.flow, r]));

  // Verify composed workflow station picked up answerComposed changed_at.
  const composedRun = byFlow.get(wFlow);
  assert.equal(composedRun.metro.stations.find((s) => s.id === 'approve').state, 'done');
  assert.equal(composedRun.metro.stations.find((s) => s.id === 'approve').changedAt, composedAnswerAt);
  assert.equal(composedRun.metro.lastChangedId, 'approve');

  // Verify main-answered queue ticket picked up resumeQueueAfterAnswer timestamp.
  const mainRun = byFlow.get(qMain);
  assert.equal(mainRun.metro.stations.find((s) => s.id === 'ans/01').changedAt, resumeAnswerAt);
  assert.equal(mainRun.metro.lastChangedId, 'ans/01');

  // Verify non-default departure answer sets station changedAt from qa answer file.
  const depWorker = [...execution.board().lanes.flatMap((l) => l.workers)].find((w) => w.id === `thin-job:${jDep}`);
  assert.equal(depWorker.files.find((f) => f.kind === 'question').state, 'departure');
  const depRun = byFlow.get(qDep);
  assert.equal(depRun.metro.stations.find((s) => s.id === 'dep/01').changedAt, depAnswerMs);
  assert.equal(depRun.metro.lastChangedId, 'dep/01');
});

test('batch pool change time: failed pilot stays lastChangedStationId over unstarted pool, and legacy batch records still parse', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-metro-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  fs.mkdirSync(project, { recursive: true });
  const id = (p, n) => `${p}${n.toString(16).padStart(16, '0')}`;

  // 1. Real settleItem + saveBatch: failed pilot pauses batch before tail starts; later save bumps updated_at.
  const bFail = id('b', 30);
  fs.mkdirSync(join(flows, bFail), { recursive: true });
  const failBatch = {
    flow: bFail, cwd: project, project_root: project, pane: '', key: 'k1',
    created_at: agoMs(15), state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0, notices: {},
    scale: { role: 'sonic', count: 5, cap: 8, max_parallel: 3, presets: ['fast'], input_bytes: { max: 10, median: 10, total: 50 } },
    totals: { waiting: 4, running: 1, done: 0, failed: 0 },
  };
  const failItems = [
    { item: 1, preset: 'fast', pilot: true, state: 'running' },
    { item: 2, preset: 'fast', pilot: false, state: 'waiting' },
    { item: 3, preset: 'fast', pilot: false, state: 'waiting' },
    { item: 4, preset: 'fast', pilot: false, state: 'waiting' },
    { item: 5, preset: 'fast', pilot: false, state: 'waiting' },
  ];
  settleItem(failBatch, failItems, failItems[0], 'pilot failed check');
  saveBatch(hud, failBatch, failItems);
  assert.equal(failBatch.state, 'paused');
  assert.equal(typeof failBatch.pilot_changed_at, 'number');
  assert.equal(failBatch.pool_changed_at, undefined);
  // Simulate a later saveBatch bumping updated_at past pilot_changed_at.
  const bumpedFail = JSON.parse(fs.readFileSync(join(flows, `${bFail}.json`), 'utf8'));
  bumpedFail.updated_at = failBatch.pilot_changed_at + 10_000;
  putJson(join(flows, `${bFail}.json`), bumpedFail);

  // 2. Real settleItem + saveBatch on tail: pool_changed_at records true tail transition, ignoring later updated_at saves.
  const bTail = id('b', 31);
  fs.mkdirSync(join(flows, bTail), { recursive: true });
  const tailBatch = {
    flow: bTail, cwd: project, project_root: project, pane: '', key: 'k2',
    created_at: agoMs(15), state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0, notices: {},
    scale: { role: 'sonic', count: 3, cap: 8, max_parallel: 2, presets: ['fast'], input_bytes: { max: 10, median: 10, total: 30 } },
    totals: { waiting: 1, running: 1, done: 1, failed: 0 },
    pilot_changed_at: agoMs(10),
  };
  const tailItems = [
    { item: 1, preset: 'fast', pilot: true, state: 'done' },
    { item: 2, preset: 'fast', pilot: false, state: 'running' },
    { item: 3, preset: 'fast', pilot: false, state: 'waiting' },
  ];
  settleItem(tailBatch, tailItems, tailItems[1]);
  saveBatch(hud, tailBatch, tailItems);
  assert.equal(typeof tailBatch.pool_changed_at, 'number');
  const bumpedTail = JSON.parse(fs.readFileSync(join(flows, `${bTail}.json`), 'utf8'));
  bumpedTail.updated_at = tailBatch.pool_changed_at + 60_000;
  putJson(join(flows, `${bTail}.json`), bumpedTail);

  // 3. Legacy failed-pilot batch written before pilot_changed_at / pool_changed_at existed: still parses, pilot wins.
  const bLegacy = id('b', 32);
  const legacyPath = join(flows, `${bLegacy}.json`);
  putJson(legacyPath, {
    flow: bLegacy, cwd: project, project_root: project, pane: '', state: 'paused', reason: 'pilot failed',
    created_at: agoMs(12), updated_at: agoMs(4),
    scale: { role: 'sonic', count: 4, max_parallel: 2 },
    totals: { waiting: 3, running: 0, done: 0, failed: 1 },
  });
  putJson(join(flows, bLegacy, 'index.json'), {
    items: [
      { item: 1, pilot: true, state: 'failed', reason: 'timeout' },
      { item: 2, pilot: false, state: 'waiting' },
      { item: 3, pilot: false, state: 'waiting' },
      { item: 4, pilot: false, state: 'waiting' },
    ],
  });
  const legacyRawBefore = fs.readFileSync(legacyPath, 'utf8');

  const execution = new PanelExecution(hud, null, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, Date.now() + 120_000);
  const byFlow = new Map(execution.view(project).runs.map((r) => [r.flow, r]));

  const failRun = byFlow.get(bFail);
  assert.equal(failRun.metro.stations.find((s) => s.id === 'pilot').state, 'failed');
  assert.equal(failRun.metro.stations.find((s) => s.id === 'pilot').changedAt, failBatch.pilot_changed_at);
  assert.equal(failRun.metro.stations.find((s) => s.id === 'pool').state, 'waiting');
  assert.equal(failRun.metro.stations.find((s) => s.id === 'pool').changedAt, undefined);
  assert.equal(failRun.metro.lastChangedId, 'pilot');

  const tailRun = byFlow.get(bTail);
  assert.equal(tailRun.metro.stations.find((s) => s.id === 'pool').changedAt, tailBatch.pool_changed_at);
  assert.equal(tailRun.metro.lastChangedId, 'pool');

  const legacyRun = byFlow.get(bLegacy);
  assert.equal(legacyRun.metro.stations.find((s) => s.id === 'pilot').state, 'failed');
  assert.equal(legacyRun.metro.stations.find((s) => s.id === 'pilot').changedAt, agoMs(4));
  assert.equal(legacyRun.metro.stations.find((s) => s.id === 'pool').changedAt, undefined);
  assert.equal(legacyRun.metro.lastChangedId, 'pilot');
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyRawBefore, 'legacy batch record must not be rewritten');
});
