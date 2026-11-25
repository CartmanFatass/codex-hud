import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { procStat } from '../../dist/utils/proc.js';

const cli = resolve('packages/hud-mcp/bin/hud-reap.mjs');
const herdr = String.raw`
const fs = require('node:fs');
const path = process.env.STATE;
const s = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2), [kind, op, target] = args;
fs.appendFileSync(path + '.log', JSON.stringify(args) + '\n');
const out = result => console.log(JSON.stringify({ result }));
if (op === 'list') {
  if (s.quitPolls && kind === 'agent' && !--s.quitPolls) s.agents = [];
  out({[kind+'s']: s[kind+'s']});
} else if (kind === 'agent' && op === 'get') out({agent: s.replacement ?? s.agents.find(a => a.pane_id === target)});
else if (kind === 'agent' && op === 'prompt' && args[3] === '/quit') {
  s.quitPolls = 2; s.panes[0].agent = null; // Detached pane: agent still listed.
  out({});
} else if (kind === 'tab' && op === 'close') { s.tabs = s.tabs.filter(t => t.tab_id !== target); out({}); }
else throw Error('unexpected fake herdr command: ' + args);
fs.writeFileSync(path, JSON.stringify(s));`;

function fixture(t, { status = 'idle', orch = 'main-pane', label = 'synthetic', name = 'worker', replacement } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-')), dir = join(root, 'job');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(dir);
  fs.writeFileSync(join(root, 'herdr'), `#!${process.execPath}\n${herdr}`, { mode: 0o700 });
  const state = join(root, 'state'), log = `${state}.log`;
  const agent = { pane_id: 'worker-pane', tab_id: 'worker-tab', name, agent_status: status };
  fs.writeFileSync(state, JSON.stringify({
    tabs: [{ tab_id: 'worker-tab', label }], panes: [{ pane_id: 'worker-pane', tab_id: 'worker-tab', agent: status && 'pi' },
      { pane_id: 'main-pane', tab_id: 'main-tab', agent: 'pi' }], agents: status ? [agent] : [], replacement: replacement && { ...agent, ...replacement },
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `TAB=worker-tab\nTAB_NAME=synthetic\nLEFT=worker-pane\nORCH=${orch}\nPRIMARY=worker\n`);
  const env = { ...process.env, HOME: root, HUD_HOME: root, STATE: state, PATH: root, PI_ROLES_LEDGER: join(root, 'ledger') };
  const put = (fields) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ version: 1, task_dir: dir, slot: 'primary', state: 'idle_grace', ...fields }));
  put({});
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l)) : [];
  return { dir, env, put, calls, root, run: (...args) => spawnSync(process.execPath, [cli, dir, ...args], { env, encoding: 'utf8', timeout: 15000 }) };
}
function worker(t, f) {
  // Even with the exact task dir in argv, only the start stamp can authorize SIGTERM.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', f.dir], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return child;
}

test('idle/done: one /quit, wait for inventory (not just pane detachment), verify tab closed; no ledger or stop marker', t => {
  for (const status of ['idle', 'done']) {
    const f = fixture(t, { status });
    f.put({ session_id: 'synthetic-run' });
    const r = f.run(); assert.equal(r.status, 0, r.stderr);
    const log = f.calls();
    assert.deepEqual(log.filter(a => ['prompt','close'].includes(a[1])), [['agent','prompt','worker-pane','/quit'], ['tab','close','worker-tab']]);
    assert.ok(log.filter(a => a.join(' ') === 'agent list').length >= 4);
    assert.deepEqual(log.at(-1), ['tab','list']);
    assert.equal(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')), false);
    assert.equal(fs.existsSync(f.env.PI_ROLES_LEDGER), false);
  }
});

test('renamed tab, foreign occupant, changed occupant and orchestrator pane are never quit or closed', async t => {
  for (const [options, reason] of [
    [{ status: null, label: 'renamed' }, /: TAB worker-tab name changed or missing; not closing\n$/],
    [{ name: 'foreign' }, /still has an agent; not closing/],
    [{ replacement: { name: 'foreign' } }, /agent changed/],
    [{ orch: 'worker-pane' }, /orchestrator tab; not closing/],
  ]) {
    const f = fixture(t, options);
    let child;
    if (options.orch) {
      child = worker(t, f); f.put({ state: 'working', pid: child.pid, pid_start_time: procStat(child.pid).start });
    }
    const r = f.run(); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, reason);
    if (options.label) assert.equal(r.stderr.trim().split('\n').length, 1, 'watcher matches this single line');
    if (child) assert.ok(procStat(child.pid) && !child.killed);
    assert.deepEqual(f.calls().filter(a => a[1] === 'prompt' || a[1] === 'close'), []);
  }
});

