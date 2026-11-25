import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { entry, fixture, publishSonic, rpcClient, sonicTask, until } from '../helpers/thin-mcp-harness.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';

const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const scouts = [{ kind: 'code', ask: 'Find the synthetic entry point.' }];
const runner = resolve('packages/hud-mcp/bin/workflow-runner.mjs');
async function waitScout(f, target, signal) {
  const root = join(f.env.HUD_HOME, 'jobs');
  let scout;
  await until(() => fs.readdirSync(root).some(id => {
    const file = join(root, id, 'job.json');
    if (!fs.existsSync(file)) return false;
    const job = read(file);
    if (job.parent_job !== target.job || job.dispatch_exit_code !== 0) return false;
    scout = job; return true;
  }), signal);
  return scout;
}

test('watcher adopts the killed inline prewalk, binds the live scout and launches exactly one reserved target', { timeout: 30000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  sonicTask(f);
  const target = await f.call('hud_create', { role: 'imp', task: 'Implement synthetic example.', scouts });
  const run = () => read(join(home, 'flows', `${target.job}.json`));
  const scout = await waitScout(f, target, t.signal), { pid, host } = run();
  assert.equal(host, 'mcp'); assert.equal(run().steps.target.state, 'waiting');
  assert.ok(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HUD_HOME=${home}`));
  process.kill(pid, 'SIGKILL'); await f.stopMcp();
  await until(() => run().host === 'detached' && run().pid !== pid, t.signal);
  const adopted = run().pid;
  execFileSync(process.execPath, [runner, target.job], { cwd: f.root, env: f.env, timeout: 4000 });
  assert.equal(run().pid, adopted, 'duplicate driver lost election');
  fs.writeFileSync(join(home, 'jobs', scout.job, 'release-sonic'), '');
  await until(() => run().state === 'completed', t.signal);
  const receipt = read(join(target.task_dir, 'job.json'));
  assert.deepEqual(receipt.from_jobs, [scout.job]); assert.equal(receipt.scout_state, 'done');
  assert.equal(receipt.dispatch_exit_code, 0); assert.equal(receipt.attempts.length, 1);
  assert.deepEqual(fs.readdirSync(join(home, 'jobs')).sort(), [scout.job, target.job].sort());
  assert.equal(f.commands().filter(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start' && c.args.includes(target.task_dir)).length, 1);
});

test('closing MCP stdin leaves the live scout adoptable across restart', { timeout: 30000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  sonicTask(f);
  const target = await f.call('hud_create', { role: 'imp', task: 'Implement after reconnecting.', scouts });
  const run = () => read(join(home, 'flows', `${target.job}.json`));
  const scout = await waitScout(f, target, t.signal), scoutDir = join(home, 'jobs', scout.job);
  const { pid } = run();
  assert.equal(run().host, 'mcp');
  assert.equal(run().steps.scouts.state, 'running');
  assert.equal(read(join(scoutDir, 'STATUS.json')).state, 'working');
  assert.deepEqual(await f.stopMcp(), { forced: false, result: [0, null] });
  assert.equal(run().state, 'working');
  assert.equal(run().steps.target.state, 'waiting');
  assert.equal(read(join(scoutDir, 'STATUS.json')).state, 'working');

  const restarted = spawn(process.execPath, [entry], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(restarted, 'exit'), rpc = rpcClient(restarted);
  f.onCleanup(() => stopChild(restarted, exited, { closeStdin: true }));
  const lookup = await rpc('tools/call', { name: 'hud_read', arguments: { job: target.job } });
  assert.equal(JSON.parse(lookup.result.content[0].text).state, 'working');
  await until(() => run().host === 'detached' && run().pid !== pid, t.signal);
  fs.writeFileSync(join(scoutDir, 'release-sonic'), '');
  await until(() => run().state === 'completed', t.signal);
  const receipt = read(join(target.task_dir, 'job.json'));
  assert.deepEqual(receipt.from_jobs, [scout.job]);
  assert.equal(receipt.attempts.length, 1);
  assert.equal(f.commands().filter(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start' && c.args.includes(target.task_dir)).length, 1);
  assert.deepEqual(fs.readdirSync(join(home, 'jobs')).sort(), [scout.job, target.job].sort());
});

test('queued prewalk uses the same template and a stop from another host never starts its target', { timeout: 30000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  sonicTask(f);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, impOverflow: false, roleCaps: { imp: 1 } }));
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const first = await f.call('hud_create', { role: 'imp', task: 'Hold the synthetic slot.' });
  const target = await f.call('hud_create', { role: 'imp', task: 'Wait for the synthetic slot.', scouts });
  assert.equal(target.queued, true);
  publishSonic(first.task_dir, { state: 'done' });
  const scout = await waitScout(f, target, t.signal);
  const run = () => read(join(home, 'flows', `${target.job}.json`));
  assert.equal(run().host, 'watcher'); assert.equal(run().template, 'prewalk');
  const closed = await f.call('hud_close', { job: target.job });
  assert.equal(closed.last_line, 'stopping scouted dispatch');
  await until(() => run().state === 'stopped', t.signal);
  assert.equal(read(join(target.task_dir, 'STATUS.json')).exit_reason, 'scouted dispatch stopped');
  assert.equal(read(join(target.task_dir, 'job.json')).prewalk[0].result, 'stopped');
  assert.equal(run().steps.target.state, 'cancelled');
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')));
  assert.notEqual(read(join(home, 'jobs', scout.job, 'STATUS.json')).state, 'working');
});
