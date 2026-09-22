/**
 * The machine-readable half of the HUD.
 *
 * Two things are pinned here. The snapshot is plain JSON and deterministic, so
 * a consumer diffing two of them sees what changed rather than what the clock
 * did. And the bar's segments describe the line that was actually drawn, which
 * is what lets a click at a column be answered with the field under it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSnapshot, snapshotFileName, SnapshotWriter, SNAPSHOT_VERSION } from '../../src/snapshot.js';
import { fitModules } from '../../src/render/layout/engine.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { stripAnsi, theme, visualLength } from '../../src/render/colors.js';
import { makeHudData, FIXED_NOW } from '../fixtures/hud-data.js';
import type { HudData } from '../../src/types.js';

const NOW = FIXED_NOW.getTime();

/** The same fit the renderer performs, with the clock held still. */
function fitAt(width: number, data: HudData = makeHudData()) {
  const modules = buildBarModules(data, { nowMs: NOW, barWidth: 10 });
  return fitModules(modules, { width, separator: theme.separator(' │ '), groupSeparator: '  ' });
}

function barAt(width: number, data: HudData = makeHudData()) {
  return { width, segments: fitAt(width, data).segments };
}

/** Column -> string index: a wide glyph is one column and two characters. */
function indexOfColumn(text: string, column: number): number {
  let columns = 0;
  for (let index = 0; index < text.length; index++) {
    if (columns >= column) {
      return index;
    }
    columns += visualLength(text[index]);
  }
  return text.length;
}

test('the snapshot is plain JSON and says the same thing twice', () => {
  const first = buildSnapshot(makeHudData(), barAt(160), NOW);
  const second = buildSnapshot(makeHudData(), barAt(160), NOW);

  assert.equal(first.version, SNAPSHOT_VERSION);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'nothing here survives a round trip by luck');
  assert.equal(first.updatedAt, FIXED_NOW.toISOString());
});

test('the snapshot reports what the fixture actually holds', () => {
  const snapshot = buildSnapshot(makeHudData(), barAt(160), NOW);

  assert.equal(snapshot.session?.id, 'root-session-id-0123456789');
  assert.equal(snapshot.session?.model, 'gpt-5.6-astra');
  assert.equal(snapshot.session?.effort, 'xhigh');
  assert.equal(snapshot.project.name, 'codex-hud');
  assert.equal(snapshot.project.branch, 'main');
  assert.equal(snapshot.project.dirty, true);
  assert.equal(snapshot.project.ahead, 2);
  assert.equal(snapshot.context?.percent, 42);
  assert.equal(snapshot.context?.total, 272000);
  assert.equal(snapshot.tokens?.total, 84000);
  assert.deepEqual(snapshot.quota.map((window) => window.label), ['5h', '7d']);
  assert.equal(snapshot.quota[0].percent, 61);
  assert.equal(snapshot.agents.active, 1);
  assert.equal(snapshot.agents.failed, 1);
  assert.deepEqual(snapshot.agents.nodes.map((node) => node.name), ['explorer', 'reviewer', '代码审查员']);
  assert.ok(snapshot.attention.some((item) => item.kind === 'agent-error' && item.severity === 'error'));
});

test('a field with no data is absent, not zero', () => {
  const empty = makeHudData({
    session: undefined,
    contextUsage: undefined,
    tokenUsage: undefined,
    rateLimits: undefined,
    activity: undefined,
    subagentTree: undefined,
    subagents: [],
    toolActivity: undefined,
    git: { branch: null, isDirty: false, isGitRepo: false, ahead: 0, behind: 0, modified: 0, added: 0, deleted: 0, untracked: 0 },
  });
  const snapshot = buildSnapshot(empty, barAt(80, empty), NOW);

  assert.equal('session' in snapshot, false);
  assert.equal('context' in snapshot, false);
  assert.equal('tokens' in snapshot, false);
  assert.equal('activity' in snapshot, false);
  assert.equal('branch' in snapshot.project, false, 'no repository is not a branch named ""');
  assert.deepEqual(snapshot.quota, []);
  assert.deepEqual(snapshot.agents.nodes, []);
  assert.deepEqual(snapshot.attention, []);
});

