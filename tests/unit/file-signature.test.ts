/**
 * The rollout re-parse guard rests entirely on this stamp: if it failed to
 * change after an append, the HUD would stop following a live session.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fileSignature } from '../../src/utils/file-signature.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-signature-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an append changes the signature', t => {
  const file = join(workspace(t), 'rollout.jsonl');
  writeFileSync(file, 'one\n');
  const before = fileSignature(file);
  assert.notEqual(before, null);

  appendFileSync(file, 'two\n');
  assert.notEqual(fileSignature(file), before);
});

test('a still file keeps the same signature', t => {
  const file = join(workspace(t), 'rollout.jsonl');
  writeFileSync(file, 'one\n');
  assert.equal(fileSignature(file), fileSignature(file));
});

test('a rename-over of identical content still changes the signature', t => {
  const root = workspace(t);
  const file = join(root, 'rollout.jsonl');
  const replacement = join(root, 'replacement.jsonl');
  writeFileSync(file, 'one\n');
  const before = fileSignature(file);

  writeFileSync(replacement, 'one\n');
  renameSync(replacement, file);
  // Size matches and mtime may not have ticked; the inode is what separates a
  // replaced file from an untouched one.
  assert.notEqual(fileSignature(file), before);
});

test('a missing file has no signature', t => {
  assert.equal(fileSignature(join(workspace(t), 'absent.jsonl')), null);
});
