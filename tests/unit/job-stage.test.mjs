import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { PanelJobPipeline } from '../../dist/panel/job-pipeline.js';
import { scope, stageJob, transcripts } from '../fixtures/job-stage.mjs';

const scratch = (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'job-stage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const stages = (home, options) => readThinJobs(home, scope, undefined, options).flatMap((lane) => lane.workers);

test('thin jobs follow appended tool calls in pi, stdout, Claude, Codex and agy; absent without evidence', (t) => {
  const home = scratch(t);
  const jobs = Object.keys(transcripts).map((format, i) => stageJob(home, i, format));
  const missing = stageJob(home, jobs.length, 'agy');
  const plain = stageJob(home, jobs.length + 1, 'agy-headless', 0);
  const symlink = stageJob(home, jobs.length + 2, 'pi-headless', 0);
  fs.writeFileSync(plain.path, 'read src.ts\nedit src.ts\n');
  fs.symlinkSync(jobs[0].path, symlink.path);
  const check = (want) => {
    const byId = new Map(stages(home).map((w) => [w.id, w]));
    for (const { id } of jobs) assert.equal(byId.get(id).stage, want, id);
    for (const { id } of [missing, plain, symlink]) assert.equal(Object.hasOwn(byId.get(id), 'stage'), false, id);
  };
  check('read');
  for (const job of jobs) fs.appendFileSync(job.path, job.records[1]);
  check('edit');
  for (const job of jobs) fs.appendFileSync(job.path, job.records[2]);
  check('test');
});

test('tail I/O is bounded at open, zero when unchanged, and exactly the appended bytes on growth', (t) => {
  const home = scratch(t);
  const { path, records } = stageJob(home, 1, 'pi');
  const history = '{"type":"text","text":"' + 'x'.repeat(128 * 1024) + '"}\n';
  fs.writeFileSync(path, history + records[0]);
  const open = fs.openSync, read = fs.readSync;
  let targetFd, bytes = 0, offsets = [];
  const opens = t.mock.method(fs, 'openSync', (p, ...args) => {
    const fd = open(p, ...args);
    if (p === path) targetFd = fd;
    else if (fd === targetFd) targetFd = undefined;
    return fd;
  });
  t.mock.method(fs, 'readSync', (fd, buf, offset, length, position) => {
    const n = read(fd, buf, offset, length, position);
    if (fd === targetFd && n) { bytes += n; offsets.push(position); }
    return n;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const stage = () => stages(home)[0].stage;
  assert.equal(stage(), 'read');
  assert.ok(bytes > 0 && bytes <= 32 * 1024 && offsets[0] > 0, 'only the initial bounded suffix was read');
  bytes = 0; offsets = [];
  const openCount = () => opens.mock.calls.filter(({ arguments: [p] }) => p === path).length;
  assert.equal(openCount(), 1);
  assert.equal(stage(), 'read');
  assert.equal(openCount(), 1, 'the unchanged transcript was not opened');
  assert.equal(bytes, 0);
  const offset = fs.statSync(path).size, record = Buffer.from(records[1]), split = record.indexOf(Buffer.from('图')) + 1;
  fs.appendFileSync(path, record.subarray(0, split));
  assert.equal(stage(), 'read', 'an unfinished JSON record preserves the last observed call');
  fs.appendFileSync(path, record.subarray(split));
  assert.equal(stage(), 'edit', 'the rest of the UTF-8 record completes the call');
  assert.equal(bytes, record.length);
  assert.deepEqual(offsets, [offset, offset + split]);
  fs.appendFileSync(path, JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [] } }) + '\n');
  assert.equal(stage(), 'edit', 'a tool result is not a new call');
  fs.appendFileSync(path, records[2].replace('npm run build', 'echo npm run build'));
  assert.equal(stage(), undefined, 'a latest tool with unrecognised intent is unknown');
  fs.writeFileSync(path, records[2]);
  assert.equal(stage(), 'test', 'same inode shrank');
  fs.writeFileSync(`${path}.new`, records[0]);
  fs.renameSync(`${path}.new`, path);
  assert.equal(stage(), 'read', 'replacement resets the cursor');
  fs.appendFileSync(path, history);
  assert.equal(stage(), undefined, 'no classification survives a gap in coverage');
  fs.appendFileSync(path, records[1]);
  assert.equal(stage(), 'edit');
});

test('stage disappears at the stall threshold and when a job settles', (t) => {
  const home = scratch(t), now = new Date();
  t.mock.timers.enable({ apis: ['Date'], now });
  const { path, dir, records } = stageJob(home, 1, 'pi-headless');
  for (const file of [path, join(dir, 'job.json'), join(dir, 'STATUS.json')]) fs.utimesSync(file, now, now);
  const worker = () => stages(home, { stallMinutes: 2 })[0];
  t.mock.timers.tick(119_999);
  assert.equal(worker().stage, 'read');
  t.mock.timers.tick(1);
  assert.equal(Object.hasOwn(worker(), 'stage'), false);
  fs.appendFileSync(path, records[2]);
  fs.utimesSync(path, new Date(), new Date());
  assert.equal(worker().stage, 'test');
  fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"done"}');
  assert.equal(Object.hasOwn(worker(), 'stage'), false);
});
