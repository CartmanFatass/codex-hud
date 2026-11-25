import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePanelPlace, PanelReload, readPanelPlace } from '../../dist/utils/panel-reload.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { delay, until, fixture, launch, encode, live, QUIET_MS } from '../helpers/panel-reload-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { until as untilRendered } from '../helpers/until.mjs';

const moduleUrl = pathToFileURL(resolve('dist/utils/panel-reload.js')).href;

test('reload place retains opening time; legacy handoffs use their consumption time', () => {
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  try {
    const openedAt = Date.now() - 60000;
    process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: initialMonitorState(), settings: null, openedAt });
    assert.equal(readPanelPlace().openedAt, openedAt);
    const flat = { mainTab: 'home', focus: 'agents', scroll: { changes: 0, details: 0 }, tree: { selectedId: null }, help: false };
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
    assert.deepEqual({ detail: exp.detail, cursor: exp.cursor, scroll: exp.scroll }, { detail: 'openai-api', cursor: 'calibration', scroll: 2 });
    assert.equal(subpage, undefined);
    assert.equal(overlay, undefined);
    for (const retired of ['preview', 'zoom', 'tree', 'controlHarnessAdd', 'expPage']) assert.ok(!(retired in legacy.state));
    assert.equal(control.subTab, 'harnesses');
    assert.equal(control.roles.nav.cursor, 'project:role:imp');
    assert.equal(control.roles.nav.scroll, 3);
    assert.deepEqual(control.roles.folded, new Set(['usage']));
    assert.equal(control.harnesses.nav.cursor, 'control:harness:pi');
    assert.deepEqual(control.harnesses.folded, new Set());
    assert.equal(control.notice, undefined);
    assert.deepEqual(control.modelPrevious, { synthetic: 'previous-model' });
    assert.equal(process.env.HUD_PANEL_RELOAD_PLACE, undefined);
  } finally {
    if (previous === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = previous;
  }
});

function readPlace(raw) {
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  try {
    process.env.HUD_PANEL_RELOAD_PLACE = raw;
    return readPanelPlace();
  } finally {
    if (previous !== undefined) process.env.HUD_PANEL_RELOAD_PLACE = previous;
  }
}

test('v1 migrates the Project view, cursor, saved pages and nested Control nav', () => {
  const split = { focus: 'preview', listCursor: 'project:role:imp', listScroll: 2,
    previewCursor: 'project:role:imp:0', previewScroll: 5, previewFor: 'control|project:role:imp' };
  const state = { mainTab: 'project', projectPage: 'progress', projectRoot: '/synthetic/selected', projectBack: true,
    projectCursor: 'project:try', projectScroll: 3, projectTry: { cursor: 'slice:one', scroll: 6 },
    projectSaved: { tickets: { cursor: 'ticket:two', scroll: 4 } }, projectFolded: new Set(['task:one']),
    splitFocus: 'preview', splitList: 'project:fold:task:one', splitSub: 'slice:one', splitScroll: 5, splitListScroll: 2,
    splitFor: 'project|progress|/synthetic/selected|project:fold:task:one',
    control: { subTab: 'roles', roles: { nav: { cursor: split.previewCursor, scroll: 3, split }, folded: new Set(['usage']) },
      harnesses: { folded: new Set(['harness-off']) }, modelPrevious: { imp: 'synthetic/old' },
      notice: { kind: 'preset', role: 'imp', name: 'not restored' } },
    focus: 'agents', filterQuery: 'slice', filterOpen: false,
    panelLayout: 'classic', cardHideMinutes: 30, splitRatio: 0.4 };
  const place = readPlace(encode({ state, settings: { selected: 2, offset: 1 }, openedAt: 42, widthOverride: 56 }));
  const { activeTab, selectedProject, project, control, prefs, home } = place.state;
  assert.equal(activeTab, 'project');
  assert.equal(selectedProject, state.projectRoot);
  assert.deepEqual(project.view, { kind: 'progress' }, 'obsolete try-only mode is not restored');
  assert.equal(project.fromProjectsList, true);
  assert.equal(project.nav.cursor, state.projectCursor);
  assert.equal(project.nav.scroll, state.projectScroll);
  assert.deepEqual(project.savedPages, state.projectSaved);
  assert.deepEqual(project.folded, state.projectFolded);
  assert.deepEqual(project.filter, { query: 'slice', editing: false });
  assert.equal(control.roles.nav.cursor, split.previewCursor);
  assert.deepEqual(control.roles.folded, new Set(['usage']));
  assert.deepEqual(control.harnesses.folded, new Set(['harness-off']));
  assert.deepEqual(control.modelPrevious, { imp: 'synthetic/old' });
  assert.equal(control.notice, undefined);
  assert.deepEqual([place.openedAt, place.widthOverride, place.settings], [42, 56, { selected: 2, offset: 1 }]);
});

