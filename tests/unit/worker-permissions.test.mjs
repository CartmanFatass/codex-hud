import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { jobChanges, readThinJobRows, readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { collectWorkSummary } from '../../dist/collectors/work-summary-snapshot.js';
import { classifyPermission, provePermission } from '../../dist/mcp/permission-policy.js';
import { claimPermissionNotice, parsePermissionPrompt, permissionStatus } from '../../dist/mcp/worker-permissions.js';
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
const filePrompt = (heading, question, extra = '') => `╭─────────────────╮\n ${heading}\n${extra ? `\n${extra}\n` : ''}\n ${question}\n ❯ 1. Yes\n   2. Yes, allow all edits during this session\n   3. No\n\n Esc to cancel\n╰─────────────────╯\n`;

async function syntheticHerdr(t, f, holdSubscribe, opts = {}) {
  const endpoint = join(dirname(f.home), 'permissions.sock');
  const sockets = new Set(), subscribers = new Set(), keys = [], prompts = [];
  let reads = 0, state = 'working', visible = '', afterRead, sendMode = 'ok', promptMode = opts.promptMode ?? 'ok';
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
        case 'ping': result = { type: 'pong', version: '1.0-hud', ...(opts.guardedPrompt ? { capabilities: { guarded_prompt: true } } : {}) }; break;
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
        case 'agent.prompt':
          prompts.push({ mode: promptMode, target: params.target, text: params.text });
          if (promptMode === 'draft_present' || promptMode === 'not_ready') return socket.write(JSON.stringify({ id, error: { code: promptMode } }) + '\n');
          if (promptMode === 'indeterminate') return socket.end();
          result = { type: 'agent_prompted' }; break;
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
  return { endpoint, keys, prompts, reads: () => reads, update,
    subscribeAck: () => subscribeAck, tabProbes: () => tabProbes, hideTab: () => { tabPresent = false; },
    changeAfterRead: text => { afterRead = text; }, sendMode: mode => { sendMode = mode; },
    promptMode: mode => { promptMode = mode; } };
}

async function permissionWorker(t, opts = {}) {
  const f = fixture(t);
  const herdr = await syntheticHerdr(t, f, opts.holdSubscribe, opts);
  const worktree = opts.withWorktree ? join(dirname(f.home), 'worktree') : undefined;
  if (worktree) fs.mkdirSync(worktree, { recursive: true });
  const dir = f.job(null, { role: 'imp', created_at: new Date().toISOString(), cwd: opts.jobCwd ?? worktree ?? dirname(f.home), herdr_pane: main,
    ...(worktree ? { worktree: { root: worktree } } : {}),
    cli: { agent: 'claude', can_continue: true, idle_grace_s: 600 }, ticket_queue: 'synthetic-run' });
  const scratch = join(dir, 'scratchpad');
  fs.mkdirSync(scratch);
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  const temp = opts.withTemp ? fs.mkdtempSync(join('/tmp', `hud-perm-test-${job.job}-`)) : undefined;
  if (temp) t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  if (opts.shadowCat) fs.writeFileSync(join(worktree, 'cat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HUD_HOME: f.home, HOME: join(dirname(f.home), 'home'), HERDR_PANE_ID: main,
    HERDR_SOCKET_PATH: herdr.endpoint, HUD_MCP_JSON: '1' };
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
    stdio: 'ignore',
    cwd: opts.workerCwd ?? worktree ?? dirname(f.home),
    env: { ...process.env, HUD_JOB_DIR: dir, S: scratch, ...(temp ? { TMPDIR: temp } : {}),
      ...(opts.shadowCat ? { PATH: `${worktree}:${process.env.PATH}` } : {}) },
  });
  const exited = once(worker, 'exit');
  t.after(() => stopChild(worker, exited));
  await until(() => procStat(worker.pid)?.start, t.signal);
  const start = procStat(worker.pid).start;
  writeFixtureFile(join(dir, 'SESSION.txt'), `TAB=w1:t2\nLEFT=${pane}\nPRIMARY=worker\nDIRECT_EXEC=1\nLAUNCH_ID=launch\nTERMINAL_ID=terminal\nPID=${worker.pid}\nPID_START=${start}\nHERDR_SOCKET_PATH=${herdr.endpoint}\n`);
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', harness: 'cli', blocked: true, pid: worker.pid, pid_start_time: start }));
  const preload = `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(herdr.endpoint)}; globalThis.fetch = () => { throw new Error('synthetic offline'); };`;
  const rows = () => readThinJobRows(f.home, { project: null, pane: main });
  const wait = check => until(check, t.signal);
  const unblocked = async () => {
    herdr.update('working', 'No native prompt');
    await wait(() => !permissionStatus(dir).active);
  };
  return { f, herdr, dir, scratch, worktree, temp, job, env, rows, wait, unblocked, startWatch: (extra = '') => f.start(preload + extra) };
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

test('one watcher pass approves only the proven worker cleanup; restart, handoff and gone are safe', { timeout: 45000 }, async t => {
  const { f, herdr, dir, scratch, job, env, rows, wait, unblocked, startWatch } = await permissionWorker(t);
  const safe = prompt(`S=${scratch}; rm -f $S/*.png`);
  herdr.update('blocked', safe);
  const watch = startWatch();
  await until(() => permissionStatus(dir).latest?.outcome === 'answered', t.signal)
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
  let notice = '';
  const stream = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { cwd: dirname(f.home), env, stdio: ['ignore', 'pipe', 'ignore'] });
  const streamExit = once(stream, 'exit');
  stream.stdout.on('data', chunk => { notice += chunk.toString('utf8'); });
  t.after(() => stopChild(stream, streamExit));
  await wait(() => fs.existsSync(join(f.home, 'watchers', `${main}.pid`)));
  herdr.update('blocked', prompt('git push'));
  await wait(() => permissionStatus(dir).active?.action === 'main');
  const pending = permissionStatus(dir).active;
  assert.equal(pending.outcome, 'pending');
  assert.equal(herdr.keys.length, 2);
  const notices = jobChanges(autoRows, rows()).join('\n');
  assert.match(notices, /git push.*recommends.*hud_respond.*"answer":"approve"/);
  assert.equal(jobChanges(rows(), rows()).length, 0);
  assert.equal(card().homeNeedsHuman, false);
  assert.equal(card().permissionWaitingMain, true);
  assert.match(machineWorkForms(collectWorkSummary(f.home).global, Date.now())[0], /Main 1/);

  await wait(() => notice.includes('git push') && notice.includes(pending.id));
  assert.equal(notice.split(pending.id).length - 1, 2); // One notice, one action per supported option.
  assert.equal(herdr.prompts.length, 0, 'live hud watch suppresses duplicate direct permission delivery');

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
  await wait(() => permissionStatus(dir).active?.text.includes('curl'));
  const risk = permissionStatus(dir).active;
  const answers = await Promise.all([respond(risk.id, 'decline'), respond(risk.id, 'decline')]);
  assert.equal(answers.filter(result => result.written).length, 1);
  assert.deepEqual(herdr.keys, [['Enter'], ['Enter'], ['Down', 'Down', 'Enter']]);
  const declined = JSON.parse(fs.readFileSync(join(dir, 'permissions.json'), 'utf8')).entries.find(entry => entry.id === risk.id);
  assert.equal(declined?.outcome, 'answered');
  assert.equal(declined?.answer, 'decline');

  for (const [visible, reason] of [
    [`Edit file synthetic.txt\n${'x'.repeat(40_000)}\nDo you want to make this edit?\n❯ 1. Yes\n2. No\nEsc to cancel`, 'exceeds the safe parsing limit'],
    [prompt('rm -f $S/*.png').replace('Esc to cancel · Tab to amend', 'Unfamiliar footer'), 'could not safely map'],
    [filePrompt(`Edit file ${scratch}/x.ts`, 'Do you want to make this edit to /w/b/x.ts?'), 'The displayed file paths disagree'],
  ]) {
    await unblocked();
    const oldRows = rows(), before = herdr.reads();
    herdr.update('blocked', visible);
    await wait(() => permissionStatus(dir).active?.reason.includes(reason));
    const manual = permissionStatus(dir).active;
    assert.equal(manual.action, 'main');
    assert.equal(manual.outcome, 'pending');
    assert.deepEqual(manual.options, []);
    const lines = jobChanges(oldRows, rows());
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`Open pane ${pane}`), lines[0]);
    assert.doesNotMatch(lines[0], /hud_respond/);
    assert.equal((await respond(manual.id, 'approve')).code, 'option_unavailable');
    assert.equal(jobChanges(rows(), rows()).length, 0);
    await wait(() => notice.includes(reason));
    await wait(() => herdr.reads() > before + 1);
    assert.equal(notice.split(reason).length - 1, 1);
    assert.equal(permissionStatus(dir).active.id, manual.id);
    assert.deepEqual(herdr.keys, [['Enter'], ['Enter'], ['Down', 'Down', 'Enter']]);
    assert.equal(card().homeNeedsHuman, false);
    assert.equal(card().permissionWaitingMain, true);
  }

  const countdown = time => `⚠ Claude Code will automatically block this request in ${time}, to avoid holding up an unattended session`;
  const timed = time => prompt('npm run build').replace(' ❯ 1. Yes', ` ${countdown(time)}\n ❯ 1. Yes`);
  const notify = async screen => {
    await unblocked();
    herdr.update('blocked', screen);
    await wait(() => permissionStatus(dir).active?.action === 'main');
    const { id } = permissionStatus(dir).active;
    await wait(() => notice.includes(`"request_id":"${id}","answer":"approve"`));
    return id;
  };

  const id = await notify(timed('1:57'));
  // Tick after the notice and again before delivery's fresh capture.
  herdr.update('blocked', timed('1:56'));
  herdr.changeAfterRead(timed('1:55'));
  const approval = await respond(id, 'approve');
  assert.equal(approval.written, true, JSON.stringify(approval));
  assert.equal(permissionStatus(dir).active.id, id);
  assert.deepEqual(herdr.keys, [['Enter'], ['Enter'], ['Down', 'Down', 'Enter'], ['Enter']]);

  const withTrailer = (screen, time) => `${screen} ${countdown(time)}\n`;
  for (const [change, screen] of [
    ['command', prompt('npm run release')],
    ['selection', prompt('npm run build', 2)],
    ['option label', prompt('npm run build').replace('3. No', '3. Decline')],
  ]) {
    const requestId = await notify(withTrailer(prompt('npm run build'), '1:57'));
    herdr.changeAfterRead(withTrailer(screen, '1:56'));
    assert.equal((await respond(requestId, 'approve')).code, 'prompt_changed', change);
    assert.equal(herdr.keys.length, 4);
  }
});

