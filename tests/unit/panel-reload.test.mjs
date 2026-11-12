import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PanelReload, readPanelPlace } from '../../dist-test/src/utils/panel-reload.js';
import { initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { targetKey } from '../../dist-test/src/collectors/workboard-types.js';
import { makeSourceId } from '../../dist-test/src/core/identity.js';
import { SETTING_ROWS } from '../../dist-test/src/render/settings-page.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(30); }
  assert.fail(message);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hud-panel-reload-'));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), HUD_HOME: join(root, 'hud'),
    CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_DIR: join(root, 'pi'),
    CODEX_HUD_CWD: join(root, 'project'), HERDR_SOCKET_PATH: join(root, 'absent.sock'), TZ: 'UTC',
    CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', HUD_PANEL_CALLER_PANE: 'w4E:p1' };
  for (const key of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HUD_CWD'])
    mkdirSync(env[key], { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ modelEnabled: false, refreshMs: 100, language: 'en', theme: 'terminal' }));
  const stops = [];
  t.after(async () => { for (const stop of stops) await stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, env, stops };
}
function launch(t, f, script, args = [], extra = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...f.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', (v) => { output += v; });
  child.stderr.on('data', (v) => { stderr += v; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  f.stops.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timer);
    }
  });
  return { child, exited, output: () => output, stderr: () => stderr };
}
const moduleUrl = pathToFileURL(resolve('dist-test/src/utils/panel-reload.js')).href;
const encode = (place) => JSON.stringify(place, (_k, v) => v instanceof Set ? { panelSet: [...v] } : v);

test('reload place retains opening time; legacy handoffs use their consumption time', () => {
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  try {
    const openedAt = Date.now() - 60000;
    process.env.HUD_PANEL_RELOAD_PLACE = encode({ state: initialMonitorState(), settings: null, openedAt });
    assert.equal(readPanelPlace().openedAt, openedAt);
    process.env.HUD_PANEL_RELOAD_PLACE = encode({ state: initialMonitorState(), settings: null });
    const before = Date.now(), legacy = readPanelPlace(), after = Date.now();
    assert.ok(legacy.openedAt >= before && legacy.openedAt <= after);
    assert.equal(process.env.HUD_PANEL_RELOAD_PLACE, undefined);
  } finally {
    if (previous === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = previous;
  }
});

test('a real dist entry change is quiet for 2s, bursts coalesce, and a generation is attempted once', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFileSync(entry, 'export const version = 0;');
  const reload = new PanelReload(entry);
  assert.equal(await reload.poll(() => false, 10000), false);
  writeFileSync(entry, 'export const version = 1;');
  assert.equal(await reload.poll(() => false, 11000), false);
  appendFileSync(entry, '\n// burst 2');
  assert.equal(await reload.poll(() => false, 12500), false);
  assert.equal(await reload.poll(() => false, 14499), false);
  assert.equal(await reload.poll(() => false, 14500), true);
  assert.equal(await reload.poll(() => false, 20000), false);
});

test('syntax errors, missing imports and missing entry keep the old generation; a good build recovers', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFileSync(entry, 'export {};');
  const reload = new PanelReload(entry);
  let now = 10000;
  for (const body of ['export syntax error!', 'import "./missing.js";', null]) {
    if (body === null) rmSync(entry); else writeFileSync(entry, body);
    assert.equal(await reload.poll(() => false, now), false);
    assert.equal(await reload.poll(() => false, now + 2000), false);
    assert.equal(reload.failed, true);
    assert.equal(await reload.poll(() => false, now + 3000), false);
    now += 4000;
  }
  writeFileSync(entry, 'export const recovered = true;');
  assert.equal(await reload.poll(() => false, now), false);
  assert.equal(await reload.poll(() => false, now + 2000), true);
  assert.equal(reload.failed, false);
});

