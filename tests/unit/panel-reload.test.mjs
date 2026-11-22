import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PanelReload, readPanelPlace } from '../../dist-test/src/utils/panel-reload.js';
import { initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { delay, until, fixture, launch, encode, live, QUIET_MS } from '../helpers/panel-reload-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const moduleUrl = pathToFileURL(resolve('dist-test/src/utils/panel-reload.js')).href;

test('reload place retains opening time; legacy handoffs use their consumption time', () => {
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  try {
    const openedAt = Date.now() - 60000;
    process.env.HUD_PANEL_RELOAD_PLACE = encode({ state: initialMonitorState(), settings: null, openedAt });
    assert.equal(readPanelPlace().openedAt, openedAt);
    const initial = initialMonitorState();
    process.env.HUD_PANEL_RELOAD_PLACE = encode({ state: { ...initial, preview: 'agent', zoom: true,
      scroll: { ...initial.scroll, agents: 4 }, tree: { ...initial.tree, collapsed: new Set(['retired']), showAll: true },
      expPage: { detail: 'openai-api', edit: { text: 'not transferred' } }, controlHarnessAdd: { text: 'not transferred' },
    }, settings: null });
    const before = Date.now(), legacy = readPanelPlace(), after = Date.now();
    assert.ok(legacy.openedAt >= before && legacy.openedAt <= after);
    assert.deepEqual(legacy.state, { ...initial, tree: { ...initial.tree, showAll: true }, expPage: { detail: 'openai-api' } });
    assert.equal(process.env.HUD_PANEL_RELOAD_PLACE, undefined);
  } finally {
    if (previous === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = previous;
  }
});

test('a real dist entry change is quiet for 2s, bursts coalesce, and a generation is attempted once', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFixtureFile(entry, 'export const version = 0;');
  const reload = new PanelReload(entry);
  assert.equal(await reload.poll(() => false, 10000), false);
  writeFixtureFile(entry, 'export const version = 1;');
  assert.equal(await reload.poll(() => false, 11000), false);
  writeFixtureFile(entry, readFileSync(entry, 'utf8') + '\n// burst 2');
  assert.equal(await reload.poll(() => false, 12500), false);
  assert.equal(await reload.poll(() => false, 14499), false);
  assert.equal(await reload.poll(() => false, 14500), true);
  assert.equal(await reload.poll(() => false, 20000), false);
});

test('syntax errors, missing imports and missing entry keep the old generation; a good build recovers', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFixtureFile(entry, 'export {};');
  const reload = new PanelReload(entry);
  let now = 10000;
  for (const body of ['export syntax error!', 'import "./missing.js";', null]) {
    if (body === null) rmSync(entry); else writeFixtureFile(entry, body);
    assert.equal(await reload.poll(() => false, now), false);
    assert.equal(await reload.poll(() => false, now + 2000), false);
    assert.equal(reload.failed, true);
    assert.equal(await reload.poll(() => false, now + 3000), false);
    now += 4000;
  }
  writeFixtureFile(entry, 'export const recovered = true;');
  assert.equal(await reload.poll(() => false, now), false);
  assert.equal(await reload.poll(() => false, now + 2000), true);
  assert.equal(reload.failed, false);
});

test('dirty Settings block reload, including edits made while the load check is running', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFixtureFile(entry, 'export {};');
  const reload = new PanelReload(entry);
  writeFixtureFile(entry, 'await new Promise(r => setTimeout(r, 200));');
  let dirty = true;
  assert.equal(await reload.poll(() => dirty, 10000), false);
  assert.equal(await reload.poll(() => dirty, 13000), false);
  dirty = false;
  const pending = reload.poll(() => dirty, 14000);
  dirty = true;
  assert.equal(await pending, false);
  dirty = false;
  assert.equal(await reload.poll(() => dirty, 15000), true);
});

