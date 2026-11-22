import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startSessionWatch } from '../../dist/cli/watch.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { enableOptionalRoles, fixture, publishSonic, resultValue, sonicTask, taskCall, taskJob, taskRpc, until, workerClient } from '../helpers/thin-mcp-harness.mjs';

const receipt = (dir) => JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
const brief = (dir) => fs.readFileSync(join(dir, 'brief.md'), 'utf8');
const jobsDir = (f) => join(f.env.HUD_HOME, 'jobs');
async function getScout(f, parent) {
  let scout;
  await until(() => scout = fs.readdirSync(jobsDir(f)).map((id) => join(jobsDir(f), id)).find((dir) =>
    fs.existsSync(join(dir, 'job.json')) && receipt(dir).parent_job === parent && receipt(dir).dispatch_exit_code !== null), 25000);
  return scout;
}
const waitLaunch = (job) => until(() => receipt(job.task_dir).dispatch_exit_code !== null, 25000);
const scoutQuestion = 'Where is the synthetic input parsed?';

test('scouted create returns one MCP task, shares the managed cwd and appends the settled dossier', async (t) => {
  const f = await fixture(t);
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const cwd = initRepo(f.root);
  fs.writeFileSync(join(cwd, 'input.md'), 'Synthetic input.');
  git(cwd, 'add', 'input.md');
  git(cwd, 'commit', '-m', 'Synthetic input');
  const upstream = await f.call('hud_create', { role: 'imp', task: 'Synthetic prerequisite.', cwd });
  fs.writeFileSync(join(upstream.task_dir, 'report.md'), 'Synthetic prerequisite report.');
  publishSonic(upstream.task_dir, { state: 'done' });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const args = { role: 'imp', task: 'Implement the synthetic parser.', thinking: 'low',
    cwd, isolation: 'worktree', context_files: ['input.md'], from_jobs: [upstream.job], scout: scoutQuestion };
  const task = await taskCall(rpc, 'hud_create', args);
  const target = taskJob(f, task);
  assert.match(task.statusMessage, /scouting/);
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  const scout = await getScout(f, target.job);
  const scouted = receipt(scout);
  assert.equal(scouted.role, 'sonic');
  assert.equal(scouted.thinking, 'high');
  assert.equal(scouted.thinking_source, 'default');
  assert.equal(scouted.cwd, receipt(target.task_dir).worktree.root);
  assert.deepEqual(scouted.context_files, [join(cwd, 'input.md')]);
  assert.ok(brief(scout).startsWith(scoutQuestion + '\n'));
  assert.ok(!fs.existsSync(join(scout, 'mcp-task.json')));
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')));
  assert.equal(resultValue(await taskCall(rpc, 'hud_create', args)).job, target.job);
  assert.equal(fs.readdirSync(jobsDir(f)).length, 3);

  fs.writeFileSync(join(scout, 'report.md'), 'Synthetic dossier.');
  assert.equal((await get()).status, 'working', 'writing a report alone does not settle the scout');
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')));
  fs.writeFileSync(join(scout, 'release-sonic'), '');
  await waitLaunch(target);
  assert.equal(receipt(target.task_dir).cwd, scouted.cwd);
  assert.deepEqual(receipt(target.task_dir).from_jobs, [upstream.job, scouted.job]);
  const targetBrief = brief(target.task_dir);
  const enPrefix = 'Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on.';
  assert.ok(targetBrief.includes(`${enPrefix}\n- ${scouted.job} report: ${JSON.stringify(join(scout, 'report.md'))}`));
  assert.ok(!targetBrief.includes(`${enPrefix}\n- ${upstream.job} report:`));
  assert.equal((await get()).status, 'working', 'the scout does not complete the task');
  const followUp = await taskCall(rpc, 'hud_send', { job: target.job, text: 'Synthetic scouted follow-up.' });
  assert.equal(followUp.resultType, 'complete');
  assert.equal(resultValue(followUp).sent, true);
  assert.equal((await get()).status, 'working', 'follow-up send carries on the scout task');
  fs.writeFileSync(join(target.task_dir, 'report.md'), 'Synthetic target result.');
  publishSonic(target.task_dir, { state: 'done' });
  const done = await get();
  assert.equal(done.taskId, task.taskId);
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, /Synthetic target result/);
  assert.ok(!done.result.content[0].text.includes(scouted.job));
});

