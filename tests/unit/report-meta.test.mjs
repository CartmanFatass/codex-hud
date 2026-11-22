import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedReportSignature, readReportMeta, writeReportMeta } from '../../dist/roles/report-meta.js';

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'report-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.md'),
    meta = join(dir, 'report-meta.json');
  const body = 'Synthetic report A.\n';
  fs.writeFileSync(report, body);
  const at = new Date('2026-11-22T08:00:00Z');
  fs.utimesSync(report, at, at);
  const sig = `${+at}:${Buffer.byteLength(body)}:${createHash('sha256').update(body).digest('hex')}`;
  return { dir, report, meta, at, sig };
}

test('report metadata is private, atomically replaced and invalidated by a same-size report rewrite', (t) => {
  const { dir, report, meta, at, sig } = fixture(t);
  assert.equal(cachedReportSignature(dir), sig);
  assert.equal(readReportMeta(dir), null);
  writeReportMeta(dir, sig, { summary: 'Synthetic result A.' }, at.toISOString());
  const before = fs.openSync(meta, 'r');
  try {
    const fields = { summary: 'Synthetic result B.', files: ['src/synthetic.ts'] };
    writeReportMeta(dir, sig, fields, at.toISOString());
    assert.equal(JSON.parse(fs.readFileSync(before, 'utf8')).summary, 'Synthetic result A.');
    assert.equal(fs.statSync(meta).mode & 0o777, 0o600);
    assert.deepEqual(readReportMeta(dir), { v: 1, at: at.toISOString(), report_sig: sig, ...fields });
  } finally {
    fs.closeSync(before);
  }
  fs.writeFileSync(report, 'Synthetic report B.\n');
  fs.utimesSync(report, at, at);
  assert.notEqual(cachedReportSignature(dir), sig);
  assert.equal(readReportMeta(dir), null);
  writeReportMeta(dir, sig, {});
  assert.equal(fs.existsSync(meta), false);
});

test('report metadata refuses symlinks, oversize bodies and invalid JSON/schema', (t) => {
  const { dir, meta, sig } = fixture(t);
  const valid = JSON.stringify({ v: 1, at: '2026-11-22T08:00:00Z', report_sig: sig, summary: 'Synthetic result' });
  const target = join(dir, 'not-meta.json');
  fs.writeFileSync(target, valid);
  fs.symlinkSync(target, meta);
  assert.equal(readReportMeta(dir), null);
  fs.unlinkSync(meta);
  for (const text of [
    valid.padEnd(16 * 1024 + 1),
    '{',
    valid.replace('"v":1', '"v":2'),
    valid.replace('"Synthetic result"', '12'),
  ]) {
    fs.writeFileSync(meta, text);
    assert.equal(readReportMeta(dir), null);
  }
  fs.writeFileSync(meta, valid);
  assert.equal(readReportMeta(dir)?.summary, 'Synthetic result');
});
