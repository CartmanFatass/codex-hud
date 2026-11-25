import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, cliState, runSonic, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { isProcAlive } from '../../dist/utils/proc.js';
import { startSessionWatch } from '../../dist/cli/watch.js';
import { monitorSonic, sonicLimitDefaults } from '../../dist/mcp/sonic-policy.js';

const workerTools = new URL('../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url).href;
function setSonicRole(f, overrides) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  writeFixtureFile(join(f.env.HUD_HOME, 'roles', 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run: [{ harness: 'pi', pi_role: 'sonic' }], ...overrides,
  }));
}

test('a quiet sonic causes no watcher ticks; killing its runner triggers a scan without an exit file', async (t) => {
  const probe = `import fs from 'node:fs'; import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/hud-watch.mjs')) {
  const home = process.env.HUD_HOME, connect = net.createConnection, lstat = fs.lstatSync;
  net.createConnection = (path, ...args) => {
    const socket = connect(path, ...args);
    if (path.startsWith('\\0myhud-runner-')) socket.once('connect', () => fs.writeFileSync(home + '/connected', 'yes'));
    return socket;
  };
  fs.lstatSync = (path, ...args) => {
    if (path === home + '/jobs') fs.appendFileSync(home + '/scans', Date.now() + '\\n');
    return lstat(path, ...args);
  };
  syncBuiltinESMExports();
}`;
  const f = await fixture(t, { watcherTickMs: 60, probe: `process.env.NODE_OPTIONS += ' --import=' + ${JSON.stringify('data:text/javascript,' + encodeURIComponent(probe))}` });
  f.overrideBin('pi', '#!/bin/sh\nexec sleep 120\n');
  const { task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic quiet query.' });
  const scans = () => fs.readFileSync(join(f.env.HUD_HOME, 'scans'), 'utf8').trim().split('\n').map(Number);
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'connected')), t.signal);
  await new Promise(resolve => setTimeout(resolve, 150)); // Let dispatch file events drain.
  const before = scans().length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(scans().length, before, 'five former slow ticks without a scan');
  const killed = Date.now();
  process.kill(cliState(dir).pid, 'SIGKILL');
  await until(() => cliState(dir).state === 'failed', t.signal);
  assert.ok(scans()[before] - killed < 1000, 'runner death wakes the watcher within one second');
  const status = cliState(dir);
  assert.equal(status.exit_reason, 'sonic runner exited without an exit receipt');
  assert.equal(status.runner_exit_signal, 'SIGKILL');
  assert.equal(status.runner_exit_code, null);
  assert.equal(status.stderr_tail, '');
  assert.equal(status.output_written, false);
  assert.equal(fs.existsSync(join(dir, 'sonic-exit.json')), false);
});

test('an aborted sonic records a parent restart and recovers only assistant text after launcher exit', async t => {
  const f = await fixture(t, { watcherTickMs: 250 });
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic parent.' });
  const publishParent = started_at => writeFixtureFile(join(parent.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(parent.task_dir), started_at }));
  publishParent(new Date(Date.now() - 10000).toISOString());
  f.overrideBin('pi', `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const entry = (role, content) => JSON.stringify({ type: 'message', message: { role, content, stopReason: 'aborted' } });
console.error('x'.repeat(4000) + 'Synthetic failure detail.');
writeFileSync(process.env.HUD_JOB_DIR + '/sonic-session.jsonl', [entry('user', 'Task'), entry('assistant', [
  { type: 'text', text: 'First finding.' }, { type: 'thinking', thinking: 'Not report text' }, { type: 'text', text: 'Second finding.' }
]), entry('toolResult', 'Not a finding'), '{'].join('\\n'));
setInterval(() => {}, 10000);
`);
  // The CLI launcher exits before we kill the runner: its exit callback cannot supply this signal.
  const launch = await runSonic(f, 'start', parent.task_dir, '--task', 'Synthetic query.');
  assert.equal(launch.status, 0, launch.stderr);
  const dir = join(f.env.HUD_HOME, 'jobs', launch.stdout.trim());
  await until(() => fs.existsSync(join(dir, 'sonic-session.jsonl')), t.signal);
  publishParent(new Date().toISOString());
  process.kill(cliState(dir).pid, 'SIGTERM');
  await until(() => cliState(dir)?.state === 'failed', t.signal);
  const status = cliState(dir);
  assert.match(status.exit_reason, /parent session restarted/);
  assert.equal(status.runner_exit_signal, 'SIGTERM');
  assert.equal(status.runner_exit_code, null);
  assert.ok(status.stderr_tail.endsWith('Synthetic failure detail.\n') && status.stderr_tail.length < status.stderr_bytes);
  assert.equal(status.output_written, true);
  assert.equal(fs.readFileSync(join(dir, 'report.md'), 'utf8'), '# Partial sonic report\n\nFirst finding.\n\nSecond finding.\n');
  assert.equal(fs.statSync(join(dir, 'report.md')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(dir, 'done.json')), false);
});

