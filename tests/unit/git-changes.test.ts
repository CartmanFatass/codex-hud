import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { collectGitChanges, readGitDiff } from '../../src/collectors/git-changes.js';

function repository(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'HUD Test');
  git(root, 'config', 'user.email', 'hud@example.invalid');
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(root: string): void {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');
}

test('returns an empty result outside a repository', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hud-no-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await collectGitChanges(root);
  assert.equal(result.root, null);
  assert.deepEqual(result.files, []);
});

test('collects both index and worktree counts and previews without changing the index', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  writeFileSync(join(root, 'deleted.txt'), 'gone\n');
  commit(root);
  writeFileSync(join(root, 'file.txt'), 'base\nstaged\n');
  git(root, 'add', 'file.txt');
  writeFileSync(join(root, 'file.txt'), 'base\nstaged\nworking\n');
  unlinkSync(join(root, 'deleted.txt'));
  const beforeIndex = readFileSync(join(root, '.git/index'));
  const beforeStatus = git(root, 'status', '--porcelain=v1', '-z');
  const result = await collectGitChanges(root);
  assert.equal(result.root, root);
  assert.equal(result.branch, 'main');
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
  const file = result.files.find(file => file.path === 'file.txt')!;
  assert.equal(file.index, 'M');
  assert.equal(file.worktree, 'M');
  assert.equal(file.added, 2);
  assert.equal(file.removed, 0);
  assert.equal(result.files.find(file => file.path === 'deleted.txt')?.removed, 1);
  const preview = (await readGitDiff(root, file)).join('\n');
  assert.match(preview, /Staged/);
  assert.match(preview, /Unstaged/);
  assert.match(preview, /\+staged/);
  assert.match(preview, /\+working/);
  assert.deepEqual(readFileSync(join(root, '.git/index')), beforeIndex);
  assert.equal(git(root, 'status', '--porcelain=v1', '-z'), beforeStatus);
});

test('preserves unusual renamed paths and treats pathspec characters literally', async t => {
  const root = repository(t);
  const previousPath = 'old\tname\n.txt';
  const path = 'new [x] \n\u001bname.txt';
  writeFileSync(join(root, previousPath), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'new x other.txt'), 'unrelated\n');
  commit(root);
  git(root, 'mv', '--', previousPath, path);
  writeFileSync(join(root, path), 'one\ntwo\nthree\nadded\n');
  git(root, 'add', '--', path);
  writeFileSync(join(root, path), 'one\ntwo\nthree\nadded\nworking\n');
  writeFileSync(join(root, 'new x other.txt'), 'unrelated change\n');
  const result = await collectGitChanges(root);
  const file = result.files.find(file => file.path === path)!;
  assert.equal(file.previousPath, previousPath);
  assert.equal(file.index, 'R');
  assert.equal(file.added, 2);
  const preview = (await readGitDiff(root, file)).join('\n');
  assert.match(preview, /\+added/);
  assert.match(preview, /\+working/);
  assert.doesNotMatch(preview, /unrelated change/);
  assert.doesNotMatch(preview, /\u001b/);
});

test('previews untracked text in an unborn repository and bounds and escapes output', async t => {
  const root = repository(t);
  const path = '--new\nfile.txt';
  writeFileSync(join(root, path), '\u001b[2J\u0007unsafe\rtext\n' + 'line\n'.repeat(700));
  const result = await collectGitChanges(root);
  assert.equal(result.branch, 'main');
  const file = result.files.find(file => file.path === path)!;
  assert.equal(file.index, '?');
  assert.equal(file.worktree, '?');
  const preview = await readGitDiff(root, file);
  assert.match(preview.join('\n'), /Untracked/);
  assert.match(preview.join('\n'), /unsafe/);
  assert.doesNotMatch(preview.join('\n'), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.ok(preview.length <= 500);
  assert.match(preview.join('\n'), /truncat/i);
});

test('reports binary changes and does not follow untracked symlinks', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
  commit(root);
  writeFileSync(join(root, 'binary'), Buffer.from([0, 2, 3]));
  writeFileSync(join(root, 'untracked-binary'), Buffer.from([0, 2, 3]));
  const outside = mkdtempSync(join(tmpdir(), 'hud-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret'), 'secret-content');
  symlinkSync(join(outside, 'secret'), join(root, 'link'));
  const result = await collectGitChanges(root);
  const binary = result.files.find(file => file.path === 'binary')!;
  assert.equal(binary.binary, true);
  assert.equal(binary.added, null);
  assert.equal(binary.removed, null);
  assert.match((await readGitDiff(root, binary)).join('\n'), /binary/i);
  const untracked = result.files.find(file => file.path === 'untracked-binary')!;
  assert.match((await readGitDiff(root, untracked)).join('\n'), /binary/i);
  const link = result.files.find(file => file.path === 'link')!;
  const preview = (await readGitDiff(root, link)).join('\n');
  assert.match(preview, /symlink/i);
  assert.doesNotMatch(preview, /secret-content/);
});

