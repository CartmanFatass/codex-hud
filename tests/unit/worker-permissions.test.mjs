import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

async function syntheticHerdr(t, f, holdSubscribe) {
  const endpoint = join(dirname(f.home), 'permissions.sock');
  const sockets = new Set(), subscribers = new Set(), keys = [];
  let reads = 0, state = 'working', visible = '', afterRead, sendMode = 'ok';
  let subscribeAck, tabProbes = 0, tabPresent = true;
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
        case 'events.subscribe':
          subscribers.add(socket);
          result = { type: 'subscribed' };
          if (holdSubscribe) { subscribeAck = () => socket.write(JSON.stringify({ id, result }) + '\n'); return; }
          break;
        case 'tab.get':
          tabProbes++;
          if (!tabPresent) return socket.write(JSON.stringify({ id, error: { code: 'tab_not_found' } }) + '\n');
          result = { tab: { tab_id: params.tab_id } }; break;
        case 'pane.get':
          if (state === 'missing') return socket.write(JSON.stringify({ id, error: { code: 'pane_not_found' } }) + '\n');
          result = { pane: { pane_id: params.pane_id, launch_id: 'launch', terminal_id: 'terminal', agent: 'claude', agent_status: state } }; break;
        case 'pane.read':
          reads++; assert.equal(params.source, 'visible'); result = { read: { text: visible } };
          if (afterRead !== undefined) { visible = afterRead; afterRead = undefined; }
          break;
        case 'pane.send_keys':
          assert.equal(params.pane_id, pane); keys.push(params.keys);
          if (sendMode === 'lost') return socket.destroy();
          if (sendMode === 'hold') return;
          result = { type: 'ok' }; break;
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
  return { endpoint, keys, reads: () => reads, update,
    subscribeAck: () => subscribeAck, tabProbes: () => tabProbes, hideTab: () => { tabPresent = false; },
    changeAfterRead: text => { afterRead = text; }, sendMode: mode => { sendMode = mode; } };
}

async function permissionWorker(t, { holdSubscribe = false } = {}) {
  const f = fixture(t);
  const herdr = await syntheticHerdr(t, f, holdSubscribe);
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
  const rows = () => readThinJobRows(f.home, { project: null, pane: main });
  const wait = check => until(check, 3000);
  const unblocked = async () => {
    herdr.update('working', 'No native prompt');
    await wait(() => !permissionStatus(dir).active);
  };
  return { f, herdr, dir, scratch, job, env, rows, wait, unblocked, startWatch: (extra = '') => f.start(preload + extra) };
}

test('initial subscribe ack reconciles a missing tab without revisiting an answered prompt', { timeout: 15000 }, async t => {
  const { f, herdr, dir, scratch, startWatch } = await permissionWorker(t, { holdSubscribe: true });
  const tabJob = f.job({ state: 'working' });
  writeFixtureFile(join(tabJob, 'SESSION.txt'), `TAB=synthetic-tab\nHERDR_SOCKET_PATH=${herdr.endpoint}\n`);
  herdr.update('blocked', prompt(`S=${scratch}; rm -f $S/*.png`));
  startWatch("process.env.HUD_WATCH_CLI_CHECK_MS = '60000';");
  await until(() => herdr.subscribeAck() && herdr.tabProbes() > 0 && permissionStatus(dir).active?.outcome === 'answered', t.signal);
  const approved = permissionStatus(dir).active;
  const reads = herdr.reads();

  herdr.hideTab(); // No close event: the failed job below confirms the ack triggered tab reconciliation.
  herdr.subscribeAck()();
  await until(() => JSON.parse(fs.readFileSync(join(tabJob, 'STATUS.json'), 'utf8')).exit_reason === 'tab closed', t.signal);
  assert.equal(herdr.reads(), reads);
  assert.deepEqual(permissionStatus(dir).active, approved);
  assert.deepEqual(herdr.keys, [['Enter']]);

  herdr.update('missing'); // A real pane lookup miss still retires the active entry, without erasing history.
  await until(() => !permissionStatus(dir).active, t.signal);
  assert.deepEqual(permissionStatus(dir).latest, approved);
  assert.deepEqual(herdr.keys, [['Enter']]);
});