// Model-free pi stand-in. Its TERM-resistant detached grandchild is not in the runner's group.
test('the headless deadline fails the query, preserves partial output and reaps verified descendants', async (t) => {
  // Backdating STATUS below must be noticed within the test window even if its rename event is missed.
  const f = await fixture(t, { watcherTickMs: 250 });
  const max_s = 60;
  setSonicRole(f, { check_s: 120, stall_s: 120, max_s });
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready"); process.disconnect()'],
  { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
await once(child, 'message');
console.log('synthetic partial output'); console.error('synthetic diagnostic');
writeFileSync(join(process.env.HUD_JOB_DIR, 'report.md'), 'Partial result');
const processes = join(process.env.HUD_JOB_DIR, 'processes');
writeFileSync(processes + '.tmp', JSON.stringify([process.pid, child.pid]));
renameSync(processes + '.tmp', processes);
`);
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic long query.' });
  const processes = join(dir, 'processes');
  await until(() => fs.existsSync(processes), t.signal);
  const working = cliState(dir), pids = [working.pid, ...JSON.parse(fs.readFileSync(processes))];
  assert.ok(pids.every(pid => isProcAlive(pid)));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ ...working, started_at: new Date(Date.now() - max_s * 1000 - 1).toISOString() }));
  await until(() => cliState(dir).state === 'failed', t.signal);
  const status = cliState(dir);
  assert.equal(status.exit_reason, 'timeout');
  assert.equal(status.output_written, true);
  assert.ok(status.stdout_bytes > 0 && status.stderr_bytes > 0);
  assert.ok(pids.every(pid => !isProcAlive(pid)));
  assert.equal((await f.call('hud_read', { job })).reason, 'timeout');
  // This killed process never persisted a pi session. Replay its partial report, not the event log.
  f.overrideBin('pi', `#!${process.execPath}
if (!process.argv.includes('--print')) process.exit(1);
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: process.argv.at(-1) });
`);
  const retry = await f.call('hud_create', { role: 'sonic', retry_of: job });
  await until(() => cliState(retry.task_dir)?.state === 'closed', t.signal);
  const prompt = fs.readFileSync(join(retry.task_dir, 'report.md'), 'utf8');
  assert.match(prompt, /Synthetic long query/);
  assert.match(prompt, /\(timeout\):\nPartial result/);
  assert.doesNotMatch(prompt, /synthetic partial output/);
});

test('hud_report captures a detached helper before pi exits; settlement reaps it without a tab', async (t) => {
  const f = await fixture(t);
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
helper.unref();
writeFileSync(join(process.env.HUD_JOB_DIR, 'helper-pid'), String(helper.pid));
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: 'Synthetic helper report.' });
`);
  const { task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic query with a helper.' });
  await until(() => cliState(dir)?.state === 'closed', 25000);
  assert.equal(isProcAlive(Number(fs.readFileSync(join(dir, 'helper-pid')))), false);
  assert.equal(fs.existsSync(join(dir, 'SESSION.txt')), false);
});