test('working CLI: publish stop before exact-PID SIGTERM; skip /quit and idle polling; occupied tab stays', async t => {
  const f = fixture(t, { status: 'working' });
  const marker = join(f.dir, 'STATUS.json.stop-requested');
  const child = spawn(process.execPath, ['-e', `process.title = 'synthetic'; process.on('SIGTERM', () => process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 1)); console.log('ready'); setInterval(()=>{}, 60000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const end = once(child, 'exit');
  f.put({ state: 'working', harness: 'cli', agent: 'codex', pid: child.pid, pid_start_time: procStat(child.pid).start });
  const r = f.run(); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /owned agent remains/);
  assert.deepEqual(await end, [0, null]);
  assert.deepEqual(f.calls().filter(a => a[1] === 'prompt' || a[1] === 'close'), []);
  assert.equal(f.calls().filter(a => a.join(' ') === 'agent list').length, 3, 'no grace polls');
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
});

test('reused PID is not signalled; live unstamped PID is incomplete and cannot close even an empty tab', t => {
  for (const stamped of [true, false]) {
    const f = fixture(t, { status: null }), child = worker(t, f), start = procStat(child.pid).start;
    f.put({ state: 'working', pid: child.pid, ...(stamped && { pid_start_time: String(BigInt(start) + 1n) }) });
    const r = f.run(); assert.equal(r.status, stamped ? 0 : 1, r.stderr);
    assert.equal(procStat(child.pid)?.start, start); assert.ok(!/^[XZ]$/.test(procStat(child.pid).state));
    if (!stamped) { assert.match(r.stderr, /missing start time/); assert.deepEqual(f.calls(), []); }
    assert.ok(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')));
  }
});

test('browser worker records its own exact PID and start before invoking its CLI', t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir, 'job.json'), JSON.stringify({ job: 'synthetic', role: 'pro', bro: { tool: 'jev-aistudio' } }));
  fs.writeFileSync(join(f.root, 'jev-aistudio'), `#!${process.execPath}\nconst fs = require('node:fs');
const stat = fs.readFileSync('/proc/' + process.ppid + '/stat', 'utf8');
fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1], JSON.stringify([process.ppid, stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19]]));`);
  fs.chmodSync(join(f.root, 'jev-aistudio'), 0o700);
  const r = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-jev.mjs'), f.dir], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(fs.readFileSync(join(f.dir, 'STATUS.json')));
  assert.deepEqual([status.pid, status.pid_start_time], JSON.parse(fs.readFileSync(join(f.dir, 'report.md'))));
});

test('--after-pid: invalid or live caller takes no action; caller exit resumes the ordinary tab checks', async t => {
  const f = fixture(t, { status: null, label: 'renamed' }), child = worker(t, f);
  const start = procStat(child.pid).start;
  f.put({ state: 'working', pid: child.pid, pid_start_time: start });
  for (const value of ['0', '1', '1.2', 'NaN', '-2']) assert.match(f.run('--after-pid', value).stderr, /invalid --after-pid PID/);
  const clock = `import { performance } from 'node:perf_hooks'; let n=0; Object.defineProperty(performance, 'now', { value: () => n+=30001 });`;
  // Accelerate the reaper deadline, not the wrapper's independent build lock.
  const main = new URL('../../dist/runtime/reap-tab.js', import.meta.url).href;
  const timed = spawnSync(process.execPath, ['--input-type=module', '-e', `${clock} const { main } = await import(${JSON.stringify(main)}); await main(process.argv.slice(1));`, f.dir, '--after-pid', String(child.pid)], { env: f.env, encoding: 'utf8' });
  assert.equal(timed.status, 1); assert.match(timed.stderr, /still alive after 30s; nothing reaped/);
  assert.deepEqual(f.calls(), []); assert.equal(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')), false);
  const reaper = spawn(process.execPath, [cli, f.dir, '--after-pid', String(child.pid)], { env: f.env, stdio: ['ignore','ignore','pipe'] });
  let err = ''; reaper.stderr.on('data', d => { err += d; });
  const finish = once(reaper, 'close');
  child.kill('SIGTERM');
  assert.deepEqual(await finish, [1, null]); assert.match(err, /name changed or missing; not closing/);
  assert.ok(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')));
});
