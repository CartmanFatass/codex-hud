import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openPreview } from '../../dist/worker/preview.js';
import { finishReport } from '../../dist/worker/tools.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { cliState, cliToken, fixture, taskCall, taskJob, taskRpc, until, writeCliRole } from '../helpers/thin-mcp-harness.mjs';

const sample = 'design sample.html';

async function setup(t, { preview, worktree = false } = {}) {
  const f = await fixture(t);
  const oldSettings = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = f.env.HUD_SETTINGS_PATH;
  t.after(() => {
    if (oldSettings === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = oldSettings;
  });
  const cwd = worktree ? initRepo(f.root) : f.root;
  if (worktree) {
    fs.chmodSync(f.env.HUD_HOME, 0o700);
    fs.appendFileSync(join(f.env.HOME, '.grok', 'trusted_folders.toml'), `\n[folders.${JSON.stringify(cwd)}]\ntrusted = true\n`);
  }
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'preview-test', 20, true);
  await f.startCliSocket();
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const args = { role: 'preview-test', task: 'Synthetic preview job.', cwd, ...(preview && { preview }),
    ...(worktree && { isolation: 'worktree' }) };
  const task = await taskCall(rpc, 'hud_create', args);
  const { job: id, task_dir: dir } = taskJob(f, task);
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  assert.equal(job.dispatch_exit_code, 0, job.stderr_tail);
  await until(() => cliState(dir)?.agent_session_id, t.signal);
  const copy = join(cwd, 'tmp', 'preview', id, sample);
  const finish = (text, opener, metadata) => finishReport({ dir, job }, cliToken(dir), text, metadata, opener);
  const ready = async (taskId = task.taskId) => {
    f.push(id, 'done');
    await until(() => cliState(dir)?.state === 'closed', t.signal);
    const done = await rpc('tasks/get', { taskId });
    assert.equal(done.status, 'completed', done.statusMessage);
    return done.result.content[0].text;
  };
  return { f, rpc, dir, job, copy, finish, ready };
}

test('declared previews copy outside a worktree and open once per rewrite (WSL and Linux)', async t => {
  const { copy, dir, f, rpc, job, finish, ready } = await setup(t, { preview: sample, worktree: true });
  const source = join(job.cwd, sample);
  const contents = '<p>Synthetic HTML sample</p>\n';
  const writeSample = text => {
    fs.writeFileSync(source, text);
    git(job.cwd, 'add', '--', sample);
    git(job.cwd, 'commit', '-qm', 'Synthetic preview', '--', sample);
  };
  writeSample(contents);
  const commands = [], conversions = [];
  const launch = async (...args) => { commands.push(args); };
  const windows = 'C:\\Synthetic Preview\\design sample.html';
  const convert = path => { conversions.push(path); return windows; };
  const wsl = path => openPreview(path, true, launch, convert);
  assert.equal(fs.existsSync(copy), false);
  await finish('Synthetic report with preview.', wsl);
  assert.equal(fs.readFileSync(copy, 'utf8'), contents);
  assert.deepEqual(conversions, [copy]);
  assert.deepEqual(commands, [['explorer.exe', [windows]]]);
  await finish('Another report without a preview rewrite.', wsl);
  assert.equal(commands.length, 1);

  await until(() => cliState(dir)?.state === 'working', t.signal);
  const followup = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Update the synthetic sample.' });
  const updated = contents.replace('sample', 'revision');
  writeSample(updated);
  await finish('Updated synthetic report.', path => openPreview(path, false, async (...args) => {
    await launch(...args);
    throw new Error('Synthetic opener failure');
  }, convert));
  assert.equal(fs.readFileSync(copy, 'utf8'), updated);
  assert.deepEqual(conversions, [copy]);
  assert.deepEqual(commands, [['explorer.exe', [windows]], ['xdg-open', [copy]]]);
  assert.ok((await ready(followup.taskId)).includes(`Preview: ${copy} (could not open in the default browser)`));
  const { digest } = await f.call('hud_read', { job: job.job });
  assert.equal(digest.preview_path, copy);
  assert.equal(digest.preview_error, 'could not open in the default browser');
});

test('Open previews off still copies a preview declared by the worker', async t => {
  const { f, copy, finish, job, ready } = await setup(t);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ openPreviews: false }));
  const contents = '<p>Synthetic HTML sample</p>';
  fs.writeFileSync(join(job.cwd, sample), contents);
  const launch = t.mock.fn();
  await finish('Synthetic report with a preview.', launch, { preview: sample });
  assert.equal(fs.readFileSync(copy, 'utf8'), contents);
  assert.equal(launch.mock.callCount(), 0);
  assert.ok((await ready()).includes(`Preview: ${copy}`));
});

test('missing previews are named in the notice without copying or opening', async t => {
  const { f, copy, finish, job, ready } = await setup(t, { preview: sample });
  const launch = t.mock.fn();
  await finish('Synthetic report without its preview.', launch);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(launch.mock.callCount(), 0);
  const message = `Preview missing: ${sample}`;
  assert.ok((await ready()).includes(message));
  const { digest } = await f.call('hud_read', { job: job.job });
  assert.equal(digest.preview_path, undefined);
  assert.equal(digest.preview_error, message);
});