test('sonic checkpoints remain readable without waking the caller or restarting pi', { timeout: 60000 }, async (t) => {
  // Advance one checkpoint only once Pi has written its tool event. Neither slow dispatch
  // nor the trip through hud_report should race a synthetic two-second policy window.
  const clock = `import { existsSync } from 'node:fs';
if (process.argv[1]?.endsWith('/sonic-run.mjs')) {
  const now = Date.now;
  Date.now = () => now() + (existsSync(process.env.HUD_JOB_DIR + '/pi-pid') ? 101000 : 0);
}`;
  const f = await fixture(t, { probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(clock))}` });
  const defaults = (await f.call('hud_roster', { detail: true })).roles.find(r => r.role === 'sonic');
  assert.deepEqual([defaults.check_s, defaults.stall_s, defaults.max_s], [600, 180, 1800]);
  setSonicRole(f, { check_s: 101, stall_s: 250, max_s: 400 });
  const role = (await f.call('hud_roster', { detail: true })).roles.find(r => r.role === 'sonic');
  assert.deepEqual([role.check_s, role.stall_s, role.max_s], [101, 250, 400]);
  const wakes = [];
  t.after(startSessionWatch(f.env.HUD_HOME, f.env.HERDR_PANE_ID, f.root, batch => wakes.push(...batch), 10));
  f.overrideBin('pi', `#!${process.execPath}
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const dir = process.env.HUD_JOB_DIR;
for (let i = 0; !existsSync(join(dir, 'release')); i++) {
  console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'synthetic-' + i } }));
  if (!i) writeFileSync(join(dir, 'pi-pid'), String(process.pid));
  await delay(50);
}
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: 'Finished in Pi PID ' + process.pid });
`);
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic ongoing query.' });
  const progress = join(dir, 'progress.jsonl');
  await until(() => fs.existsSync(progress) && fs.readFileSync(progress, 'utf8').includes('still working at '), t.signal);
  assert.match((await f.call('hud_peek', { job })).latest_progress.text, /^still working at \d+ s: tool read$/);
  const pid = Number(fs.readFileSync(join(dir, 'pi-pid')));
  assert.equal(cliState(dir).state, 'working');
  assert.ok(isProcAlive(pid));
  writeFixtureFile(join(dir, 'release'), '');
  await f.call('hud_wait', { jobs: [job], wait_ms: 60000 });
  assert.equal(cliState(dir).state, 'closed');
  assert.equal(fs.readFileSync(join(dir, 'report.md'), 'utf8'), `Finished in Pi PID ${pid}`);
  await until(() => wakes.some(line => line.includes(job) && line.includes('closed')), t.signal);
  assert.ok(wakes.every(line => !line.includes('still working at ')));
  assert.match((await f.call('hud_read', { job })).latest_progress.text, /^still working at \d+ s: tool read$/);
});

test('a running tool call with a declared timeout holds the stall and loop checks until it ends or times out', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sonic-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = Date.now();
  const output = join(root, 'stdout.jsonl');
  const event = (type, id, args) => JSON.stringify({ type, toolCallId: id, toolName: 'bash', args }) + '\n';
  const check = monitorSonic(root, sonicLimitDefaults, started);
  fs.writeFileSync(output, event('tool_execution_start', 'synthetic-1', { command: 'make check', timeout: 1200 }));
  fs.utimesSync(output, new Date(started), new Date(started + 10000));
  assert.deepEqual(check(started + 400000), {});
  assert.ok(check(started + 600000).progress);
  assert.ok(check(started + 1200000).progress);
  assert.deepEqual(check(started + 1209999), {});
  assert.deepEqual(check(started + 1210000), { stop: 'stalled' });
  // Once the call ends, the ordinary stall window applies again.
  const after = monitorSonic(root, sonicLimitDefaults, started);
  fs.appendFileSync(output, event('tool_execution_end', 'synthetic-1', {}));
  fs.utimesSync(output, new Date(started), new Date(started + 20000));
  assert.deepEqual(after(started + 199999), {});
  assert.deepEqual(after(started + 200000), { stop: 'stalled' });
  // A call without a declared timeout gets its tool tree ended once, then stops as stalled if it repeats.
  fs.writeFileSync(output, event('tool_execution_start', 'synthetic-2', { command: 'find .' }));
  fs.utimesSync(output, new Date(started), new Date(started + 30000));
  const plain = monitorSonic(root, sonicLimitDefaults, started);
  assert.deepEqual(plain(started + 209999), {});
  assert.deepEqual(plain(started + 210000), { killTool: true, progress: 'ended a silent tool after 180 s: bash' });
  assert.deepEqual(plain(started + 389999), {});
  assert.deepEqual(plain(started + 390000), { stop: 'stalled' });
  // Once that call ends, a silent model with no running tool stalls, and a new silent call gets one kill.
  const recovered = monitorSonic(root, sonicLimitDefaults, started);
  assert.deepEqual(recovered(started + 210000), { killTool: true, progress: 'ended a silent tool after 180 s: bash' });
  fs.appendFileSync(output, event('tool_execution_end', 'synthetic-2', {}));
  fs.utimesSync(output, new Date(started), new Date(started + 215000));
  assert.deepEqual(recovered(started + 394999), {});
  assert.deepEqual(recovered(started + 395000), { stop: 'stalled' });
  fs.writeFileSync(output, event('tool_execution_start', 'synthetic-2', { command: 'find .' }));
  fs.utimesSync(output, new Date(started), new Date(started + 30000));
  const nextCall = monitorSonic(root, sonicLimitDefaults, started);
  assert.deepEqual(nextCall(started + 210000), { killTool: true, progress: 'ended a silent tool after 180 s: bash' });
  fs.appendFileSync(output, event('tool_execution_end', 'synthetic-2', {}) + event('tool_execution_start', 'synthetic-3', { command: 'grep -r x .' }));
  fs.utimesSync(output, new Date(started), new Date(started + 215000));
  assert.deepEqual(nextCall(started + 395000), { killTool: true, progress: 'ended a silent tool after 180 s: bash' });
});

test('a silent running tool tree is ended while the sonic pi process continues and settles', { timeout: 60000 }, async (t) => {
  const clock = `import { existsSync } from 'node:fs';
