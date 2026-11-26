import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { withDistLock } from '../../scripts/dist-lock.mjs';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { bindSourceTab, checkout, job, jobDir, repair, settle } from '../helpers/thin-mcp-land.mjs';

test('red gate continues the source in grace with clean assertion evidence; its rebased fix passes', async t => {
  const f = await checkout(t, [`grep fixed tracked || {
cat <<'TAP'
not ok 1 - sees the fix
  ---
  location: 'sample.test.mjs:1:1'
  error: |-
    synthetic assertion: expected fix
    首页 ?1  项目  控制
    synthetic panel row
    \x1b[32m   \x1b[0m
  code: 'ERR_ASSERTION'
  ...
TAP
seq 50
exit 1
}`]);
  bindSourceTab(t, f);
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  fs.writeFileSync(join(f.main, 'upstream'), 'new base');
  f.git(f.main, 'add', 'upstream'); f.git(f.main, 'commit', '-qm', 'advance base');
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  const prompt = f.commands().find(({ args }) => args[0] === 'agent' && args[1] === 'prompt').args.at(-1);
  assert.match(prompt, /Rebase onto the current base base/);
  const evidence = prompt.split('Log tail:\n').at(-1).trimEnd();
  assert.match(evidence, /^not ok 1 - sees the fix[\s\S]*synthetic assertion: expected fix[\s\S]*ERR_ASSERTION/);
  assert.doesNotMatch(evidence, /^\s*$|synthetic panel row|首页|^50$/m);
  const [rerun] = f.flowState(flow).reruns;
  assert.deepEqual(rerun.tests, ['sees the fix (sample.test.mjs)']);
  for (const path of [rerun.output_path, rerun.rerun_output_path]) assert.equal(fs.readFileSync(path, 'utf8'), evidence);
  f.git(f.worktree, 'rebase', 'base'); fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.repairs[0].outcome, 'gate passed');
  assert.equal(done.changes.length, 1); assert.match(done.changes[0], /Repair 1: .*gate passed/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});

