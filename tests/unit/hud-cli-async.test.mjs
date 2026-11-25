import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareCliInvocation, invocationWitness } from '../../dist/runtime/cli-invocation.js';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as unixServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { procStat } from '../../dist/roles/worker-tree.js';
import { configureFakeDecision, decisionAnswer } from '../helpers/thin-mcp-harness.mjs';
import { reapStubOptions } from '../helpers/reap-stub.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { reapFixtureProcesses, stopChild, trackFixture } from '../helpers/process-cleanup.mjs';

// Leave room for subprocess startup, but never let the supervisor's own
// 20 s Herdr timeout stand in for cancellation of a held effect.
const watchdog = { timeout: 20000 };
const tab = 'synthetic-tab';
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const save = (dir, file, data) => writeFixtureFile(join(dir, file), JSON.stringify(data));
const status = (dir) => JSON.parse(read(join(dir, 'STATUS.json')) || 'null');
async function until(t, ready) {
  while (!ready()) await delay(10, null, { signal: t.signal });
}

async function fixture(t, { hang, resistant = false, fail = false, report = false, sonic = false, model, preload, pendingIdentity = false, foreign = false, replacement = false, missingWitness = false } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-cli-async-'));
  const home = join(root, 'hud'), jobs = join(home, 'jobs'), bin = join(root, 'bin');
  const untrack = trackFixture({ root, hudHome: home });
  const job = 'j0000000000000001', dir = join(jobs, job), herdrPath = join(root, 'herdr.sock');
  const env = { PATH: bin, NODE_OPTIONS: reapStubOptions(bin), HOME: join(root, 'home'), HUD_HOME: home, HERDR_SOCKET_PATH: herdrPath, TZ: 'UTC' };
  fs.mkdirSync(dir, { recursive: true });
  const launch = randomUUID(), { dir: shims, token } = prepareCliInvocation(dir, launch, 'grok', process.execPath);
  const shim = join(shims, 'grok'), agentEnv = { ...env, HUD_JOB_DIR: foreign ? root : dir, HUD_TAB_LAUNCH: launch, HERDR_PANE_ID: 'synthetic-pane', HERDR_TAB_ID: tab };
  if (replacement) {
    const original = spawnSync(shim, [token, '-e', 'console.log(process.pid)'], { env: agentEnv, encoding: 'utf8' });
    assert.equal(original.status, 0, original.stderr);
    const proof = invocationWitness(dir, launch); assert.equal(proof.pid, Number(original.stdout));
    assert.equal(fs.statSync(join(shims, 'witness.json')).mode & 0o777, 0o600);
    const replay = spawnSync(shim, [token, '-e', 'console.log("should not run")'], { env: agentEnv, encoding: 'utf8' });
    assert.notEqual(replay.status, 0); assert.equal(replay.stdout, ''); assert.deepEqual(invocationWitness(dir, launch), proof);
  }
  const agent = spawn(shim, [...(replacement || missingWitness ? [] : [token]), '-e', 'console.log("ready");setInterval(()=>{},60000)'], { stdio: ['ignore','pipe','inherit'], env: agentEnv });
  t.after(() => agent.kill('SIGKILL'));
  await once(agent.stdout, 'data');
  let discover = !pendingIdentity;
  const subscribers = new Map(), sockets = new Set(), children = [];
  let calls = 0, disconnected = false;
  const http = httpServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      if (model) res.end(JSON.stringify(decisionAnswer(model, 0.95)));
    });
    res.on('close', () => { if (!res.writableFinished) disconnected = true; });
  });
  const socket = unixServer((conn) => {
    sockets.add(conn);
    conn.on('error', () => {});
    conn.once('close', () => sockets.delete(conn));
    createInterface({ input: conn }).on('line', (line) => {
      const { id, method } = JSON.parse(line);
      if (method === 'events.subscribe') subscribers.set(id, conn);
      const result = method === 'agent.get' ? { agent: { name: 'synthetic-agent', pane_id: 'synthetic-pane', tab_id: tab, agent_status: 'idle', agent_session: { kind: 'id', value: 'demo' } } } :
        method === 'pane.process_info' ? { process_info: { pane_id: 'synthetic-pane', shell_pid: 1, foreground_process_group_id: agent.pid, foreground_processes: discover ? [{ pid: agent.pid, name: 'grok' }] : [] } } : {};
      conn.write(JSON.stringify({ id, result }) + '\n');
    });
  });
  t.after(async () => {
    const killMs = t.signal?.aborted ? 200 : 1000;
    await Promise.all(children.map(({ child, exited }) => stopChild(child, exited, { killMs })));
    const survivors = await reapFixtureProcesses({ root, hudHome: home });
    untrack();
    for (const conn of sockets) conn.destroy();
    http.closeAllConnections();
    await Promise.all([http, socket].map((server) => new Promise((done) => server.close(done))));
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(
      survivors.length,
      0,
      `Fixture left live process(es) for ${home}: ${survivors.map((p) => `${p.pid} (${p.state}) ${p.cmdline}`).join('; ')}`
    );
  });
  fs.mkdirSync(bin);
  fs.mkdirSync(env.HOME);
  const turn = { seq: 1, sent_at: new Date().toISOString(), report_sig: null };
  const record = { job, role: 'imp', dispatch_exit_code: 0, cli: { agent: 'grok', idle_grace_s: 0.05, can_continue: true } };
  save(dir, 'turn.json', turn);
  save(dir, 'STATUS.json', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), `TAB=${tab}\nLEFT=synthetic-pane\nPRIMARY=synthetic-agent\nLAUNCH=${launch}\n`);
  function finishReport() {
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
    save(dir, 'done.json', { ...turn, report_sig: reportSignature(dir), at: new Date().toISOString() });
  }
  if (report || sonic) finishReport();
  // The read receipt has millisecond precision, but the file mtime can be fractional.
  if (report) record.read_at = new Date(Math.ceil(fs.statSync(join(dir, 'report.md')).mtimeMs)).toISOString();
  if (sonic) {
    const id = 'j0000000000000002', child = join(jobs, id);
    fs.mkdirSync(join(dir, '.sonic'));
    fs.writeFileSync(join(dir, '.sonic', id), '');
    fs.mkdirSync(child);
    save(child, 'job.json', { job: id });
    save(child, 'STATUS.json', { state: 'closed' });
    fs.writeFileSync(join(child, 'report.md'), 'Synthetic sonic report.');
  }
  save(dir, 'job.json', record);
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const [area, command, , text] = process.argv.slice(2);
const kind = area === 'pane' && command === 'read' ? 'read' : text === '/quit' ? 'quit' :
  text?.startsWith('Collect these sonic reports') ? 'sonic' : 'prompt';
