import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { encodePanelPlace } from '../../dist/utils/panel-reload.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { makeSourceId } from '../../dist/core/identity.js';
import { writeFixtureFile } from './thin-mcp-files.mjs';
import { cleanupFixture, stopChild } from './process-cleanup.mjs';

const atomicWriter = new URL('./thin-mcp-files.mjs', import.meta.url).href;
export const QUIET_MS = 150;
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}
export function fixture(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hud-panel-reload-'));
  const stops = [];
  const hudHome = join(root, 'hud');
  cleanupFixture(t, { root, hudHome }, () => Promise.all(stops.map((stop) => stop())));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), HUD_HOME: hudHome, TMPDIR: root,
    CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PI_CODING_AGENT_DIR: join(root, 'pi'),
    CODEX_HUD_CWD: join(root, 'project'), HERDR_SOCKET_PATH: join(root, 'absent.sock'), TZ: 'UTC',
    CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', HUD_PANEL_CALLER_PANE: 'w4E:p1' };
  for (const key of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HUD_CWD'])
    mkdirSync(env[key], { recursive: true });
  writeFixtureFile(join(root, 'package.json'), '{"type":"module"}');
  const settingsBody = JSON.stringify({ modelEnabled: false, refreshMs: 100, language: 'en', theme: 'terminal', ...settings });
  writeFixtureFile(join(env.HUD_HOME, 'hud-settings.json'), settingsBody);
  return { root, env, stops, settingsBody };
}
export function launch(f, script, args = [], extra = {}) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...f.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', (v) => { output += v; });
  child.stderr.on('data', (v) => { stderr += v; });
  const exit = once(child, 'exit');
  f.stops.push(() => stopChild(child, exit, { killMs: 2000 }));
  return { child, exited: exit.then(([code, signal]) => ({ code, signal })), output: () => output, stderr: () => stderr };
}
export const encode = (place) => JSON.stringify(place, (_k, v) => v instanceof Set ? { panelSet: [...v] } : v);

function stagePanel(from, to, localFile, nested) {
  mkdirSync(to);
  for (const name of readdirSync(from)) {
    const source = join(from, name), target = join(to, name);
    if (name === localFile) copyFileSync(source, target);
    else if (nested && name === 'utils') stagePanel(source, target, 'panel-reload.js');
    else symlinkSync(source, target);
  }
}