test('dirty Settings block reload, including edits made while the load check is running', async (t) => {
  const f = fixture(t), entry = join(f.root, 'entry.js');
  writeFileSync(entry, 'export {};');
  const reload = new PanelReload(entry);
  writeFileSync(entry, 'await new Promise(r => setTimeout(r, 200));');
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
    projectFolded: new Set(['project']), help: true, tree: { ...initialMonitorState().tree, showAll: true, collapsed: new Set(['native']) } };
  writeFileSync(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
${fallback ? 'process.execve=undefined;' : ''}
const reload=new PanelReload();const place=readPanelPlace();
console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(2),test:process.env.SYNTHETIC,consumed:!process.env.HUD_PANEL_RELOAD_PLACE,place},(_k,v)=>v instanceof Set?{panelSet:[...v]}:v));
const phase=place?.state.helpScroll??0;
if(phase<3) await reload.restart({state:{...(place?.state??JSON.parse(process.env.SYNTHETIC_PLACE,(_k,v)=>v?.panelSet?new Set(v.panelSet):v)),helpScroll:phase+1},settings:{selected:2,offset:1}},()=>{});
else process.exitCode=17;
`);
  const run = launch(t, f, runner, ['arg with spaces', '--root', 'synthetic/root'], { SYNTHETIC: 'preserved', SYNTHETIC_PLACE: encode(state) });
  assert.deepEqual(await run.exited, { code: 17, signal: null }, run.stderr());
  const rows = run.output().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  if (fallback) assert.ok(rows.slice(1).every((r) => r.ppid === rows[0].pid), 'one parent, never nested supervisors');
  else assert.equal(new Set(rows.map((r) => r.pid)).size, 1, 'exec replaces the same process');
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(row.argv, ['arg with spaces', '--root', 'synthetic/root']);
    assert.equal(row.test, 'preserved');
    assert.equal(row.consumed, true);
    if (i) {
      assert.deepEqual(row.place.state, JSON.parse(encode({ ...state, helpScroll: i })));
      assert.deepEqual(row.place.settings, { selected: 2, offset: 1 });
    }
  }
});

test('the older-Node supervisor forwards signals and returns the child status', async (t) => {
  const f = fixture(t), runner = join(f.root, 'signal.mjs');
  writeFileSync(runner, `import {PanelReload,readPanelPlace} from ${JSON.stringify(moduleUrl)};