for (const fallback of [false, true]) test(`${fallback ? 'single-supervisor fallback' : 'execve'} preserves argv/env and revives the saved place over three restarts`, { skip: !fallback && typeof process.execve !== 'function' }, async (t) => {
  const f = fixture(t), runner = join(f.root, 'restart.mjs');
  const state = { ...initialMonitorState(), mainTab: 'project', homeTarget: { kind: 'worker', laneId: 'lane', workerId: 'worker' },
    boardExpanded: new Set(['worker:lane:worker']), boardToggled: new Set(['worker:lane:worker']), boardFolded: new Set(['other']),
    projectFolded: new Set(['project']), help: true, tree: { ...initialMonitorState().tree, showAll: true } };
  writeFixtureFile(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
${fallback ? 'process.execve=undefined;' : ''}
const reload=new PanelReload();const transportedOverlay=JSON.parse(process.env.HUD_PANEL_RELOAD_PLACE??'null')?.state?.overlay;const place=readPanelPlace();
console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(2),test:process.env.SYNTHETIC,consumed:!process.env.HUD_PANEL_RELOAD_PLACE,place,transportedOverlay},(_k,v)=>v instanceof Set?{panelSet:[...v]}:v));
const phase=place?.state.helpScroll??0;
if(phase<3) await reload.restart({state:{...(place?.state??JSON.parse(process.env.SYNTHETIC_PLACE,(_k,v)=>v?.panelSet?new Set(v.panelSet):v)),helpScroll:phase+1},settings:{selected:2,offset:1}},()=>{});
else process.exitCode=17;
`);
  const run = launch(f, runner, ['arg with spaces', '--root', 'synthetic/root'], { SYNTHETIC: 'preserved', SYNTHETIC_PLACE: encode({ ...state, overlay: { kind: 'control-chain',
    role: { editor: { places: [{ raw: { args: ['--synthetic-secret-flag'] } }] } }, at: 0, mode: { kind: 'places' } } }) });
  assert.deepEqual(await run.exited, { code: 17, signal: null }, run.stderr());
  const rows = run.output().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  if (fallback) assert.ok(rows.slice(1).every((r) => r.ppid === rows[0].pid), 'one parent, never nested supervisors');
  else assert.equal(new Set(rows.map((r) => r.pid)).size, 1, 'exec replaces the same process');
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(row.argv, ['arg with spaces', '--root', 'synthetic/root']);
    assert.equal(row.test, 'preserved');
    assert.equal(row.consumed, true);
    assert.equal(row.transportedOverlay, undefined, 'the reload environment never contains the overlay');
    if (i) {
      assert.deepEqual(row.place.state, JSON.parse(encode({ ...state, helpScroll: i })));
      assert.deepEqual(row.place.settings, { selected: 2, offset: 1 });
    }
  }
});

test('the older-Node supervisor forwards signals and returns the child status', async (t) => {
  const f = fixture(t), runner = join(f.root, 'signal.mjs');
  writeFixtureFile(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
process.execve=undefined;const reload=new PanelReload();
if(readPanelPlace()){process.on('SIGTERM',()=>process.exit(23));console.log('ready');setInterval(()=>{},1000);}
else await reload.restart({state:{},settings:null},()=>{});`);
  const run = launch(f, runner);
  await until(() => run.output().includes('ready'), 'replacement did not start');
  run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 23, signal: null });
});

test('the live panel coalesces build bursts, retains jobs settled during its life, and keeps a broken build alive with a notice', async (t) => {
  const openedAt = Date.now() - 60000;
  const f = live(t, (state) => ({ state, settings: null, openedAt }));
  await until(() => f.output().includes('SYNTHETIC reload job'), 'initial collected Home frame did not render');
  writeFixtureFile(join(f.env.HUD_HOME, 'jobs/j0000000000000000/STATUS.json'), JSON.stringify({ state: 'done', settled_at: new Date().toISOString() }));
  for (let i = 0; i < 2; i++) { f.appendBuild(`\n// build burst ${i}`); await delay(20); }
  const lastChange = Date.now();
  f.appendBuild('\n// build burst 2');
  await until(() => f.events().filter((e) => e.start).length === 2, 'panel did not replace itself');
  await delay(400);
  assert.equal(f.restarts().length, 1);
  assert.ok(f.restarts()[0].at - lastChange >= QUIET_MS, 'quiet period measured from last change');
  assert.equal(f.restarts()[0].restart.openedAt, openedAt);
  const saved = f.restarts()[0].restart.state;
  assert.equal(saved.mainTab, 'home');
  assert.deepEqual(saved.homeTarget, f.state.homeTarget);
  assert.deepEqual(saved.boardExpanded.panelSet, [...f.state.boardExpanded]);
  assert.equal(saved.tree.showAll, true);
  f.appendBuild('\ninvalid syntax !');
  await until(() => f.output().includes('new build failed to load'), 'bad build notice not rendered');
  assert.equal(f.restarts().length, 1);
  assert.equal(f.child.exitCode, null);
  writeFixtureFile(f.entry, f.baseline + '\n// good recovery');
  await until(() => f.events().filter((e) => e.start).length === 3, 'good build did not recover');
  assert.equal(f.restarts()[1].restart.openedAt, openedAt);
  const restored = f.restarts()[1].restart.state;
  assert.deepEqual(restored.homeTarget, saved.homeTarget, 'settled job and selection survived the first collected frame');
  assert.deepEqual(restored.boardExpanded, saved.boardExpanded);
  assert.deepEqual(restored.boardFolded, saved.boardFolded);
  assert.deepEqual(restored.boardToggled, saved.boardToggled);
  for (const start of f.events().filter((e) => e.start)) {
    assert.deepEqual(start.argv, ['same argv']);
    assert.equal(start.test, 'same env');
  }
  await delay(500);
  assert.equal(f.restarts().length, 2, 'no restart loop on an unchanged generation');
});
