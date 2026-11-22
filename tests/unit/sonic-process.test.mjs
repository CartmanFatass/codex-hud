import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, cliState, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { SONIC_TIMEOUT_MS } from '../../dist/mcp/sonic-process.js';
import { isProcAlive } from '../../dist/utils/proc.js';

// Model-free pi stand-in. Its TERM-resistant detached grandchild is not in the runner's group.
test('the headless deadline fails the query, preserves partial output and reaps verified descendants', async (t) => {
  // Backdating STATUS below must be noticed within the test window even if its rename event is missed.
  const f = await fixture(t, { watcherTickMs: 250 });
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
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ ...working, started_at: new Date(Date.now() - SONIC_TIMEOUT_MS - 1).toISOString() }));
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
  const tools = new URL('../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url).href;
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
helper.unref();
writeFileSync(join(process.env.HUD_JOB_DIR, 'helper-pid'), String(helper.pid));
const { callWorkerTool } = await import(${JSON.stringify(tools)});
await callWorkerTool('hud_report', { text: 'Synthetic helper report.' });
`);
  const { task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic query with a helper.' });
  await until(() => cliState(dir).state === 'closed');
  assert.equal(isProcAlive(Number(fs.readFileSync(join(dir, 'helper-pid')))), false);
  assert.equal(fs.existsSync(join(dir, 'SESSION.txt')), false);
});

test('exit zero without hud_report is a final failure, not an idle or continuable worker', async (t) => {
  const f = await fixture(t);
  f.overrideBin('pi', '#!/bin/sh\nexit 0\n');
  const { job, task_dir: dir } = await f.call('hud_create', { role: 'sonic', task: 'Synthetic silent query.' });
  await until(() => cliState(dir).state === 'failed');
  assert.equal(cliState(dir).exit_reason, 'pi exited without a declared report');
  assert.equal((await f.call('hud_send', { job, text: 'Again?' })).code, 'not_continuable');
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 1);
});
