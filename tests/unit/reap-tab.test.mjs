import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { recordTabShells } from '../../dist/runtime/tab-shell.js';
import { prepareCliInvocation } from '../../dist/runtime/cli-invocation.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { reapWorkerTree, tabTreeGrant } from '../../dist/roles/worker-tree.js';
import { randomUUID } from 'node:crypto';
import { isActiveProcState, listProcPids, procStat } from '../../dist/utils/proc.js';
import { until } from '../helpers/until.mjs';

const noZsh = spawnSync('zsh', ['--version']).error?.code === 'ENOENT';

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
} else if (op === 'process-info') {
  const status = JSON.parse(fs.readFileSync(process.env.DIR + '/STATUS.json')), root = status.pid;
  const pane = args[3], shellPid = s.shells?.[pane] ?? s.shell;
  const isWorkerPane = !s.shells || pane === (s.workerPane ?? 'worker-pane');
  const fg = isWorkerPane ? (s.foreground ?? (root ?? (s.agents.length ? s.occupant : 0))) : 0;
  const live = fg && fs.existsSync('/proc/' + fg + '/stat') && !/\) [ZX] /.test(fs.readFileSync('/proc/' + fg + '/stat','utf8'));
  out({process_info:{pane_id:pane, shell_pid:shellPid, foreground_process_group_id:live ? fg : shellPid, foreground_processes:live ? [{pid:fg, name:status.agent || 'pi'}] : [{pid:shellPid,name:'shell'}]}});
} else if (kind === 'agent' && op === 'get') out({agent: s.replacement ?? s.agents.find(a => a.pane_id === target)});
else if (kind === 'agent' && op === 'prompt' && args[3] === '/quit') {
  process.kill(s.occupant, 'SIGTERM');
  s.quitPolls = 2; s.panes[0].agent = null; // Detached pane: agent still listed.
  out({});
} else if (kind === 'tab' && op === 'close') { s.tabs = s.tabs.filter(t => t.tab_id !== target); out({}); }
else throw Error('unexpected fake herdr command: ' + args);
fs.writeFileSync(path, JSON.stringify(s));`;

function fixture(t, { status = 'idle', orch = 'main-pane', label = 'synthetic', name = 'worker', replacement, foreignShell = false } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-')), dir = join(root, 'job');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(dir);
  fs.writeFileSync(join(root, 'herdr'), `#!${process.execPath}\n${herdr}`, { mode: 0o700 });
  const state = join(root, 'state'), log = `${state}.log`;
  const launch = randomUUID();
  const tags = { HUD_JOB_DIR: dir, HERDR_PANE_ID: 'worker-pane', HERDR_TAB_ID: 'worker-tab', HUD_TAB_LAUNCH: launch };
  const sleeper = (env) => {
    const p = spawn('/bin/sleep', ['600'], { env, stdio: 'ignore' }); t.after(() => p.kill('SIGKILL')); return p.pid;
  };
  const sh = spawn('/bin/sh', ['-c', 'read line; exec /bin/sleep 600'], { detached: true, stdio: ['pipe','ignore','ignore'], env: { ...tags, ...(foreignShell && { HUD_TAB_LAUNCH: 'replacement' }) } });
  t.after(() => sh.kill('SIGKILL'));
  const shell = sh.pid, exe = `/proc/${shell}/exe`, image = fs.statSync(exe, { bigint: true });
  fs.writeFileSync(join(dir, 'tab-shells.json'), JSON.stringify({ launch, tab: 'worker-tab', shells: [
    { pane: 'worker-pane', pid: shell, start: procStat(shell).start, exe: fs.readlinkSync(exe), inode: `${image.dev}:${image.ino}` },
  ] }));
  const occupant = sleeper(tags);
  const native = join(dir, 'pi.jsonl');
  const agent = { agent_session: { value: native }, pane_id: 'worker-pane', tab_id: 'worker-tab', name, agent_status: status };
  fs.writeFileSync(state, JSON.stringify({ shell, occupant,
    tabs: [{ tab_id: 'worker-tab', label }], panes: [{ pane_id: 'worker-pane', tab_id: 'worker-tab', agent: status && 'pi' },
      { pane_id: 'main-pane', tab_id: 'main-tab', agent: 'pi' }], agents: status ? [agent] : [], replacement: replacement && { ...agent, ...replacement },
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `LAUNCH=${launch}\nTAB=worker-tab\nTAB_NAME=synthetic\nLEFT=worker-pane\nORCH=${orch}\nPRIMARY=worker\n`);
  const env = { ...process.env, HOME: root, HUD_HOME: root, DIR: dir, STATE: state, PATH: root, PI_ROLES_LEDGER: join(root, 'ledger') };
  const put = (fields) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ version: 1, task_dir: dir, slot: 'primary', session_file: native, state: 'idle_grace', ...fields }));
  put({});
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l)) : [];
  return { dir, env, tags, put, calls, root, state, occupant, sh, launch, run: (...args) => spawnSync(process.execPath, [cli, dir, ...args], { env, encoding: 'utf8', timeout: 15000 }) };
}
function worker(t, f) {
  // Even with the exact task dir in argv, only the start stamp can authorize SIGTERM.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', f.dir], { env: f.tags, stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return child;
}