process.execve=undefined;const reload=new PanelReload();
if(readPanelPlace()){process.on('SIGTERM',()=>process.exit(23));console.log('ready');setInterval(()=>{},1000);}
else await reload.restart({state:{},settings:null},()=>{});`);
  const run = launch(t, f, runner);
  await until(() => run.output().includes('ready'), 'replacement did not start');
  run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 23, signal: null });
});

function live(t, initialPlace, { bound = false, width = false } = {}) {
  const f = fixture(t);
  if (bound) {
    const source = join(f.env.CLAUDE_CONFIG_DIR, 'projects', 'synthetic');
    mkdirSync(join(source, 'synthetic-session', 'subagents'), { recursive: true });
    writeFileSync(join(source, 'synthetic-session.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Synthetic root' } }) + '\n');
    Object.assign(f.env, { CODEX_HUD_PANEL_ROOT: `${makeSourceId('claude', source)}/synthetic-session`,
      CODEX_HUD_PANEL_HARNESS: 'claude', CODEX_HUD_PANEL_SOURCE: source });
  }
  const geometry = join(f.root, 'geometry.json');
  if (width) {
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(geometry, JSON.stringify({ total: 160, width: 56, resizes: [] }));
    writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
const file=${JSON.stringify(geometry)}, args=process.argv.slice(2), g=JSON.parse(fs.readFileSync(file));
if(args[1]==='resize') { const amount=Number(args[args.indexOf('--amount')+1]);
  g.width+=g.total*amount*(args.includes('left')?1:-1);g.resizes.push(args);fs.writeFileSync(file,JSON.stringify(g)); }
const rect=(x,width)=>({x,y:0,width,height:40});
console.log(JSON.stringify({result:args[1]==='layout'?{layout:{
  panes:[{pane_id:'w4E:p1',rect:rect(0,g.total-g.width)},{pane_id:'w4E:p2',rect:rect(g.total-g.width,g.width)}],
  splits:[{direction:'right',ratio:1-g.width/g.total,rect:rect(0,g.total)}]
}}:{pane:{pane_id:args[2]}}}));
`, { mode: 0o700 });
    Object.assign(f.env, { PATH: `${bin}:${f.env.PATH}`, HERDR_PANE_ID: 'w4E:p2', HUD_PANEL_WIDTH: '56' });
  }
  cpSync(resolve('dist-test/src'), join(f.root, 'dist'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(f.root, 'node_modules'), 'dir');
  const log = join(f.root, 'events.jsonl'), runner = join(f.root, 'live.mjs'), entry = join(f.root, 'dist/tree-page.js');
  for (let i = 0; i < 2; i++) {
    const id = `j${String(i).padStart(16, '0')}`, dir = join(f.env.HUD_HOME, 'jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', herdr_pane: 'w4E:p1', cwd: f.env.CODEX_HUD_CWD, created_at: new Date(Date.now() - 10000 - i).toISOString() }));
    writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    writeFileSync(join(dir, 'brief.md'), `# SYNTHETIC reload job ${i}`);
  }
  const lane = readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })[0];
  const target = { kind: 'worker', laneId: lane.id, workerId: lane.workers[0].id };
  const state = { ...initialMonitorState(), homeTarget: target, boardExpanded: new Set([targetKey(target)]),
    boardToggled: new Set([targetKey(target)]), boardFolded: new Set(['synthetic-fold']), tree: { ...initialMonitorState().tree, showAll: true } };
  writeFileSync(runner, `import {appendFileSync} from 'node:fs';
import {PanelReload} from './dist/utils/panel-reload.js';
import {runLivePage} from './dist/tree-page.js';
process.stdout.columns=100;process.stdout.rows=35;
const log=v=>appendFileSync(${JSON.stringify(log)},JSON.stringify(v,(_k,v)=>v instanceof Set?{panelSet:[...v]}:v)+'\\n');
log({start:true,pid:process.pid,argv:process.argv.slice(2),test:process.env.SYNTHETIC});
const original=PanelReload.prototype.restart;
PanelReload.prototype.restart=function(place,finish){log({restart:place});return original.call(this,place,finish);};
await runLivePage();process.exit(process.exitCode??0);`);
  const run = launch(t, f, runner, ['same argv'], { SYNTHETIC: 'same env', HUD_PANEL_RELOAD_PLACE: encode(typeof initialPlace === 'function' ? initialPlace(state) : initialPlace ?? { state, settings: null }), CODEX_HUD_INITIAL_COMMAND: 'help' });
  const events = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { ...f, ...run, entry, events, state, geometry: () => JSON.parse(readFileSync(geometry, 'utf8')),
    baseline: readFileSync(entry, 'utf8'), restarts: () => events().filter((e) => e.restart) };
}