export function live(t, initialPlace, { bound = false, width = false, columns = 100, settings } = {}) {
  const f = fixture(t, settings);
  f.env.HUD_PANEL_RELOAD_QUIET_MS = String(QUIET_MS);
  f.env.HUD_PANEL_ADAPTIVE_MAX_MS = '100';
  if (bound) {
    const source = join(f.env.CLAUDE_CONFIG_DIR, 'projects', 'synthetic');
    mkdirSync(join(source, 'synthetic-session', 'subagents'), { recursive: true });
    writeFixtureFile(join(source, 'synthetic-session.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Synthetic root' } }) + '\n');
    Object.assign(f.env, { CODEX_HUD_PANEL_ROOT: `${makeSourceId('claude', source)}/synthetic-session`,
      CODEX_HUD_PANEL_HARNESS: 'claude', CODEX_HUD_PANEL_SOURCE: source });
  }
  const geometry = join(f.root, 'geometry.json');
  if (width) {
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFixtureFile(geometry, JSON.stringify({ total: 160, width: 56, resizes: [] }));
    writeFixtureFile(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
import {writeFixtureFile} from ${JSON.stringify(atomicWriter)};
const file=${JSON.stringify(geometry)}, args=process.argv.slice(2), g=JSON.parse(fs.readFileSync(file));
if(args[1]==='resize') { const amount=Number(args[args.indexOf('--amount')+1]);
  g.width+=g.total*amount*(args.includes('left')?1:-1);g.resizes.push(args);writeFixtureFile(file,JSON.stringify(g)); }
const rect=(x,width)=>({x,y:0,width,height:40});
console.log(JSON.stringify({result:args[1]==='layout'?{layout:{
  panes:[{pane_id:'w4E:p1',rect:rect(0,g.total-g.width)},{pane_id:'w4E:p2',rect:rect(g.total-g.width,g.width)}],
  splits:[{direction:'right',ratio:1-g.width/g.total,rect:rect(0,g.total)}]
}}:{pane:{pane_id:args[2]}}}));
`, { mode: 0o700 });
    Object.assign(f.env, { PATH: `${bin}:${f.env.PATH}`, HERDR_PANE_ID: 'w4E:p2', HUD_PANEL_WIDTH: '56' });
  }
  // Keep the entry and its reload probe local: the probe finds the entry relative to import.meta.url.
  stagePanel(resolve('dist'), join(f.root, 'dist'), 'tree-page.js', true);
  for (const file of ['bin/hud', 'bin/hud-dist.mjs', 'scripts/dist-lock.mjs']) {
    mkdirSync(join(f.root, file.split('/')[0]), { recursive: true });
    copyFileSync(resolve(file), join(f.root, file));
  }
  symlinkSync(resolve('node_modules'), join(f.root, 'node_modules'), 'dir');
  const log = join(f.root, 'events.jsonl'), pollsFile = join(f.root, 'polls.jsonl'), runner = join(f.root, 'live.mjs'), entry = join(f.root, 'dist/tree-page.js');
  for (let i = 0; i < 2; i++) {
    const id = `j${String(i).padStart(16, '0')}`, dir = join(f.env.HUD_HOME, 'jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', herdr_pane: 'w4E:p1', cwd: f.env.CODEX_HUD_CWD, created_at: new Date(Date.now() - 10000 - i).toISOString() }));
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    writeFixtureFile(join(dir, 'brief.md'), `# SYNTHETIC reload job ${i}`);
  }
  const lane = readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })[0];
  const target = { kind: 'worker', laneId: lane.id, workerId: lane.workers[0].id };
  const initial = initialMonitorState();
  const state = { ...initial, jobs: { cursor: targetKey(target), scroll: 0 } };
  writeFixtureFile(log, '');
  writeFixtureFile(runner, `import {appendFileSync,readFileSync} from 'node:fs';
import {writeFixtureFile} from ${JSON.stringify(atomicWriter)};
import {PanelReload,encodePanelPlace} from './dist/utils/panel-reload.js';
import {runLivePage} from './dist/tree-page.js';
process.stdout.columns=${columns};process.stdout.rows=35;
const file=${JSON.stringify(log)}, pollsFile=${JSON.stringify(pollsFile)};
const log=v=>writeFixtureFile(file,readFileSync(file,'utf8') + JSON.stringify(v)+'\\n');
log({start:true,at:Date.now(),pid:process.pid,argv:process.argv.slice(2),test:process.env.SYNTHETIC});
const originalPoll=PanelReload.prototype.poll;
PanelReload.prototype.poll=async function(...args){const res=await originalPoll.apply(this,args);appendFileSync(pollsFile,Date.now()+'\\n');return res;};
const original=PanelReload.prototype.restart;
PanelReload.prototype.restart=function(place,finish){log({restart:JSON.parse(encodePanelPlace(place)),at:Date.now()});return original.call(this,place,finish);};
await runLivePage();process.exit(process.exitCode??0);`);
  const place = typeof initialPlace === 'function' ? initialPlace(state, target) : initialPlace ?? { state, settings: null };
  const run = launch(f, runner, ['same argv'], { SYNTHETIC: 'same env',
    HUD_PANEL_RELOAD_PLACE: typeof place === 'string' ? place : encodePanelPlace(place), CODEX_HUD_INITIAL_COMMAND: 'help' });
  const events = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const polls = () => existsSync(pollsFile) ? readFileSync(pollsFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
  return { ...f, ...run, entry, events, polls, state, target, geometry: () => JSON.parse(readFileSync(geometry, 'utf8')),
    baseline: readFileSync(entry, 'utf8'), restarts: () => events().filter((e) => e.restart),
    appendBuild: (suffix) => writeFixtureFile(entry, readFileSync(entry, 'utf8') + suffix) };
}
