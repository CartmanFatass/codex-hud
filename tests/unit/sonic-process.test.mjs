import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, cliState, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { isProcAlive } from '../../dist/utils/proc.js';
import { startSessionWatch } from '../../dist/cli/watch.js';
import { monitorSonic, sonicLimitDefaults } from '../../dist/mcp/sonic-policy.js';

const workerTools = new URL('../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url).href;
function setLimits(f, limits) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  writeFixtureFile(join(f.env.HUD_HOME, 'roles', 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run: [{ harness: 'pi', pi_role: 'sonic' }], ...limits,
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
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'connected')));
  await new Promise(resolve => setTimeout(resolve, 150)); // Let dispatch file events drain.
  const before = scans().length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(scans().length, before, 'five former slow ticks without a scan');
  const killed = Date.now();
  process.kill(cliState(dir).pid, 'SIGKILL');
  await until(() => cliState(dir).state === 'failed');
  assert.ok(scans()[before] - killed < 1000, 'runner death wakes the watcher within one second');
  assert.equal(cliState(dir).exit_reason, 'sonic runner exited without an exit receipt');
  assert.equal(fs.existsSync(join(dir, 'sonic-exit.json')), false);
});

// Model-free pi stand-in. Its TERM-resistant detached grandchild is not in the runner's group.
test('the headless deadline fails the query, preserves partial output and reaps verified descendants', async (t) => {
  // Backdating STATUS below must be noticed within the test window even if its rename event is missed.
  const f = await fixture(t, { watcherTickMs: 250 });
  const max_s = 60;
  setLimits(f, { check_s: 120, stall_s: 120, max_s });
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
  await until(() => fs.existsSync(processes));
  const working = cliState(dir), pids = [working.pid, ...JSON.parse(fs.readFileSync(processes))];
  assert.ok(pids.every(pid => isProcAlive(pid)));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ ...working, started_at: new Date(Date.now() - max_s * 1000 - 1).toISOString() }));
  await until(() => cliState(dir).state === 'failed');
  const status = cliState(dir);
  assert.equal(status.exit_reason, 'timeout');
  assert.equal(status.output_written, true);
  assert.ok(status.stdout_bytes > 0 && status.stderr_bytes > 0);
  assert.ok(pids.every(pid => !isProcAlive(pid)));
  assert.equal((await f.call('hud_read', { job })).reason, 'timeout');
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

test('sonic checkpoints reach the caller and keep the original pi process running', async (t) => {
  const f = await fixture(t);
  const defaults = (await f.call('hud_roster', { detail: true })).roles.find(r => r.role === 'sonic');
  assert.deepEqual([defaults.check_s, defaults.stall_s, defaults.max_s], [600, 180, 1800]);
  setLimits(f, { check_s: 2, stall_s: 5, max_s: 12 });
  const role = (await f.call('hud_roster', { detail: true })).roles.find(r => r.role === 'sonic');
  assert.deepEqual([role.check_s, role.stall_s, role.max_s], [2, 5, 12]);
  const lines = [];
  t.after(startSessionWatch(f.env.HUD_HOME, f.env.HERDR_PANE_ID, f.root, batch => lines.push(...batch), 10));
  f.overrideBin('pi', `#!${process.execPath}
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const dir = process.env.HUD_JOB_DIR;
writeFileSync(join(dir, 'pi-pid'), String(process.pid));
for (let i = 0; !existsSync(join(dir, 'release')); i++) {
  console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'synthetic-' + i } }));
  await delay(50);
}
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: 'Finished in Pi PID ' + process.pid });
`);
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic ongoing query.' });
  const pidFile = join(dir, 'pi-pid');
  await until(() => fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile));
  await until(() => lines.some(line => line.startsWith(`[sonic ${job}] still working at `) && line.endsWith(': tool read')));
  assert.equal(cliState(dir).state, 'working');
  assert.ok(isProcAlive(pid));
  writeFixtureFile(join(dir, 'release'), '');
  await until(() => cliState(dir).state === 'closed');
  assert.equal(fs.readFileSync(join(dir, 'report.md'), 'utf8'), `Finished in Pi PID ${pid}`);
  assert.match((await f.call('hud_read', { job })).latest_progress.text, /^still working at \d+ s: tool read$/);
});

test('a default checkpoint counts worker milestones but not its own progress or a reread of an old target', async (t) => {
  const f = await fixture(t);
  const started = Date.now();
  const output = join(f.root, 'stdout.jsonl'), progress = join(f.root, 'progress.jsonl');
  const call = offset => JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'synthetic.md', offset } }) + '\n';
  const milestone = (s, text, source) => JSON.stringify({ at: new Date(started + s * 1000).toISOString(), text, source }) + '\n';
  const check = monitorSonic(f.root, sonicLimitDefaults, started);
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
  const loop = monitorSonic(f.root, { check_s: 3, stall_s: 5, max_s: 20 }, started + 1500000);
  assert.ok(loop(started + 1503000).progress);
  fs.appendFileSync(output, call(9));
  fs.utimesSync(output, new Date(started), new Date(started + 1505000));
  assert.deepEqual(loop(started + 1506000), { stop: 'looping' });
});

for (const reason of ['looping', 'stalled']) {
  test(`sonic stops as ${reason} and preserves its last progress in the digest`, async (t) => {
    // Settlement must also complete if the watch misses the runner's stop-receipt rename.
    const f = await fixture(t, { watcherTickMs: 250 });
    setLimits(f, reason === 'looping' ? { check_s: 4, stall_s: 8, max_s: 20 } : { check_s: 12, stall_s: 4, max_s: 20 });
    f.overrideBin('pi', `#!${process.execPath}
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_progress', { message: 'Synthetic partial milestone.' });
const log = () => console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'synthetic.md' } }));
log();
setInterval(${reason === 'looping' ? 'log' : '() => {}'}, 50);
`);
    const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic interrupted query.' });
    await until(() => cliState(dir).state === 'failed');
    const status = cliState(dir);
    assert.equal(status.exit_reason, reason);
    assert.ok(status.stdout_bytes > 0);
    assert.equal((await f.call('hud_read', { job })).latest_progress.text, 'Synthetic partial milestone.');
  });
}

test('exit zero without hud_report is a final failure, not an idle or continuable worker', async (t) => {
  const f = await fixture(t);
  f.overrideBin('pi', '#!/bin/sh\nexit 0\n');
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic silent query.' });
  await until(() => cliState(dir).state === 'failed');
  assert.equal(cliState(dir).exit_reason, 'pi exited without a declared report');
  assert.equal((await f.call('hud_send', { job, text: 'Again?' })).code, 'not_continuable');
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 1);
});