test('v1 drops Home card, Split and Changes state but restores Inspector, Help and Project filters', () => {
  const target = { kind: 'worker', laneId: 'lane', workerId: 'thin-job:j0000000000000001' };
  const state = { mainTab: 'home', focus: 'agents', homeTarget: target, boardAnchor: 'home-progress:progress', homeScroll: 4,
    boardExpanded: new Set(['worker']), boardToggled: new Set(['worker']), boardFolded: new Set(['lane']),
    projectFolded: new Set(['task:one', 'ledger:two', 'agents']), splitCursor: 'lane', splitFocus: 'preview',
    splitFor: 'home|lane', splitSub: 'worker', splitScroll: 5, splitListScroll: 2, tree: { showAll: true, selectedId: 'node' },
    filterQuery: 'job', scroll: { changes: 8, details: 7 } };
  const get = (patch = {}) => readPlace(encode({ state: { ...state, ...patch } })).state;
  const restored = get();
  assert.deepEqual(restored.project.folded, new Set(['agents']));
  assert.equal(restored.project.filter, undefined);
  const inspector = get({ focus: 'details', boardInspect: target, inspectCursor: 'file:one' });
  const { kind, target: inspected, cursor, scroll } = inspector.subpage;
  assert.deepEqual([kind, inspected, cursor, scroll], ['inspector', target, 'file:one', 7]);
  assert.equal(get({ focus: 'changes' }).subpage, undefined);
  assert.deepEqual(restored.home, { scroll: 0 });
  const help = get({ help: true, helpScroll: 14 });
  assert.deepEqual(help.help, { scroll: 14 });
  for (const projectPage of ['tickets', 'docs']) {
    const { home, project } = get({ mainTab: 'project', projectPage });
    assert.equal(project.filter?.query, projectPage === 'tickets' ? 'job' : undefined);
  }
});

test('v2 keeps independent Home and Project places and restores only whitelisted navigation', () => {
  const secret = 'SYNTHETIC_DO_NOT_TRANSPORT';
  const rawArgs = { args: ['--synthetic-secret-flag', secret] };
  const state = initialMonitorState();
  state.activeTab = 'project';
  state.selectedProject = '/synthetic/project';
  const target = { kind: 'worker', laneId: 'lane', workerId: 'thin-job:j0000000000000001', raw: rawArgs };
  const homeSplit = { focus: 'preview', listCursor: 'lane', listScroll: 2, previewCursor: 'worker', previewScroll: 9, previewFor: 'home|lane' };
  const projectSplit = { focus: 'preview', listCursor: 'project:page:tree', listScroll: 3,
    previewCursor: 'project:file:synthetic', previewScroll: 5, previewFor: 'project|hub|/synthetic/project|project:page:tree' };
  Object.assign(state.home, { cursor: { kind: 'work', target }, scroll: 6, showAll: true, split: homeSplit,
    expanded: new Set(['worker']), toggled: new Set(['card']), foldedLanes: new Set(['other']), expandedTasks: new Set(['task:home']),
    filter: { query: 'worker', editing: false }, trySelection: new Map([['discarded-mark', rawArgs]]), newestCard: secret, revealed: secret });
  Object.assign(state.project, { view: { kind: 'progress', onlyTry: { cursor: 'slice:try', scroll: 7, raw: rawArgs } },
    nav: { cursor: 'project:file:synthetic', scroll: 4, split: projectSplit }, folded: new Set(['task:project']),
    savedPages: { docs: { cursor: 'doc', scroll: 1, raw: rawArgs }, retired: rawArgs }, filter: { query: 'project', editing: false } });
  state.control.roles.folded = new Set([]);
  state.control.harnesses.folded = new Set(['pi']);
  state.control.notice = { kind: 'model', model: secret };
  state.subpage = { kind: 'inspector', target, cursor: 'report', scroll: 2, selectedNodeId: 'node' };
  state.help = { scroll: 15, editor: rawArgs };
  state.exp = { detail: 'openai-api', cursor: 'balance', scroll: 3, notice: secret };
  state.prefs = { ...state.prefs, splitRatio: 0.4, acceptance: 'slice', cardHideMinutes: 12 };
  state.overlay = { kind: 'control-chain', role: { instructions: 'SYNTHETIC_ROLE_FACT', editor: { places: [{ raw: rawArgs }] } },
    draft: { run: [{ raw: rawArgs }] }, mode: { kind: 'confirm-leave' } };
  const settings = { selected: 1, offset: 2, draft: rawArgs };
  const raw = encodePanelPlace({ state, settings, widthOverride: null, openedAt: 42, extra: rawArgs });
  assert.doesNotMatch(raw, /overlay|confirm-leave|discarded-mark|trySelection|expandedTasks|onlyTry|SYNTHETIC_|synthetic-secret-flag|revealed|draft|panelSet|notice|retired/);
  assert.doesNotMatch(encodePanelPlace({ state: { ...state, overlay: { kind: 'confirm-stop', dir: secret } }, settings: null }), /confirm-stop|SYNTHETIC_/);
  const place = readPlace(raw);
  assert.equal(JSON.parse(raw).schemaVersion, 2);
  assert.equal(JSON.parse(raw).state, undefined, 'a rollback reader must not see a legacy state slot');
  assert.equal(JSON.parse(raw).settings, undefined, 'a rollback reader must not reopen Settings');
  assert.deepEqual([place.openedAt, place.widthOverride, place.settings], [42, null, { selected: 1, offset: 2 }]);
  const { home, project, prefs, subpage, control, exp } = place.state;
  assert.equal(place.state.activeTab, 'project');
  assert.equal(place.state.selectedProject, state.selectedProject);
  assert.deepEqual(place.state.help, { scroll: 15 });
  assert.equal(home.scroll, 6);
  assert.equal(project.nav.scroll, 4);
  assert.deepEqual(project.filter, state.project.filter);
  assert.deepEqual(home, { scroll: 6 });
  assert.equal(prefs, undefined, 'obsolete display preferences are not restored');
  assert.deepEqual(project.folded, state.project.folded);
  assert.deepEqual(project.savedPages, { docs: { cursor: 'doc', scroll: 1 } });
  assert.deepEqual(control.roles.folded, state.control.roles.folded);
  assert.deepEqual(control.harnesses.folded, state.control.harnesses.folded);
  assert.equal(exp.detail, 'openai-api');
  assert.equal(encodePanelPlace(place), raw);
  const edited = { ...state, home: { ...state.home, filter: { query: secret, editing: true } }, subpage: { kind: 'changes', scroll: 3 } };
  const changed = readPlace(encodePanelPlace({ state: edited, settings: null })).state;
});