test('one watcher pass approves only the proven worker cleanup; restart, handoff and gone are safe', { timeout: 15000 }, async t => {
  const { f, herdr, dir, scratch, job, env, rows, wait, unblocked, startWatch } = await permissionWorker(t);
  const safe = prompt(`S=${scratch}; rm -f $S/*.png`);
  herdr.update('blocked', safe);
  const watch = startWatch();
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
  const autoRows = rows();
  assert.equal(autoRows[0].blocked, false);
  setDisplayConfig({ theme: 'none' });
  const card = () => readThinJobs(f.home, { project: null, pane: main }).flatMap(lane => lane.workers)[0];
  assert.equal(card().homeNeedsHuman, false);
  assert.match(workInspectorRows(card(), 120, Date.now()).map(row => row.text).join('\n'), /Permission approved.*rm -f/);

  await stopChild(watch.child, watch.exited);
  startWatch();
  await wait(() => permissionStatus(dir).active?.action === 'main');
  assert.match(jobChanges(autoRows, rows()).join('\n'), /stayed blocked.*Open pane/);
  assert.deepEqual(herdr.keys, [['Enter']]);

  await unblocked();
  herdr.update('blocked', safe);
  await wait(() => herdr.keys.length === 2 && permissionStatus(dir).active?.outcome === 'answered');
  assert.notEqual(permissionStatus(dir).active.id, approved.id);
  await unblocked();
  herdr.update('blocked', prompt('git push'));
  await until(() => permissionStatus(dir).active?.action === 'main', 3000);
  const pending = permissionStatus(dir).active;
  assert.equal(pending.outcome, 'pending');
  assert.equal(herdr.keys.length, 2);
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
  assert.equal(herdr.keys.length, 2);

  herdr.update('blocked', prompt('curl -X POST https://example.invalid', 1));
  await until(() => permissionStatus(dir).active?.text.includes('curl'), 3000);
  const risk = permissionStatus(dir).active;
  const answers = await Promise.all([respond(risk.id, 'decline'), respond(risk.id, 'decline')]);
  assert.equal(answers.filter(result => result.written).length, 1);
  assert.deepEqual(herdr.keys, [['Enter'], ['Enter'], ['Down', 'Down', 'Enter']]);
  assert.equal(permissionStatus(dir).latest.answer, 'decline');
});

test('unproven targets, nested headings and menu changes go to main without sending a key', { timeout: 15000 }, async t => {
  const { herdr, dir, scratch, rows, wait, unblocked, startWatch } = await permissionWorker(t);
  fs.writeFileSync(join(dir, 'original-reference.png'), 'synthetic original');
  const safe = `S=${scratch}; rm -f $S/*.png`;
  startWatch();
  for (const [command, replacement, manual] of [
    ['rm -f $S/*.png', undefined, false],
    [`rm -f ${dir}/*.png`, undefined, false],
    [`preview line\n   Bash command\n   ${safe}`, undefined, true],
    [safe, prompt(safe, 2), true],
    [safe, prompt(safe).replace('3. No', '3. Decline'), true],
    [safe, 'Partially clipped menu', true],
  ]) {
    if (replacement) herdr.changeAfterRead(replacement);
    herdr.update('blocked', prompt(command));
    await wait(() => permissionStatus(dir).active?.action === 'main');
    const entry = permissionStatus(dir).active;
    assert.deepEqual(herdr.keys, [], command);
    const notice = jobChanges([], rows()).join('\n');
    assert.match(notice, /worker permission/);
    assert.match(notice, manual ? /Open pane/ : /hud_respond/);
    if (replacement) assert.match(entry.reason, /changed.*no key was sent/);
    await unblocked();
  }
});