test('idle/done: one /quit, wait for inventory (not just pane detachment), verify tab closed; no ledger or stop marker', t => {
  for (const status of ['idle', 'done']) {
    const f = fixture(t, { status });
    f.put({ session_id: 'synthetic-run', pid: f.occupant, pid_start_time: procStat(f.occupant).start });
    const r = f.run(); assert.equal(r.status, 0, r.stderr);
    const log = f.calls();
    assert.deepEqual(log.filter(a => ['prompt','close'].includes(a[1])), [['agent','prompt','worker-pane','/quit'], ['tab','close','worker-tab']]);
    assert.ok(log.filter(a => a.join(' ') === 'agent list').length >= 4);
    assert.deepEqual(log.at(-1), ['tab','list']);
    assert.equal(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')), false);
    assert.equal(fs.existsSync(f.env.PI_ROLES_LEDGER), false);
  }
});

test('missing or exited stamped Pi cannot quit a replacement on the identical transcript', async t => {
  for (const dead of [false, true]) {
    const f = fixture(t);
    if (dead) {
      const original = worker(t, f), start = procStat(original.pid).start, end = once(original, 'exit'); original.kill(); await end;
      f.put({ pid: original.pid, pid_start_time: start });
    }
    const state = JSON.parse(fs.readFileSync(f.state)); state.foreground = f.occupant; fs.writeFileSync(f.state, JSON.stringify(state));
    const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /idle agent launch identity unverified/);
    assert.ok(!f.calls().some(a => ['prompt','close'].includes(a[1])));
    assert.ok(!/^[XZ]$/.test(procStat(f.occupant).state));
  }
});

test('launch-time shell capture permits the same otherwise-empty foreground shell, not a missing receipt', async t => {
  const f = fixture(t, { status: null }); fs.unlinkSync(join(f.dir, 'tab-shells.json'));
  assert.equal(f.run().status, 1); assert.ok(!f.calls().some(a => a[1] === 'close'));
  const socket = join(f.root, 'herdr.sock'), server = createServer(conn => conn.once('data', bytes => {
    const msg = JSON.parse(bytes.toString());
    assert.equal(msg.method, 'pane.process_info');
    conn.end(JSON.stringify({ id: msg.id, result: { process_info: { pane_id: 'worker-pane', shell_pid: f.sh.pid } } }) + '\n');
  }));
  server.listen(socket); await once(server, 'listening');
  const prior = process.env.HERDR_SOCKET_PATH; process.env.HERDR_SOCKET_PATH = socket;
  try { await recordTabShells(f.dir, f.launch, 'worker-tab', ['worker-pane']); }
  finally { if (prior === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = prior; await new Promise(done => server.close(done)); }
  const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.ok(f.calls().some(a => a[1] === 'close'));
});

test('exec in the original shell keeps the tab even with identical PID, start, session and foreground group', async t => {
  const f = fixture(t, { status: null }), pid = f.sh.pid, start = procStat(pid).start;
  f.sh.stdin.end('replace\n');
  const { until } = await import('../helpers/until.mjs');
  await until(() => fs.readlinkSync(`/proc/${pid}/exe`).endsWith('/sleep'), 2000);
  assert.equal(procStat(pid).start, start);
  const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /original shell identity/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));
});