test('a running turn carries the tool the snapshot saw running', () => {
  const data = makeHudData({ activity: { state: 'working', updatedAt: FIXED_NOW, turnStartedAt: FIXED_NOW } });
  const snapshot = buildSnapshot(data, barAt(160, data), NOW);
  assert.equal(snapshot.activity?.state, 'working');
  assert.equal(snapshot.activity?.turnStartedAt, FIXED_NOW.toISOString());
  assert.deepEqual(snapshot.activity?.tool, { name: 'Edit', target: 'src/types.ts' });
});

test('each segment names the columns its own text occupies on the line', () => {
  for (const width of [40, 60, 80, 100, 120, 160, 200]) {
    const data = makeHudData();
    const fit = fitAt(width, data);
    const variants = new Map(
      buildBarModules(data, { nowMs: NOW, barWidth: 10 }).map((module) => [module.id, module.variants])
    );
    const plain = stripAnsi(fit.line);
    const snapshot = buildSnapshot(data, { width, segments: fit.segments }, NOW);

    assert.deepEqual(snapshot.bar.segments.map((s) => s.id), fit.kept, 'segments follow the kept order');
    assert.equal(snapshot.bar.width, width);

    for (const segment of snapshot.bar.segments) {
      assert.ok(segment.x >= 0, `${segment.id} starts before the line at ${width}`);
      assert.ok(
        segment.x + segment.width <= width,
        `${segment.id} runs past column ${width}: ${segment.x}+${segment.width}`
      );

      // The text the fit settled on really starts at the column claimed.
      const text = stripAnsi(variants.get(segment.id)![segment.level]!);
      const expected = plain.indexOf(text, indexOfColumn(plain, segment.x));
      if (!fit.clipped) {
        assert.equal(expected, indexOfColumn(plain, segment.x), `${segment.id} at width ${width}`);
        assert.equal(visualLength(text), segment.width, `${segment.id} width at ${width}`);
      }
    }

    // Reading order, and no two fields claiming the same column.
    for (let i = 1; i < snapshot.bar.segments.length; i++) {
      const previous = snapshot.bar.segments[i - 1];
      const current = snapshot.bar.segments[i];
      assert.ok(
        current.x >= previous.x + previous.width,
        `${previous.id} and ${current.id} overlap at width ${width}`
      );
    }
    assert.ok(visualLength(fit.line) <= width);
  }
});

test('a clipped line reports only the columns that are still on it', () => {
  // Six columns is narrower than the pinned alert's shortest form plus
  // anything else, so the line is truncated rather than merely shortened.
  const fit = fitAt(6);
  for (const segment of fit.segments) {
    assert.ok(segment.x < 6);
    assert.ok(segment.x + segment.width <= 6, `${segment.id} claims past the edge`);
  }
});

test('the file is written atomically, privately, and only when something changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hud-snapshot-'));
  const file = join(dir, 'nested', 'codex-hud-abc.json');
  try {
    const writer = new SnapshotWriter(file);
    const snapshot = buildSnapshot(makeHudData(), barAt(120), NOW);

    assert.equal(writer.write(snapshot, NOW), true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), snapshot);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'one session’s state is not another’s business');

    // Same content, later clock: nothing to say, so nothing is written.
    const later = buildSnapshot(makeHudData(), barAt(120), NOW + 60_000);
    assert.notEqual(later.updatedAt, snapshot.updatedAt);
    assert.equal(writer.write(later, NOW + 60_000), false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).updatedAt, snapshot.updatedAt);

    // Something changed, but less than a second after the last write.
    const quiet = makeHudData({ contextUsage: undefined });
    const changed = buildSnapshot(quiet, barAt(120, quiet), NOW + 500);
    assert.equal(writer.write(changed, NOW + 500), false);
    assert.equal(writer.write(changed, NOW + 2000), true);
    assert.equal('context' in JSON.parse(readFileSync(file, 'utf8')), false);

    writer.remove();
    assert.equal(existsSync(file), false, 'a HUD that stopped leaves no state behind');
    writer.remove();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session name that is not a filename still becomes one', () => {
  assert.equal(snapshotFileName('codex-hud-9f3a1c'), 'codex-hud-9f3a1c.json');
  assert.equal(snapshotFileName('proj/../../etc/passwd'), 'proj_.._.._etc_passwd.json');
  assert.equal(snapshotFileName(''), 'unnamed.json');
});