for (const mode of ['lost', 'hold']) {
  test(`a reflow is never answered again after ${mode === 'lost' ? 'a lost reply' : 'restart with a send in flight'}`, { timeout: 10000 }, async t => {
    const { herdr, dir, scratch, rows, wait, startWatch } = await permissionWorker(t);
    const safe = `S=${scratch}; rm -f $S/*.png`;
    herdr.sendMode(mode);
    herdr.update('blocked', prompt(safe));
    const watch = startWatch();
    await wait(() => herdr.keys.length === 1);
    if (mode === 'hold') {
      watch.child.kill('SIGKILL');
      await watch.exited;
      assert.equal(permissionStatus(dir).latest.outcome, 'sending');
    } else {
      await wait(() => permissionStatus(dir).latest?.outcome === 'uncertain');
    }
    const spent = permissionStatus(dir).latest;
    herdr.sendMode('ok');
    // Still a match for the local safety proof, but the changed rendering produces a different fingerprint.
    herdr.update('blocked', prompt(`S=${scratch}; rm -f \${S}/*.png`));
    if (mode === 'hold') startWatch();
    await wait(() => permissionStatus(dir).active?.id !== spent.id && permissionStatus(dir).active?.action === 'main');
    assert.deepEqual(herdr.keys, [['Enter']]);
    assert.match(jobChanges([], rows()).join('\n'), /stayed blocked.*Open pane/);
    assert.equal(JSON.parse(fs.readFileSync(join(dir, 'permissions.json'), 'utf8')).entries[0].outcome, 'uncertain');
  });
}

test('local proof refuses expansion ambiguity, symlinks, broad deletion and foreign paths', t => {
  const f = fixture(t), task = f.job(null);
  const scratch = join(task, 'scratchpad');
  fs.mkdirSync(scratch);
  fs.symlinkSync(dirname(f.home), join(scratch, 'link'));
  for (const command of [`rm -f ${scratch}/*.png`, `S=${scratch}; rm -f $S/*.png`])
    assert.equal(permissionProof(command, { task }), 'task scratchpad');
  for (const command of ['rm -f $S/*.png', 'rm -f $OTHER/*.png', 'rm -f $S/*.png; git push', `rm -f ${scratch}/link/*.png`, 'rm -f /tmp/*.png',
    'rm -rf $S', 'rm -f $S/../*.png', 'rm -f $S/*.png\nscript', 'rm -f /home/synthetic/.local/bin/*.png'])
    assert.equal(permissionProof(command, { task }), undefined, command);
});

test('worktree cleanup requires every glob match to be recoverable from Git', t => {
  const f = fixture(t), task = f.job(null), worktree = join(dirname(f.home), 'worktree');
  fs.mkdirSync(worktree);
  const git = (...args) => execFileSync('git', args, { cwd: worktree, stdio: 'ignore' });
  git('init');
  const tracked = join(worktree, 'tracked.png');
  fs.writeFileSync(tracked, 'synthetic tracked');
  git('add', 'tracked.png');
  const proof = () => permissionProof(`rm -f ${worktree}/*.png`, { task, worktree });
  assert.equal(proof(), 'worktree (Git-tracked files)');
  fs.writeFileSync(tracked, 'synthetic unstaged change');
  assert.equal(proof(), undefined);
  git('add', 'tracked.png');
  fs.writeFileSync(join(worktree, 'original.png'), 'synthetic untracked');
  assert.equal(proof(), undefined);
  git('add', '-N', 'original.png');
  assert.equal(proof(), undefined);
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
  for (const screen of [
    prompt('preview\n   Bash command\n   rm -f $S/*.png'),
    `Bash command\n${prompt('rm -f $S/*.png')}`,
    prompt('rm -f $S/*.png').replace(' Bash command', ' Prior preview line\n   Bash command'),
  ]) {
    const ambiguous = parsePermissionPrompt(screen, 'claude');
    assert.equal(ambiguous.command, undefined);
    assert.deepEqual(ambiguous.options, []);
  }
  assert.equal(parsePermissionPrompt(`${prompt('git push')}\n❯ Fresh input`, 'claude'), null);
  assert.equal(parsePermissionPrompt('Is this a project you created or one you trust?\n❯ 1. Yes\n2. No\nEsc to cancel', 'claude'), null);
  const codex = 'Would you like to run the following command?\n$ git push\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel';
  assert.deepEqual(parsePermissionPrompt(codex, 'codex').options.map(option => option.value), ['approve', 'decline']);
  const pi = 'Command approval required\nCommand: rm -f $S/*.png\n❯ 1. Allow once\n2. Decline\nEnter to select · Esc to cancel';
  assert.equal(parsePermissionPrompt(pi, 'pi').command, 'rm -f $S/*.png');
});