if (process.argv[1]?.endsWith('/sonic-run.mjs')) {
  const now = Date.now;
  Date.now = () => now() + (existsSync(process.env.HUD_JOB_DIR + '/tool-ready') ? ${sonicLimitDefaults.stall_s * 1000 + 1000} : 0);
}`;
  const f = await fixture(t, {
    watcherTickMs: 250,
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(clock))}`,
  });
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.HUD_JOB_DIR;
const child = spawn(process.execPath, ['-e', \`
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready"); process.disconnect()'],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  grandchild.once('message', () => {
    process.send(grandchild.pid);
    process.disconnect();
  });
  setInterval(() => {}, 1000);
\`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const [grandchildPid] = await once(child, 'message');
writeFileSync(join(dir, 'pids.json'), JSON.stringify({ pi: process.pid, child: child.pid, grandchild: grandchildPid }));
console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'silent-tool-1', toolName: 'bash', args: { command: 'find /' } }));
writeFileSync(join(dir, 'tool-ready'), '');
const [code, signal] = await once(child, 'exit');
console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'silent-tool-1', toolName: 'bash', isError: true }));
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: 'Recovered in Pi PID ' + process.pid + ' after ' + (signal || code) });
`);
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic silent tool query.' });
  await until(() => cliState(dir)?.state === 'closed', t.signal);
  const pids = JSON.parse(fs.readFileSync(join(dir, 'pids.json'), 'utf8'));
  assert.equal(isProcAlive(pids.child), false);
  assert.equal(isProcAlive(pids.grandchild), false);
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), new RegExp(`^Recovered in Pi PID ${pids.pi} after SIG(TERM|KILL)$`));
  const progressLines = fs.readFileSync(join(dir, 'progress.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(progressLines.some(row => row.source === 'checkpoint' && /^ended a silent tool after 18\d s: bash$/.test(row.text)));
  assert.match((await f.call('hud_read', { job })).latest_progress.text, /^ended a silent tool after 18\d s: bash$/);
});