test('marks merge conflicts and shows their worktree diff', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'conflict.txt'), 'base\n');
  commit(root);
  git(root, 'checkout', '-b', 'other');
  writeFileSync(join(root, 'conflict.txt'), 'other\n');
  commit(root);
  git(root, 'checkout', 'main');
  writeFileSync(join(root, 'conflict.txt'), 'main\n');
  commit(root);
  assert.throws(() => git(root, 'merge', 'other'));
  const result = await collectGitChanges(root);
  const file = result.files.find(file => file.path === 'conflict.txt')!;
  assert.equal(file.conflict, true);
  assert.equal(file.index, 'U');
  assert.equal(file.worktree, 'U');
  assert.match((await readGitDiff(root, file)).join('\n'), /Unstaged/);
});

test('collects local upstream divergence and handles detached HEAD', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'base'), 'base\n');
  commit(root);
  git(root, 'checkout', '-b', 'upstream');
  writeFileSync(join(root, 'upstream'), 'upstream\n');
  commit(root);
  git(root, 'checkout', 'main');
  git(root, 'branch', '--set-upstream-to=upstream');
  writeFileSync(join(root, 'local'), 'local\n');
  commit(root);
  const result = await collectGitChanges(root);
  assert.equal(result.ahead, 1);
  assert.equal(result.behind, 1);
  assert.deepEqual(result.files, []);
  git(root, 'checkout', '--detach');
  assert.equal((await collectGitChanges(root)).branch, null);
});

test('shows staged additions before the first commit', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'new.txt'), 'new\n');
  git(root, 'add', '--', 'new.txt');
  const result = await collectGitChanges(root);
  assert.equal(result.error, undefined);
  assert.equal(result.files[0].index, 'A');
  assert.equal(result.files[0].added, 1);
  assert.match((await readGitDiff(root, result.files[0])).join('\n'), /\+new/);
});

test('does not execute configured external diff or text conversion commands', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  writeFileSync(join(root, '.gitattributes'), '*.txt diff=unsafe\n');
  commit(root);
  writeFileSync(join(root, 'file.txt'), 'changed\n');
  git(root, 'config', 'diff.external', 'false');
  git(root, 'config', 'diff.unsafe.textconv', 'false');
  git(root, 'config', 'core.fsmonitor', 'false');
  const result = await collectGitChanges(root);
  assert.equal(result.error, undefined);
  assert.equal(result.files[0].added, 1);
  assert.match((await readGitDiff(root, result.files[0])).join('\n'), /\+changed/);
});

for (const driver of ['clean', 'process']) {
  for (const operation of ['collect', 'preview']) {
    test(`${operation} suppresses configured ${driver} filters without changing configuration`, async t => {
      const root = repository(t);
      writeFileSync(join(root, 'file.txt'), 'base\n');
      writeFileSync(join(root, '.gitattributes'), '*.txt filter=unsafe.Name\n');
      commit(root);
      writeFileSync(join(root, 'file.txt'), 'changed\n');
      git(root, 'config', `filter.unsafe.Name.${driver}`,
        driver === 'clean' ? 'echo invoked > FILTER_EXECUTED\ncat' : 'echo invoked > FILTER_EXECUTED\nexit 1');
      git(root, 'config', 'filter.unsafe.Name.required', 'true');
      const beforeConfig = readFileSync(join(root, '.git/config'));
      const beforeIndex = readFileSync(join(root, '.git/index'));
      if (operation === 'collect') {
        const result = await collectGitChanges(root);
        assert.equal(existsSync(join(root, 'FILTER_EXECUTED')), false);
        assert.equal(result.error, undefined);
        assert.equal(result.files.find(file => file.path === 'file.txt')?.added, 1);
      } else {
        const preview = await readGitDiff(root, {
          path: 'file.txt', index: ' ', worktree: 'M', added: 1, removed: 1, binary: false, conflict: false,
        });
        assert.equal(existsSync(join(root, 'FILTER_EXECUTED')), false);
        assert.match(preview.join('\n'), /\+changed/);
      }
      assert.deepEqual(readFileSync(join(root, '.git/config')), beforeConfig);
      assert.deepEqual(readFileSync(join(root, '.git/index')), beforeIndex);
    });
  }
}

test('fails closed when filter names cannot be expressed as Git command overrides', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=unsafe=name\n');
  commit(root);
  writeFileSync(join(root, 'file.txt'), 'changed\n');
  git(root, 'config', 'filter.unsafe=name.clean', 'echo invoked > FILTER_EXECUTED; cat');
  const result = await collectGitChanges(root);
  assert.equal(existsSync(join(root, 'FILTER_EXECUTED')), false);
  assert.match(result.error ?? '', /Cannot safely disable/);
  const preview = await readGitDiff(root, {
    path: 'file.txt', index: ' ', worktree: 'M', added: 1, removed: 1, binary: false, conflict: false,
  });
  assert.equal(existsSync(join(root, 'FILTER_EXECUTED')), false);
  assert.match(preview.join('\n'), /unavailable/i);
});

