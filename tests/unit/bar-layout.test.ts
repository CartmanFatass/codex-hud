/**
 * The three bottom bars share one builder: the same fields in the same order, one line at every width, and one notice
 * zone that tells events (3 minutes each) and what needs the owner, nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentEvent, renderBar, NOTICE_MS, type BarFacts } from '../../src/render/layout/bar-fields.js';
import { fitStatusBar } from '../../src/render/header.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { renderParity } from '../../src/statusline-parity/render.js';
import { compactWindow } from '../../src/statusline-parity/collect.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { makeHudData } from '../fixtures/hud-data.js';
import { NOW, OWNER_CONFIG } from '../fixtures/claude-hud-parity/fixture.js';
import { parityFixture, FOOTER_NOW } from '../fixtures/pi-footer.js';

const noColour = (t: test.TestContext) => {
  const previous = setDisplayConfig({ theme: 'none', barFields: ['model', 'context', 'project', 'notice', 'loaded'] });
  t.after(() => setDisplayConfig(previous));
};

test('Claude, pi and Codex bars: the same segments in the same order, one row that fits, at 120 columns', (t) => {
  noColour(t);
  t.mock.method(Date, 'now', () => FOOTER_NOW);
  const transcript = {
    agents: [{ id: 'a', type: 'Explore', description: 'Audit', start: NOW - 20_000, startPos: 1, background: true }],
    todos: [],
    skills: ['hud-delegate'],
    ultracode: false,
    bytesRead: 0,
    pendingHistory: false,
  };
  const input = {
    model: { display_name: 'Opus 5.5' },
    effort: 'high',
    cwd: '/synthetic/project',
    context_window: { used_percentage: 4, context_window_size: 1_000_000 },
  };
  const claude = renderParity(
    input,
    120,
    paritySettings(OWNER_CONFIG),
    { transcript, counts: { mcpCount: 4 }, git: { branch: 'main', dirty: true, ahead: 0, behind: 0 } },
    NOW
  );
  const f = parityFixture({ name: 'main', width: 120 });
  t.after(() => f.dispose());
  f.statuses.clear();
  f.controller.setWork({
    needs: [],
    events: [agentEvent('started', { name: 'Explore', detail: 'Audit' }, FOOTER_NOW - 20_000)],
  });
  const codex = fitStatusBar(
    makeHudData({
      project: { ...makeHudData().project, skillsCount: 10 },
      notices: [{ kind: 'agent-started', subject: 'Explore', at: new Date(FOOTER_NOW - 20_000) }],
    }),
    DEFAULT_LAYOUT,
    120,
    FOOTER_NOW
  ).line;
  // model [effort] │ context (its meter is the first thing to go) │ repo branch │ notice, then what was loaded (which
  // gives way to a long notice).
  const shape =
    /^[^│]+ │ (?:[━╸─]+ +)?\d+%\/[\d.]+[KM] │ [^│]+ │ ◐ started Explore[^·]*· \d+s ago(?: +MCP \d+  skills \d+)?$/;
  for (const row of [claude, f.render()[0], codex]) {
    assert.match(stripAnsi(row), shape);
    assert.ok(visualWidth(row) <= 120 && !row.includes('\n'), 'one row that fits');
  }
  // Every field is optional, the order stays fixed; narrower, whole segments drop and none is cut.
  setDisplayConfig({ barFields: ['model', 'loaded'] });
  assert.match(stripAnsi(f.render()[0]), /^[^│]+ {3,}MCP \d+  skills \d+$/);
  setDisplayConfig({ barFields: ['model', 'context', 'project', 'notice', 'loaded'] });
  assert.ok(visualWidth(f.render(60)[0]) <= 60);
});

test('notice zone: two items at once, one per subject, needs-you pinned, three minutes, loaded gives way', (t) => {
  noColour(t);
  const at = 1_800_000_000_000 - (1_800_000_000_000 % 15_000);
  const event = (kind: 'started' | 'done' | 'failed', text: string, ago: number, key?: string) => ({
    kind,
    text,
    at: at - ago,
    key,
  });
  const events = [
    event('started', 'started a', 10_000),
    event('done', 'finished b', 20_000),
    event('failed', 'failed c', 30_000),
  ];
  const zone = (facts: BarFacts, now: number, width = 160) =>
    stripAnsi(renderBar({ model: { name: 'M' }, ...facts }, width, now).line);
  // Three events at 160 columns: the newest two, then after 5 s the pair advances (the third alone), then it cycles.
  assert.match(zone({ events }, at), /^M │ ◐ started a · 10s ago │ ✓ finished b · 20s ago$/);
  assert.match(zone({ events }, at + 5000), /^M │ ✗ failed c · 35s ago$/);
  assert.match(zone({ events }, at + 10_000), /started a · 20s ago │ ✓ finished b/);
  // With too little room one shows, and all take turns.
  const narrow = [0, 5000, 10_000].map(
    (dt) => zone({ events }, at + dt, 25).match(/started a|finished b|failed c/)?.[0]
  );
  assert.equal(new Set(narrow).size, 3);
  // A pinned item takes the first slot; the events take the second in turn.
  const needs = ['Work: 1 needs you'];
  assert.match(zone({ events, needs }, at), /^M │ ! Work: 1 needs you │ ◐ started a · 10s ago$/);
  assert.match(zone({ events, needs }, at + 5000), /^M │ ! Work: 1 needs you │ ✓ finished b/);
  // One item per subject: `finished` replaces `started`, and nothing else is there.
  const same = [event('started', 'started a', 60_000, 'a'), event('done', 'finished a', 10_000, 'a')];
  assert.equal(zone({ events: same }, at), 'M │ ✓ finished a · 10s ago');
  // An event is shown at +2 minutes and gone at +4, and nothing replaces it.
  const old = [event('done', 'finished d', 0)];
  assert.match(zone({ events: old }, at + 120_000), /finished d · 2m ago$/);
  assert.equal(zone({ events: old }, at + NOTICE_MS + 60_000), 'M');
  // A notice shows in full: the loaded cluster gives way for it, and comes back with room (or with no notice).
  const loaded = { counts: [['MCP', 2]] as const };
  assert.match(zone({ events: old, loaded }, at, 40), /^M │ ✓ finished d · 0s ago +MCP 2$/);
  assert.equal(zone({ events: old, loaded }, at, 28), 'M │ ✓ finished d · 0s ago');
  assert.match(zone({ events: [], loaded }, at, 28), /^M +MCP 2$/);
  // A background subagent that started 10 minutes ago and still runs is not an event; a skill load is, for three minutes.
  const transcript = {
    agents: [{ id: 'a', type: 'Explore', description: 'Audit', start: NOW - 600_000, startPos: 1, background: true }],
    todos: [],
    skills: ['hud-delegate'],
    skillLoads: [{ name: 'hud-delegate', at: NOW - 30_000 }],
    ultracode: false,
    bytesRead: 0,
    pendingHistory: false,
  };
  const draw = (loads: typeof transcript.skillLoads) =>
    stripAnsi(
      renderParity(
        { model: { display_name: 'M' }, cwd: '/p' },
        100,
        paritySettings(OWNER_CONFIG),
        { transcript: { ...transcript, skillLoads: loads }, counts: { mcpCount: 0 }, git: null },
        NOW
      )
    );
  assert.doesNotMatch(draw([]), /Explore/);
  assert.match(draw(transcript.skillLoads), /✦ skill hud-delegate · 30s ago/);
});

test('context is measured against where Claude and Codex compact, when their settings say so', (t) => {
  noColour(t);
  const dir = fs.mkdtempSync(join(tmpdir(), 'bar-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: dir, HOME: dir };
  assert.equal(compactWindow(env, 'claude-opus-5-5[1m]'), null);
  fs.writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ autoCompactWindow: 300000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } } })
  );
  assert.equal(compactWindow(env, 'claude-opus-5-5[1m]'), 400000);
  assert.equal(compactWindow(env, 'claude-sonnet-5-5'), 300000);
  const input = {
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus' },
    cwd: '/p',
    context_window: { used_percentage: 16, context_window_size: 1_000_000 },
  };
  const transcript = { agents: [], todos: [], skills: [], ultracode: false, bytesRead: 0, pendingHistory: false };
  const draw = (compact: number | null) =>
    stripAnsi(
      renderParity(
        input,
        100,
        paritySettings(OWNER_CONFIG),
        { transcript, counts: { mcpCount: 0 }, git: null, compact },
        NOW
      )
    );
  assert.match(draw(400000), /40%\/400K/);
  assert.match(draw(null), /16%\/1M/);
  const data = makeHudData({ config: { ...makeHudData().config, model_auto_compact_token_limit: 150_000 } });
  assert.match(stripAnsi(fitStatusBar(data, DEFAULT_LAYOUT, 120, FOOTER_NOW).line), /\/150K/);
});
