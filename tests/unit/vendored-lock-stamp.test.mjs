import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

// The release archive ships the vendored node_modules with this stamp, so an offline ./install
// skips `npm ci`. Whoever changes package-lock.json reruns ./install (which rewrites the stamp)
// and commits it with the vendored tree.
test('vendored node_modules stamp matches package-lock.json', () => {
  const lock = createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');
  assert.equal(fs.readFileSync('node_modules/.hud-package-lock-hash', 'utf8').trim(), lock);
});
