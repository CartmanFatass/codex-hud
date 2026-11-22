import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileBounded, readJsonBounded, writePrivateFile } from '../../dist/utils/atomic-fs.js';

function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'atomic-fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creates private directories and replaces a file without modifying the old inode', (t) => {
  const dir = join(directory(t), 'private'), file = join(dir, 'state');
  writePrivateFile(file, 'old');
  const old = fs.openSync(file, 'r');
  try {
    const published = writePrivateFile(file, 'new');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file).ino, published.ino);
    assert.equal(fs.readFileSync(old, 'utf8'), 'old');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ['state']);
  } finally { fs.closeSync(old); }
});

test('failed rename and failed exclusive publication leave only the original target', (t) => {
  const dir = directory(t), file = join(dir, 'state');
  fs.mkdirSync(file);
  assert.throws(() => writePrivateFile(file, 'new'));
  assert.deepEqual(fs.readdirSync(dir), ['state']);
  fs.rmdirSync(file);
  writePrivateFile(file, 'first', { exclusive: true });
  assert.throws(() => writePrivateFile(file, 'second', { exclusive: true }), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(dir), ['state']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
});

test('a rejected compare-and-swap does not publish or leave a temporary file', (t) => {
  const dir = directory(t), file = join(dir, 'state');
  writePrivateFile(file, 'before');
  const changed = new Error('changed');
  assert.throws(() => writePrivateFile(file, 'after', { beforeRename() { throw changed; } }), (e) => e === changed);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(dir), ['state']);
});

test('bounded reads distinguish a complete file from a prefix and refuse symlinks by default', (t) => {
  const dir = directory(t), file = join(dir, 'value'), link = join(dir, 'link');
  fs.writeFileSync(file, '[123]');
  assert.deepEqual(readJsonBounded(file, 5), [123]);
  assert.equal(readFileBounded(file, 5).truncated, false);
  assert.equal(readFileBounded(file, 4).bytes.toString(), '[123');
  assert.equal(readFileBounded(file, 4).truncated, true);
  assert.throws(() => readJsonBounded(file, 4), /too_large/);
  fs.symlinkSync(file, link);
  assert.throws(() => readFileBounded(link, 5), { code: 'ELOOP' });
});