test('an answered permission does not hide the next CLI block on the bar or panel', t => {
  const f = fixture(t), created = '2026-01-01T00:00:00.000Z';
  const dir = f.job(null, { role: 'imp', created_at: created, herdr_pane: main, cli: { agent: 'claude' } });
  const id = 'perm-0000000000000001';
  writeFixtureFile(join(dir, 'permissions.json'), JSON.stringify({ active: id, entries: [{ id, action: 'approve', outcome: 'answered',
    answer: 'approve', at: '2026-01-01T00:00:02.000Z', resolved_at: '2026-01-01T00:00:04.000Z', pane, options: [],
    reason: 'Synthetic local proof', text: 'Bash command' }] }));
  const block = blocked_at => writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({
    state: 'waiting_orchestrator', harness: 'cli', blocked: true, blocked_at, updated_at: '2026-01-01T00:00:06.000Z',
  }));
  const row = () => readThinJobRows(f.home, { pane: main })[0];
  const card = () => readThinJobs(f.home, { project: null, pane: main })[0].workers[0];
  block('2026-01-01T00:00:01.000Z');
  assert.equal(row().blocked, false);
  assert.equal(card().homeNeedsHuman, false);
  assert.equal(collectWorkSummary(f.home).global.asking, 0);

  block('2026-01-01T00:00:05.000Z');
  assert.equal(row().blocked, true);
  assert.equal(card().phase, 'asking');
  assert.equal(card().work.requestInfo.id, 'blocked');
  assert.equal(collectWorkSummary(f.home).global.asking, 1);
  assert.equal(card().permission.outcome, 'answered'); // The prior decision remains in the Inspector history.
});

