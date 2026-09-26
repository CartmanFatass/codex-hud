import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitTargetCache, resolveGitTarget } from '../../src/collectors/git-root.js';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { renderProjectLine } from '../../src/render/lines/project-line.js';
import { stripAnsi } from '../../src/render/colors.js';
import { buildSnapshot } from '../../src/snapshot.js';
import { makeHudData, FIXED_NOW } from '../fixtures/hud-data.js';

/** A workspace folder like ~/shenlun: notes beside two repositories. */
function workspace(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'hud-git-root-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = (name: string) => {
    mkdirSync(join(base, name, '.git'), { recursive: true });
    writeFileSync(join(base, name, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(base, name, 'src'));
    return join(base, name);
  };
  mkdirSync(join(base, 'notes'));
  // An empty .git folder, like the one sitting in this machine's home
  // directory, is not a repository and must not swallow the whole workspace.
  mkdirSync(join(base, '.git'));
  return { base, repo };
}

test('a folder inside a repository is described as before', t => {
  const { repo } = workspace(t);
  const learn = repo('Learn-to-Write');
  assert.deepEqual(resolveGitTarget([join(learn, 'src')]), { dir: join(learn, 'src') });
});

test('a session above its repository is described by the repository it works in', t => {
  const { base, repo } = workspace(t);
  const learn = repo('Learn-to-Write');
  const other = repo('archive');
  // The newest place the rollout worked wins; the folder itself and paths
  // outside the session folder are passed over.
  const found = resolveGitTarget([base], [join(other, 'src'), join(learn, 'src'), base, '/usr/lib']);
  assert.deepEqual(found, { dir: learn, subRepo: learn });
  assert.deepEqual(resolveGitTarget([base], [join(learn, 'src'), other]), { dir: other, subRepo: other });
  // A linked worktree's .git is a file pointing at the real git directory.
  mkdirSync(join(base, 'linked'));
  writeFileSync(join(base, 'linked', '.git'), `gitdir: ${join(learn, '.git')}\n`);
  assert.deepEqual(resolveGitTarget([base], [join(base, 'linked')]), { dir: join(base, 'linked'), subRepo: join(base, 'linked') });
});

test('another project read for reference is not the session repository', t => {
  const { base } = workspace(t);
  const elsewhere = workspace(t).repo('reference');
  assert.equal(resolveGitTarget([base], [join(elsewhere, 'src')]), null);
});

test('before anything has run, a lone repository in the folder is the one', t => {
  const { base, repo } = workspace(t);
  const learn = repo('Learn-to-Write');
  assert.deepEqual(resolveGitTarget([base]), { dir: learn, subRepo: learn });
  repo('archive');
  assert.equal(resolveGitTarget([base]), null, 'two candidates: no guess');
  assert.equal(resolveGitTarget([undefined]), null);
});

test('the rollout keeps where commands ran and files changed, newest last', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-work-dirs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'rollout.jsonl');
  const row = (payload: object) => JSON.stringify({ timestamp: FIXED_NOW.toISOString(), type: 'event_msg', payload }) + '\n';
  const command = (cwd: string) => row({ type: 'item_completed', item: { type: 'CommandExecution', cwd } });
  writeFileSync(file, JSON.stringify({ timestamp: FIXED_NOW.toISOString(), type: 'session_meta', payload: { id: 's', cwd: '/w' } }) + '\n');
  appendFileSync(file, command(pathToFileURL('/w/Learn-to-Write').href) + command('file:///w'));
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  assert.deepEqual((await parser.parse())?.workDirs, ['/w/Learn-to-Write', '/w']);
  // Incremental: the next batch moves an old directory to the newest end.
  appendFileSync(file, row({ type: 'item_completed', item: { type: 'FileChange', changes: { '/w/Learn-to-Write/tools/a.py': {} } } })
    + command('relative/is/ignored') + row({ type: 'exec_command_begin', cwd: '/w/Learn-to-Write' }));
  assert.deepEqual((await parser.parse())?.workDirs, ['/w', '/w/Learn-to-Write/tools', '/w/Learn-to-Write']);
});

test('the bar, the project line and the snapshot all name the repository', () => {
  const data = makeHudData();
  data.project = { ...data.project, projectName: 'shenlun' };
  data.git = { ...data.git, isGitRepo: true, branch: 'main', isDirty: true, repo: 'Learn-to-Write' };
  const project = buildBarModules(data, { nowMs: FIXED_NOW.getTime(), density: 'full' }).find(module => module.id === 'project')!;
  assert.equal(stripAnsi(project.variants.full!), 'shenlun › Learn-to-Write git:(main * ↑2)');
  assert.equal(stripAnsi(project.variants.short!), 'Learn-to-Write main*');
  assert.match(stripAnsi(renderProjectLine(data)), /^shenlun › Learn-to-Write git:\(main \* ↑2\) /);
  const snapshot = buildSnapshot(data, { width: 80, segments: [] }, FIXED_NOW.getTime());
  assert.equal(snapshot.project.repo, 'Learn-to-Write');
  assert.equal(snapshot.project.branch, 'main');
  // A folder that is itself the repository reads exactly as it always did.
  delete data.git.repo;
  data.project = { ...data.project, projectName: 'codex-hud' };
  const plain = buildBarModules(data, { nowMs: FIXED_NOW.getTime(), density: 'full' }).find(module => module.id === 'project')!;
  assert.equal(stripAnsi(plain.variants.full!), 'codex-hud git:(main * ↑2)');
  assert.equal(buildSnapshot(data, { width: 80, segments: [] }, FIXED_NOW.getTime()).project.repo, undefined);
});

test('the answer is reused until the evidence changes or it grows old', t => {
  const { base, repo } = workspace(t);
  const learn = repo('Learn-to-Write');
  let now = 0;
  const cache = new GitTargetCache(30_000, () => now);
  assert.equal(cache.resolve([base])?.dir, learn);
  repo('archive');
  now = 29_000;
  assert.equal(cache.resolve([base])?.dir, learn, 'same inputs, still fresh: no disk access');
  assert.equal(cache.resolve([base], [join(base, 'archive', 'src')])?.dir, join(base, 'archive'), 'new evidence: worked out again');
  now = 60_000;
  assert.equal(cache.resolve([base]), null, 'too old: worked out again, and two repos means no guess');
});
