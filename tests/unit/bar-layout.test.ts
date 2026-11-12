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
import { agentDefinitions, compactWindow } from '../../src/statusline-parity/collect.js';
import { shortModel } from '../../src/render/providers.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { makeHudData } from '../fixtures/hud-data.js';
import { NOW, OWNER_CONFIG } from '../fixtures/claude-hud-parity/fixture.js';
import { parityFixture, FOOTER_NOW } from '../fixtures/pi-footer.js';

const noColour = (t: test.TestContext) => {
  const previous = setDisplayConfig({
    theme: 'none',
    barFields: ['model', 'context', 'project', 'quota', 'notice', 'loaded'],
  });
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
  const f = parityFixture({ name: 'main', width: 120, settings: { band: { cost: false } } });
  t.after(() => f.dispose());
  f.statuses.clear();
  f.controller.setWork({
    needs: [],
    events: [agentEvent('started', { name: 'Explore' }, FOOTER_NOW - 20_000)],
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
  // model [effort] │ context (its meter is the first thing to go) │ repo branch │ [quota] │ notice (an agent's name, no
  // age), then what was loaded (which gives way to a long notice). pi's session cost is switched off here.
  const shape =
    /^[^│]+ │ (?:[█░]+ +)?\d+%\/[\d.]+[KM] │ [^│]+ │ (?:\d+[hd] (?:[█░]+ )?\d+%[^│]* │ )?◐ Explore(?: +MCP \d+  skills \d+)?$/;
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

test('notice zone: the newest two, steady over time, one per subject, needs-you pinned, three minutes, loaded gives way', (t) => {
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
  // Three events at 160 columns: the newest two, and the bar does not change while time passes (no rotation, no clock).
  assert.equal(zone({ events }, at), 'M │ ◐ started a │ ✓ finished b');
  for (const dt of [5000, 10_000, 60_000]) assert.equal(zone({ events }, at + dt), zone({ events }, at));
  // With too little room the newest alone shows, and stays.
  assert.match(zone({ events }, at, 25), /started a/);
  assert.equal(zone({ events }, at + 5000, 25), zone({ events }, at, 25));
  // A pinned item takes the first slot, the newest event the second.
  const needs = ['Work: 1 needs you'];
  assert.equal(zone({ events, needs }, at), 'M │ ! Work: 1 needs you │ ◐ started a');
  assert.equal(zone({ events, needs }, at + 5000), zone({ events, needs }, at));
  // One item per subject: `finished` replaces `started`, and nothing else is there.
  const same = [event('started', 'started a', 60_000, 'a'), event('done', 'finished a', 10_000, 'a')];
  assert.equal(zone({ events: same }, at), 'M │ ✓ finished a');
  // Three subagents of one name started: one item with ×3, not the name three times; a different kind stays apart.
  const three = [1, 2, 3].map((n) => agentEvent('started', { id: `fe${n}`, name: 'frontend-implementer', model: 'claude-sonnet-5-5' }, at - n * 1000));
  assert.equal(zone({ events: three }, at), 'M │ ◐ frontend-implementer [sonnet-5.5] ×3');
  const mixed = [...three.slice(0, 2), agentEvent('done', { id: 'fe3', name: 'frontend-implementer' }, at - 500)];
  assert.equal(zone({ events: mixed }, at), 'M │ ✓ frontend-implementer │ ◐ frontend-implementer [sonnet-5.5] ×2');
  // An event is shown at +2 minutes and gone at +4, and nothing replaces it.
  const old = [event('done', 'finished d', 0)];
  assert.match(zone({ events: old }, at + 120_000), /finished d$/);
  assert.equal(zone({ events: old }, at + NOTICE_MS + 60_000), 'M');
  // A notice shows in full: the loaded cluster gives way for it, and comes back with room (or with no notice).
  const loaded = { counts: [['MCP', 2]] as const };
  assert.match(zone({ events: old, loaded }, at, 30), /^M │ ✓ finished d +MCP 2$/);
  assert.equal(zone({ events: old, loaded }, at, 18), 'M │ ✓ finished d');
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
  assert.match(draw(transcript.skillLoads), /✦ skill hud-delegate/);
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
    rate_limits: { five_hour: { used_percentage: 8, resets_at: (NOW + 79 * 60_000) / 1000 } },
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

test('context and quota bars as claude-hud draws them: cells, colours, one window (the tightest), the shrink order', (t) => {
  noColour(t);
  const win = (label: string, percent: number, reset = '') => ({ label, percent, reset });
  const draw = (facts: BarFacts, width = 160) => renderBar({ model: { name: 'M' }, ...facts }, width, NOW).line;
  const context = { percent: 40, shown: '40%', window: 400_000 };
  const quota = { windows: [win('5h', 8, '1h19m')] };
  assert.equal(stripAnsi(draw({ context })), 'M │ ████░░░░░░ 40%/400K');
  assert.equal(stripAnsi(draw({ quota })), 'M │ 5h █░░░░░░░░░ 8% (1h19m)');
  // One window: the one with the least left; the first wins a tie.
  const both = (n: number) => stripAnsi(draw({ quota: { windows: [...quota.windows, win('7d', n, '2d')] } }));
  assert.match(both(5), /5h █░░░░░░░░░ 8% \(1h19m\)$/);
  assert.match(both(80), /│ 7d ████████░░ 80% \(2d\)$/);
  assert.doesNotMatch(both(80), /5h/);
  assert.match(both(8), /5h █░░░░░░░░░ 8% \(1h19m\)$/);
  assert.equal(stripAnsi(draw({ quota: { windows: [win('7d', 31, '2d')] } })), 'M │ 7d ███░░░░░░░ 31% (2d)');
  // Narrower: the context's bar goes, then the quota's reset, then its bar (leaving `5h 8%`), then the segments.
  const shrunk = [39, 31, 20, 12].map((w) => stripAnsi(draw({ context, quota }, w)).replace('M │ 40%/400K', '·'));
  assert.deepEqual(shrunk, ['· │ 5h █░░░░░░░░░ 8% (1h19m)', '· │ 5h █░░░░░░░░░ 8%', '· │ 5h 8%', '·']);
  // Colours (the terminal theme): the context green; the quota bright magenta from 75 (bright blue below, red from 90).
  setDisplayConfig({ theme: 'terminal' });
  const has = (facts: BarFacts, ...codes: string[]) => codes.every((code) => draw(facts).includes(code));
  assert.ok(has({ context }, '\x1b[32m████\x1b[0m', '\x1b[32m40%\x1b[0m'));
  assert.ok(has({ quota: { windows: [win('5h', 80)] } }, '\x1b[95m████████\x1b[0m', '\x1b[95m80%\x1b[0m'));
});

test('subagent notices: name, model, effort from the agent definition; the main effort outlives a long notice', (t) => {
  noColour(t);
  const dir = fs.mkdtempSync(join(tmpdir(), 'bar-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(join(dir, 'agents'));
  const definition = '---\nname: frontend-implementer\nmodel: sonnet\neffort: xhigh\n---\nBody\n';
  fs.writeFileSync(join(dir, 'agents', 'frontend-implementer.md'), definition);
  const base = { description: 'd', startPos: 1, background: false };
  const agents = [
    { ...base, id: 'a', type: 'frontend-implementer', model: 'claude-sonnet-5-5', start: NOW - 20_000 },
    { ...base, id: 'b', type: 'Explore', model: 'claude-haiku-4-5-20251001', start: NOW - 90_000, end: NOW - 60_000 },
  ];
  const definitions = agentDefinitions(agents, undefined, { CLAUDE_CONFIG_DIR: dir }, NOW);
  assert.deepEqual(definitions, { 'frontend-implementer': { model: 'sonnet', effort: 'xhigh' } });
  const input = {
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5' },
    effort: 'high',
    cwd: '/p/example',
    context_window: { used_percentage: 16, context_window_size: 1_000_000 },
    rate_limits: { five_hour: { used_percentage: 8, resets_at: (NOW + 79 * 60_000) / 1000 } },
  };
  const draw = (width: number, rest = {}) => {
    const transcript = { agents, todos: [], skills: [], ultracode: false, bytesRead: 0, pendingHistory: false };
    const evidence = {
      transcript: { ...transcript, ...rest },
      counts: { mcpCount: 4 },
      git: { branch: 'main', dirty: true, ahead: 0, behind: 0 },
      definitions,
    };
    return stripAnsi(renderParity(input, width, paritySettings(OWNER_CONFIG), evidence, NOW));
  };
  assert.match(
    draw(160),
    /^✻ opus-5\.5 high │ .* │ ◐ frontend-implementer \[sonnet-5\.5 · xhigh\] │ ✓ Explore \[haiku-4\.5\]/
  );
  // No effort: the model alone in the brackets.
  const events = [agentEvent('done', { name: 'reviewer', model: 'claude-haiku-4-5' }, NOW)];
  assert.equal(stripAnsi(renderBar({ model: { name: 'M' }, events }, 80, NOW).line), 'M │ ✓ reviewer [haiku-4.5]');
  // A long notice at 120 columns is cut at a word before the main model's effort goes.
  const skillLoads = [{ name: 'a-skill-with-a-very-long-name-that-cannot-fit-on-the-bar-at-all', at: NOW - 30_000 }];
  assert.match(draw(120, { agents: [], skillLoads }), /^✻ opus-5\.5 high │ .*✦ skill(?: hud-delegate|…)$/);
});

test('model names are short: route, vendor, date, build and window words go, version hyphens become dots', () => {
  const pairs =
    'claude-opus-5-5[1m]=opus-5.5 claude-haiku-4-5-20251001=haiku-4.5 gpt-6.1-sol=6.1-sol x/custom-2=custom-2';
  for (const pair of `${pairs} zai-glm-5-3-flash=5.3-flash deepseek-v4-1-flash-1017=v4.1-flash gemini-4-argon=4-argon`.split(
    ' '
  ))
    assert.equal(shortModel(pair.split('=')[0]), pair.split('=')[1]);
});