test('unproven targets, nested headings and menu changes go to main without sending a key', { timeout: 45000 }, async t => {
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
  test(`a reflow is never answered again after ${mode === 'lost' ? 'a lost reply' : 'restart with a send in flight'}`, { timeout: 30000 }, async t => {
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
    assert.deepEqual(provePermission(command, { task })?.roots, ['task scratchpad']);
  for (const command of ['rm -f $S/*.png', 'rm -f $OTHER/*.png', 'rm -f $S/*.png; git push', `rm -f ${scratch}/link/*.png`, 'rm -f /tmp/*.png',
    'rm -rf $S', 'rm -f $S/../*.png', 'rm -f $S/*.png\nscript', 'rm -f /home/synthetic/.local/bin/*.png'])
    assert.equal(provePermission(command, { task }), undefined, command);
});

test('worktree cleanup requires every glob match to be recoverable from Git', t => {
  const f = fixture(t), task = f.job(null), worktree = join(dirname(f.home), 'worktree');
  fs.mkdirSync(worktree);
  const git = (...args) => execFileSync('git', args, { cwd: worktree, stdio: 'ignore' });
  git('init');
  const tracked = join(worktree, 'tracked.png');
  fs.writeFileSync(tracked, 'synthetic tracked');
  git('add', 'tracked.png');
  const proof = () => provePermission(`rm -f ${worktree}/*.png`, { task, worktree });
  assert.deepEqual(proof()?.roots, ['worktree (Git-tracked files)']);
  assert.deepEqual(provePermission(`rm -f ${worktree}/?racked.png`, { task, worktree })?.roots, ['worktree (Git-tracked files)']);
  fs.writeFileSync(join(worktree, 'index-only.txt'), 'synthetic bytes without a recovery blob');
  git('update-index', '--add', '--info-only', 'index-only.txt');
  assert.equal(provePermission(`cat ${tracked} > ${worktree}/index-only.txt`, { task, worktree }), undefined);
  fs.writeFileSync(tracked, 'synthetic unstaged change');
  assert.equal(proof(), undefined);
  git('add', 'tracked.png');
  fs.writeFileSync(join(worktree, 'original.png'), 'synthetic untracked');
  assert.equal(proof(), undefined);
  git('add', '-N', 'original.png');
  assert.equal(proof(), undefined);
});

test('decision timeout or malformed response falls back; valid model reason may veto', async t => {
  const f = fixture(t), task = f.job(null);
  const scratch = join(task, 'scratchpad');
  fs.mkdirSync(scratch);
  const verified = provePermission(`rm -f ${scratch}/*.png`, { task });
  assert.ok(verified);
  for (const decide of [async () => ({ failure: 'timeout' }), async () => { throw Error('unavailable'); }, async () => ({ result: { answers: [] } })]) {
    assert.equal((await classifyPermission(f.home, verified, decide)).action, 'approve');
    assert.equal((await classifyPermission(f.home, undefined, decide)).action, 'main');
  }
  const modelChoice = choice => async (_home, _settings, key, input) => {
    assert.equal(key, 'worker-permission');
    assert.equal(input.page.text, '');
    const probabilities = Object.fromEntries(input.choices[0].choices.map(({ value }) => [value, value === choice ? 1 : 0]));
    return { result: { provider: 'anthropic', answers: [{ name: 'permission', kind: 'choice', choice, probabilities, confidence: 1 }] } };
  };
  assert.match((await classifyPermission(f.home, verified, modelChoice('irreversible'))).reason, /^Decision model:.*not proven reversible/);
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

  const claudeEdit = filePrompt('Edit file /tmp/wt/src/app.ts', 'Do you want to make this edit to app.ts?', '   -const a = 1;\n   +const a = 2;');
  assert.deepEqual(parsePermissionPrompt(claudeEdit, 'claude').target, { kind: 'file_edit', paths: ['/tmp/wt/src/app.ts'], cwd: undefined });
  const claudeWrite = filePrompt('Create file src/new.ts', 'Do you want to create src/new.ts?');
  assert.deepEqual(parsePermissionPrompt(claudeWrite, 'claude').target, { kind: 'file_create', paths: ['src/new.ts'], cwd: undefined });
  const codexEdits = 'Would you like to make the following edits?\nCwd: /tmp/wt\nM src/a.ts (+2 -1)\nA src/b.ts\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel';
  assert.deepEqual(parsePermissionPrompt(codexEdits, 'codex').target, { kind: 'file_edit', paths: ['src/a.ts', 'src/b.ts'], cwd: '/tmp/wt' });
  const codexDelete = 'Would you like to make the following edits?\nD src/old.ts\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel';
  assert.equal(parsePermissionPrompt(codexDelete, 'codex').target, undefined);
  const piEdit = 'Edit approval required\nCwd: /tmp/wt\nFile: src/app.ts\n❯ 1. Allow once\n2. Decline\nEnter to select · Esc to cancel';
  assert.deepEqual(parsePermissionPrompt(piEdit, 'pi').target, { kind: 'file_edit', paths: ['src/app.ts'], cwd: '/tmp/wt' });
});

test('Claude accepts a basename-only question but not conflicting qualified file paths', () => {
  const parse = path => parsePermissionPrompt(filePrompt('Edit file /w/a/x.ts', `Do you want to make this edit to ${path}?`), 'claude');
  assert.deepEqual(parse('x.ts').target, { kind: 'file_edit', paths: ['/w/a/x.ts'], cwd: undefined });
  for (const path of ['/w/b/x.ts', 'a/x.ts', './x.ts']) {
    const parsed = parse(path);
    assert.equal(parsed.target, undefined, path);
    assert.match(parsed.manualReason, /file paths disagree/);
    assert.deepEqual(parsed.options, []);
  }
});

test('watcher approves recoverable edits, new files and scratch cleanup once per prompt', { timeout: 20000 }, async t => {
  const { herdr, dir, scratch, worktree, unblocked, startWatch } = await permissionWorker(t, { withWorktree: true });
  const worktreeScratch = join(worktree, 'scratchpad');
  fs.mkdirSync(join(worktreeScratch, 'out'), { recursive: true });
  fs.writeFileSync(join(worktreeScratch, 'out', 'b.txt'), 'synthetic b');
  fs.mkdirSync(join(scratch, 'out'), { recursive: true });
  fs.writeFileSync(join(scratch, 'out', 'a.png'), 'synthetic a');
  fs.mkdirSync(join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(join(worktree, 'a'), 'synthetic file');
  fs.writeFileSync(join(worktree, 'src', 'app.ts'), 'export const x = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['add', 'src/app.ts'], { cwd: worktree });
  const cases = [
    { screen: prompt(`S=${worktreeScratch}; rm -rf $S/out`), match: /Local path check: verified rm \(-r, -f\) in the job’s scratchpad/ },
    { screen: prompt(`S=${scratch}; rm -f $S/out/*.png`), match: /Local path check: verified rm \(-f, glob\) in the job’s task scratchpad/ },
    { screen: prompt(`cat a > ${dir}/new-copy.txt`), match: /Local path check: verified cat in the job’s worktree and task directory/ },
    { screen: prompt('cat a | grep synthetic | head -n 1'), match: /Local path check: verified cat, grep, head in the job’s worktree/ },
    { screen: filePrompt(`Edit file ${worktree}/src/app.ts`, 'Do you want to make this edit to app.ts?', '   -export const x = 1;\n   +export const x = 2;'), match: /Local path check: verified Edit file in the job’s worktree/ },
    { screen: filePrompt('Edit file src/app.ts', 'Do you want to make this edit to app.ts?', `Cwd: ${worktree}`), match: /Local path check: verified Edit file in the job’s worktree/ },
    { screen: filePrompt(`Create file ${worktree}/new.txt`, 'Do you want to create new.txt?'), match: /Local path check: verified Create file in the job’s worktree/ },
  ];

  herdr.update('blocked', cases[0].screen);
  startWatch();

  let expectedKeys = 0;
  for (let i = 0; i < cases.length; i++) {
    const { screen, match } = cases[i];
    if (i > 0) herdr.update('blocked', screen);
    expectedKeys++;
    await until(() => herdr.keys.length === expectedKeys && permissionStatus(dir).active?.outcome === 'answered', i === 0 ? 5000 : 3000);
    const entry = permissionStatus(dir).active;
    assert.equal(entry.action, 'approve');
    assert.match(entry.reason, match);
    assert.doesNotMatch(entry.reason, /regenerable PNG cleanup/i);
    await unblocked();
  }
  assert.deepEqual(herdr.keys, cases.map(() => ['Enter']));
});

test('milestone review blockers go to main with a recommendation and no keys', { timeout: 20000 }, async t => {
  const { herdr, dir, worktree, temp, rows, wait, unblocked, startWatch } = await permissionWorker(t, {
    withWorktree: true, withTemp: true, shadowCat: true,
  });
  fs.mkdirSync(join(worktree, 'sub'));
  fs.writeFileSync(join(worktree, 'sub', 'x'), 'synthetic key');
  fs.writeFileSync(join(temp, 'out'), 'synthetic temp');
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['add', 'sub/x'], { cwd: worktree });
  const cases = [
    prompt('git diff'),
    prompt('git log -p'),
    prompt('git status'),
    prompt('git commit -m x'),
    prompt('chmod -R 755 sub'),
    prompt('grep -r key .'),
    prompt('cd sub; rm -f x'),
    filePrompt('Edit file sub/x', 'Do you want to make this edit to x?', '   -synthetic key\n   +synthetic value'),
    prompt(`rm -f ${temp}/out`),
    prompt('cat sub/x'), // Worker PATH shadows the otherwise allowed system verb.
  ];
  herdr.update('blocked', cases[0]);
  startWatch();
  for (const [i, screen] of cases.entries()) {
    if (i > 0) herdr.update('blocked', screen);
    await wait(() => permissionStatus(dir).active?.action === 'main');
    assert.equal(permissionStatus(dir).active.outcome, 'pending', screen);
    assert.match(jobChanges([], rows()).join('\n'), /recommends.*hud_respond/, screen);
    assert.deepEqual(herdr.keys, [], screen);
    await unblocked();
  }
});

test('review findings 1–6 write pending manual entries without keys', { timeout: 25000 }, async t => {
  const { herdr, dir, scratch, worktree, rows, wait, unblocked, startWatch } = await permissionWorker(t, { withWorktree: true });
  const original = join(dir, 'ref.png');
  const outside = join(dirname(worktree), 'outside-job');
  const git = (...args) => execFileSync('git', args, { cwd: worktree });
  git('init', '-q');
  for (const folder of ['dest', 'images', 'sub', 'node_modules/.bin']) {
    fs.mkdirSync(join(worktree, folder), { recursive: true });
  }
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(worktree, 'sub', 'link'));
  fs.writeFileSync(original, 'synthetic original');
  for (const file of ['src.txt', 'dirty.txt', 'tracked.png', 'images/a.png']) {
    fs.writeFileSync(join(worktree, file), 'synthetic indexed bytes');
  }
  git('add', 'src.txt', 'dirty.txt', 'tracked.png', 'images/a.png');
  fs.writeFileSync(join(worktree, 'dirty.txt'), 'synthetic unstaged bytes');
  fs.writeFileSync(join(worktree, 'move-me.txt'), 'synthetic untracked bytes');
  fs.writeFileSync(join(worktree, 'dest', 'alias.txt'), 'synthetic untracked destination');
  fs.writeFileSync(join(worktree, 'images', 'b.png'), 'synthetic untracked image');
  fs.writeFileSync(join(worktree, 'x.js'), '// synthetic worker script\n');
  fs.writeFileSync(join(worktree, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('src.txt', join(worktree, 'alias.txt'));

  const cases = [
    // 1: recovery depends on the bytes, not the spelling of the write.
    prompt(`printf x > ${original}`),
    prompt(`cat src.txt > ${original}`),
    prompt(`ln -sf src.txt ${original}`),
    filePrompt(`Write file ${original}`, 'Do you want to overwrite ref.png?'),
    prompt('git restore dirty.txt'),
    // 2: local executable paths do not prove execution effects.
    prompt('node x.js'),
    prompt('node --test x.js'),
    prompt('cargo build'),
    prompt('cargo test'),
    prompt('npx --no-install tsc --noEmit'),
    // 3: the link name, not the referent name, selects the destination child.
    prompt('cp alias.txt dest/'),
    prompt('mv alias.txt dest/'),
    // 4: neither shell bracket negation nor malformed ranges should reach the matcher.
    prompt('rm -f images/[!a].png'),
    prompt('rm -f images/[z-a].png'),
    prompt(`rm -f ${scratch}/[z-a].png`),
    // 5: a relative variable survives cd, and a move changes the bytes a later rm sees.
    prompt('S=images; cd sub; rm -f $S/a.png'),
    prompt('mv move-me.txt tracked.png; rm -f tracked.png'),
    // 6: --files has no pattern; traversal flags can follow links inside the start directory.
    prompt(`rg --files ${outside}`),
    prompt('rg -L synthetic sub'),
    prompt('grep -R synthetic sub'),
  ];
  startWatch();
  for (const screen of cases) {
    assert.ok(parsePermissionPrompt(screen, 'claude').target, screen);
    herdr.update('blocked', screen);
    await wait(() => permissionStatus(dir).active?.action === 'main');
    assert.equal(permissionStatus(dir).active.outcome, 'pending', screen);
    assert.deepEqual(herdr.keys, [], screen);
    assert.match(jobChanges([], rows()).join('\n'), /recommends.*hud_respond/);
    await unblocked();
  }
});

test('watcher sends high-risk, escaping, sensitive, substituted and sudo prompts to main with recommendation and action', { timeout: 20000 }, async t => {
  const { herdr, dir, scratch, worktree, rows, unblocked, startWatch } = await permissionWorker(t, { withWorktree: true });
  const outside = join(dirname(worktree), 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, join(worktree, 'escape'));
  fs.symlinkSync(outside, join(worktree, 'scratchpad'));
  fs.mkdirSync(join(worktree, 'dir'), { recursive: true });
  fs.symlinkSync(join(outside, 'target.txt'), join(worktree, 'dir', 'a'));
  fs.writeFileSync(join(worktree, 'a'), 'synthetic');

  const risky = [
    prompt('git push'),
    prompt('git fetch'),
    prompt('curl -X POST https://example.invalid'),
    prompt('npm install left-pad'),
    prompt('npm run release'),
    prompt('npm run build'),
    prompt('npx tsc --noEmit'),
    prompt(`S=${worktree}/scratchpad; rm -rf $S/out`),
    prompt('test -d sub && cd sub; rm -f x'),
    prompt(`cp a ${worktree}/dir/`),
    prompt('cp a ~/.local/bin/x'),
    prompt('rm -f ~/.local/bin/x'),
    prompt(`cp a ${worktree}/escape/x`),
    filePrompt(`Edit file ${worktree}/escape/app.ts`, 'Do you want to make this edit to app.ts?'),
    filePrompt(`Edit file ${worktree}/.env`, 'Do you want to make this edit to .env?'),
    filePrompt(`Edit file ${worktree}/server.key`, 'Do you want to make this edit to server.key?'),
    filePrompt(`Edit file ${worktree}/.git/config`, 'Do you want to make this edit to config?'),
    prompt('mkdir -p $(pwd)/x'),
    prompt('mkdir -p `pwd`/x'),
    prompt(`sudo rm -rf ${scratch}/out`),
  ];

  herdr.update('blocked', risky[0]);
  startWatch();

  for (let i = 0; i < risky.length; i++) {
    if (i > 0) herdr.update('blocked', risky[i]);
    await until(() => permissionStatus(dir).active?.action === 'main', i === 0 ? 5000 : 3000);
    const entry = permissionStatus(dir).active;
    assert.equal(entry.outcome, 'pending');
    assert.deepEqual(herdr.keys, []);
    const notice = jobChanges([], rows()).join('\n');
    assert.match(notice, /recommends.*hud_respond.*"answer":"approve".*"answer":"decline"/);
    await unblocked();
  }
});

test('relative paths require verifiable cwd, never job.cwd alone', { timeout: 15000 }, async t => {
  const f = fixture(t);
  // Worker process cwd stays outside worktree even though job.cwd is worktree.
  const { herdr, dir, unblocked, startWatch } = await permissionWorker(t, { withWorktree: true, workerCwd: dirname(f.home) });
  const screens = [
    prompt('cp a b'),
    filePrompt('Edit file src/app.ts', 'Do you want to make this edit to app.ts?'),
  ];
  herdr.update('blocked', screens[0]);
  startWatch();
  for (let i = 0; i < screens.length; i++) {
    if (i > 0) herdr.update('blocked', screens[i]);
    await until(() => permissionStatus(dir).active?.action === 'main', i === 0 ? 5000 : 3000);
    assert.deepEqual(herdr.keys, []);
    await unblocked();
  }
});

test('decision model receives only structural facts without raw args or absolute paths, and cannot approve unproven prompts', async t => {
  const f = fixture(t), task = f.job(null), worktree = join(dirname(f.home), 'wt-facts');
  const scratch = join(task, 'scratchpad');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(join(worktree, 'alpha.txt'), 'synthetic');

  const proofs = [
    provePermission(`S=${scratch}; rm -rf $S/output-dir-99`, { task }),
    provePermission(`mkdir -p ${worktree}/custom-dir-77/x`, { task, worktree, cwd: worktree }),
    provePermission('cat alpha.txt && cp alpha.txt beta-output.txt', { task, worktree, cwd: worktree }),
    provePermission({ kind: 'file_edit', paths: [join(worktree, 'src', 'my-module-file.ts')] }, { task, worktree }),
  ];
  for (const proof of proofs) {
    assert.ok(proof);
    let captured;
    const decide = async (_home, _settings, key, input) => {
      assert.equal(key, 'worker-permission');
      captured = input;
      const probs = Object.fromEntries(input.choices[0].choices.map(({ value }) => [value, value === 'approve' ? 1 : 0]));
      return { result: { provider: 'anthropic', answers: [{ name: 'permission', kind: 'choice', choice: 'approve', probabilities: probs, confidence: 1 }] } };
    };
    const decision = await classifyPermission(f.home, proof, decide);
    assert.equal(decision.action, 'approve');
    const serialized = JSON.stringify(captured);
    for (const forbidden of [task, scratch, worktree, 'output-dir-99', 'custom-dir-77', 'alpha.txt', 'beta-output.txt', 'my-module-file.ts']) {
      assert.ok(!serialized.includes(forbidden), `model input leaked ${forbidden}: ${serialized}`);
    }
    assert.equal(captured.facts.verified, true);
    assert.ok(Array.isArray(captured.facts.operations) && captured.facts.operations.length > 0);
  }

  // Model "approve" without local proof MUST still go to main.
  const alwaysApprove = async (_home, _settings, _key, input) => {
    assert.equal(input.facts.verified, false);
    assert.deepEqual(input.facts.operations, []);
    const probs = Object.fromEntries(input.choices[0].choices.map(({ value }) => [value, value === 'approve' ? 1 : 0]));
    return { result: { provider: 'anthropic', answers: [{ name: 'permission', kind: 'choice', choice: 'approve', probabilities: probs, confidence: 1 }] } };
  };
  assert.equal((await classifyPermission(f.home, undefined, alwaysApprove)).action, 'main');
});

test('local proof allows confined forms and refuses unproven flags, sequences and paths', t => {
  const f = fixture(t), task = f.job(null), worktree = join(dirname(f.home), 'wt-policy');
  const scratch = join(task, 'scratchpad');
  const temp = join(dirname(f.home), 'external-temp');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(join(worktree, 'src'), { recursive: true });
  fs.mkdirSync(join(worktree, 'dest-empty'), { recursive: true });
  fs.mkdirSync(join(worktree, 'dest-symlink'), { recursive: true });
  fs.mkdirSync(join(worktree, 'dest-untracked'), { recursive: true });
  fs.mkdirSync(join(worktree, 'dest-tracked'), { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: worktree, stdio: 'ignore' });
  git('init');
  fs.writeFileSync(join(worktree, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(join(worktree, 'dest-tracked', 'a.ts'), 'export const old = 0;\n');
  git('add', 'src/a.ts', 'dest-tracked/a.ts');
  fs.writeFileSync(join(worktree, 'dest-untracked', 'a.ts'), 'untracked work\n');
  fs.symlinkSync(join(worktree, 'src', 'a.ts'), join(worktree, 'dest-symlink', 'a.ts'));
  fs.symlinkSync(join(worktree, 'dest-empty'), join(worktree, 'dir-link'));
  fs.writeFileSync(join(worktree, 'archive.tar.gz'), 'synthetic');
  fs.writeFileSync(join(worktree, 'bundle.zip'), 'synthetic');
  fs.symlinkSync(dirname(f.home), join(worktree, 'escape-link'));
  const roots = { task, worktree, cwd: worktree };
  fs.writeFileSync(join(worktree, 'src', 'linked.ts'), 'synthetic hard-linked file');
  fs.linkSync(join(worktree, 'src', 'linked.ts'), join(dirname(f.home), 'hardlink.ts'));
  fs.writeFileSync(join(temp, 'out'), 'synthetic external bytes');

  const allowed = [
    `S=${scratch}; rm -rf $S/out`,
    'mkdir -p tmp/x',
    'touch tmp/x/f',
    'cp src/a.ts tmp/x/b.ts',
    'mv src/a.ts tmp/x/c.ts',
    `cp src/a.ts ${worktree}/dest-empty/`,
    `cp src/a.ts ${worktree}/dest-tracked/`,
    `cp src/a.ts ${scratch}/`,
    `ln -s a.ts src/a-link.ts`,
    `chmod 755 src/a.ts`,
    `chmod u+x src/a.ts`,
    `tar -tf archive.tar.gz`,
    `unzip -l bundle.zip`,
    `ls -la src && cat src/a.ts | head -n 5 | wc -l`,
    `tail -n 10 src/a.ts`,
    `grep -n export src/a.ts`,
    `diff -u src/a.ts src/a.ts`,
    `cat src/a.ts > ${scratch}/copy.txt`,
    `cat src/a.ts > dest-tracked/a.ts`,
    `cat src/a.ts 2>/dev/null`,
  ];
  for (const cmd of allowed) {
    assert.ok(provePermission(cmd, roots), `expected allowed: ${cmd}`);
  }

  const denied = [
    'chmod 4755 src/a.ts',
    'chmod u+s src/a.ts',
    'chmod 755 src/linked.ts',
    'chmod --recursive 755 src',
    'chmod 755 -R src',
    'ls -R src',
    'grep -r export src',
    'grep export src',
    'rg export src',
    'rg export',
    'rg --files src',
    'rg --files',
    `find ${scratch} -name '*.png' -delete`,
    `rm -f ${temp}/out`,
    'ln -s /etc/passwd src/bad-link',
    'ln -s ../../../../etc/passwd src/bad-link',
    'ln src/a.ts src/hard-link',
    `tar -xzf archive.tar.gz -C ${scratch}`,
    `tar -xzf archive.tar.gz -C ${scratch} a.ts`,
    'tar --to-command=sh -xf archive.tar.gz -C ' + scratch,
    'tar -xzf archive.tar.gz -C /tmp',
    `unzip -q bundle.zip -d ${temp}`,
    `unzip -q bundle.zip a.ts -d ${temp}`,
    'unzip bundle.zip -d /tmp',
    `cp src/a.ts ${worktree}/dest-symlink/`,
    `cp src/a.ts ${worktree}/dest-symlink`,
    `cp -t ${worktree}/dest-symlink src/a.ts`,
    `cp src/a.ts ${worktree}/dest-untracked/`,
    `cp src/a.ts ${worktree}/dir-link/`,
    `cp src/a.ts ${worktree}/dest-symlink/a.ts`,
    'test -d src && cd src; rm -f a.ts',
    'ls src && cd src; rm -f a.ts',
    'cd src && rm -f a.ts',
    `cd ${worktree} && git status -s`,
    `ls src && S=${scratch}; rm -rf $S/out`,
    `S=${scratch}; cd ${worktree} && rm -rf $S/out`,
    `S=${scratch} && rm -rf $S/out`,
    `S=${worktree}; rm -f $S/src/a.ts`,
    `S=${scratch}; touch $S/out`,
    `S=${scratch}; rm -rf ${scratch}/out`,
    'cd src | cat',
    `S=${scratch} | cat`,
    'cat src/a.ts | wc -l; cd src; ls',
    'mkdir -p tmp/x && touch tmp/x/f',
    'touch tmp/x/f; ls tmp',
    'cat src/a.ts > new.txt; ls new.txt',
    'cat src/a.ts | head > new.txt',
    'git status',
    'git diff',
    'git log -p',
    'git status -s && git diff --stat && git log -n 5 --oneline',
    'git show HEAD',
    `git -C ${worktree} status -s`,
    'git add src/a.ts && git commit -m "synthetic fix"',
    'git add src/a.ts',
    'git commit -m "synthetic fix"',
    'git stash list',
    'git rebase main',
    'git restore src/a.ts',
    'git status --unknown',
    'git log --max-count=unknown',
    'git diff --ext-diff',
    'git show --output=out',
    'diff -r src dest-empty',
    'find src -delete',
    'find src -exec rm {} ;',
    'rg --pre sh foo src',
    'node -e "process.exit(0)"',
    'npm run build',
    'npm run release',
    'npm test',
    'npm install pkg',
    'npx tsc --noEmit',
    'npx evil-pkg',
    'cargo install ripgrep',
    'pip install requests',
    'git push',
    'git fetch',
    'git pull',
    'git clone https://example.invalid/repo.git',
    'git config user.name x',
    'git -c core.sshCommand=sh status',
    'git rebase -x sh main',
    'git stash drop',
    'curl -X POST https://example.invalid',
    'wget https://example.invalid',
    'ssh host ls',
    'scp a host:/tmp/a',
    'sudo ls',
    'eval "ls"',
    'source src/a.ts',
    'env',
    'printenv',
    'cat src/a.ts | sh',
    'cat src/a.ts | bash',
    'cat src/a.ts > /tmp/outside-file',
    'cat src/a.ts > ~/.bashrc',
    `cat ${worktree}/.env`,
    `cat ${worktree}/credentials.json`,
    `cp ${worktree}/escape-link/x src/y`,
    `rm -f ${task}/job.json`,
    `cp src/a.ts ${task}/permissions.json`,
  ];
  for (const cmd of denied) {
    assert.equal(provePermission(cmd, roots), undefined, `expected denied: ${cmd}`);
  }
  assert.equal(provePermission({ kind: 'file_edit', paths: [join(task, 'permissions.json')] }, roots), undefined);
  assert.equal(provePermission({ kind: 'file_edit', paths: [join(worktree, '.git', 'HEAD')] }, roots), undefined);
  assert.equal(provePermission({ kind: 'file_edit', paths: [join(worktree, 'escape-link', 'x.ts')] }, roots), undefined);
  assert.ok(provePermission({ kind: 'file_create', paths: [join(worktree, 'new-dir', 'sub', 'file.ts')] }, roots));
  assert.equal(provePermission({ kind: 'file_edit', paths: ['src/a.ts'] }, roots), undefined);
  assert.ok(provePermission({ kind: 'file_edit', paths: ['src/a.ts'], cwd: worktree }, roots));
});

test('narrowed proof rejects symlinked scratchpads', t => {
  const f = fixture(t), task = f.job(null);
  const worktree = join(dirname(f.home), 'wt-narrow');
  const outside = join(dirname(f.home), 'outside-owned');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(join(worktree, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(join(worktree, 'src', 'untracked.txt'), 'keep');
  fs.writeFileSync(join(outside, 'keep.txt'), 'outside');

  // Symlinked worktree/scratchpad pointing outside the job must never become a deletion root.
  fs.symlinkSync(outside, join(worktree, 'scratchpad'));
  assert.equal(provePermission(`S=${worktree}/scratchpad; rm -rf $S/out`, { task, worktree }), undefined);

  // Symlinked worktree/scratchpad pointing to a worktree subdir must not promote it to a scratchpad root.
  fs.unlinkSync(join(worktree, 'scratchpad'));
  fs.symlinkSync(join(worktree, 'src'), join(worktree, 'scratchpad'));
  assert.equal(provePermission(`S=${worktree}/scratchpad; rm -rf $S/untracked.txt`, { task, worktree }), undefined);

  // Symlinked task/scratchpad pointing outside the job must never become a deletion root.
  fs.symlinkSync(outside, join(task, 'scratchpad'));
  assert.equal(provePermission(`S=${task}/scratchpad; rm -rf $S/out`, { task, worktree }), undefined);

  // Real worktree/scratchpad stays approved.
  fs.unlinkSync(join(worktree, 'scratchpad'));
  fs.mkdirSync(join(worktree, 'scratchpad'));
  assert.deepEqual(provePermission(`S=${worktree}/scratchpad; rm -rf $S/out`, { task, worktree })?.roots, ['scratchpad']);
});

test('direct manual-permission handoff retries confirmed refusal and never repeats indeterminate send', { timeout: 20_000 }, async t => {
  const { herdr, dir, unblocked, startWatch } = await permissionWorker(t, { guardedPrompt: true, promptMode: 'draft_present' });
  herdr.update('blocked', prompt('git push'));
  startWatch();

  // 1. Confirmed refusal (draft_present) keeps the entry pending and releases its delivery claim so the watcher retries.
  await until(() => permissionStatus(dir).active?.action === 'main' && herdr.prompts.length >= 1, 8_000);
  const firstEntry = permissionStatus(dir).active;
  assert.equal(firstEntry.outcome, 'pending');
  const firstMarker = join(dir, `${firstEntry.id}.noticed`);
  assert.equal(herdr.prompts[0].target, main);
  assert.equal(herdr.prompts[0].mode, 'draft_present');
  await until(() => !fs.existsSync(firstMarker), 4_000);

  // Once main's prompt clears, the watcher retries and delivers once, keeping the marker.
  herdr.promptMode('ok');
  await until(() => herdr.prompts.some(p => p.mode === 'ok' && p.text.includes(firstEntry.id)), 8_000);
  assert.equal(fs.existsSync(firstMarker), true);
  const okCount = herdr.prompts.filter(p => p.mode === 'ok' && p.text.includes(firstEntry.id)).length;
  assert.equal(okCount, 1);
  // Subsequent scans must not repeat the delivered handoff.
  await new Promise(r => setTimeout(r, 300));
  assert.equal(herdr.prompts.filter(p => p.mode === 'ok' && p.text.includes(firstEntry.id)).length, 1);

  // 2. Indeterminate send (dropped reply after submit) keeps the claim and is never repeated.
  await unblocked();
  herdr.promptMode('indeterminate');
  herdr.update('blocked', prompt('git fetch'));
  await until(() => permissionStatus(dir).active?.action === 'main' && herdr.prompts.some(p => p.mode === 'indeterminate'), 8_000);
  const secondEntry = permissionStatus(dir).active;
  const secondMarker = join(dir, `${secondEntry.id}.noticed`);
  assert.equal(fs.existsSync(secondMarker), true, 'indeterminate manual handoff must keep its claim');
  const secondAttempts = herdr.prompts.filter(p => p.text.includes(secondEntry.id)).length;
  assert.equal(secondAttempts, 1);

  herdr.promptMode('ok');
  await new Promise(r => setTimeout(r, 700));
  assert.equal(herdr.prompts.filter(p => p.text.includes(secondEntry.id)).length, 1, 'indeterminate manual handoff must never repeat');
});

test('watcher permission hand-off uses durable per-entry claim across refusal/expiry and prunes .noticed markers with 12-entry ledger', { timeout: 25_000 }, async t => {
  // Part 1: hud watch --queue uses durable per-entry .noticed claim so a refused or expired guarded retry redelivers once (even after prev advanced).
  const f = fixture(t);
  const root = join(dirname(f.home), 'perm-watch-project');
  const bin = join(f.home, 'perm-watch-bin');
  const socketPath = join(dirname(f.home), 'perm-watch.sock');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const fake = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: 'codex', agent_status: 'idle', agent_session: { value: '00000000-0000-4000-8000-000000000008' } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else if (args[0] === 'queue') {
  console.error('no rollout found');
  process.exit(1);
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });

  let mode = 'draft_present';
  let subscription;
  const attempts = [];
  const delivered = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const lines = createInterface({ input: socket });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'ping') { socket.write(JSON.stringify({ id, result: { type: 'pong', capabilities: { guarded_prompt: true } } }) + '\n'); return; }
      if (method === 'events.subscribe') { subscription = socket; socket.write(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n'); return; }
      if (method === 'agent.prompt') {
        attempts.push(params.text);
        if (mode === 'draft_present' || mode === 'agent_not_ready') {
          socket.write(JSON.stringify({ id, error: { code: mode } }) + '\n');
          return;
        }
        if (mode === 'indeterminate') { socket.end(); return; }
        delivered.push(params.text);
        socket.write(JSON.stringify({ id, result: { type: 'agent_prompted' } }) + '\n');
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });

  const jobId = 'j00000000000008a1';
  const permId = 'perm-00000000000008a1';
  const dir = join(f.home, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({
    job: jobId, role: 'imp', cwd: root, caller_pane: main, created_at: nowIso, cli: { agent: 'claude' },
  }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'blocked', blocked: true, blocked_at: nowIso, updated_at: nowIso }));
  writeFixtureFile(join(dir, 'permissions.json'), JSON.stringify({
    active: permId,
    entries: [{
      id: permId, key: 'k1', launch: 'l1', pane, at: nowIso, text: 'Bash command\ngit push',
      action: 'main', reason: 'Risky push requires main.',
      options: [{ label: 'Yes', value: 'approve' }, { label: 'No', value: 'decline' }],
      selected: 0, outcome: 'pending',
    }],
  }));

  const env = { ...process.env, HOME: join(dirname(f.home), 'home'), HUD_HOME: f.home, HERDR_PANE_ID: main, HERDR_SOCKET_PATH: socketPath, PATH: `${bin}:${process.env.PATH}` };
  const prevCwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(prevCwd));

  const realNow = performance.now.bind(performance);
  let advance = 0;
  t.mock.method(performance, 'now', () => realNow() + advance);

  const marker = join(dir, `${permId}.noticed`);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand(['--queue'], { env, stdout: s => assert.fail(s), stderr: () => {} }, { signal: ac.signal, rescanMs: 80 });

  // 1. Guarded refusal (draft_present) holds the claim while retrying; expiry releases it so a later pass redelivers once.
  await until(() => Boolean(subscription) && attempts.length >= 1, 8_000);
  assert.equal(fs.existsSync(marker), true, 'marker is claimed while guarded retry is pending');
  assert.equal(delivered.length, 0);

  const sub = subscription;
  advance += 10 * 60_000;
  sub.write(JSON.stringify({ event: 'pane.scroll_changed', data: { pane_id: main } }) + '\n');
  await until(() => sub.destroyed, 8_000);
  assert.equal(fs.existsSync(marker), false, 'expired guarded retry must release permission .noticed marker');

  // 2. Confirmed non-send refusal (agent_not_ready) releases the claim and redelivers once prompt becomes ready.
  mode = 'agent_not_ready';
  const beforeRefusal = attempts.length;
  await until(() => attempts.length > beforeRefusal, 8_000);
  await until(() => !fs.existsSync(marker), 4_000);

  mode = 'ok';
  await until(() => delivered.length === 1, 8_000);
  assert.match(delivered[0], new RegExp(`${jobId}.*${permId}`));
  assert.equal(fs.existsSync(marker), true, 'delivered permission notice keeps its claim');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(delivered.length, 1, 'delivered permission notice must not repeat');
  ac.abort();
  assert.equal(await running, 0);

  // Part 2: .noticed markers are pruned as older entries roll off the 12-entry permissions.json ledger.
  const { herdr, dir: permDir, unblocked, startWatch } = await permissionWorker(t);
  herdr.update('blocked', prompt('git push origin b0'));
  startWatch();
  const seenIds = [];
  for (let i = 0; i < 14; i++) {
    if (i > 0) herdr.update('blocked', prompt(`git push origin b${i}`));
    await until(() => {
      const active = permissionStatus(permDir).active;
      return active?.action === 'main' && !seenIds.includes(active.id);
    }, i === 0 ? 5_000 : 3_000);
    const entry = permissionStatus(permDir).active;
    seenIds.push(entry.id);
    // Ensure each entry has a .noticed file on disk (claimed either by watch-runtime or directly).
    claimPermissionNotice(permDir, entry);
    assert.equal(fs.existsSync(join(permDir, `${entry.id}.noticed`)), true);
    await unblocked();
  }
  const ledger = JSON.parse(fs.readFileSync(join(permDir, 'permissions.json'), 'utf8'));
  assert.equal(ledger.entries.length, 12, 'ledger stays bounded to 12 entries');
  const noticedFiles = fs.readdirSync(permDir).filter(name => /^perm-[a-f0-9]{16}\.noticed$/.test(name));
  assert.ok(noticedFiles.length <= 12, `expected <= 12 .noticed markers, got ${noticedFiles.length}`);
  assert.equal(fs.existsSync(join(permDir, `${seenIds[0]}.noticed`)), false, 'evicted entry 0 marker was pruned');
  assert.equal(fs.existsSync(join(permDir, `${seenIds[1]}.noticed`)), false, 'evicted entry 1 marker was pruned');
  assert.equal(fs.existsSync(join(permDir, `${seenIds.at(-1)}.noticed`)), true, 'latest entry marker kept');
});