import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { jobChanges, readThinJobRows, readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { collectWorkSummary } from '../../dist/collectors/work-summary-snapshot.js';
import { classifyPermission, permissionProof } from '../../dist/mcp/permission-policy.js';
import { parsePermissionPrompt, permissionStatus } from '../../dist/mcp/worker-permissions.js';
import { machineWorkForms } from '../../dist/render/work-summary.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { procStat } from '../../dist/utils/proc.js';
import { fixture, until } from '../helpers/job-retention-fixture.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { entry as mcpEntry, rpcClient } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const pane = 'w1:p2', main = 'w1:p1';
const prompt = (command, highlighted = 1) => `Historical output\n╭─────────────────╮\n Bash command\n\n   ${command}\n\n Do you want to proceed?\n ${highlighted === 1 ? '❯' : ' '} 1. Yes\n ${highlighted === 2 ? '❯' : ' '} 2. Yes, and don't ask again\n ${highlighted === 3 ? '❯' : ' '} 3. No\n\n Esc to cancel · Tab to amend\n╰─────────────────╯\n`;

async function syntheticHerdr(t, f) {
  const endpoint = join(dirname(f.home), 'permissions.sock');
  const sockets = new Set(), subscribers = new Set(), keys = [];
  let reads = 0, state = 'blocked', visible = prompt('rm -f $S/*.png');
  const update = (status, text = visible) => {
    visible = text;
    state = status;
    for (const socket of subscribers) socket.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: pane, agent_status: status } }) + '\n');
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    socket.on('error', () => {});
    const input = createInterface({ input: socket });
    input.on('error', () => {});
    input.on('line', line => {
      const { id, method, params } = JSON.parse(line);
      let result;
      switch (method) {
        case 'ping': result = { type: 'pong', version: '1.0-hud' }; break;
        case 'events.subscribe': subscribers.add(socket); result = { type: 'subscribed' }; break;
        case 'pane.get': result = { pane: { pane_id: params.pane_id, launch_id: 'launch', terminal_id: 'terminal', agent: 'claude', agent_status: state } }; break;
        case 'pane.read': reads++; assert.equal(params.source, 'visible'); result = { read: { text: visible } }; break;
        case 'pane.send_keys': assert.equal(params.pane_id, pane); keys.push(params.keys); result = { type: 'ok' }; break;
        default: result = {};
      }
      socket.write(JSON.stringify({ id, result }) + '\n');
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(done => server.close(done));
  });
  return { endpoint, keys, reads: () => reads, subscribed: () => subscribers.size > 0, update };
}