test('a default checkpoint counts worker milestones but not its own progress or a reread of an old target', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sonic-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = Date.now();
  const output = join(root, 'stdout.jsonl'), progress = join(root, 'progress.jsonl');
  const call = offset => JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'synthetic.md', offset } }) + '\n';
  const milestone = (s, text, source) => JSON.stringify({ at: new Date(started + s * 1000).toISOString(), text, source }) + '\n';
  const check = monitorSonic(root, sonicLimitDefaults, started);
  fs.writeFileSync(output, call(1));
  fs.utimesSync(output, new Date(started), new Date(started + 550000));
  assert.deepEqual(check(started + 599999), {});
  const first = check(started + 600000);
  assert.deepEqual(first, { progress: 'still working at 10 min: tool read' });
  fs.writeFileSync(progress, milestone(600, first.progress, 'checkpoint') + milestone(1175, 'Synthetic new finding.'));
  const second = check(started + 1200000);
  assert.deepEqual(second, { progress: 'still working at 20 min: Synthetic new finding.' });
  fs.appendFileSync(progress, milestone(1200, second.progress, 'checkpoint'));
  assert.deepEqual(check(started + 1355000), { stop: 'stalled' });
  // A shorter window shows why stdout growth alone can't get a query past checkpoints.
  fs.writeFileSync(output, call(5));
  fs.utimesSync(output, new Date(started), new Date(started + 1500000));
  const loop = monitorSonic(root, { check_s: 3, stall_s: 5, max_s: 20 }, started + 1500000);
  assert.ok(loop(started + 1503000).progress);
  fs.appendFileSync(output, call(9));
  fs.utimesSync(output, new Date(started), new Date(started + 1505000));
  assert.deepEqual(loop(started + 1506000), { stop: 'looping' });
});

test('Sonic bounds threshold compaction from its start, not from its last retry, and clears the bound on end', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sonic-compaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Date.now(), stdout = join(dir, 'stdout.jsonl');
  const emit = (type, seconds, reason) => {
    fs.appendFileSync(stdout, JSON.stringify({ type, reason }) + '\n');
    fs.utimesSync(stdout, new Date(started), new Date(started + seconds * 1000));
  };
  const check = monitorSonic(dir, { check_s: 60, stall_s: 10, max_s: 600 }, started);
  emit('compaction_start', 58, 'threshold');
  assert.deepEqual(check(started + 60000), { progress: 'still working at 1 min: pi threshold compaction' });
  emit('auto_retry_start', 67);
  assert.deepEqual(check(started + 67999), {});
  assert.deepEqual(check(started + 68000), { stop: 'pi threshold compaction did not finish within 10 s' });
  // An end already in the log at the deadline wins, even when read in the same batch as the start.
  emit('compaction_end', 68, 'threshold');
  assert.deepEqual(check(started + 68000), {});
  const replay = monitorSonic(dir, sonicLimitDefaults, started);
  assert.deepEqual(replay(started + 248000), { stop: 'stalled' });
});

const compactionFailure = `pi overflow compaction did not finish within ${sonicLimitDefaults.stall_s} s`;
for (const reason of ['looping', 'stalled', compactionFailure]) {
  test(`sonic stops as ${reason} and preserves its last progress in the digest`, { timeout: 60000 }, async (t) => {
    // Advance the stalled runner's clock only after Pi logs its first event, which
    // follows hud_progress. Real startup must not race a synthetic inactivity window.
    const clock = `import { statSync } from 'node:fs';
if (process.argv[1]?.endsWith('/sonic-run.mjs')) {
  const now = Date.now, stdout = process.env.HUD_JOB_DIR + '/stdout.jsonl';
  Date.now = () => now() + (statSync(stdout, { throwIfNoEntry: false })?.size ? ${sonicLimitDefaults.stall_s * 1000 + 1} : 0);
}`;
    const f = await fixture(t, {
      // Settlement must also complete if the watch misses the runner's stop-receipt rename.
      watcherTickMs: 250,
      probe: reason !== 'looping' ? `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(clock))}` : '',
    });
    if (reason === 'looping') setSonicRole(f, { check_s: 4, stall_s: 8, max_s: 20 });
    if (reason === compactionFailure) setSonicRole(f, { run: [{
      harness: 'pi', pi_role: 'sonic', model: 'anthropic/claude-haiku-5-5', thinking: 'max',
    }] });
    f.overrideBin('pi', `#!${process.execPath}
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_progress', { message: 'Synthetic partial milestone.' });
const log = () => console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'done-1', toolName: 'read', args: { path: 'synthetic.md' } }));
${reason === compactionFailure ? `
if (!process.argv.includes('--print') || !process.argv.includes('anthropic/claude-haiku-5-5')) process.exit(2);
console.log(JSON.stringify({ type: 'compaction_start', reason: 'overflow' }));` : 'log();'}
${reason === 'stalled' ? "console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'done-1', toolName: 'read' }));" : ''}
setInterval(${reason === 'looping' ? 'log' : '() => {}'}, 50);
`);
    const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic interrupted query.' });
    await until(() => cliState(dir)?.state === 'failed', t.signal);
    const status = cliState(dir);
    assert.equal(status.exit_reason, reason);
    assert.ok(status.stdout_bytes > 0);
    const digest = await f.call('hud_read', { job });
    assert.equal(digest.reason, reason);
    assert.equal(digest.latest_progress.text, 'Synthetic partial milestone.');
  });
}

