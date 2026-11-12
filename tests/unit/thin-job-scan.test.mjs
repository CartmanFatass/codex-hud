import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
test('300 jobs: unchanged scan parses no receipts; a changed job appears next scan', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { project: null, pane: 'synthetic' };
  let parses = 0;
  const parse = (text) => {
    const value = JSON.parse(text);
    if (value?.job) parses++;
    return value;
  };
  for (let n = 0; n < 300; n++) {
    const job = `j${n.toString(16).padStart(16, '0')}`;
    const dir = join(home, 'jobs', job);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job,
        role: 'imp',
        herdr_pane: scope.pane,
        created_at: new Date(n * 1000).toISOString(),
      })
    );
    for (const [name, text] of [
      ['STATUS.json', '{"state":"closed"}'],
      ['brief.md', '# Synthetic'],
      ['report.md', 'Synthetic result'],
    ])
      fs.writeFileSync(join(dir, name), text);
  }
  const workers = () => readThinJobs(home, scope, parse).flatMap((lane) => lane.workers);
  const first = workers();
  assert.equal(first.length, 200);
  assert.equal(parses, 300);
  parses = 0;
  assert.deepEqual(workers(), first);
  assert.equal(parses, 0);
  const file = join(home, 'jobs', 'j000000000000012b', 'job.json');
  const changed = { ...JSON.parse(fs.readFileSync(file)), model: 'synthetic-new-model' };
  fs.writeFileSync(file + '.tmp', JSON.stringify(changed));
  fs.renameSync(file + '.tmp', file);
  assert.equal(workers()[0].model, changed.model);
  assert.equal(parses, 1);
});