test('one watcher pass approves only the proven worker cleanup; restart, handoff and gone are safe', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const herdr = await syntheticHerdr(t, f);
  const dir = f.job(null, { role: 'imp', created_at: new Date().toISOString(), cwd: dirname(f.home), herdr_pane: main,
    cli: { agent: 'claude', can_continue: true, idle_grace_s: 600 }, ticket_queue: 'synthetic-run' });
  const scratch = join(dir, 'scratchpad');
  fs.mkdirSync(scratch);
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  const env = { ...process.env, HUD_HOME: f.home, HOME: join(dirname(f.home), 'home'), HERDR_PANE_ID: main,
    HERDR_SOCKET_PATH: herdr.endpoint, HUD_MCP_JSON: '1' };
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore', env: { ...process.env, HUD_JOB_DIR: dir, S: scratch } });
  const exited = once(worker, 'exit');
  t.after(() => stopChild(worker, exited));
  await until(() => procStat(worker.pid)?.start, t.signal);
  const start = procStat(worker.pid).start;
  writeFixtureFile(join(dir, 'SESSION.txt'), `TAB=w1:t2\nLEFT=${pane}\nPRIMARY=worker\nDIRECT_EXEC=1\nLAUNCH_ID=launch\nTERMINAL_ID=terminal\nPID=${worker.pid}\nPID_START=${start}\nHERDR_SOCKET_PATH=${herdr.endpoint}\n`);
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', harness: 'cli', blocked: true, pid: worker.pid, pid_start_time: start }));
  const preload = `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(herdr.endpoint)}; globalThis.fetch = () => { throw new Error('synthetic offline'); };`;
  const watch = f.start(preload);
  await until(() => permissionStatus(dir).latest?.outcome === 'answered', 5000)
    .catch(error => { throw new Error(`${error.message}: reads=${herdr.reads()} ledger=${JSON.stringify(permissionStatus(dir))}\n${f.log()}`); });
  const approved = permissionStatus(dir).latest;
  assert.deepEqual(herdr.keys, [['Enter']]);
  assert.match(approved.text, /rm -f \$S\/\*\.png/);
  assert.match(approved.reason, /Local path check.*task scratchpad/);
  assert.equal(approved.action, 'approve');
  assert.equal(fs.statSync(join(dir, 'permissions.json')).mode & 0o777, 0o600);
  assert.equal(collectWorkSummary(f.home).global.permissionMain, undefined);
  assert.equal(collectWorkSummary(f.home).global.asking, 0);
  const rows = () => readThinJobRows(f.home, { project: null, pane: main });
  const autoRows = rows();
  assert.equal(autoRows[0].blocked, false);
  setDisplayConfig({ theme: 'none' });
  const card = () => readThinJobs(f.home, { project: null, pane: main }).flatMap(lane => lane.workers)[0];
  assert.equal(card().homeNeedsHuman, false);
  assert.match(workInspectorRows(card(), 120, Date.now()).map(row => row.text).join('\n'), /Permission approved.*rm -f/);

  await stopChild(watch.child, watch.exited);
  const before = herdr.reads();
  f.start(preload);
  await until(() => herdr.reads() > before && herdr.subscribed(), 3000);
  assert.deepEqual(herdr.keys, [['Enter']]);

  herdr.update('blocked', prompt('git push'));
  await until(() => permissionStatus(dir).active?.action === 'main', 3000);
  const pending = permissionStatus(dir).active;
  assert.equal(pending.outcome, 'pending');
  assert.equal(herdr.keys.length, 1);
  const notices = jobChanges(autoRows, rows()).join('\n');
  assert.match(notices, /git push.*recommends.*hud_respond.*"answer":"approve"/);
  assert.equal(jobChanges(rows(), rows()).length, 0);
  assert.equal(card().homeNeedsHuman, false);
  assert.equal(card().permissionWaitingMain, true);
  assert.match(machineWorkForms(collectWorkSummary(f.home).global, Date.now())[0], /Main 1/);

  let notice = '';
  const stream = new AbortController();
  const streamDone = watchCommand([], { env, stdout: (line) => { notice += line; }, stderr: () => {} }, { signal: stream.signal });
  t.after(() => { stream.abort(); return streamDone; });
  await until(() => notice.includes('git push') && notice.includes(pending.id), 3000);
  assert.equal(notice.split(pending.id).length - 1, 2); // One notice, one action per supported option.

  const mcp = spawn(process.execPath, [mcpEntry], { cwd: dirname(f.home), env, stdio: ['pipe', 'pipe', 'ignore'] });
  const mcpExit = once(mcp, 'exit');
  t.after(() => stopChild(mcp, mcpExit, { closeStdin: true }));
  const rpc = rpcClient(mcp);
  const respond = async (id, answer) => {
    const response = await rpc('tools/call', { name: 'hud_respond', arguments: { job: job.job, request_id: id, answer } });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    return JSON.parse(response.result.content[0].text);
  };
  herdr.update('working', 'No native prompt');
  const gone = await respond(pending.id, 'approve');
  assert.ok(!gone.written);
  assert.equal(permissionStatus(dir).latest.outcome, 'gone');
  assert.equal(herdr.keys.length, 1);

  herdr.update('blocked', prompt('curl -X POST https://example.invalid', 1));
  await until(() => permissionStatus(dir).active?.text.includes('curl'), 3000);
  const risk = permissionStatus(dir).active;
  const answers = await Promise.all([respond(risk.id, 'decline'), respond(risk.id, 'decline')]);
  assert.equal(answers.filter(result => result.written).length, 1);
  assert.deepEqual(herdr.keys, [['Enter'], ['Down', 'Down', 'Enter']]);
  assert.equal(permissionStatus(dir).latest.answer, 'decline');
});

