/**
 * The health record: what lets a person tell "the session is quiet" from
 * "the HUD cannot read". Absent until something happens, bounded however
 * long it runs, and never rewriting the state file just because time passed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HudHealth, errorText } from '../../src/collectors/hud-health.js';
import { HudStatus } from '../../src/collectors/hud-status.js';
import { healthLine, renderSettingsPage } from '../../src/render/settings-page.js';
import { buildSnapshot, SnapshotWriter } from '../../src/snapshot.js';
import { colors, stripAnsi, theme, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { defaultSettings } from '../../src/settings.js';
import { makeHudData, FIXED_NOW } from '../fixtures/hud-data.js';

const NOW = FIXED_NOW.getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000);
const bar = { width: 80, segments: [] };

test('an error is kept as its first line, cut to a bounded length', () => {
  assert.equal(errorText(new Error("EACCES: permission denied, open '/x'\n    at open (node:fs)")), "EACCES: permission denied, open '/x'");
  assert.equal(errorText('plain  text'), 'plain text');
  const long = errorText(new Error('x'.repeat(1000)));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(errorText(new Error('')), 'Error');
});

test('the record starts empty and keeps one read time and one error', () => {
  const health = new HudHealth();
  assert.deepEqual(health.current(), {});
  health.read(ago(10));
  health.fail('rollout', new Error('first'), ago(5));
  health.fail('session', new Error('second'), ago(3));
  health.read(ago(1));
  assert.deepEqual(health.current(), {
    lastReadAt: ago(1),
    lastError: { source: 'session', message: 'second', at: ago(3) },
  });
});

test('the health row says when the HUD last read, and a current failure stands out', () => {
  assert.equal(healthLine(undefined, NOW), null);
  assert.equal(healthLine({}, NOW), null, 'no data is no row, not "never"');
  assert.equal(healthLine({ lastReadAt: ago(3) }, NOW), colors.dim('Last read 3s ago'));

  const failing = healthLine({ lastReadAt: ago(120), lastError: { source: 'rollout', message: 'EACCES', at: ago(2) } }, NOW);
  assert.equal(failing, theme.warning('Last read 2m ago · Session read failed 2s ago: EACCES'));

  const recovered = healthLine({ lastReadAt: ago(1), lastError: { source: 'git', message: 'boom', at: ago(600) } }, NOW);
  assert.equal(recovered, colors.dim('Last read 1s ago · Git failed 10m ago: boom'), 'an old failure is history');

  const never = healthLine({ lastError: { source: 'session', message: 'ENOENT', at: ago(4) } }, NOW);
  assert.equal(stripAnsi(never ?? ''), 'No read yet · Session lookup failed 4s ago: ENOENT');

  const previous = setLanguage('zh');
  try {
    assert.equal(stripAnsi(healthLine({ lastReadAt: ago(3) }, NOW) ?? ''), '上次读取 3s前');
  } finally {
    setLanguage(previous);
  }
});

test('the settings page carries the health row above the help, within its width', () => {
  const state = { draft: defaultSettings(), selected: 0, offset: 0, message: '' };
  const plain = renderSettingsPage(state, 30, 12);
  const health = { lastReadAt: ago(3), lastError: { source: 'rollout', message: 'x'.repeat(80), at: ago(1) } };
  for (const width of [16, 30, 60]) {
    const frame = renderSettingsPage(state, width, 12, { state: health, nowMs: NOW });
    const text = frame.lines.map(stripAnsi);
    assert.equal(frame.lines.length, 12);
    assert.ok(frame.lines.every((line) => visualLength(line) <= width), `width ${width}`);
    assert.ok(text.at(-3)?.startsWith('Last read'.slice(0, width)), text.join('\n'));
    assert.equal(frame.rowCount, plain.rowCount - 1, 'the row costs one setting row, not the help');
  }
  assert.equal(renderSettingsPage(state, 30, 12, { state: {}, nowMs: NOW }).rowCount, plain.rowCount);
  assert.equal(renderSettingsPage(state, 30, 3, { state: health, nowMs: NOW }).lines.length, 3, 'a tiny page keeps its controls');
});

test('the snapshot carries health only when there is some, and not as a clock', () => {
  assert.equal('health' in buildSnapshot(makeHudData(), bar, NOW), false);

  const read = buildSnapshot(makeHudData({ health: { lastReadAt: ago(1) } }), bar, NOW);
  assert.deepEqual(read.health, { lastReadAt: ago(1).toISOString() });

  const failed = buildSnapshot(makeHudData({ health: { lastError: { source: 'rollout', message: 'EIO', at: ago(2) } } }), bar, NOW);
  assert.deepEqual(failed.health, { lastError: { source: 'rollout', message: 'EIO', at: ago(2).toISOString() } });

  const dir = mkdtempSync(join(tmpdir(), 'hud-health-'));
  try {
    const writer = new SnapshotWriter(join(dir, 'state.json'));
    assert.equal(writer.write(read, NOW), true);
    const later = buildSnapshot(makeHudData({ health: { lastReadAt: ago(-5) } }), bar, NOW + 5000);
    assert.equal(writer.write(later, NOW + 5000), false, 'another successful read is not a change');
    const broken = buildSnapshot(makeHudData({ health: { lastReadAt: ago(-5), lastError: { source: 'session', message: 'gone', at: ago(-6) } } }), bar, NOW + 6000);
    assert.equal(writer.write(broken, NOW + 6000), true, 'a new failure is');
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).health.lastError.message, 'gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shared status build carries the record, absent until fed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hud-health-cwd-'));
  const status = new HudStatus(cwd);
  const empty = status.build({ rollout: null, stale: false });
  assert.equal('health' in empty, false);
  status.health.read(ago(0));
  assert.deepEqual(status.build({ rollout: null, stale: false }).health, { lastReadAt: ago(0) });
});