test('does not traverse submodules with configured worktree filters', async t => {
  const root = repository(t);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  git(nested, 'init', '-b', 'main');
  git(nested, 'config', 'user.name', 'HUD Test');
  git(nested, 'config', 'user.email', 'hud@example.invalid');
  writeFileSync(join(nested, 'file.txt'), 'base\n');
  writeFileSync(join(nested, '.gitattributes'), '*.txt filter=unsafe\n');
  commit(nested);
  writeFileSync(join(root, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n');
  commit(root);
  writeFileSync(join(nested, 'file.txt'), 'changed\n');
  git(nested, 'config', 'filter.unsafe.clean', 'echo invoked > FILTER_EXECUTED; cat');
  const result = await collectGitChanges(root);
  assert.equal(existsSync(join(nested, 'FILTER_EXECUTED')), false);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.files, []);
  await readGitDiff(root, {
    path: 'nested', index: ' ', worktree: 'M', added: null, removed: null, binary: false, conflict: false,
  });
  assert.equal(existsSync(join(nested, 'FILTER_EXECUTED')), false);
});

for (const operation of ['collect', 'preview']) {
  test(`${operation} does not fetch missing partial-clone blobs or write object packs`, async t => {
    const origin = repository(t);
    writeFileSync(join(origin, 'file.txt'), 'base\n');
    commit(origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    const directory = mkdtempSync(join(tmpdir(), 'hud-partial-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    git(directory, 'clone', '--no-checkout', '--filter=blob:none', pathToFileURL(origin).href, 'clone');
    const root = join(directory, 'clone');
    git(root, 'read-tree', 'HEAD');
    writeFileSync(join(root, 'file.txt'), 'changed\n');
    const packDirectory = join(root, '.git/objects/pack');
    const snapshot = () => readdirSync(packDirectory).sort().map(name => ({
      name, hash: createHash('sha256').update(readFileSync(join(packDirectory, name))).digest('hex'),
    }));
    const beforePacks = snapshot();
    const beforeIndex = readFileSync(join(root, '.git/index'));
    if (operation === 'collect') {
      const result = await collectGitChanges(root);
      assert.deepEqual(snapshot(), beforePacks);
      assert.ok(result.error, 'missing objects should report unavailable statistics');
      const file = result.files.find(file => file.path === 'file.txt');
      assert.ok(file);
      assert.equal(file.added, null);
      assert.equal(file.removed, null);
    } else {
      const preview = await readGitDiff(root, {
        path: 'file.txt', index: ' ', worktree: 'M', added: null, removed: null, binary: false, conflict: false,
      });
      assert.deepEqual(snapshot(), beforePacks);
      assert.match(preview.join('\n'), /unavailable/i);
    }
    assert.deepEqual(readFileSync(join(root, '.git/index')), beforeIndex);
  });
}

test('returns bounded previews for huge tracked changes', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'large'), 'base\n');
  commit(root);
  writeFileSync(join(root, 'large'), 'changed'.repeat(30000) + '\n');
  const result = await collectGitChanges(root);
  const preview = await readGitDiff(root, result.files[0]);
  assert.match(preview.join('\n'), /changed/);
  assert.match(preview.join('\n'), /truncat/i);
  assert.ok(preview.join('\n').length < 10000);
});

test('retains both diff sections when the staged patch exceeds the line budget', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'large'), 'base\n');
  commit(root);
  writeFileSync(join(root, 'large'), 'base\n' + 'staged\n'.repeat(700));
  git(root, 'add', '--', 'large');
  writeFileSync(join(root, 'large'), 'base\n' + 'staged\n'.repeat(700) + 'working\n');
  const result = await collectGitChanges(root);
  const preview = await readGitDiff(root, result.files[0]);
  assert.ok(preview.length <= 500);
  assert.match(preview.join('\n'), /Staged/);
  assert.match(preview.join('\n'), /Unstaged/);
  assert.match(preview.join('\n'), /\+working/);
});

test('rejects paths outside the repository and parent symlink traversal', async t => {
  const root = repository(t);
  const outside = mkdtempSync(join(tmpdir(), 'hud-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret'), 'secret-content');
  symlinkSync(outside, join(root, 'dir'));
  const file = { path: 'dir/secret', index: '?', worktree: '?', added: null, removed: null, binary: false, conflict: false };
  for (const path of ['dir/secret', '../secret', join(outside, 'secret')]) {
    const preview = (await readGitDiff(root, { ...file, path })).join('\n');
    assert.match(preview, /unavailable/i);
    assert.doesNotMatch(preview, /secret-content/);
  }
});