if (kind === ${JSON.stringify(hang ?? null)}) {
  if (${resistant}) process.on('SIGTERM', () => {});
  fs.writeFileSync(process.env.HUD_HOME + '/herdr-pid', String(process.pid));
  if (${fail}) {
    while (!fs.existsSync(${JSON.stringify(join(dir, 'STATUS.json.stop-requested'))})) await delay(10);
    process.exit(1);
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
console.log(JSON.stringify({ result: { read: { text: 'Synthetic quiet pane.' } } }));
`, { mode: 0o700 });
  fs.writeFileSync(join(bin, 'hud-reap'), `#!${process.execPath}\n`, { mode: 0o700 });
  http.listen(0, '127.0.0.1'); socket.listen(herdrPath);
  await Promise.all([once(http, 'listening'), once(socket, 'listening')]);
  configureFakeDecision({ env }, `http://127.0.0.1:${http.address().port}`);
  function start(script, args = [], probe = preload) {
    const imports = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
    const child = spawn(process.execPath, [...imports, resolve('packages/hud-mcp/bin', script), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const run = { child, exited, stderr: () => stderr };
    children.push(run);
    return run;
  }
  return {
    dir, jobs, start, agent, enableDiscovery: () => { discover = true; writeFixtureFile(join(dir, 'STATUS.json.stop-requested'), ''); }, cli: start('hud-cli.mjs', [dir]), finishReport,
    herdrPid: () => Number(read(join(home, 'herdr-pid'))), calls: () => calls, disconnected: () => disconnected,
    stop: () => fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), ''),
    subscribed: (id) => subscribers.has(id),
    closeTab: (id = 'hud-cli-events', tabId = tab) => subscribers.get(id).write(JSON.stringify({ event: 'tab.closed', data: { tab_id: tabId } }) + '\n'),
  };
}

test('stop before discovery retains the supervisor until a verified worker PID can be stamped', watchdog, async t => {
  const f = await fixture(t, { pendingIdentity: true });
  f.stop();
  await until(t, () => status(f.dir)?.reason === 'stop pending verified worker identity');
  assert.equal(status(f.dir).pid, null);
  f.enableDiscovery();
  await until(t, () => status(f.dir)?.state === 'stopped');
  assert.equal(status(f.dir).pid, f.agent.pid);
  assert.equal(status(f.dir).pid_start_time, procStat(f.agent.pid).start);
});

test('stable foreign foreground from discovery through stop cannot acquire a PID stamp', watchdog, async t => {
  const f = await fixture(t, { foreign: true });
  await until(t, () => status(f.dir)?.supervisor_pid);
  assert.equal(status(f.dir).pid, null);
  f.stop();
  await until(t, () => status(f.dir)?.reason === 'stop pending verified worker identity');
  assert.equal(status(f.dir).pid, null);
  assert.equal(f.agent.exitCode, null);
});

for (const mode of ['replacement', 'missingWitness']) test(`same CLI in the original shell without exact invocation proof is not adopted (${mode})`, watchdog, async t => {
  const f = await fixture(t, { [mode]: true });
  await until(t, () => status(f.dir).supervisor_pid && f.cli.stderr().includes('identity not adopted'));
  assert.equal(status(f.dir).pid, null); assert.equal(status(f.dir).agent_session_id, null);
  f.stop(); await until(t, () => status(f.dir)?.reason === 'stop pending verified worker identity');
  assert.equal(status(f.dir).pid_start_time, null); assert.equal(f.agent.signalCode, null);
});

async function expectState(t, f, state, reason) {
  await until(t, () => status(f.dir)?.state === state);
  assert.equal(status(f.dir).exit_reason, reason);
}

for (const stop of [true, false]) {
  test(`a hanging pane read is cancelled by ${stop ? 'stop intent' : 'tab close'} before any Decision API call`, watchdog, async (t) => {
    const f = await fixture(t, { hang: 'read', resistant: stop });
    await until(t, f.herdrPid);
    if (stop) f.stop();
    else f.closeTab();
    await expectState(t, f, stop ? 'stopped' : 'failed', stop ? 'stop requested' : 'tab closed');
    assert.deepEqual(await f.cli.exited, [stop ? 0 : 1, null]);
    assert.equal(f.calls(), 0);
    assert.equal(procStat(f.herdrPid()), null, 'the cancelled child was reaped');
  });
}

test('stop published at cap reservation prevents a paid request with no directory watch', watchdog, async (t) => {
  const f = await fixture(t, { model: 'still-working', preload: `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.watch = () => { throw new Error('synthetic watch unavailable'); };
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (to.endsWith('/calls.json')) fs.writeFileSync(process.argv[2] + '/STATUS.json.stop-requested', '');
};
syncBuiltinESMExports();` });
  await until(t, () => status(f.dir)?.state === 'stopped');
  assert.deepEqual(await f.cli.exited, [0, null]);
  assert.equal(f.calls(), 0);
});

test('a new report and done receipt cancel an in-flight Decision API request', watchdog, async (t) => {
  const f = await fixture(t);
  await until(t, f.calls);
  f.finishReport();
  await expectState(t, f, 'idle_grace', null);
  await until(t, f.disconnected);
  assert.equal(f.calls(), 1);
  assert.equal(status(f.dir).quiet_decision, undefined);
});

for (const [hang, interrupt] of [['prompt', 'SIGTERM'], ['prompt', 'stop'], ['sonic', 'SIGTERM'], ['sonic', 'stop']]) {
  test(`${interrupt} during ${hang} does not report a delivery or supervisor failure`, watchdog, async (t) => {
    const f = await fixture(t, { hang, sonic: hang === 'sonic', model: 'finished-no-report', fail: hang === 'prompt' && interrupt === 'stop' });
    await until(t, f.herdrPid);
    if (interrupt === 'stop') {
      f.stop();
      await expectState(t, f, 'stopped', 'stop requested');
    } else f.cli.child.kill('SIGTERM');
    assert.deepEqual(await f.cli.exited, [0, null]);
    assert.equal(f.cli.stderr(), '');
    assert.equal(procStat(f.herdrPid()), null);
    assert.equal(status(f.dir).state, interrupt === 'stop' ? 'stopped' : 'working');
    assert.equal(status(f.dir).quiet_decision, undefined);
  });
}

test('stop intent wins while /quit is pending', watchdog, async (t) => {
  const f = await fixture(t, { hang: 'quit', report: true });
  await until(t, f.herdrPid);
  f.stop();
  await expectState(t, f, 'stopped', 'stop requested');
  assert.deepEqual(await f.cli.exited, [0, null]);
  assert.equal(procStat(f.herdrPid()), null);
});

test('tab close during /quit records closed even when the global watcher sees it first', watchdog, async (t) => {
  const f = await fixture(t, { hang: 'quit', report: true });
  const other = join(f.jobs, 'j0000000000000002');
  fs.mkdirSync(other);
  save(other, 'job.json', { job: 'j0000000000000002', cli: { agent: 'grok' } });
  save(other, 'STATUS.json', { state: 'working' });
  fs.writeFileSync(join(other, 'SESSION.txt'), 'TAB=control-tab\n');
  const guard = join(f.dir, 'watcher-saw-quit');
  f.start('hud-watch.mjs', [], `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
fs.existsSync = (file) => {
  const found = exists(file);
  if (found && typeof file === 'string' && file.startsWith(${JSON.stringify(join(f.dir, 'STATUS.json.quit-'))}))
    fs.writeFileSync(${JSON.stringify(guard)}, '');
  return found;
};
syncBuiltinESMExports();`);
  await until(t, () => f.herdrPid() && f.subscribed('hud-watch'));
  f.closeTab('hud-watch');
  f.closeTab('hud-watch', 'control-tab');
  // The control job can be visited first; wait for the watcher to check this job too.
  await until(t, () => status(other).state === 'failed' && fs.existsSync(guard));
  assert.equal(status(f.dir).state, 'working', 'watcher did not preempt the live supervisor');
  f.closeTab();
  await expectState(t, f, 'closed', 'closed after report read');
  assert.deepEqual(await f.cli.exited, [0, null]);
  assert.equal(procStat(f.herdrPid()), null);
});
