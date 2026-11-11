import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDisplayFixture } from '../fixtures/display.js';
import { fixture } from '../fixtures/job-progress-perf.js';
import { workInspectorRows } from '../../src/render/work-inspector.js';
import { stripAnsi } from '../../src/render/colors.js';
useDisplayFixture();

test('P3b production-shaped end to end: real collection, allowlisted material, model, persisted provenance, Work and Inspector', async (t) => {
  const f = await fixture(t, 1, true);
  assert.equal(f.progress.consentState(), 'denied');
  f.grant();
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1);
  const sent = f.payloads.join('\n');
  for (const privateText of ['PRIVATE_THINKING', 'PRIVATE_TOOL', 'PRIVATE_DESIGN', 'PRIVATE_ANSWER'])
    assert.ok(!sent.includes(privateText));
  assert.ok(sent.includes('Repair the public parser'));
  const note = f.progress.state().get(f.board.workers[0].id)?.note;
  assert.equal(note?.line, 'Repairing the public parser boundary.');
  assert.match(f.draw().lines.map(stripAnsi).join('\n'), /Repairing the public parser/);
  const detail = workInspectorRows(f.board.workers[0], f.state, 56, f.f.now(), true, { note })
    .map((r) => stripAnsi(r.text))
    .join('\n');
  assert.match(detail, /brief.md/);
  assert.match(detail, /src\/parser.ts/);
  const files = fs.readdirSync(path.join(f.f.home, 'derived', 'jobs-v1'));
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(f.f.home, 'derived', 'jobs-v1', files[0]), 'utf8');
  assert.match(saved, /recordFingerprint/);
  assert.ok(!saved.includes('synthetic-key-never-persist'));
  f.restart();
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1, 'restart restores a matching authorized note, no new transport');
  assert.equal(f.progress.state().get(f.board.workers[0].id)?.note?.line, note?.line);
});