test('legacy EXP navigation reopens in Control Resources, and the new location round-trips', () => {
  const exp = { detail: 'openai-api', cursor: 'calibration', scroll: 2 };
  for (const handoff of [
    { state: { mainTab: 'exp', expPage: exp } },
    { schemaVersion: 2, stateV2: { activeTab: 'exp', exp } },
  ]) {
    const place = readPlace(JSON.stringify(handoff));
    assert.equal(place.state.activeTab, 'control');
    assert.equal(place.state.control.subTab, 'resources');
    assert.deepEqual(place.state.exp, { ...exp, revealed: exp.cursor });
    assert.deepEqual(readPlace(encodePanelPlace(place)).state, place.state);
  }
});

test('broken and unknown handoffs fall back safely, retaining a valid opening time', () => {
  assert.equal(readPlace('{invalid JSON'), undefined);
  assert.equal(readPlace('[]'), undefined);
  assert.deepEqual(readPlace(JSON.stringify({ schemaVersion: 99, state: { mainTab: 'project' }, openedAt: 42 })),
    { openedAt: 42, settings: null });
  const { state } = readPlace(JSON.stringify({ schemaVersion: 2, stateV2: { activeTab: 'unknown',
    project: { view: { kind: 'waiting', index: 'bad' }, nav: { scroll: -3 } }, home: { expanded: [2, 'ok', {}] },
    subpage: { kind: 'inspector', target: { kind: 'worker', laneId: 'missing-worker' } } } }));
  assert.equal(state.activeTab, 'home');
  assert.deepEqual(state.project.view, { kind: 'hub' }, 'an index without a request key cannot restore the detail');
  assert.equal(state.project.nav.scroll, 0);
  assert.equal(state.subpage, undefined);
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
  const entered = join(f.root, 'entered'), release = join(f.root, 'release');
  writeFixtureFile(
    entry,
    `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(entered)}, '');
for (let i = 0; i < 600 && !existsSync(${JSON.stringify(release)}); i++) await new Promise(r => setTimeout(r, 5));`
  );
  let dirty = true;
  assert.equal(await reload.poll(() => dirty, 10000), false);
  assert.equal(await reload.poll(() => dirty, 13000), false);
  dirty = false;
  const pending = reload.poll(() => dirty, 14000);
  await until(() => existsSync(entered), 'load check did not start');
  dirty = true;
  writeFixtureFile(release, '');
  assert.equal(await pending, false);
  dirty = false;
  assert.equal(await reload.poll(() => dirty, 15000), true);
});

