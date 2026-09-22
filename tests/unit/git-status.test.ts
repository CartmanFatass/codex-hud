/**
 * The HUD reads git through a single `status --porcelain=v2 --branch` call.
 * That output shape is the whole contract, so it is pinned with fixtures here
 * rather than by running git, and the counts are kept identical to the ones
 * the previous `--porcelain` (v1) reader produced.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectGitStatus,
  formatGitStatus,
  parseGitStatusPorcelainV2,
  resetGitStatusCache,
} from '../../src/collectors/git.js';

const HASH = '0000000000000000000000000000000000000000';

test('clean tracked branch reports ahead and behind', () => {
  const parsed = parseGitStatusPorcelainV2([
    '# branch.oid 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '',
  ].join('\n'));

  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.detached, false);
  assert.equal(parsed.upstream, 'origin/main');
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 3);
  assert.equal(parsed.isDirty, false);
  assert.deepEqual(
    { modified: parsed.modified, added: parsed.added, deleted: parsed.deleted, untracked: parsed.untracked },
    { modified: 0, added: 0, deleted: 0, untracked: 0 }
  );
});

test('staged, unstaged, renamed and untracked entries are counted', () => {
  const parsed = parseGitStatusPorcelainV2([
    '# branch.oid 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    '# branch.head feature/counts',
    '# branch.upstream origin/feature/counts',
    '# branch.ab +0 -0',
    `1 M. N... 100644 100644 100644 ${HASH} ${HASH} src/staged.ts`,
    `1 .M N... 100644 100644 100644 ${HASH} ${HASH} src/unstaged.ts`,
    `1 A. N... 000000 100644 100644 ${HASH} ${HASH} src/new.ts`,
    `1 .D N... 100644 100644 000000 ${HASH} ${HASH} src/gone.ts`,
    `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 src/after.ts\tsrc/before.ts`,
    `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} src/conflict.ts`,
    '? notes.txt',
    '? build/',
    '',
  ].join('\n'));

  assert.equal(parsed.branch, 'feature/counts');
  assert.equal(parsed.isDirty, true);
  assert.equal(parsed.ahead, 0);
  assert.equal(parsed.behind, 0);
  // A rename counts as a modification, as it did under `--porcelain` v1, and
  // an unresolved conflict is not counted as any of the four kinds.
  assert.deepEqual(
    { modified: parsed.modified, added: parsed.added, deleted: parsed.deleted, untracked: parsed.untracked },
    { modified: 3, added: 1, deleted: 1, untracked: 2 }
  );
});

test('detached HEAD reports no branch and keeps the commit id', () => {
  const parsed = parseGitStatusPorcelainV2([
    '# branch.oid 9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192',
    '# branch.head (detached)',
    `1 .M N... 100644 100644 100644 ${HASH} ${HASH} src/edited.ts`,
    '',
  ].join('\n'));

  assert.equal(parsed.detached, true);
  assert.equal(parsed.branch, null);
  assert.equal(parsed.oid, '9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192');
  assert.equal(parsed.upstream, null);
  assert.equal(parsed.isDirty, true);
  assert.equal(parsed.modified, 1);
});

test('a branch without an upstream has no ab header and stays at zero', () => {
  const parsed = parseGitStatusPorcelainV2([
    '# branch.oid 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    '# branch.head solo',
    '',
  ].join('\n'));

  assert.equal(parsed.branch, 'solo');
  assert.equal(parsed.upstream, null);
  assert.equal(parsed.ahead, 0);
  assert.equal(parsed.behind, 0);
  assert.equal(parsed.isDirty, false);
});

test('an unborn branch reports its name and no commit id', () => {
  const parsed = parseGitStatusPorcelainV2([
    '# branch.oid (initial)',
    '# branch.head main',
    '',
  ].join('\n'));

  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.oid, null);
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-git-status-'));
  t.after(() => {
    resetGitStatusCache();
    rmSync(root, { recursive: true, force: true });
  });
  resetGitStatusCache();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'HUD Test');
  git(root, 'config', 'user.email', 'hud@example.invalid');
  return root;
}

test('a directory outside a repository reports no repository', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hud-git-none-'));
  t.after(() => {
    resetGitStatusCache();
    rmSync(root, { recursive: true, force: true });
  });
  resetGitStatusCache();

  const status = await collectGitStatus(root);
  assert.equal(status.isGitRepo, false);
  assert.equal(status.branch, null);
  assert.equal(status.isDirty, false);
  assert.equal(formatGitStatus(status), '');
});

test('a real repository reports its branch, dirt and counts', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');

  const clean = await collectGitStatus(root);
  assert.equal(clean.isGitRepo, true);
  assert.equal(clean.branch, 'main');
  assert.equal(clean.isDirty, false);
  assert.equal(clean.ahead, 0);
  assert.equal(clean.behind, 0);

  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  writeFileSync(join(root, 'fresh.txt'), 'new\n');
  resetGitStatusCache();

  const dirty = await collectGitStatus(root);
  assert.equal(dirty.isDirty, true);
  assert.equal(dirty.modified, 1);
  assert.equal(dirty.untracked, 1);
  assert.equal(formatGitStatus(dirty), 'git:(main) ●');
});

test('a detached HEAD falls back to the short commit id', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '--detach', head);
  resetGitStatusCache();

  const status = await collectGitStatus(root);
  assert.equal(status.isGitRepo, true);
  assert.equal(status.branch, head.slice(0, 7));
});

test('a detached HEAD on a tagged commit reports the tag', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');
  git(root, 'tag', 'v1.2.3');
  git(root, 'checkout', '--detach', 'v1.2.3');
  resetGitStatusCache();

  const status = await collectGitStatus(root);
  assert.equal(status.branch, 'tag:v1.2.3');
});

test('an unchanged repository is answered from cache without running git', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');

  const first = await collectGitStatus(root);
  assert.equal(first.isDirty, false);

  // No git metadata changed, so this edit is deliberately not observed until
  // the cache ages out: the working tree leaves no trace in the git directory.
  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  const second = await collectGitStatus(root);
  assert.equal(second, first, 'expected the cached snapshot object itself');

  // Staging touches the index, which invalidates the cache immediately.
  git(root, 'add', '--all');
  const third = await collectGitStatus(root);
  assert.equal(third.isDirty, true);
  assert.equal(third.modified, 1);
});