test('a scout cannot ask; a failed query leaves a note and only the target notifies', async (t) => {
  const f = await fixture(t);
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const lines = [];
  t.after(startSessionWatch(f.env.HUD_HOME, f.env.HERDR_PANE_ID, f.root, (batch) => lines.push(...batch), 10));
  const target = await f.call('hud_create', { role: 'imp', task: 'Synthetic target.', scout: scoutQuestion });
  const scout = await getScout(f, target.job);
  const scouted = receipt(scout);
  const worker = workerClient(t, f, scout, '0');
  assert.equal((await worker('hud_ask', { question: 'Which synthetic parser?', default: 'A' })).isError, true);
  fs.writeFileSync(join(scout, 'fail-sonic'), '');
  fs.writeFileSync(join(scout, 'release-sonic'), '');
  await waitLaunch(target);
  assert.match(brief(target.task_dir), /^Scout failed: pi exited: 4$/m);
  assert.equal(receipt(target.task_dir).from_jobs, undefined);
  assert.equal(JSON.parse(fs.readFileSync(join(scout, 'STATUS.json'))).state, 'failed');
  assert.ok(!f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === f.env.HERDR_PANE_ID));
  fs.writeFileSync(join(target.task_dir, 'report.md'), 'Synthetic target result.');
  publishSonic(target.task_dir, { state: 'done' });
  await until(() => lines.some((line) => line.includes(target.job)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /report \| hud_read/);
  const { changes } = await f.call('hud_read', { view: 'recent' });
  assert.ok(!changes.some((line) => line.includes(scouted.job)));
});

test('an unavailable scout leaves a failure note, but sonic cannot request a scout', async (t) => {
  const f = await fixture(t);
  const invalid = await f.call('hud_create', { role: 'sonic', task: 'Synthetic scout.', scout: scoutQuestion });
  assert.equal(invalid.code, 'invalid_arguments');
  assert.ok(!fs.existsSync(jobsDir(f)));
  fs.mkdirSync(join(f.root, '.hud'));
  fs.writeFileSync(join(f.root, '.hud/project.json'), JSON.stringify({ version: 1, roles: ['imp'] }));
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({
    version: 1, projects: [{ root: f.root, registered_at: '2026-01-01T00:00:00.000Z' }],
  }));
  const target = await f.call('hud_create', { role: 'imp', task: 'Synthetic fallback.', scout: scoutQuestion });
  await waitLaunch(target);
  assert.match(brief(target.task_dir), /^Scout failed: Role sonic is not configured or is hidden in this project$/m);
  assert.equal(receipt(target.task_dir).dispatch_exit_code, 0);
  assert.deepEqual(fs.readdirSync(jobsDir(f)), [target.job]);
});

test('a scout that exceeds its time cap is closed and the target still starts', async (t) => {
  const f = await fixture(t, { probe: `
    import fs from 'node:fs';
    import { join } from 'node:path';
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { value: () => now() +
      (fs.existsSync(join(process.env.HOME, 'expire-scout')) ? 600001 : 0) });
  ` });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const target = await f.call('hud_create', { role: 'imp', task: 'Synthetic time cap.', scout: scoutQuestion });
  const scout = await getScout(f, target.job);
  fs.writeFileSync(join(f.env.HOME, 'expire-scout'), '');
  await waitLaunch(target);
  assert.match(brief(target.task_dir), /^Scout failed: timed out$/m);
  await until(() => JSON.parse(fs.readFileSync(join(scout, 'STATUS.json'))).state === 'failed', 15000);
  const status = JSON.parse(fs.readFileSync(join(scout, 'STATUS.json')));
  assert.equal(status.state, 'failed');
  assert.equal(status.exit_reason, 'timeout');
});

test('sonic reports attached via from_jobs carry the unverified-facts prefix in the brief language (EN/ZH, local and browser)', async (t) => {
  const f = await fixture(t);
  const sonic = await f.call('hud_create', { role: 'sonic', task: 'Find the synthetic entry points.' });
  await until(() => JSON.parse(fs.readFileSync(join(sonic.task_dir, 'STATUS.json'))).state === 'closed');
  const imp = await f.call('hud_create', { role: 'imp', task: 'Synthetic non-sonic upstream.' });
  fs.writeFileSync(join(imp.task_dir, 'report.md'), 'Synthetic imp report.\n');
  publishSonic(imp.task_dir, { state: 'done' });

  const enPrefix = 'Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on.';
  const zhPrefix = 'Sonic 事实：带 file:line 的未核实起点；未检查列表是它没有看的地方；凡是据此做决定的代码，请亲自阅读。';

  const enLocal = await f.call('hud_create', { role: 'imp', task: 'Implement the synthetic change.', from_jobs: [imp.job, sonic.job] });
  const enText = brief(enLocal.task_dir);
  assert.ok(enText.includes(`${enPrefix}\n- ${sonic.job} report:`));
  assert.ok(!enText.includes(`${enPrefix}\n- ${imp.job} report:`));

  const zhLocal = await f.call('hud_create', { role: 'imp', task: '实现 parser 模块的合成改动。', from_jobs: [sonic.job] });
  assert.ok(brief(zhLocal.task_dir).includes(`${zhPrefix}\n- ${sonic.job} report:`));

  enableOptionalRoles(f, 'pro');
  const zhBro = await f.call('hud_create', { role: 'pro', task: '请分析合成架构方案。', from_jobs: [sonic.job] });
  assert.ok(brief(zhBro.task_dir).includes(`${zhPrefix}\n\n### ${sonic.job} report:`));
});
