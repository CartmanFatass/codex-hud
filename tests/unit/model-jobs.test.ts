import test from 'node:test';
import assert from 'node:assert/strict';
import { changeSummaryInput, changeFingerprint, CHANGE_HUNK_CHARS } from '../../src/collectors/model-jobs.js';
import type { GitChangedFile } from '../../src/collectors/git-changes.js';

test('the change summary sends the stat of every file and hunks up to a bound; untracked files by name only', () => {
  const files: GitChangedFile[] = [
    { path: 'src/a.ts', index: 'M', worktree: ' ', added: 3, removed: 1, binary: false, conflict: false },
    { path: 'new.txt', index: '?', worktree: '?', added: null, removed: null, binary: false, conflict: false },
  ];
  const sent = changeSummaryInput(files, `@@ -1 +1 @@\n${'z'.repeat(CHANGE_HUNK_CHARS + 500)}`);
  assert.match(sent, /^<diff>\nM  src\/a\.ts \+3 -1\n\?\? new\.txt\n/);
  assert.match(sent, /more hunks omitted/);
  assert.ok(sent.length < CHANGE_HUNK_CHARS + 300);
  assert.notEqual(changeFingerprint(files), changeFingerprint([{ ...files[0], added: 4 }, files[1]]));
});
