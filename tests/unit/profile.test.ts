/**
 * The profiling switch. Off, it must be invisible: the wrapped work runs and
 * returns (or throws) as before and nothing is recorded. On, a window of
 * samples becomes one line per stage and starts over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProfileRecorder,
  formatProfileLine,
  percentile,
  profileLogPath,
  startProfiling,
  stopProfiling,
  summarizeStage,
  time,
  timeAsync,
  useProfileRecorder,
} from '../../src/utils/profile.js';

const AT = new Date('2026-10-04T10:00:00.000Z');

test('percentile is nearest-rank over sorted samples', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 95), 0);
});

test('a stage summary keeps count, average, p95 and max', () => {
  const summary = summarizeStage({ count: 4, totalMs: 10, maxMs: 6, samples: [6, 1, 2, 1] });
  assert.deepEqual(summary, { count: 4, avgMs: 2.5, p95Ms: 6, maxMs: 6 });
});

test('a profile line names the time, process, stage and numbers', () => {
  const line = formatProfileLine(AT, 'panel', 42, 'rollout.parse', { count: 10, avgMs: 0.123, p95Ms: 1.5, maxMs: 12.34 });
  assert.equal(line, '2026-10-04T10:00:00.000Z panel pid=42 rollout.parse n=10 avg=0.12ms p95=1.50ms max=12.3ms');
});

test('the recorder flushes one line per stage that ran, then starts a new window', () => {
  const written: string[][] = [];
  const recorder = new ProfileRecorder('bar', (lines) => written.push(lines), () => AT, 7);
  recorder.record('session.find', 2);
  recorder.record('render', 1);
  recorder.record('session.find', 4);

  const lines = recorder.flush();
  assert.deepEqual(lines, [
    '2026-10-04T10:00:00.000Z bar pid=7 render n=1 avg=1.00ms p95=1.00ms max=1.00ms',
    '2026-10-04T10:00:00.000Z bar pid=7 session.find n=2 avg=3.00ms p95=4.00ms max=4.00ms',
  ]);
  assert.deepEqual(written, [lines]);
  assert.deepEqual(recorder.flush(), [], 'an empty window writes nothing');
  assert.equal(written.length, 1);
});

test('a sink that throws does not reach the caller', () => {
  const recorder = new ProfileRecorder('bar', () => { throw new Error('disk full'); }, () => AT);
  recorder.record('tick', 1);
  assert.equal(recorder.flush().length, 1);
});

test('time and timeAsync pass results and errors through, recording only when on', async () => {
  useProfileRecorder(null);
  assert.equal(time('x', () => 5), 5);
  assert.equal(await timeAsync('x', async () => 6), 6);

  const recorder = new ProfileRecorder('test', () => {}, () => AT);
  useProfileRecorder(recorder);
  try {
    assert.equal(time('sync', () => 1), 1);
    assert.throws(() => time('sync', () => { throw new Error('boom'); }), /boom/);
    assert.equal(await timeAsync('async', async () => 2), 2);
    await assert.rejects(timeAsync('async', async () => { throw new Error('late'); }), /late/);
    const lines = recorder.flush();
    assert.equal(lines.length, 2);
    assert.match(lines[0], / async n=2 /, 'a failed call still took time');
    assert.match(lines[1], / sync n=2 /);
  } finally {
    useProfileRecorder(null);
  }
});

test('profiling stays off unless CODEX_HUD_PROFILE is 1, and writes no file then', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-profile-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(startProfiling('bar', {}), false);
    assert.equal(startProfiling('bar', { CODEX_HUD_PROFILE: '0' }), false);
    assert.equal(time('x', () => 1), 1);
    assert.equal(existsSync(join(home, 'hud')), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('on, the samples land in the HUD folder of the Codex home, never on stdout', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-profile-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(startProfiling('bar', { CODEX_HUD_PROFILE: '1' }), true);
    time('tick', () => 1);
    time('tick', () => 2);
    stopProfiling();
    const file = profileLogPath();
    assert.equal(file, join(home, 'hud', 'profile.log'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+Z bar pid=\d+ tick n=2 avg=\S+ms p95=\S+ms max=\S+ms$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(time('tick', () => 3), 3, 'stopped means off again');
  } finally {
    stopProfiling();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