for (const fallback of [false, true]) test(`${fallback ? 'single-supervisor fallback' : 'execve'} preserves argv/env and revives the saved place over three restarts`, { skip: !fallback && typeof process.execve !== 'function' }, async (t) => {
  const f = fixture(t), runner = join(f.root, 'restart.mjs');
  const state = initialMonitorState();
  state.activeTab = 'project';
  state.home = { ...state.home, cursor: { kind: 'work', target: { kind: 'worker', laneId: 'lane', workerId: 'thin-job:j0000000000000001' } },
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
    assert.doesNotMatch(JSON.stringify(row.wire), /overlay|--synthetic-secret-flag/);
    if (i) {
      assert.equal(row.wire.schemaVersion, 2);
      assert.deepEqual(row.wire.stateV2, JSON.parse(encodePanelPlace({ state: { ...state, help: { scroll: i } }, settings: null })).stateV2);
      assert.deepEqual(row.place.stateV2, row.wire.stateV2);
      assert.deepEqual(row.place.settingsView, { selected: 2, offset: 1 });
    }
  }
});

test('the older-Node supervisor forwards signals and returns the child status', async (t) => {
  const f = fixture(t), runner = join(f.root, 'signal.mjs');
  writeFixtureFile(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
import {initialMonitorState} from ${JSON.stringify(pathToFileURL(resolve('dist/render/monitor.js')).href)};
process.execve=undefined;const reload=new PanelReload();
if(readPanelPlace()){process.on('SIGTERM',()=>process.exit(23));console.log('ready');setInterval(()=>{},1000);}
else await reload.restart({state:initialMonitorState(),settings:null},()=>{});`);
  const run = launch(f, runner);
  await until(() => run.output().includes('ready'), 'replacement did not start');
  run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 23, signal: null });
});

test('the live panel coalesces build bursts, retains jobs settled during its life, and keeps a broken build alive with a notice', { timeout: 60000 }, async (t) => {
  const openedAt = Date.now() - 60000;
  const f = live(t, (state) => ({ state: { ...state, subpage: { kind: 'jobs', ...state.jobs } }, settings: null, openedAt }));
  // A start record precedes PanelReload construction. Wait for a collected Home
  // frame on the new alternate screen before replacing that generation's entry.
  const homeFrame = (generation) => {
    const screens = f.output().split('\x1b[?1049h');
    return screens.length === generation + 1 && screens.at(-1).includes('SYNTHETIC reloa');
  };
  await untilRendered(() => homeFrame(1), t.signal);
  writeFixtureFile(join(f.env.HUD_HOME, 'jobs/j0000000000000000/STATUS.json'), JSON.stringify({ state: 'done', settled_at: new Date().toISOString() }));
  for (let i = 0; i < 2; i++) { f.appendBuild(`\n// build burst ${i}`); await delay(20); }
  const lastChange = Date.now();
  f.appendBuild('\n// build burst 2');
  await untilRendered(() => homeFrame(2), t.signal);
  assert.equal(f.events().filter((e) => e.start).length, 2, 'panel replaced itself');
  assert.equal(f.restarts().length, 1);
  assert.ok(f.restarts()[0].at - lastChange >= QUIET_MS, 'quiet period measured from last change');
  assert.equal(f.restarts()[0].restart.openedAt, openedAt);
  const saved = f.restarts()[0].restart.stateV2;
  assert.equal(saved.activeTab, 'home');
  assert.equal(saved.subpage.kind, 'jobs');
  assert.equal(saved.jobs.cursor, f.state.jobs.cursor);
  f.appendBuild('\ninvalid syntax !');
  await untilRendered(() => f.output().includes('new build failed to load'), t.signal);
  assert.equal(f.restarts().length, 1);
  assert.equal(f.child.exitCode, null);
  writeFixtureFile(f.entry, f.baseline + '\n// good recovery');
  await untilRendered(() => homeFrame(3), t.signal);
  assert.equal(f.events().filter((e) => e.start).length, 3, 'good build recovered');
  assert.equal(f.restarts()[1].restart.openedAt, openedAt);
  const restored = f.restarts()[1].restart.stateV2;
  assert.deepEqual(restored.jobs, saved.jobs);
  assert.deepEqual(restored.subpage, saved.subpage);
  for (const start of f.events().filter((e) => e.start)) {
    assert.deepEqual(start.argv, ['same argv']);
    assert.equal(start.test, 'same env');
  }
  await delay(500);
  assert.equal(f.restarts().length, 2, 'no restart loop on an unchanged generation');
});