test('the live panel coalesces build bursts, retains jobs settled during its life, and keeps a broken build alive with a notice', async (t) => {
  const openedAt = Date.now() - 60000;
  const f = live(t, (state) => ({ state, settings: null, openedAt }));
  await until(() => f.output().includes('SYNTHETIC reload job'), 'initial collected Home frame did not render');
  writeFileSync(join(f.env.HUD_HOME, 'jobs/j0000000000000000/STATUS.json'), JSON.stringify({ state: 'done', settled_at: new Date().toISOString() }));
  for (let i = 0; i < 3; i++) { appendFileSync(f.entry, `\n// build burst ${i}`); await delay(200); }
  await delay(1400);
  assert.equal(f.restarts().length, 0, 'quiet period measured from last change');
  await until(() => f.events().filter((e) => e.start).length === 2, 'panel did not replace itself');
  await delay(400);
  assert.equal(f.restarts().length, 1);
  assert.equal(f.restarts()[0].restart.openedAt, openedAt);
  const saved = f.restarts()[0].restart.state;
  assert.equal(saved.mainTab, 'home');
  assert.deepEqual(saved.homeTarget, f.state.homeTarget);
  assert.deepEqual(saved.boardExpanded.panelSet, [...f.state.boardExpanded]);
  assert.equal(saved.tree.showAll, true);
  appendFileSync(f.entry, '\ninvalid syntax !');
  await until(() => f.output().includes('new build failed to load'), 'bad build notice not rendered');
  assert.equal(f.restarts().length, 1);
  assert.equal(f.child.exitCode, null);
  writeFileSync(f.entry, f.baseline + '\n// good recovery');
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

for (const bound of [false, true]) for (const view of ['project', 'help', 'inspector']) test(`the live ${bound ? 'Claude-bound' : 'unbound'} panel restores ${view}, selection and show-all across replacements`, async (t) => {
  const f = live(t, (state) => ({ state: { ...state,
    mainTab: view === 'project' ? 'project' : 'home', help: view === 'help',
    focus: view === 'inspector' ? 'details' : 'agents', boardInspect: view === 'inspector' ? state.homeTarget : undefined,
  }, settings: null }), { bound });
  await until(() => f.output().includes('models off') || f.output().includes('Home ›') || f.output().includes('Help'), 'first collected view did not render');
  for (let generation = 1; generation <= 2; generation++) {
    appendFileSync(f.entry, `\n// ${view} build ${generation}`);
    await until(() => f.events().filter((e) => e.start).length === generation + 1, `${view} did not restart`);
    await delay(300);
    const state = f.restarts()[generation - 1].restart.state;
    assert.equal(state.mainTab, view === 'project' ? 'project' : 'home');
    assert.equal(state.help, view === 'help');
    assert.equal(state.focus, view === 'inspector' ? 'details' : 'agents');
    if (view === 'inspector') assert.deepEqual(state.boardInspect, f.state.homeTarget);
    assert.deepEqual(state.homeTarget, f.state.homeTarget);
    assert.equal(state.tree.showAll, true);
    assert.deepEqual(state.boardToggled.panelSet, [...f.state.boardToggled]);
    assert.equal(state.cardHideMinutes, 15, 'missing handoff fields get configured defaults');
  }
});

test('saving Width 64 from opening width 56 keeps 64 across real panel replacements', async (t) => {
  const f = live(t, (state) => ({ state, settings: { selected: SETTING_ROWS.findIndex((r) => r.key === 'treeWidth'), offset: 0 } }), { width: true });
  await until(() => f.output().includes('Settings'), 'Settings did not open');
  f.child.stdin.write('\x1b[Cs');
  await until(() => Math.abs(f.geometry().width - 64) < 0.01, 'saved width was not applied: ' + f.stderr());
  assert.equal(JSON.parse(readFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), 'utf8')).treeWidth, 64);
  for (let generation = 1; generation <= 2; generation++) {
    appendFileSync(f.entry, `\n// saved width build ${generation}`);
    await until(() => f.events().filter((e) => e.start).length === generation + 1, 'panel did not replace itself');
    await delay(700);
    assert.ok(Math.abs(f.geometry().width - 64) < 0.01, JSON.stringify(f.geometry()));
    assert.equal(f.geometry().resizes.length, 1, 'no reload-time shrink to opening width');
  }
});

for (const action of ['save', 'discard']) test(`the live panel waits for Settings ${action} before restarting`, async (t) => {
  const f = live(t, { state: { ...initialMonitorState(), mainTab: 'project' }, settings: { selected: 0, offset: 0 } });
  await until(() => f.output().includes('Settings'), 'Settings overlay did not resume');
  f.child.stdin.write('\x1b[C');
  await until(() => f.output().includes('unsaved'), 'Settings edit was not dirty');
  appendFileSync(f.entry, '\n// settings build');
  await delay(2700);
  assert.equal(f.restarts().length, 0);
  if (action === 'save') f.child.stdin.write('s');
  else { f.child.stdin.write('\x1b'); await delay(150); f.child.stdin.write('\x1b[D\r'); }
  await until(() => f.events().filter((e) => e.start).length === 2, `no reload after ${action}`);
  assert.equal(f.restarts().length, 1);
  const place = f.restarts()[0].restart;
  assert.equal(place.state.mainTab, 'project');
  assert.equal('draft' in (place.settings ?? {}), false, 'drafts are not transported');
  assert.equal(Boolean(place.settings), action === 'save', 'saved Settings stays open; discarded overlay closes');
  const settings = JSON.parse(readFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), 'utf8'));
  assert.equal(settings.theme, action === 'save' ? 'titanium' : 'terminal');
});