test('renamed tab, foreign occupant, changed occupant and orchestrator pane are never quit or closed', async t => {
  for (const [options, reason] of [
    [{ status: null, label: 'renamed' }, /: TAB worker-tab name changed or missing; not closing\n$/],
    [{ name: 'foreign' }, /foreign agent/], // Even though it reopened the recorded session.
    [{ status: null, foreignShell: true }, /pane launch ownership unverified/],
    [{ replacement: { agent_session: { value: '/other' } } }, /agent changed/],
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
  const child = spawn(process.execPath, ['-e', `process.title = 'synthetic'; process.on('SIGTERM', () => process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 1)); console.log('ready'); setInterval(()=>{}, 60000)`], { env: f.tags, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const end = once(child, 'exit');
  const state = JSON.parse(fs.readFileSync(f.state)); state.panes[0].agent = 'codex'; fs.writeFileSync(f.state, JSON.stringify(state));
  const proof = join(f.dir, 'cli-invocations', f.launch); fs.mkdirSync(proof, { recursive: true });
  fs.writeFileSync(join(proof, 'witness.json'), JSON.stringify({ pid: child.pid, start: procStat(child.pid).start }));
  f.put({ state: 'working', harness: 'cli', agent: 'codex', pid: child.pid, pid_start_time: procStat(child.pid).start });
  const r = f.run(); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /owned agent remains/);
  assert.deepEqual(await end, [0, null]);
  assert.deepEqual(f.calls().filter(a => a[1] === 'prompt' || a[1] === 'close'), []);
  assert.equal(f.calls().filter(a => a.join(' ') === 'agent list').length, 2, 'no grace polls');
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
});

test('reused PID is not signalled; live unstamped PID is incomplete and cannot close even an empty tab', t => {
  for (const stamped of [true, false]) {
    const f = fixture(t, { status: null }), child = worker(t, f), start = procStat(child.pid).start;
    f.put({ state: 'working', pid: child.pid, ...(stamped && { pid_start_time: String(BigInt(start) + 1n) }) });
    const r = f.run(); assert.equal(r.status, 1, r.stderr); // A live foreground occupant is not an empty shell.
    assert.equal(procStat(child.pid)?.start, start); assert.ok(!/^[XZ]$/.test(procStat(child.pid).state));
    if (!stamped) { assert.match(r.stderr, /missing start time/); assert.deepEqual(f.calls(), []); }
    assert.ok(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')));
  }
});

test('recycled split or tab without its recorded pane is never closed; reaped job is a no-op', t => {
  const f = fixture(t, { status: null, foreignShell: true });
  fs.writeFileSync(join(f.dir, 'SESSION.txt'), 'RIGHT_SPLIT=1\nRIGHT=worker-pane\nLAUNCH=original-launch\nORCH=main-pane\n');
  let r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /launch ownership unverified/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));
  const g = fixture(t, { status: null });
  const data = JSON.parse(fs.readFileSync(g.state)); data.panes.shift(); fs.writeFileSync(g.state, JSON.stringify(data));
  r = g.run(); assert.equal(r.status, 1); assert.match(r.stderr, /pane set changed/);
  assert.ok(!g.calls().some(a => a[1] === 'close'));
  const h = fixture(t); h.put({ state: 'working' });
  fs.writeFileSync(join(h.dir, 'job.json'), JSON.stringify({ reaped_at: new Date().toISOString() }));
  assert.equal(h.run().status, 0); assert.deepEqual(h.calls(), []);
  assert.equal(fs.existsSync(join(h.dir, 'STATUS.json.stop-requested')), false);
});

for (const foreign of [true, false]) test(foreign ? 'refused replacement and its tree survive even a retry after root exit' :
  'verified worker waiting for its child: incomplete TERM explicitly authorizes captured child cleanup', async t => {
  const f = fixture(t, { status: 'working', name: foreign ? 'replacement' : 'worker' });
  const root = spawn(process.execPath, ['-e', `const c=require('node:child_process').spawn('/bin/sleep',['600'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{}); c.once('exit',()=>process.exit(0)); console.log(c.pid);`],
    { env: foreign ? { ...f.tags, HUD_JOB_DIR: f.root } : f.tags, stdio: ['ignore','pipe','ignore'] });
  const end = once(root, 'exit');
  t.after(() => root.kill('SIGKILL'));
  const member = Number((await once(root.stdout, 'data'))[0]), start = procStat(member).start;
  t.after(() => { if (procStat(member)?.start === start) process.kill(member, 'SIGKILL'); });
  f.put({ state: 'working', pid: root.pid, pid_start_time: procStat(root.pid).start });
  const runTree = () => reapWorkerTree(f.dir, JSON.parse(fs.readFileSync(join(f.dir, 'STATUS.json'))), () => {
    const r = f.run(); return { ok: r.status === 0, reason: r.status ? 'failed' : 'ok', stdout: r.stdout };
  }, r => r.ok, { treeGrant: tabTreeGrant });
  const attempt = await runTree();
  assert.equal(attempt.complete, false);
  if (foreign) {
    assert.equal(root.exitCode, null); assert.equal(root.signalCode, null);
    assert.equal(procStat(member).start, start); assert.match(attempt.issue, /not authorized/);
    root.kill('SIGKILL'); await end;
    const state = JSON.parse(fs.readFileSync(f.state)); state.tabs = []; state.panes = []; state.agents = [];
    fs.writeFileSync(f.state, JSON.stringify(state));
    assert.match((await runTree()).issue, /not authorized/); assert.ok(!/^[ZX]$/.test(procStat(member).state));
  } else {
    assert.match(attempt.result.stdout, /^tree-owner /m); assert.equal(attempt.issue, undefined);
    assert.deepEqual(await end, [0, null]); assert.equal(procStat(member), null);
  }
});

test('symlinked task_dir in a live browser receipt is verified and stopped; incompatible receipt is incomplete', async t => {
  const f = fixture(t, { status: null });
  const alias = join(f.root, 'job-link'); fs.symlinkSync(f.dir, alias);
  const child = worker(t, f), end = once(child, 'exit');
  f.put({ harness: 'bro', state: 'working', task_dir: alias, pid: child.pid, pid_start_time: procStat(child.pid).start });
  const r = f.run(); assert.equal(r.status, 0, r.stderr); assert.deepEqual(await end, [null, 'SIGTERM']);
  assert.ok(fs.existsSync(join(f.dir, 'STATUS.json.stop-requested')));
  assert.ok(f.calls().some(a => a[1] === 'close'));
  const g = fixture(t, { status: null }); g.put({ task_dir: g.root });
  const bad = g.run(); assert.equal(bad.status, 1); assert.match(bad.stderr, /incompatible primary STATUS/); assert.deepEqual(g.calls(), []);
});

test('browser worker records its own exact PID and start before invoking its CLI', t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir, 'job.json'), JSON.stringify({ job: 'synthetic', role: 'pro', bro: { tool: 'jev-aistudio' } }));
  fs.writeFileSync(join(f.root, 'jev-aistudio'), `#!${process.execPath}\nconst fs = require('node:fs');
const stat = fs.readFileSync('/proc/' + process.ppid + '/stat', 'utf8');
fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1], JSON.stringify([process.ppid, stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19]]));`);
  fs.chmodSync(join(f.root, 'jev-aistudio'), 0o700);
  const alias = join(f.root, 'job-link'); fs.symlinkSync(f.dir, alias);
  const r = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-jev.mjs'), alias], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(fs.readFileSync(join(f.dir, 'STATUS.json')));
  assert.equal(status.task_dir, f.dir);
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

async function zshTabFixture(t, { harness, leaveBackground = false, precmdSleep = '0.35', stampCliStatus = true, liveIdlePi = false, omitSnapshot = false, splitPreWorkerBackground = false }) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reap-zsh-'));
  const dir = join(root, 'job'), ownerHome = join(root, 'home'), fakeBin = join(root, 'fake-bin'), herdrBin = join(root, 'herdr-bin');
  for (const d of [dir, ownerHome, fakeBin, herdrBin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(join(herdrBin, 'herdr'), `#!${process.execPath}\n${herdr}`, { mode: 0o700 });
  const launch = randomUUID();
  const tags = { HUD_JOB_DIR: dir, HERDR_PANE_ID: 'worker-pane', HERDR_TAB_ID: 'worker-tab', HUD_TAB_LAUNCH: launch };
  const hudExt = new URL('../../integrations/pi/package/extensions/hud.mjs', import.meta.url).href;

  // Owner zsh rc modeled on powerlevel10k: a reparented startup daemon plus a per-prompt precmd helper.
  fs.writeFileSync(join(ownerHome, '.zshrc'), `
export PATH=${JSON.stringify(fakeBin)}:"$PATH"
( /bin/sleep 600 </dev/null >/dev/null 2>&1 & echo $! > "$HOME/daemon.pid" )
precmd() {
  ( /bin/sleep ${precmdSleep} </dev/null >/dev/null 2>&1 & echo $! >> "$HOME/precmd.pids" )
  printf 'PROMPT_READY\\n'
}
PS1=''
`);

  const piSessionStart = harness === 'pi' && !omitSnapshot ? `
  const { default: hud } = await import(${JSON.stringify(hudExt)});
  const hooks = new Map();
  process.argv.push('--hud-worker-tools');
  await hud({ on: (name, fn) => hooks.set(name, fn), registerTool: () => {}, sendMessage: () => {} });
  await hooks.get('session_start')?.();
` : '';
  const workerBody = `(async () => {
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
  ${piSessionStart}
  fs.writeFileSync(${JSON.stringify(join(root, 'worker.json'))}, JSON.stringify({ pid: process.pid, start }));
  if (${JSON.stringify(leaveBackground)}) {
    // Reparented background child in the same shell session, using the exact same /bin/sleep binary as the startup daemon.
    const bg = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(join(root, 'bg.pid'))}, String(bg.pid));
    bg.unref();
  }
  if (${JSON.stringify(liveIdlePi)}) {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 60000);
  } else {
    setTimeout(() => process.exit(0), 60);
  }
})().catch(err => { console.error(err); process.exit(1); });
`;
  const workerPath = join(fakeBin, harness === 'cli' ? 'codex' : 'pi');
  fs.writeFileSync(workerPath, `#!${process.execPath}\n${workerBody}`, { mode: 0o700 });

  let zshEnv = { ...process.env, ...tags, HOME: ownerHome, ZDOTDIR: ownerHome };
  if (harness === 'cli') {
    const cliInv = prepareCliInvocation(dir, launch, 'codex', workerPath);
    zshEnv = { ...zshEnv, ...cliInv.env };
  }

  const sh = spawn('zsh', ['-i'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: zshEnv });
  const shStart = procStat(sh.pid)?.start;
  assert.ok(shStart, 'zsh shell started');
  const trackedShells = [{ sh, start: shStart }];
  t.after(() => {
    for (const { sh: proc, start: startTick } of trackedShells) {
      for (const pid of listProcPids()) {
        const st = procStat(pid);
        if (st && st.session === proc.pid && BigInt(st.start) >= BigInt(startTick)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
        }
      }
      try { proc.kill('SIGKILL'); } catch { /* Already gone. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let prompts = 0;
  sh.stdout.on('data', chunk => {
    const matches = chunk.toString('utf8').match(/PROMPT_READY/g);
    if (matches) prompts += matches.length;
  });

  const daemonFile = join(ownerHome, 'daemon.pid'), precmdFile = join(ownerHome, 'precmd.pids');
  await until(() => prompts >= 1 && fs.existsSync(daemonFile) && fs.existsSync(precmdFile), 10000);
  const daemonPid = Number(fs.readFileSync(daemonFile, 'utf8').trim());
  const daemonStat = procStat(daemonPid);
  assert.ok(daemonStat && daemonStat.session === sh.pid && isActiveProcState(daemonStat.state), 'startup daemon active in shell session');

  const exe = `/proc/${sh.pid}/exe`, image = fs.statSync(exe, { bigint: true });
  const tabShells = [
    { pane: 'worker-pane', pid: sh.pid, start: shStart, exe: fs.readlinkSync(exe), inode: `${image.dev}:${image.ino}` },
  ];

  let splitSh = null, splitBgPid = null, splitBgStart = null;
  if (splitPreWorkerBackground) {
    const splitHome = join(root, 'split-home');
    fs.mkdirSync(splitHome);
    const splitEnv = { ...process.env, ...tags, HERDR_PANE_ID: 'split-pane', HOME: splitHome, ZDOTDIR: splitHome };
    splitSh = spawn('zsh', ['-f', '-i'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: splitEnv });
    const splitStart = procStat(splitSh.pid)?.start;
    assert.ok(splitStart, 'split zsh shell started');
    trackedShells.push({ sh: splitSh, start: splitStart });
    const splitExe = `/proc/${splitSh.pid}/exe`, splitImage = fs.statSync(splitExe, { bigint: true });
    tabShells.push({ pane: 'split-pane', pid: splitSh.pid, start: splitStart, exe: fs.readlinkSync(splitExe), inode: `${splitImage.dev}:${splitImage.ino}` });
    const splitBgFile = join(splitHome, 'owner-bg.pid');
    // Owner starts a background job in the right-hand split shell BEFORE the worker starts.
    splitSh.stdin.write(`( /bin/sleep 600 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(splitBgFile)} )\n`);
    await until(() => fs.existsSync(splitBgFile), 5000);
    splitBgPid = Number(fs.readFileSync(splitBgFile, 'utf8').trim());
    const splitBgStat = procStat(splitBgPid);
    assert.ok(splitBgStat && splitBgStat.session === splitSh.pid && isActiveProcState(splitBgStat.state), 'owner split background job active');
    assert.ok(BigInt(splitStart) <= BigInt(splitBgStat.start));
    splitBgStart = splitBgStat.start;
  }

  fs.writeFileSync(join(dir, 'tab-shells.json'), JSON.stringify({ launch, tab: 'worker-tab', shells: tabShells }));

  // Ensure the worker starts on a strictly later kernel tick than both the startup daemon and any split background job.
  await new Promise(r => setTimeout(r, 30));

  sh.stdin.write(harness === 'cli' ? 'codex\n' : `${workerPath}\n`);
  const workerFile = join(root, 'worker.json');
  await until(() => fs.existsSync(workerFile) && (liveIdlePi || prompts >= 2), 10000);
  const workerInfo = JSON.parse(fs.readFileSync(workerFile, 'utf8'));
  if (!liveIdlePi) {
    await until(() => {
      const st = procStat(workerInfo.pid);
      return !st || st.start !== workerInfo.start || !isActiveProcState(st.state);
    }, 5000);
  }

  assert.ok(BigInt(daemonStat.start) < BigInt(workerInfo.start), `daemon (${daemonStat.start}) started before worker (${workerInfo.start})`);
  if (splitBgStart) assert.ok(BigInt(splitBgStart) < BigInt(workerInfo.start), 'owner split background job started strictly before worker');
  if (!liveIdlePi) {
    const precmdPids = fs.readFileSync(precmdFile, 'utf8').trim().split('\n').map(Number);
    assert.ok(precmdPids.length >= 2, 'precmd helper spawned again after worker exit');
    if (Number(precmdSleep) >= 0.3) {
      const postPrecmd = procStat(precmdPids.at(-1));
      assert.ok(postPrecmd && postPrecmd.session === sh.pid && isActiveProcState(postPrecmd.state),
        'post-exit precmd helper is still active when hud-reap starts');
      assert.ok(BigInt(postPrecmd.start) > BigInt(workerInfo.start));
    }
  }

  let bgPid = null, bgStart = null;
  if (leaveBackground) {
    const bgFile = join(root, 'bg.pid');
    await until(() => fs.existsSync(bgFile), 5000);
    bgPid = Number(fs.readFileSync(bgFile, 'utf8').trim());
    const bgStat = procStat(bgPid);
    assert.ok(bgStat && bgStat.session === sh.pid && isActiveProcState(bgStat.state), 'worker background child active in shell session');
    assert.ok(BigInt(bgStat.start) >= BigInt(workerInfo.start), 'worker background child started at/after worker start');
    bgStart = bgStat.start;
  }

  const native = join(dir, 'pi.jsonl');
  const statePath = join(root, 'state'), logPath = `${statePath}.log`;
  const panes = [
    { pane_id: 'worker-pane', tab_id: 'worker-tab', agent: liveIdlePi ? 'pi' : null },
    ...(splitSh ? [{ pane_id: 'split-pane', tab_id: 'worker-tab', agent: null }] : []),
    { pane_id: 'main-pane', tab_id: 'main-tab', agent: 'pi' },
  ];
  fs.writeFileSync(statePath, JSON.stringify({
    shell: sh.pid,
    ...(splitSh && { shells: { 'worker-pane': sh.pid, 'split-pane': splitSh.pid }, workerPane: 'worker-pane' }),
    occupant: workerInfo.pid,
    tabs: [{ tab_id: 'worker-tab', label: 'synthetic' }],
    panes,
    agents: liveIdlePi ? [{ agent_session: { value: native }, pane_id: 'worker-pane', tab_id: 'worker-tab', name: 'worker', agent_status: 'idle' }] : [],
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `LAUNCH=${launch}\nTAB=worker-tab\nTAB_NAME=synthetic\nLEFT=worker-pane\n${splitSh ? 'RIGHT=split-pane\n' : ''}ORCH=main-pane\nPRIMARY=worker\n`);
  const status = harness === 'cli'
    ? { version: 1, task_dir: dir, slot: 'primary', harness: 'cli', agent: 'codex', state: 'closed',
        pid: stampCliStatus ? workerInfo.pid : null, pid_start_time: stampCliStatus ? workerInfo.start : null }
    : { version: 1, task_dir: dir, slot: 'primary', session_file: native, state: liveIdlePi ? 'idle_grace' : 'closed',
        pid: workerInfo.pid, pid_start_time: workerInfo.start };
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(status));

  const env = { ...process.env, HOME: root, HUD_HOME: root, DIR: dir, STATE: statePath, PATH: herdrBin };
  const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l)) : [];
  return {
    dir, launch, daemonPid, daemonStart: daemonStat.start, workerInfo, bgPid, bgStart, splitBgPid, splitBgStart, calls,
    precmdCount: () => fs.readFileSync(precmdFile, 'utf8').trim().split('\n').length,
    snapshotPath: join(dir, 'cli-invocations', launch, 'shell-session.json'),
    run: () => spawnSync(process.execPath, [cli, dir], { env, encoding: 'utf8', timeout: 15000 }),
  };
}

for (const [label, opts] of [
  ['finished pi job', { harness: 'pi' }],
  ['live idle_grace pi job quit into precmd', { harness: 'pi', liveIdlePi: true }],
  ['finished CLI job with stamped STATUS', { harness: 'cli', stampCliStatus: true }],
  ['finished CLI job using witness alone', { harness: 'cli', stampCliStatus: false }],
]) test(`real zsh with p10k-style startup daemon and precmd helper: ${label} closes`, { skip: noZsh }, async t => {
  const f = await zshTabFixture(t, opts);
  const snap = JSON.parse(fs.readFileSync(f.snapshotPath, 'utf8'));
  assert.ok(snap.members.some(m => m.pid === f.daemonPid && m.start === f.daemonStart), 'startup daemon recorded in session snapshot');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(f.calls().some(a => a[0] === 'tab' && a[1] === 'close' && a[2] === 'worker-tab'));
  if (opts.liveIdlePi) assert.ok(f.precmdCount() >= 2, 'post-/quit precmd helper ran before tab closed');
  // Startup daemon was still running (exempted by exact PID+start in startup snapshot, never by name or age).
  assert.equal(procStat(f.daemonPid)?.start, f.daemonStart);
});

for (const harness of ['pi', 'cli']) test(`real zsh with p10k-style startup daemon: background child started by ${harness} worker still blocks close`, { skip: noZsh }, async t => {
  const f = await zshTabFixture(t, { harness, leaveBackground: true, precmdSleep: '0.05' });
  const r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /active unlisted process remains in shell session; not closing/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));
  assert.equal(procStat(f.bgPid)?.start, f.bgStart);
});

test('real zsh with p10k-style startup daemon: missing startup snapshot fails closed even with worker start stamped', { skip: noZsh }, async t => {
  const f = await zshTabFixture(t, { harness: 'pi', omitSnapshot: true, precmdSleep: '0.05' });
  assert.equal(fs.existsSync(f.snapshotPath), false);
  const r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /without startup snapshot; not closing/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));
});

test('owner background job in a split shell started before the worker refuses tab close', { skip: noZsh }, async t => {
  const f = await zshTabFixture(t, { harness: 'pi', splitPreWorkerBackground: true, precmdSleep: '0.05' });
  const r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /non-worker shell session; not closing/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));
  assert.equal(procStat(f.splitBgPid)?.start, f.splitBgStart);
});

test('startup helper listed in the worker pane snapshot permits tab close; mismatched start or missing snapshot refuses', async t => {
  const f = fixture(t, { status: null });
  const helperSh = spawn('/bin/sh', ['-c', '/bin/sleep 600 </dev/null >/dev/null 2>&1 & echo $!; read line'], {
    detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: f.tags,
  });
  const shStart = procStat(helperSh.pid).start;
  t.after(() => {
    for (const pid of listProcPids()) {
      const st = procStat(pid);
      if (st && st.session === helperSh.pid && BigInt(st.start) >= BigInt(shStart)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
      }
    }
    try { helperSh.kill('SIGKILL'); } catch { /* Already gone. */ }
  });
  const [chunk] = await once(helperSh.stdout, 'data');
  const helperPid = Number(chunk.toString('utf8').trim());
  const helperStat = procStat(helperPid);
  assert.ok(helperStat && helperStat.session === helperSh.pid && isActiveProcState(helperStat.state));

  const exe = `/proc/${helperSh.pid}/exe`, image = fs.statSync(exe, { bigint: true });
  fs.writeFileSync(join(f.dir, 'tab-shells.json'), JSON.stringify({ launch: f.launch, tab: 'worker-tab', shells: [
    { pane: 'worker-pane', pid: helperSh.pid, start: shStart, exe: fs.readlinkSync(exe), inode: `${image.dev}:${image.ino}` },
  ] }));
  const state = JSON.parse(fs.readFileSync(f.state));
  state.shell = helperSh.pid;
  fs.writeFileSync(f.state, JSON.stringify(state));

  // Missing snapshot -> refuse.
  const noSnap = f.run();
  assert.equal(noSnap.status, 1, noSnap.stdout);
  assert.match(noSnap.stderr, /without startup snapshot; not closing/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));

  // Wrong start tick in snapshot (PID reuse protection) -> refuse.
  const snapDir = join(f.dir, 'cli-invocations', f.launch);
  fs.mkdirSync(snapDir, { recursive: true });
  const snapPath = join(snapDir, 'shell-session.json');
  fs.writeFileSync(snapPath, JSON.stringify({
    version: 1, launch: f.launch, pane: 'worker-pane', session: helperSh.pid, session_start: shStart,
    members: [{ pid: helperPid, start: String(BigInt(helperStat.start) + 1n) }],
  }));
  const wrongStart = f.run();
  assert.equal(wrongStart.status, 1, wrongStart.stdout);
  assert.match(wrongStart.stderr, /active unlisted process remains in shell session; not closing/);
  assert.ok(!f.calls().some(a => a[1] === 'close'));

  // Exact PID+start listed in worker pane snapshot -> close.
  fs.writeFileSync(snapPath, JSON.stringify({
    version: 1, launch: f.launch, pane: 'worker-pane', session: helperSh.pid, session_start: shStart,
    members: [{ pid: helperPid, start: helperStat.start }],
  }));
  const ok = f.run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(f.calls().some(a => a[0] === 'tab' && a[1] === 'close' && a[2] === 'worker-tab'));
  assert.equal(procStat(helperPid)?.start, helperStat.start);
});
