/** Integration of the maintainer script against dist, kept with the existing .mjs unit-runner scripts.
 * Real disk formats, shim subprocess, PanelJobPipeline and monitor; no DTO or renderer fakes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { stageEnv, ROOT, WINDOWS, windowLaunch, processStart, stop } from '../../scripts/demo-r5-jobs.mjs';
import { visualLength } from '../../dist/render/colors.js';
import { effectiveStatus } from '../../dist/render/job-details.js';
const SCRIPT = resolve('scripts/demo-r5-jobs.mjs');
const NAMES = [
  'Parser fix',
  'Docs sweep',
  'Design review',
  'Page check',
  'External build',
  'Old migration',
  'Schema question',
  'Flaky test',
];
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-r5-stage-test-')));
  const dir = join(parent, 'stage with spaces');
  const home = join(parent, 'real-home');
  for (const sub of ['.hud', '.codex', '.claude', '.pi']) {
    fs.mkdirSync(join(home, sub), { recursive: true });
    fs.writeFileSync(join(home, sub, 'sentinel'), `DO NOT READ OR WRITE synthetic ${sub}\n`);
  }
  const env = {
    PATH: `${resolve('node_modules/.bin')}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: join(home, '.hud'),
    CODEX_HOME: join(home, '.codex'),
    TMPDIR: parent,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
  };
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const run = (command, success = true) => {
    const r = spawnSync(process.execPath, [SCRIPT, command, '--dir', dir], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status === 0, success, `${command}: ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
    return r;
  };
  return { parent, dir, env, run };
}
function inventory(root, excluded) {
  const entries = {};
  const walk = (path) => {
    if (path === excluded) return;
    for (const name of fs.readdirSync(path).sort()) {
      const file = join(path, name);
      if (file === excluded) continue;
      const s = fs.lstatSync(file);
      entries[file.slice(root.length)] = [
        s.mode,
        s.isDirectory() ? 'directory' : fs.readFileSync(file).toString('base64'),
      ];
      if (s.isDirectory()) walk(file);
    }
  };
  walk(root);
  return entries;
}
function collect(dir) {
  const source = `import { collectStage } from ${JSON.stringify(new URL('../../scripts/demo-r5-jobs.mjs', import.meta.url).href)}; console.log(JSON.stringify(await collectStage(process.argv[1])));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source, dir], {
    env: stageEnv(dir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('R5 stage: real collection/composition has every scenario, effective status, helpers, current QA and per-statement verdicts', (t) => {
  const f = fixture(t);
  f.run('stage');
  const result = collect(f.dir);
  const nodes = new Map(result.tree.nodes.map((n) => [n.name, n]));
  assert.equal(nodes.size, 8);
  for (const [name, status, role, kind] of [
    ['Parser fix', 'running', 'imp', 'role'],
    ['Docs sweep', 'running', 'imp', 'role'],
    ['Design review', 'completed', 'oracle', 'role'],
    ['Page check', 'completed', 'jev', 'role'],
    ['External build', 'running', null, 'external'],
    ['Old migration', 'unknown', 'imp', 'role'],
    ['Schema question', 'unknown', 'imp', 'role'],
    ['Flaky test', 'error', 'imp', 'role'],
  ]) {
    const n = nodes.get(name);
    assert.ok(n, name);
    assert.equal(effectiveStatus(n), status, name);
    assert.equal(n.job.role, role, name);
    assert.equal(n.job.kind, kind, name);
  }
  assert.equal(nodes.get('Parser fix').job.backend.executor, 'herdr');
  assert.equal(nodes.get('Parser fix').job.backend.harness, 'codex');
  assert.equal(nodes.get('Docs sweep').job.backend.harness, 'pi');
  const helpers = nodes.get('Docs sweep').children;
  assert.deepEqual(helpers.map((h) => [h.job.role, effectiveStatus(h)]).sort(), [
    ['reviewer', 'running'],
    ['sonic', 'completed'],
  ]);
  assert.equal(nodes.get('Old migration').job.freshness.state, 'stale');
  assert.equal(nodes.get('Old migration').job.freshness.reason, 'herdr_uncorroborated');
  const current = [...nodes.values()].flatMap((n) =>
    (n.job.requests ?? []).filter((q) => q.current).map((q) => [n.name, q.id, q.state, q.respondable])
  );
  assert.deepEqual(current, [['Schema question', 'q1', 'unanswered', true]]);
  assert.equal(nodes.get('Schema question').job.freshness.state, 'current');
  assert.equal(nodes.get('Design review').job.lifecycle, 'closed');
  assert.equal(nodes.get('Design review').job.outcome, 'answered');
  assert.equal(nodes.get('Page check').job.outcome, null);
  assert.deepEqual(nodes.get('Page check').job.judgments, [
    { name: 'layout', verdict: 'pass' },
    { name: 'copy', verdict: 'deny' },
  ]);
  assert.equal(nodes.get('Flaky test').job.lifecycle, 'closed');
});

test('R5 stage: real frames show all names in EN/ZH at 110/44; narrow rows fit and stale work never runs', (t) => {
  const f = fixture(t);
  f.run('stage');
  const output = f.run('frames').stdout;
  assert.doesNotMatch(output, /\x1b/);
  const blocks = [...output.matchAll(/=== (EN|ZH) (110|44)x40 ===\n([\s\S]*?)(?==== |$)/g)];
  assert.equal(blocks.length, 4);
  for (const [, language, width, body] of blocks) {
    for (const name of NAMES) assert.ok(body.includes(name), `${language} ${width}: ${name}\n${body}`);
    const lines = body.trimEnd().split('\n');
    for (const line of lines) assert.ok(visualLength(line) <= Number(width), `${language} ${width}: ${line}`);
    const stale = lines.find((line) => line.includes('Old migration'));
    assert.match(stale, /\?/);
    assert.doesNotMatch(stale, /▸|◷|⏱/);
    assert.match(body, /! (?:answer|回答) q1/);
  }
});

test('R5 stage: Page check Inspector renders layout pass and copy deny without aggregate success', (t) => {
  const f = fixture(t);
  f.run('stage');
  const source = `
    import { collectStage } from ${JSON.stringify(new URL('../../scripts/demo-r5-jobs.mjs', import.meta.url).href)};
    import { initialMonitorState, renderMonitor } from ${JSON.stringify(new URL('../../dist/render/monitor.js', import.meta.url).href)};
    import { stripAnsi } from ${JSON.stringify(new URL('../../dist/render/colors.js', import.meta.url).href)};
    const result = await collectStage(process.argv[1]);
    const state = initialMonitorState();
    state.focus = 'details'; state.preview = 'agent';
    state.modes = { agents: 'closed', timeline: 'closed', changes: 'closed', details: 'open' };
    state.tree.selectedId = result.tree.nodes.find(n => n.name === 'Page check').id;
    console.log(renderMonitor({ tree: result.tree, state, nowMs: result.nowMs, width: 110, height: 120 }).lines.map(stripAnsi).join('\\n'));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.dir], {
    env: stageEnv(f.dir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /layout.*pass/);
  assert.match(r.stdout, /copy.*deny/);
  assert.doesNotMatch(r.stdout, /success/i);
});

test('R5 stage: isolated stage/frames/stop leave the entire outside sandbox and real-home sentinels byte-identical', (t) => {
  const f = fixture(t);
  const before = inventory(f.parent, f.dir);
  f.run('stage');
  assert.deepEqual(inventory(f.parent, f.dir), before, 'stage wrote outside dir');
  f.run('frames');
  assert.deepEqual(inventory(f.parent, f.dir), before, 'frames wrote outside dir');
  f.run('stop');
  assert.deepEqual(inventory(f.parent, f.dir), before, 'stop wrote outside dir');
  assert.equal(fs.existsSync(f.dir), false);
});

test('R5 stage: nested-checkout project/status/Changes/worktree collectors cannot read ancestor sentinels', (t) => {
  const f = fixture(t);
  const globalConfig = join(f.parent, 'test-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const gitEnv = { ...f.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: f.parent, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '--initial-branch=ancestor-sentinel');
  fs.writeFileSync(join(f.parent, 'ancestor-committed'), 'synthetic ancestor commit\n');
  git('add', 'ancestor-committed');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'ancestor sentinel');
  fs.writeFileSync(join(f.parent, 'ancestor-untracked'), 'synthetic untracked sentinel\n');
  fs.mkdirSync(join(f.parent, '.codex'), { recursive: true });
  fs.writeFileSync(
    join(f.parent, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'never-run' }] }] } })
  );
  fs.mkdirSync(join(f.parent, '.agents', 'skills', 'ancestor-skill'), { recursive: true });
  fs.writeFileSync(join(f.parent, '.agents', 'skills', 'ancestor-skill', 'SKILL.md'), 'Synthetic ancestor skill\n');
  const before = inventory(f.parent, f.dir);
  f.run('stage');
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { collectProjectInfo } from ${JSON.stringify(new URL('../../dist/collectors/project.js', import.meta.url).href)};
    import { HudStatus } from ${JSON.stringify(new URL('../../dist/collectors/hud-status.js', import.meta.url).href)};
    import { collectGitChanges } from ${JSON.stringify(new URL('../../dist/collectors/git-changes.js', import.meta.url).href)};
    import { WorktreeCollector } from ${JSON.stringify(new URL('../../dist/collectors/worktrees.js', import.meta.url).href)};
    const dir = process.argv[1], parent = process.argv[2], cwd = dir + '/project';
    const outsideReads = [];
    for (const method of ['readFileSync', 'readdirSync', 'statSync', 'existsSync']) {
      const original = fs[method];
      fs[method] = function(file, ...args) {
        if (typeof file === 'string' && file.startsWith(parent + '/') && !file.startsWith(dir + '/')) outsideReads.push(file);
        return original.call(this, file, ...args);
      };
    }
    syncBuiltinESMExports();
    const project = collectProjectInfo(cwd);
    const hud = new HudStatus(cwd);
    hud.build({ rollout: null, stale: false, tree: { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() } });
    const changes = await collectGitChanges(cwd);
    const worktrees = await new WorktreeCollector().refresh([cwd]);
    for (let n = 0; n < 100 && !hud.current().git.isGitRepo; n++) await new Promise(r => setTimeout(r, 10));
    console.log(JSON.stringify({ project, git: hud.current().git, changes, worktrees, outsideReads }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.dir, f.parent], {
    env: stageEnv(f.dir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.outsideReads, [], 'Node project scanners must not even read ancestor configuration');
  assert.equal(result.project.hooksCount, null);
  assert.equal(result.project.skillsCount, null);
  assert.equal(result.project.agentsMdCount, 0);
  assert.equal(result.git.branch, 'r5-synthetic');
  assert.equal(result.git.untracked, 0);
  assert.equal(result.changes.root, join(f.dir, 'project'));
  assert.deepEqual(result.changes.files, []);
  assert.equal(result.worktrees.entries.length, 1);
  assert.equal(result.worktrees.entries[0].path, join(f.dir, 'project'));
  assert.equal(result.worktrees.entries[0].branch, 'r5-synthetic');
  assert.equal(result.worktrees.entries[0].status.untracked, 0);
  const output = f.run('frames').stdout;
  assert.doesNotMatch(output, /ancestor-sentinel|ancestor-untracked|ancestor-skill/);
  f.run('stop');
  assert.deepEqual(inventory(f.parent, f.dir), before, 'ancestor checkout stays byte-identical');
});

test('R5 stage: stop matches pid + kernel start time, leaves a mismatched decoy alive and is idempotent', async (t) => {
  const f = fixture(t);
  f.run('stage');
  const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: stageEnv(f.dir), stdio: 'ignore' });
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: stageEnv(f.dir), stdio: 'ignore' });
  t.after(() => {
    owned.kill('SIGKILL');
    decoy.kill('SIGKILL');
  });
  await Promise.all([once(owned, 'spawn'), once(decoy, 'spawn')]);
  const ended = once(owned, 'exit');
  fs.writeFileSync(
    join(f.dir, 'pids.json'),
    JSON.stringify([
      { pid: owned.pid, startTime: processStart(owned.pid), kind: 'panel' },
      { pid: decoy.pid, startTime: String(BigInt(processStart(decoy.pid)) + 1n), kind: 'panel' },
    ])
  );
  await stop(f.dir);
  await ended;
  assert.equal(owned.signalCode, 'SIGTERM');
  assert.ok(processStart(decoy.pid), 'decoy survives mismatched identity');
  assert.equal(fs.existsSync(f.dir), false);
  await stop(f.dir);
});

test('R5 stage: launch argv/env is dedicated WT windows, exact titles/sizes, WSL exec, isolated homes and shim first', (t) => {
  const f = fixture(t);
  f.run('stage');
  assert.deepEqual(
    WINDOWS.map((w) => [w.title, w.width, w.height, w.language]),
    [
      ['R5ACC-EN', 110, 40, 'en'],
      ['R5ACC-ZH', 110, 40, 'zh'],
      ['R5ACC-NARROW', 44, 40, 'en'],
    ]
  );
  for (const w of WINDOWS) {
    const launch = windowLaunch(f.dir, w, 'Synthetic Ubuntu');
    assert.equal(launch.executable, 'wt.exe');
    assert.deepEqual(launch.argv, [
      '--window',
      'new',
      '--size',
      `${w.width},40`,
      '--title',
      w.title,
      '--suppressApplicationTitle',
      'wsl.exe',
      '--distribution',
      'Synthetic Ubuntu',
      '--exec',
      process.execPath,
      SCRIPT,
      'panel-run',
      '--dir',
      f.dir,
      '--title',
      w.title,
      '--language',
      w.language,
    ]);
    assert.equal(launch.env.HOME, join(f.dir, 'home'));
    assert.equal(launch.env.HUD_HOME, join(f.dir, 'hud'));
    assert.equal(launch.env.CODEX_HOME, join(f.dir, `codex-${w.language}`));
    assert.equal(launch.env.PATH.split(':')[0], join(f.dir, 'bin'));
    assert.equal(launch.env.NO_COLOR, '1');
    assert.equal(launch.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(launch.env.GIT_CONFIG_GLOBAL, join(f.dir, 'gitconfig'));
    assert.equal(launch.env.GIT_ATTR_NOSYSTEM, '1');
    assert.equal(launch.env.GIT_CEILING_DIRECTORIES, f.dir);
    assert.equal(launch.env.CODEX_HUD_CWD, join(f.dir, 'project'));
    assert.equal(launch.env.TMUX, undefined);
    assert.equal(launch.env.OPENAI_API_KEY, undefined);
  }
  assert.throws(() => windowLaunch(f.dir, WINDOWS[0], ''), /WSL_DISTRO_NAME/);
  assert.equal(ROOT, 'synthetic/r5-acceptance');
});

test('R5 stage: exclusive creation, missing/unstaged refusals and unsafe cleanup refusal', async (t) => {
  const f = fixture(t);
  for (const cmd of ['frames', 'open']) assert.match(f.run(cmd, false).stderr, /not an R5 stage/);
  fs.mkdirSync(f.dir);
  assert.match(f.run('stage', false).stderr, /EEXIST/);
  for (const cmd of ['frames', 'open', 'stop']) assert.match(f.run(cmd, false).stderr, /not an R5 stage/);
  fs.rmdirSync(f.dir);
  f.run('stage');
  assert.match(f.run('stage', false).stderr, /EEXIST/);
  fs.writeFileSync(join(f.dir, 'pids.json'), JSON.stringify([{ pid: 1, startTime: '1' }]));
  await assert.rejects(stop(f.dir), /invalid pids.json/);
  assert.ok(fs.existsSync(f.dir));
});