for (const ask of [false, true]) test(`a CLI land repair ignores pre-turn attention and ${ask ? 'hands back its new question' : 'lands its fresh report'}`, async t => {
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const stat = fs.statSync;
fs.statSync = (path, ...args) => {
  if (String(path).endsWith('/${job}/STATUS.json') && new Error().stack.includes('at repairLand ')) {
    fs.appendFileSync(process.env.HOME + '/repair-polls', 'poll\\n');
  }
  return stat(path, ...args);
};
syncBuiltinESMExports();`;
  const f = await checkout(t, ['grep fixed tracked'], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  const dir = jobDir(f), jobFile = join(dir, 'job.json'), statusFile = join(dir, 'STATUS.json');
  writeFixtureFile(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile)),
    cli: { agent: 'claude', can_continue: true, idle_grace_s: 60 } }));
  bindSourceTab(t, f);
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic previous report.');
  const previous = new Date(Date.now() - 60000);
  writeFixtureFile(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: previous.toISOString(), report_sig: null }));
  writeFixtureFile(statusFile, JSON.stringify({ state: 'idle_grace' }));
  // Admission sees a settled source. Hold back the new status so land's first poll sees an old attention row.
  writeFixtureFile(`${statusFile}.previous`, JSON.stringify({ state: 'waiting_orchestrator', blocked: true, updated_at: previous.toISOString() }));
  fs.utimesSync(`${statusFile}.previous`, previous, previous);
  f.overrideBin('herdr', `#!/bin/sh
set -e
if [ "$1 $2 $3" = 'agent prompt source-agent' ]; then
  status="$HUD_HOME/jobs/${job}/STATUS.json"
  mv "$status.previous" "$status"
fi
exec node "$FAKE_BIN" herdr "$@"
`);
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'turn.json'))).seq, 2);
  const polls = join(f.env.HOME, 'repair-polls');
  // Two polls prove the first one already ignored the unchanged pre-turn row.
  await until(() => fs.existsSync(polls) && fs.readFileSync(polls, 'utf8').startsWith('poll\npoll\n'), t.signal);
  assert.equal(f.flowState(flow).state, 'running', JSON.stringify(f.flowState(flow)));
  if (ask) {
    fs.mkdirSync(join(dir, 'qa'));
    writeFixtureFile(join(dir, 'qa/q1.md'), 'Which synthetic version?');
  } else {
    fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
    f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  if (ask) {
    assert.equal(done.state, 'failed');
    assert.equal(done.error, `${job} needs the main session: q1`);
  } else {
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  }
});

async function isolatedLand(t, gate) {
  // Publish to a private installation so the real dist and other test processes are untouched.
  const install = fs.mkdtempSync(join(tmpdir(), 'hud-land-build-'));
  let f;
  cleanupFixture(t, { root: install }, () => f?.stopMcp());
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(install, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(install, 'node_modules'));
  f = await checkout(t, gate, { mcpEntry: join(install, 'packages/hud-mcp/bin/hud-mcp.mjs') });
  const dist = join(install, 'dist');
  const publish = (files) => withDistLock(() => {
    for (const [name, content] of Object.entries(files)) {
      const file = join(dist, name);
      fs.writeFileSync(`${file}.next`, content);
      fs.renameSync(`${file}.next`, file);
    }
    const now = new Date(); fs.utimesSync(join(dist, 'index.js'), now, now);
  }, install, { exclusive: true });
  return { ...f, dist, publish };
}

test('land repairs using its original modules after dist is rebuilt during the gate', async t => {
  const f = await isolatedLand(t, ['while test ! -f "$HOME/release"; do sleep .05; done; grep fixed tracked']);
  bindSourceTab(t, f);
  fs.writeFileSync(join(jobDir(f), 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  // The old lazy repair path imported thin-main here, but abstract-lock was already cached.
  const read = (name) => fs.readFileSync(join(f.dist, name), 'utf8');
  await f.publish({
    'utils/abstract-lock.js': read('utils/abstract-lock.js') + '\nexport const newBuildOnly = true;\n',
    'mcp/thin-main.js': read('mcp/thin-main.js') + "\nimport { newBuildOnly } from '../utils/abstract-lock.js';\nif (!newBuildOnly) throw Error('mixed build');\n",
  });
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  assert.equal(await repair(f, flow, 0), job);
  fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  assert.equal(f.flowState(flow).state, 'completed', JSON.stringify(f.flowState(flow)));
  assert.equal(f.flowState(flow).repairs[0].outcome, 'gate passed');
});

test('a land helper that cannot import its build leaves a retryable flow', async t => {
  const f = await isolatedLand(t, ['true']);
  const entry = 'mcp/land-runner.js', original = fs.readFileSync(join(f.dist, entry), 'utf8');
  await f.publish({ [entry]: original + "\nimport { missingAfterBuild } from '../utils/abstract-lock.js';\n" });
  const { flow } = await f.call('hud_land', { job });
  const failed = await f.call('hud_read', { job: flow });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'load land helper');
  assert.equal(failed.error, 'HUD was rebuilt; retry the land');
  assert.equal(f.git(f.main, 'rev-parse', 'base'), f.base_head);
  await f.publish({ [entry]: original });
  const retry = await f.call('hud_land', { job });
  assert.notEqual(retry.flow, flow);
  await until(() => ['failed', 'completed'].includes(f.flowState(retry.flow).state), 15000);
  assert.equal(f.flowState(retry.flow).state, 'completed', JSON.stringify(f.flowState(retry.flow)));
});

test('a red gate resumes the closed source session in its managed checkout', async t => {
  const f = await checkout(t, ['grep fixed tracked || { echo repair-needed; exit 1; }']);
  const dir = jobDir(f), file = join(f.env.PI_CODING_AGENT_DIR, 'synthetic.jsonl');
  const id = 'synthetic-land-session', now = new Date().toISOString();
  writeFixtureFile(file, JSON.stringify({ type: 'session', id, cwd: f.worktree }) + '\n');
  const jobFile = join(dir, 'job.json');
  const source = JSON.parse(fs.readFileSync(jobFile));
  writeFixtureFile(jobFile, JSON.stringify({ ...source, reaped_at: now, resume_s: 1620,
    place: { harness: 'pi', pi_role: 'implementer' } }));
  await bindSourceTab(t, f).exit();
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic original report.');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true,
    exit_reason: 'closed after declared report', settled_at: now, ended_at: now, session_id: id, session_file: file }));
  const { flow } = await f.call('hud_land', { job });
  assert.equal(await repair(f, flow, 0), job);
  const cmds = f.commands();
  assert.ok(cmds.find(({ args }) => args[0] === 'agent' && args[1] === 'start').args.includes(file));
  assert.ok(cmds.find(({ args }) => args[0] === 'tab' && args[1] === 'create').args.includes(f.worktree));
  const receipt = JSON.parse(fs.readFileSync(jobFile));
  assert.deepEqual(receipt.worktree, source.worktree);
  assert.equal(receipt.send_outcomes.at(-1).resumed, true);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'))).session_id, id);
  fs.appendFileSync(join(f.worktree, 'tracked'), 'fixed\n');
  f.git(f.worktree, 'commit', '-qam', 'repair'); settle(f, job, 'Fixed.');
  await until(() => f.flowState(flow).state === 'completed', 15000);
  assert.equal(f.flowState(flow).repairs[0].outcome, 'gate passed');
});

test('a persistently red gate creates same-role repairs and hands back once after two', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/count"; seq 50; exit 7']);
  // The role and the original context come from the registered main checkout, not the worker's copy.
  fs.mkdirSync(join(f.main, '.hud/roles'));
  fs.writeFileSync(join(f.main, '.hud/roles/builder.json'), JSON.stringify({ role: 'builder', can_continue: true,
    instructions: 'implementer', run: [{ harness: 'pi', pi_role: 'implementer' }] }));
  const source = join(jobDir(f), 'job.json');
  const original = JSON.parse(fs.readFileSync(source));
  const objective = { id: 'delivery', title: 'Synthetic delivery' };
  fs.writeFileSync(source, JSON.stringify({ ...original, objective, role: 'builder', context_files: [join(f.main, 'tracked')],
    create_options: { ...original.create_options, thinking: 'high' } }));
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  let prior = job;
  for (const i of [0, 1]) {
    const id = await repair(f, flow, i), dir = jobDir(f, id);
    const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
    assert.equal(receipt.role, 'builder'); assert.equal(receipt.retry_of, prior); assert.equal(receipt.cwd, f.worktree);
    assert.deepEqual(receipt.context_files, [join(f.main, 'tracked')]);
    assert.deepEqual(receipt.objective, objective);
    assert.equal(receipt.thinking, 'high', 'land repair retains internal placement options');
    assert.match(fs.readFileSync(join(dir, 'brief.md'), 'utf8'), /Log tail:\n11\n[\s\S]*50/);
    settle(f, id, `Attempt ${i}.`); prior = id;
  }
  await until(() => f.flowState(flow).state === 'failed', 15000);
  const done = await rpc('tasks/get', { taskId: flow });
  assert.match(done.result.content[0].text, /gate\[1\].*exit 7\nRepair 1:[^\n]+\nRepair 2:[^\n]+\ngate\[1\][\s\S]*\n11\n[\s\S]*50$/);
  const paths = f.flowState(flow).reruns.flatMap(({ rerun_ok, output_path, rerun_output_path }) => {
    assert.equal(rerun_ok, false);
    return [output_path, rerun_output_path];
  });
  assert.equal(paths.length, 6);
  assert.equal(new Set(paths).size, 6);
  for (const path of paths) assert.equal(fs.readFileSync(path, 'utf8'), Array.from({ length: 40 }, (_, i) => i + 11).join('\n'));
  assert.equal(fs.readFileSync(join(f.env.HOME, 'count'), 'utf8'), 'run\n'.repeat(6));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
});

test('cherry-pick conflict goes to the repair worker; even a quickly answered question stops the land', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'tracked'), 'conflict\n'); f.git(f.main, 'commit', '-qam', 'conflict');
  const { flow } = await f.call('hud_land', { job });
  const id = await repair(f, flow, 0), dir = jobDir(f, id);
  assert.match(fs.readFileSync(join(dir, 'brief.md'), 'utf8'), /cherry-pick[\s\S]*CONFLICT/);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Which version?'); fs.writeFileSync(join(dir, 'qa/q1.answer.md'), 'Keep both.');
  settle(f, id, 'Answered.');
  await until(() => f.flowState(flow).state === 'failed', 15000);
  const done = f.flowState(flow); assert.match(done.error, /needs the main session: q1/); assert.equal(done.repairs.length, 1);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
});
