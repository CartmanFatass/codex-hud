import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { headerScanner } from '../../dist/workflows/header-scan.js';
import { noticeEvents } from '../../dist/workflows/store.js';

test('quiet passes reuse parsed headers, but not delivery claims; a replaced or pruned receipt is not stale', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'workflow-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const flow = 'b0000000000000001', dir = join(home,'flows',flow), file = `${flow}.json`, path = `${dir}.json`;
  fs.mkdirSync(dir, { recursive: true });
  const row = { flow, state: 'completed', notices: { 'end-0': 'final' } };
  fs.writeFileSync(path, JSON.stringify(row));
  const scan = headerScanner(), first = scan(home).header(file);
  assert.equal(first, scan(home).header(file));
  const claim = noticeEvents(home, first)[0]; assert.deepEqual(noticeEvents(home, first), []);
  fs.unlinkSync(claim.marker); assert.deepEqual(noticeEvents(home, first), [claim]);
  fs.writeFileSync(path+'.tmp', JSON.stringify({ ...row, state: 'paused' })); fs.renameSync(path+'.tmp',path);
  assert.equal(scan(home).header(file).state, 'paused');
  fs.unlinkSync(path); const pass = scan(home);
  assert.ok(!pass.files.includes(file)); assert.equal(pass.header(file), null);
});