test('retry_of resumes the stopped Sonic history or starts fresh with the partial result', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { watcherTickMs: 250 });
  f.overrideBin('pi', `#!${process.execPath}
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--print')) process.exit(1);
const file = process.argv[process.argv.indexOf('--session') + 1], prompt = process.argv.at(-1);
const history = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const header = history ? JSON.parse(history.split('\\n')[0]) : { type: 'session', id: randomUUID(), cwd: process.cwd() };
if (history && fs.existsSync(join(process.env.HOME, 'reject-open'))) process.exit(2);
console.log(JSON.stringify(header));
if (!history) fs.writeFileSync(file, JSON.stringify(header) + '\\n');
fs.appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: prompt } }) + '\\n');
if (!fs.existsSync(join(process.env.HOME, 'retry'))) {
  console.log('Synthetic partial finding.');
  setInterval(() => {}, 10000);
} else {
  const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
  await callWorkerTool('hud_report', { text: JSON.stringify({ header, history, prompt }) });
}
`);
  const task = 'Investigate the synthetic input.';
  const source = await f.call('hud_create', { role: 'sonic', task });
  const session = join(source.task_dir, 'sonic-session.jsonl');
  await until(() => fs.existsSync(session) && fs.readFileSync(join(source.task_dir, 'stdout.jsonl'), 'utf8').includes('Synthetic partial finding.'), t.signal);
  await f.call('hud_close', { job: source.job });
  assert.equal(cliState(source.task_dir).state, 'stopped');
  const original = fs.readFileSync(session, 'utf8'), id = JSON.parse(original.split('\n')[0]).id;
  assert.equal(fs.statSync(session).mode & 0o777, 0o600);
  writeFixtureFile(join(f.env.HOME, 'retry'), '');
  const retry = async key => {
    const job = await f.call('hud_create', { role: 'sonic', retry_of: source.job, request_key: key });
    await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
    const report = JSON.parse(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
    assert.deepEqual(receipt.sessions, [{ harness: 'pi', id: report.header.id, path: join(job.task_dir, 'sonic-session.jsonl') }]);
    return report;
  };
  const resumed = await retry('resumed');
  assert.equal(resumed.header.id, id);
  assert.equal(resumed.history, original);
  assert.match(resumed.prompt, /^Continue; you were stopped for stopped\./);
  assert.ok(!resumed.prompt.includes(task));
  assert.equal(fs.readFileSync(session, 'utf8'), original);
  writeFixtureFile(join(f.env.HOME, 'reject-open'), '');
  for (const key of ['open-rejected', 'identity-mismatch']) {
    if (key === 'identity-mismatch') {
      fs.unlinkSync(join(f.env.HOME, 'reject-open'));
      writeFixtureFile(session, original.replace(id, 'another-session'));
    }
    const fresh = await retry(key);
    assert.notEqual(fresh.header.id, id);
    assert.equal(fresh.history, '');
    assert.ok(fresh.prompt.includes(task));
    assert.match(fresh.prompt, /Synthetic partial finding/);
  }
});

test('exit zero without hud_report is a final failure, not an idle or continuable worker', async (t) => {
  const f = await fixture(t);
  f.overrideBin('pi', '#!/bin/sh\nexit 0\n');
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic silent query.' });
  await until(() => cliState(dir).state === 'failed', t.signal);
  assert.equal(cliState(dir).exit_reason, 'pi exited without a declared report');
  assert.equal((await f.call('hud_send', { job, text: 'Again?' })).code, 'not_continuable');
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 1);
});
