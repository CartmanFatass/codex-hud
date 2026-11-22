import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const tab = 'synthetic-tab';
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const save = (dir, file, data) => writeFixtureFile(join(dir, file), JSON.stringify(data));
const status = (dir) => JSON.parse(read(join(dir, 'STATUS.json')) || 'null');
async function until(ready, label, limit = 5000) {
  const start = performance.now();
  while (!ready() && performance.now() - start < limit) await delay(5);
  const ms = performance.now() - start;
  assert.ok(ready() && ms < limit, `${label} did not settle within ${limit} ms (observed ${Math.round(ms)} ms)`);
  return Math.round(ms);
}

async function fixture(t, { hang, resistant = false, fail = false, report = false, sonic = false, model } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-cli-async-'));
  const home = join(root, 'hud'), jobs = join(home, 'jobs'), bin = join(root, 'bin');
  const job = 'j0000000000000001', dir = join(jobs, job), herdrPath = join(root, 'herdr.sock');
  const env = { PATH: bin, HOME: join(root, 'home'), HUD_HOME: home, HERDR_SOCKET_PATH: herdrPath, TZ: 'UTC' };
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
      const result = method === 'agent.get' ? { agent: { agent_status: 'idle', agent_session: { kind: 'id', value: 'demo' } } } : {};
      conn.write(JSON.stringify({ id, result }) + '\n');
    });
  });
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(({ exited }) => exited));
    for (const conn of sockets) conn.destroy();
    http.closeAllConnections();
    await Promise.all([http, socket].map((server) => new Promise((done) => server.close(done))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(env.HOME);
  const turn = { seq: 1, sent_at: new Date().toISOString(), report_sig: null };
  const record = { job, role: 'imp', dispatch_exit_code: 0, cli: { agent: 'grok', idle_grace_s: 0.05, can_continue: true } };
  save(dir, 'turn.json', turn);
  save(dir, 'STATUS.json', { state: 'working' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), `TAB=${tab}\nLEFT=synthetic-pane\nPRIMARY=synthetic-agent\n`);
  function finishReport() {
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
    save(dir, 'done.json', { ...turn, report_sig: reportSignature(dir), at: new Date().toISOString() });
  }
  if (report || sonic) finishReport();
  if (report) record.read_at = new Date().toISOString();
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
  await delay(${fail ? 200 : 5000});
  if (${fail}) process.exit(1);
}
console.log(JSON.stringify({ result: { read: { text: 'Synthetic quiet pane.' } } }));
`, { mode: 0o700 });
  fs.writeFileSync(join(bin, 'pi-role-reap'), `#!${process.execPath}\n`, { mode: 0o700 });
  http.listen(0, '127.0.0.1'); socket.listen(herdrPath);
  await Promise.all([once(http, 'listening'), once(socket, 'listening')]);
  configureFakeDecision({ env }, `http://127.0.0.1:${http.address().port}`);
  function start(script, args = []) {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin', script), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const run = { child, exited, stderr: () => stderr };
    children.push(run);
    return run;
  }
  return {
    dir, jobs, start, cli: start('hud-cli.mjs', [dir]), finishReport,
    herdrPid: () => Number(read(join(home, 'herdr-pid'))), calls: () => calls, disconnected: () => disconnected,
    stop: () => fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), ''),
    subscribed: (id) => subscribers.has(id),
    closeTab: (id = 'hud-cli-events', tabId = tab) => subscribers.get(id).write(JSON.stringify({ event: 'tab.closed', data: { tab_id: tabId } }) + '\n'),
  };
}

async function expectState(t, f, state, reason) {
  const ms = await until(() => status(f.dir)?.state === state, state, 500);
  t.diagnostic(`${state} in ${ms} ms`);
  assert.equal(status(f.dir).exit_reason, reason);
}

for (const stop of [true, false]) {
  test(`a hanging pane read is cancelled by ${stop ? 'stop intent' : 'tab close'} before any Decision API call`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { hang: 'read', resistant: stop });
    await until(f.herdrPid, 'synthetic herdr starts');
    if (stop) f.stop();
    else f.closeTab();
    await expectState(t, f, stop ? 'stopped' : 'failed', stop ? 'stop requested' : 'tab closed');
    assert.deepEqual(await f.cli.exited, [stop ? 0 : 1, null]);
    assert.equal(f.calls(), 0);
    assert.equal(procStat(f.herdrPid()), null, 'the cancelled child was reaped');
  });
}

test('a new report and done receipt cancel an in-flight Decision API request', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await until(f.calls, 'Decision API starts');
  f.finishReport();
  await expectState(t, f, 'idle_grace', null);
  await until(f.disconnected, 'Decision API socket closes', 500);
  assert.equal(f.calls(), 1);
  assert.equal(status(f.dir).quiet_decision, undefined);
});

for (const [hang, interrupt] of [['prompt', 'SIGTERM'], ['prompt', 'stop'], ['sonic', 'SIGTERM'], ['sonic', 'stop']]) {
  test(`${interrupt} during ${hang} does not report a delivery or supervisor failure`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { hang, sonic: hang === 'sonic', model: 'finished-no-report', fail: hang === 'prompt' && interrupt === 'stop' });
    await until(f.herdrPid, 'synthetic prompt starts');
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

test('stop intent wins while /quit is pending', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { hang: 'quit', report: true });
  await until(f.herdrPid, 'synthetic /quit starts');
  f.stop();
  await expectState(t, f, 'stopped', 'stop requested');
  assert.deepEqual(await f.cli.exited, [0, null]);
  assert.equal(procStat(f.herdrPid()), null);
});

test('tab close during /quit records closed even when the global watcher sees it first', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { hang: 'quit', report: true });
  const other = join(f.jobs, 'j0000000000000002');
  fs.mkdirSync(other);
  save(other, 'job.json', { job: 'j0000000000000002', cli: { agent: 'grok' } });
  save(other, 'STATUS.json', { state: 'working' });
  fs.writeFileSync(join(other, 'SESSION.txt'), 'TAB=control-tab\n');
  f.start('hud-watch.mjs');
  await until(() => f.herdrPid() && f.subscribed('hud-watch'), 'pending /quit and a watcher subscription');
  f.closeTab('hud-watch');
  f.closeTab('hud-watch', 'control-tab');
  await until(() => status(other).state === 'failed', 'watcher processed the tab closes', 500);
  assert.equal(status(f.dir).state, 'working', 'watcher did not preempt the live supervisor');
  f.closeTab();
  await expectState(t, f, 'closed', 'closed after report read');
  assert.deepEqual(await f.cli.exited, [0, null]);
  assert.equal(procStat(f.herdrPid()), null);
});
