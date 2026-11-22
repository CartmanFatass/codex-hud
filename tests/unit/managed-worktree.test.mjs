import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  addWorktree,
  gitSummary,
  planWorktree,
  populateWorktree,
  reapWorktree,
  reusableWorktree,
} from '../../dist/mcp/managed-worktree.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';

function initTrackedNodeModulesRepo(parent, { ignoreNodeModules = true } = {}) {
  const main = initRepo(parent);
  if (ignoreNodeModules) fs.appendFileSync(join(main, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(join(main, 'node_modules/@types/tracked'), { recursive: true });
  fs.writeFileSync(join(main, 'node_modules/@types/tracked/index.d.ts'), 'export type Base = string;\n');
  fs.mkdirSync(join(main, 'node_modules/tracked-pkg'), { recursive: true });
  fs.writeFileSync(join(main, 'node_modules/tracked-pkg/index.js'), 'export const tracked = true;\n');
  git(main, 'add', '-f', '.gitignore', 'node_modules/@types/tracked/index.d.ts', 'node_modules/tracked-pkg/index.js');
  git(main, 'commit', '-qm', 'track partial node_modules');

  // Untracked dependencies in the main checkout (both top-level and inside tracked @types scope).
  fs.mkdirSync(join(main, 'node_modules/extra-dep'), { recursive: true });
  fs.writeFileSync(join(main, 'node_modules/extra-dep/index.js'), 'export const extra = 1;\n');
  fs.mkdirSync(join(main, 'node_modules/@types/extra'), { recursive: true });
  fs.writeFileSync(join(main, 'node_modules/@types/extra/index.d.ts'), 'export type Extra = number;\n');
  fs.mkdirSync(join(main, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(join(main, 'node_modules/.bin/tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return main;
}

for (const ignoreNodeModules of [true, false]) {
  test(`populateWorktree links untracked node_modules entries and keeps checkout clean/reusable/reapable (ignored=${ignoreNodeModules})`, async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'managed-wt-nm-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const main = initTrackedNodeModulesRepo(home, { ignoreNodeModules });
    const hud = join(home, 'hud');
    fs.mkdirSync(hud, { recursive: true, mode: 0o700 });

    const id = 'j00000000000000a1';
    const wt = await planWorktree(main, id, 'imp');
    await addWorktree(wt);
    await populateWorktree(wt);

    // Tracked files remain real files; missing entries (top-level and nested scoped) are symlinked.
    assert.equal(fs.lstatSync(join(wt.root, 'node_modules')).isDirectory(), true);
    assert.equal(fs.lstatSync(join(wt.root, 'node_modules/tracked-pkg/index.js')).isFile(), true);
    assert.equal(fs.readlinkSync(join(wt.root, 'node_modules/extra-dep')), join(main, 'node_modules/extra-dep'));
    assert.equal(fs.readlinkSync(join(wt.root, 'node_modules/@types/extra')), join(main, 'node_modules/@types/extra'));
    assert.equal(fs.readlinkSync(join(wt.root, 'node_modules/.bin')), join(main, 'node_modules/.bin'));

    // Populated dependency links do not look dirty to gitSummary or reusableWorktree.
    const summary = await gitSummary(wt);
    assert.equal(summary.dirty, false);
    assert.equal(summary.changed_files, 0);
    assert.ok(await reusableWorktree({ job: id, cwd: wt.root, worktree: wt }, main));

    if (ignoreNodeModules) {
      // Ignored runtime artifacts inside tracked-plus-ignored node_modules are also removable.
      fs.mkdirSync(join(wt.root, 'node_modules/.cache'), { recursive: true });
      fs.writeFileSync(join(wt.root, 'node_modules/.cache/state.json'), '{"ok":true}\n');
    } else {
      // Unignored real untracked files inside node_modules still block reap.
      const extraFile = join(wt.root, 'node_modules/user-untracked.txt');
      fs.writeFileSync(extraFile, 'keep\n');
      const blocked = await reapWorktree(id, { job: id, cwd: wt.root, worktree: wt }, hud);
      assert.match(blocked.worktree_kept_reason ?? '', /dirty/);
      assert.equal(fs.existsSync(extraFile), true);
      fs.unlinkSync(extraFile);
    }

    const res = await reapWorktree(id, { job: id, cwd: wt.root, worktree: wt }, hud);
    assert.ok(res.worktree_removed_at, res.worktree_kept_reason);
    assert.equal(fs.existsSync(wt.root), false);
    assert.equal(git(main, 'branch', '--list', wt.branch), '');
    // Main checkout symlink targets must remain untouched.
    assert.equal(fs.readFileSync(join(main, 'node_modules/extra-dep/index.js'), 'utf8'), 'export const extra = 1;\n');
    assert.equal(fs.readFileSync(join(main, 'node_modules/@types/extra/index.d.ts'), 'utf8'), 'export type Extra = number;\n');
  });
}

for (const blocker of ['untracked-outside', 'ignored-outside', 'tracked-nm-edit', 'nested-git-in-nm']) {
  test(`reapWorktree refuses tracked-plus-ignored node_modules worktree when blocked by ${blocker}`, async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'managed-wt-block-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const main = initTrackedNodeModulesRepo(home, { ignoreNodeModules: true });
    const hud = join(home, 'hud');
    fs.mkdirSync(hud, { recursive: true, mode: 0o700 });

    const id = 'j00000000000000b2';
    const wt = await planWorktree(main, id, 'imp');
    await addWorktree(wt);
    await populateWorktree(wt);

    if (blocker === 'untracked-outside') {
      fs.writeFileSync(join(wt.root, 'user-note.txt'), 'do not delete\n');
    } else if (blocker === 'ignored-outside') {
      fs.writeFileSync(join(wt.root, 'ignored.txt'), 'do not delete\n');
    } else if (blocker === 'tracked-nm-edit') {
      fs.appendFileSync(join(wt.root, 'node_modules/tracked-pkg/index.js'), '// modified\n');
    } else if (blocker === 'nested-git-in-nm') {
      const nested = join(wt.root, 'node_modules/local-pkg');
      fs.mkdirSync(nested, { recursive: true });
      git(nested, 'init', '-q');
    }

    const res = await reapWorktree(id, { job: id, cwd: wt.root, worktree: wt }, hud);
    assert.equal(res.worktree_removed_at, undefined);
    assert.match(res.worktree_kept_reason ?? '', blocker === 'nested-git-in-nm' ? /nested Git/ : /dirty/);
    assert.equal(fs.existsSync(wt.root), true);
    if (blocker === 'untracked-outside') {
      assert.equal(fs.readFileSync(join(wt.root, 'user-note.txt'), 'utf8'), 'do not delete\n');
    }
  });
}

test('watcher one-time sweep removes stale closed and archived managed worktrees while preserving user files, open jobs and manual worktrees', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'watch-wt-sweep-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const main = initTrackedNodeModulesRepo(home, { ignoreNodeModules: true });
  const hud = join(home, 'hud');
  fs.mkdirSync(join(hud, 'jobs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(hud, 'archive'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(hud, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main }] }));
  fs.writeFileSync(join(home, 'pi-role-reap'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const now = new Date().toISOString();
  const makeManaged = async (hex, { state = 'closed', keptReason = null, archived = false, userFile = null, unmerged = false } = {}) => {
    const id = `j000000000000${hex}`;
    const wt = await planWorktree(main, id, 'imp');
    await addWorktree(wt);
    await populateWorktree(wt);
    fs.mkdirSync(join(wt.root, 'node_modules/.cache'), { recursive: true });
    fs.writeFileSync(join(wt.root, 'node_modules/.cache/meta.json'), '{"v":1}\n');
    if (userFile) fs.writeFileSync(join(wt.root, userFile), 'preserve me\n');
    if (unmerged) {
      fs.appendFileSync(join(wt.root, 'tracked.txt'), 'unmerged change\n');
      git(wt.root, 'commit', '-qam', 'unmerged');
    }
    if (archived) {
      fs.appendFileSync(join(hud, 'archive/2026-11.jsonl'), JSON.stringify({
        v: 1, job: id, project: main, state: 'closed', ended_at: now, reaped_at: now,
      }) + '\n');
      return { id, wt, jobFile: null };
    }
    const dir = join(hud, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, ...(state === 'closed' ? { ended_at: now } : {}) }));
    const jobFile = join(dir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({
      job: id, role: 'imp', cwd: wt.root, project_root: main, created_at: now,
      dispatch_exit_code: 0, stderr_tail: '', worktree: wt,
      ...(state === 'closed' ? { reaped_at: now } : {}),
      ...(keptReason ? { worktree_kept_reason: keptReason } : {}),
    }));
    return { id, wt, jobFile };
  };

  // 1. Stale closed job in jobs/ previously marked dirty under the old dependencyLink() check.
  const staleJob = await makeManaged('0001', { keptReason: 'worktree is dirty (tracked, untracked or ignored files)' });
  // 2. Stale closed job in jobs/ with a real untracked user file outside node_modules -> must stay.
  const dirtyJob = await makeManaged('0002', { keptReason: 'worktree is dirty (tracked, untracked or ignored files)', userFile: 'notes.txt' });
  // 3. Stale archived closed job (jobs/<id> already expired) -> must be removed.
  const archivedClean = await makeManaged('0003', { archived: true });
  // 4. Stale archived closed job with a user file -> must stay.
  const archivedDirty = await makeManaged('0004', { archived: true, userFile: 'draft.txt' });
  // 5. Stale archived closed job with unmerged commits -> must stay.
  const archivedUnmerged = await makeManaged('0005', { archived: true, unmerged: true });
  // 6. Manual (non-HUD-managed) worktree beside the repo -> must stay.
  const manualRoot = join(home, 'demo-wt', 'manual-branch');
  git(main, 'worktree', 'add', '-qb', 'manual-branch', manualRoot, 'HEAD');

  const env = { ...process.env, HOME: home, HUD_HOME: hud, PATH: `${home}:${process.env.PATH}`, HERDR_SOCKET_PATH: join(home, 'absent.sock') };
  const runWatch = () => {
    const res = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(res.status, 0, res.stderr || String(res.error));
  };

  runWatch();

  // Removable stale worktrees are gone (checkout + branch).
  for (const item of [staleJob, archivedClean]) {
    assert.equal(fs.existsSync(item.wt.root), false, `${item.id} checkout removed`);
    assert.equal(git(main, 'branch', '--list', item.wt.branch), '', `${item.id} branch removed`);
  }
  const staleReceipt = JSON.parse(fs.readFileSync(staleJob.jobFile, 'utf8'));
  assert.ok(staleReceipt.worktree_removed_at);
  assert.equal(staleReceipt.worktree_kept_reason, undefined);

  // User files, unmerged archived commits, and manual worktrees are preserved.
  assert.equal(fs.readFileSync(join(dirtyJob.wt.root, 'notes.txt'), 'utf8'), 'preserve me\n');
  assert.equal(fs.readFileSync(join(archivedDirty.wt.root, 'draft.txt'), 'utf8'), 'preserve me\n');
  assert.equal(fs.existsSync(archivedUnmerged.wt.root), true);
  assert.equal(fs.existsSync(manualRoot), true);

  // One-time sweep marker is private (0600) and prevents re-spawning Git for dirty worktrees on later scans.
  const marker = join(hud, 'worktree-reap-sweep.json');
  assert.equal(fs.lstatSync(marker).mode & 0o777, 0o600);
  const markerData = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(markerData.version, 1);
  assert.equal(markerData.removed, 2);
  assert.equal(markerData.kept, 3);

  const gitStub = join(home, 'git');
  fs.writeFileSync(gitStub, '#!/bin/sh\ntouch "$HOME/git-called"; exit 1\n', { mode: 0o700 });
  runWatch();
  assert.equal(fs.existsSync(join(home, 'git-called')), false, 'subsequent scan does not re-run the one-time sweep');
});

test('watcher one-time sweep never touches an open job worktree even if an archived row shares its suffix', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'watch-wt-open-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const main = initTrackedNodeModulesRepo(home, { ignoreNodeModules: true });
  const hud = join(home, 'hud');
  fs.mkdirSync(join(hud, 'jobs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(hud, 'archive'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(hud, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main }] }));

  const now = new Date().toISOString();
  const openId = 'j0000000000000099';
  const wt = await planWorktree(main, openId, 'imp');
  await addWorktree(wt);
  await populateWorktree(wt);
  const dir = join(hud, 'jobs', openId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: openId, role: 'imp', cwd: wt.root, project_root: main, created_at: now,
    dispatch_exit_code: 0, stderr_tail: '', worktree: wt,
  }));
  // Even an archived closed job sharing the 6-char suffix must not cause the open worktree to be swept.
  fs.appendFileSync(join(hud, 'archive/2026-11.jsonl'), JSON.stringify({
    v: 1, job: 'j1111111111000099', project: main, state: 'closed', ended_at: now, reaped_at: now,
  }) + '\n');

  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const env = { ...process.env, HOME: home, HUD_HOME: hud, HERDR_SOCKET_PATH: join(home, 'absent.sock') };
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  const marker = join(hud, 'worktree-reap-sweep.json');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 25));
  assert.equal(fs.existsSync(marker), true, 'sweep completed');
  assert.equal(fs.existsSync(wt.root), true, 'open job worktree preserved');
  assert.equal(Boolean(git(main, 'branch', '--list', wt.branch)), true);
  child.kill('SIGTERM');
  await exited;
});

