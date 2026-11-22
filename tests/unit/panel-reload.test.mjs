import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePanelPlace, PanelReload, readPanelPlace } from '../../dist-test/src/utils/panel-reload.js';
import { initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { delay, until, fixture, launch, encode, live, QUIET_MS } from '../helpers/panel-reload-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const moduleUrl = pathToFileURL(resolve('dist-test/src/utils/panel-reload.js')).href;

test('reload place retains opening time; legacy handoffs use their consumption time', () => {
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  try {
    const openedAt = Date.now() - 60000;
    process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: initialMonitorState(), settings: null, openedAt });
    assert.equal(readPanelPlace().openedAt, openedAt);
    const initial = initialMonitorState();
    const flat = { mainTab: 'home', focus: 'agents', modes: initial.modes, scroll: { changes: 0, details: 0 }, tree: { selectedId: null }, help: false };
    process.env.HUD_PANEL_RELOAD_PLACE = encode({ state: { ...flat, preview: 'agent', zoom: true,
      scroll: { ...flat.scroll, agents: 4 }, tree: { ...flat.tree, collapsed: new Set(['retired']), showAll: true },
      projectCursor: 'project:page:docs', controlHarnesses: true,
      controlNav: { projectCursor: 'project:role:imp', projectFolded: new Set(['usage']), projectScroll: 3 },
      controlHarnessNav: { projectCursor: 'control:harness:pi', projectFolded: new Set(), splitFor: 'harnesses|control:harness:pi', splitScroll: 4 },
      controlHarnessNotice: { id: 'pi', off: false }, modelPrevious: { synthetic: 'previous-model' },
      expPage: { detail: 'openai-api', cursor: 'calibration', scroll: 2, edit: { text: 'not transferred' } },
      controlHarnessAdd: { text: 'not transferred' },
    }, settings: null });
    const before = Date.now(), legacy = readPanelPlace(), after = Date.now();
    assert.ok(legacy.openedAt >= before && legacy.openedAt <= after);
    const { control, home, project, exp, subpage, overlay } = legacy.state;
    assert.equal(legacy.state.activeTab, 'home');
    assert.equal(project.nav.cursor, 'project:page:docs');
    assert.equal(home.showAll, true);
    assert.deepEqual({ detail: exp.detail, cursor: exp.cursor, scroll: exp.scroll }, { detail: 'openai-api', cursor: 'calibration', scroll: 2 });
    assert.equal(subpage, undefined);
    assert.equal(overlay, undefined);
    for (const retired of ['preview', 'zoom', 'tree', 'controlHarnessAdd', 'expPage']) assert.ok(!(retired in legacy.state));
    assert.equal(control.subTab, 'harnesses');
    assert.equal(control.roles.nav.cursor, 'project:role:imp');
    assert.equal(control.roles.nav.scroll, 3);
    assert.deepEqual(control.roles.folded, new Set(['usage']));
    assert.equal(control.harnesses.nav.cursor, 'control:harness:pi');
    assert.equal(control.harnesses.nav.split.previewScroll, 4);
    assert.equal(control.harnesses.nav.split.previewFor, 'harnesses|control:harness:pi');
    assert.deepEqual(control.harnesses.folded, new Set());
    assert.deepEqual(control.notice, { kind: 'harness', id: 'pi', off: false });
    assert.deepEqual(control.modelPrevious, { synthetic: 'previous-model' });
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
  const state = initialMonitorState();
  state.activeTab = 'project';
  state.home = { ...state.home, cursor: { kind: 'work', target: { kind: 'worker', laneId: 'lane', workerId: 'worker' } },
    expanded: new Set(['worker:lane:worker']), toggled: new Set(['worker:lane:worker']), foldedLanes: new Set(['other']), showAll: true };
  state.project.folded = new Set(['project']);
  state.help = {};
  const roles = state.control.roles;
  roles.folded = new Set(['usage']);
  roles.nav = { cursor: 'project:role:imp:0', scroll: 3, revealed: 'control|project:role:imp|project:role:imp:0',
    split: { focus: 'preview', listCursor: 'project:role:imp', previewCursor: 'project:role:imp:0', listScroll: 2, previewScroll: 5, previewFor: 'control|project:role:imp' } };
  state.exp = { detail: 'openai-api', cursor: 'calibration', scroll: 2 };
  writeFixtureFile(runner, `import {PanelReload,readPanelPlace,encodePanelPlace} from ${JSON.stringify(moduleUrl)};
${fallback ? 'process.execve=undefined;' : ''}
const reload=new PanelReload(), wire=JSON.parse(process.env.HUD_PANEL_RELOAD_PLACE??'null'), place=readPanelPlace();
console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(2),test:process.env.SYNTHETIC,consumed:!process.env.HUD_PANEL_RELOAD_PLACE,place:place&&JSON.parse(encodePanelPlace(place)),wire}));
const phase=place?.state.help?.scroll??0;
if(phase<3) await reload.restart({state:{...(place?.state??JSON.parse(process.env.SYNTHETIC_PLACE,(_k,v)=>v?.panelSet?new Set(v.panelSet):v)),help:{scroll:phase+1}},settings:{selected:2,offset:1}},()=>{});
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
    assert.equal(row.wire?.state.overlay, undefined, 'the reload environment never contains the overlay');
    if (i) {
      assert.deepEqual(row.wire.state, JSON.parse(encodePanelPlace({ state: { ...state, help: { scroll: i } }, settings: null })).state);
      assert.equal(row.wire.state.home, undefined, 'the handoff still carries the previous flat shape');
      assert.deepEqual(row.place.state, row.wire.state);
      assert.deepEqual(row.place.settings, { selected: 2, offset: 1 });
    }
  }
});

test('the older-Node supervisor forwards signals and returns the child status', async (t) => {
  const f = fixture(t), runner = join(f.root, 'signal.mjs');
  writeFixtureFile(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
import {initialMonitorState} from ${JSON.stringify(pathToFileURL(resolve('dist-test/src/render/monitor.js')).href)};
process.execve=undefined;const reload=new PanelReload();
if(readPanelPlace()){process.on('SIGTERM',()=>process.exit(23));console.log('ready');setInterval(()=>{},1000);}
else await reload.restart({state:initialMonitorState(),settings:null},()=>{});`);
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
  assert.deepEqual(saved.homeTarget, f.state.home.cursor.target);
  assert.deepEqual(saved.boardExpanded.panelSet, [...f.state.home.expanded]);
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