test('local proof refuses expansion ambiguity, symlinks, broad deletion and foreign paths', t => {
  const f = fixture(t), task = f.job(null);
  const scratch = join(task, 'scratchpad');
  fs.mkdirSync(scratch);
  fs.symlinkSync(dirname(f.home), join(scratch, 'link'));
  for (const command of ['rm -f $S/*.png', `rm -f ${scratch}/*.png`, `S=${scratch}; rm -f $S/*.png`])
    assert.equal(permissionProof(command, { task, variable: scratch }), 'task scratchpad');
  for (const command of ['rm -f $OTHER/*.png', 'rm -f $S/*.png; git push', `rm -f ${scratch}/link/*.png`, 'rm -f /tmp/*.png',
    'rm -rf $S', 'rm -f $S/../*.png', 'rm -f $S/*.png\nscript', 'rm -f /home/synthetic/.local/bin/*.png'])
    assert.equal(permissionProof(command, { task, variable: scratch }), undefined, command);
  assert.equal(permissionProof('rm -f $S/*.png', { task, variable: undefined }), undefined);
});

test('decision timeout or malformed response falls back; valid model reason may veto', async t => {
  const f = fixture(t);
  for (const decide of [async () => ({ failure: 'timeout' }), async () => { throw Error('unavailable'); }, async () => ({ result: { answers: [] } })]) {
    assert.equal((await classifyPermission(f.home, 'scratchpad', decide)).action, 'approve');
    assert.equal((await classifyPermission(f.home, undefined, decide)).action, 'main');
  }
  const modelChoice = choice => async (_home, _settings, key, input) => {
    assert.equal(key, 'worker-permission');
    assert.equal(input.page.text, '');
    const probabilities = Object.fromEntries(input.choices[0].choices.map(({ value }) => [value, value === choice ? 1 : 0]));
    return { result: { provider: 'anthropic', answers: [{ name: 'permission', kind: 'choice', choice, probabilities, confidence: 1 }] } };
  };
  assert.match((await classifyPermission(f.home, 'scratchpad', modelChoice('irreversible'))).reason, /^Decision model:.*not proven reversible/);
  assert.equal((await classifyPermission(f.home, undefined, modelChoice('approve'))).action, 'main');
});

test('native approval layouts pin one-time action and reject stale, wrapped and trust controls', () => {
  assert.equal(parsePermissionPrompt(prompt('rm -f $S/*.png', 2), 'claude').selected, 1);
  assert.equal(parsePermissionPrompt(prompt('rm -f $S/*.png', 2), 'claude').options[1].value, undefined);
  assert.equal(parsePermissionPrompt(prompt('rm -f $S/*.png\n   more args'), 'claude').command, undefined);
  assert.equal(parsePermissionPrompt(`${prompt('git push')}\n❯ Fresh input`, 'claude'), null);
  assert.equal(parsePermissionPrompt('Is this a project you created or one you trust?\n❯ 1. Yes\n2. No\nEsc to cancel', 'claude'), null);
  const codex = 'Would you like to run the following command?\n$ git push\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel';
  assert.deepEqual(parsePermissionPrompt(codex, 'codex').options.map(option => option.value), ['approve', 'decline']);
  const pi = 'Command approval required\nCommand: rm -f $S/*.png\n❯ 1. Allow once\n2. Decline\nEnter to select · Esc to cancel';
  assert.equal(parsePermissionPrompt(pi, 'pi').command, 'rm -f $S/*.png');
});