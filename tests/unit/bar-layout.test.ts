/**
 * The three bottom bars share one builder: the same fields in the same order, one line at every width, and one notice
 * zone: native approvals, machine-wide HUD load and the client's own recent events.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentEvent, renderBar, NOTICE_MS, type BarFacts } from '../../dist/render/layout/bar-fields.js';
import { fitStatusBar } from '../../dist/render/header.js';
import { BAR_STYLES, setDisplayConfig } from '../../dist/render/hud-config.js';

// These tests are about layout and draw the Unicode set.
setDisplayConfig({ icons: 'unicode' });
import { stripAnsi, visualWidth } from '../../dist/render/colors.js';
import { renderParity } from '../../dist/statusline-parity/render.js';
import { compactWindow } from '../../dist/statusline-parity/collect.js';
import type { MachineWorkCounts } from '../../dist/collectors/work-summary-snapshot.js';
import { BarNoticeTracker } from '../../dist/collectors/bar-notices.js';
import { readEvenQuotaNotices } from '../../dist/collectors/even-quota.js';
import { markExhausted } from '../../dist/roles/roster.js';
import { formatMachineWork } from '../../dist/render/work-summary.js';
import { shortModel } from '../../dist/render/providers.js';
import { paritySettings } from '../../dist/statusline-parity/settings.js';
import { DEFAULT_LAYOUT } from '../../dist/types.js';
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
    agents: [],
    todos: [],
    skills: ['hud-delegate'],
    ultracode: false,
    bytesRead: 0,
    pendingHistory: false,
  };
  const work = { running: 1, queued: 0, roles: { imp: { running: 1, asking: 0 } } };
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
    NOW,
    {},
    work
  );
  const f = parityFixture({ name: 'main', width: 120, env: { HUD_ICONS: 'unicode' }, settings: { band: { cost: false } } });
  t.after(() => f.dispose());
  f.statuses.clear();
  f.controller.setWork(work);
  const codex = fitStatusBar(
    makeHudData({
      project: { ...makeHudData().project, skillsCount: 10 },
      work,
    }),
    DEFAULT_LAYOUT,
    120,
    FOOTER_NOW
  ).line;
  // Client facts, then machine-wide load, then what was loaded. pi's session cost is off.
  const shape =
    /^[^│]+ │ (?:[█░]+ +)?\d+%\/[\d.]+[KM] │ [^│]+ │ (?:\d+[hd] (?:[█░]+ )?\d+%[^│]* │ )?⚒1(?: +MCP \d+  skills \d+)?$/;
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

test('even quota goes between approval and HUD load in all bar looks until the preset rejoins', (t) => {
  noColour(t);
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-even-quota-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.mkdirSync(join(home, 'roles'));
  const pi = (model: string) => ({ harness: 'pi', model: `synthetic/${model}` });
  const fast = pi('fast'), small = pi('small'), backup = pi('backup');
  fs.writeFileSync(join(home, 'roles', 'imp.json'), JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true,
    run: [backup], presets: [{ name: 'multi', run: [fast, backup] }, { name: 'fast', run: [fast] }] }));
  fs.writeFileSync(join(home, 'roles', 'sonic.json'), JSON.stringify({ role: 'sonic', instructions: 'sonic', can_continue: false,
    run: [small], presets: [{ name: 'small', run: [small] }] }));
  const env = { HOME: home, HUD_HOME: home, PATH: bin };
  fs.writeFileSync(join(home, 'hud-settings.json'), JSON.stringify({ impPlacement: 'even', impEvenPool: ['multi', 'fast'],
    sonicPlacement: 'even', sonicEvenPool: ['small'] }));
  const now = 1_800_000_000_000;
  markExhausted(home, 'pi:synthetic/fast', 'quota; retry in 10m', now);
  markExhausted(home, 'pi:synthetic/small', 'quota; retry in 20m', now);
  const evenQuota = readEvenQuotaNotices(home, home, now, env);
  assert.deepEqual(evenQuota?.map(({ role, preset }) => [role, preset]), [['imp', 'fast'], ['sonic', 'small']],
    'a preset with a usable standby stays in the pool');
  const work = { running: 1, queued: 0, roles: { imp: { running: 1, asking: 0 } } };
  const facts = { model: { name: 'M' }, needs: ['Approve: Bash'], evenQuota, work };
  for (const theme of ['mocha', 'none'] as const) {
    for (const [icons, mark] of [['unicode', '⚠'], ['emoji', '⚠'], ['text', '!'], ['nerd', '\uf071']] as const) {
      setDisplayConfig({ theme, icons });
      for (const style of BAR_STYLES) {
        const render = (at: number, width = 120) => stripAnsi(renderBar(facts, width, at, style).line);
        const line = render(now);
        const note = line.indexOf(`${mark} imp fast: quota +1`);
        const approval = line.indexOf('Approve: Bash');
        assert.ok(approval >= 0 && note > approval && line.indexOf(formatMachineWork(work, now)) > note, line);
        assert.ok(!line.includes('sonic small'), line);
        assert.ok(render(now + 600_000).includes(`${mark} sonic small: quota`));
        assert.doesNotMatch(render(now + 1_200_000), /: quota/);
        for (const width of [1, 8, 22, 40]) assert.ok(visualWidth(render(now, width)) <= width);
      }
    }
  }
  assert.equal(readEvenQuotaNotices(home, home, now + 1_200_000, env), undefined);
  setDisplayConfig({ barFields: ['model'] });
  assert.doesNotMatch(stripAnsi(renderBar(facts, 120, now).line), /: quota/);

  const clock = t.mock.method(Date, 'now', () => now);
  const piFooter = parityFixture({ name: 'even quota', width: 120, env: { ...env, HUD_ICONS: 'unicode' } });
  t.after(() => piFooter.dispose());
  piFooter.controller.setWork(work);
  assert.match(stripAnsi(piFooter.render()[0]), /⚠ imp fast: quota \+1/);
  clock.mock.mockImplementation(() => now + 1_200_000);
  piFooter.controller.setWork(work);
  assert.doesNotMatch(stripAnsi(piFooter.render()[0]), /: quota/);
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
  const needs = ['Approve: Bash'];
  assert.equal(zone({ events, needs }, at), 'M │ ! Approve: Bash │ ◐ started a');
  assert.equal(zone({ events, needs }, at + 5000), zone({ events, needs }, at));
  // One item per subject: `finished` replaces `started`, and nothing else is there.
  const same = [event('started', 'started a', 60_000, 'a'), event('done', 'finished a', 10_000, 'a')];
  assert.equal(zone({ events: same }, at), 'M │ ✓ finished a');
  // Three subagents of one name started: one item with ×3, not the name three times; a different kind stays apart.
  const three = [1, 2, 3].map((n) =>
    agentEvent('started', { id: `fe${n}`, name: 'frontend-implementer' }, at - n * 1000)
  );
  assert.equal(zone({ events: three }, at), 'M │ ◐ frontend-implementer ×3');
  const mixed = [...three.slice(0, 2), agentEvent('done', { id: 'fe3', name: 'frontend-implementer' }, at - 500)];
  assert.equal(zone({ events: mixed }, at), 'M │ ✓ frontend-implementer │ ◐ frontend-implementer ×2');
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
  // Narrower: both bars go together, then the quota's reset, then the context's window (`40%`), then the quota itself.
  const shrunk = [49, 28, 27, 19, 14].map((w) => stripAnsi(draw({ context, quota }, w)));
  assert.deepEqual(shrunk, [
    'M │ 40%/400K │ 5h 8% (1h19m)',
    'M │ 40%/400K │ 5h 8% (1h19m)',
    'M │ 40%/400K │ 5h 8%',
    'M │ 40% │ 5h 8%',
    'M │ 40%',
  ]);
  // Colours (the terminal theme): the context green; the quota bright magenta from 75 (bright blue below, red from 90).
  setDisplayConfig({ theme: 'terminal' });
  const has = (facts: BarFacts, ...codes: string[]) => codes.every((code) => draw(facts).includes(code));
  assert.ok(has({ context }, '\x1b[32m████\x1b[0m', '\x1b[32m40%\x1b[0m'));
  assert.ok(has({ quota: { windows: [win('5h', 80)] } }, '\x1b[95m████████\x1b[0m', '\x1b[95m80%\x1b[0m'));
});

// ─── What a notice says: the work, not the model (bar-notice 01) ─────────────────────────────────────────────────

/** A synthetic Claude transcript with the given Agent calls, drawn through the statusline's real renderer. */
function claudeBar(agents: Array<Record<string, unknown>>, width: number, now = NOW, work?: MachineWorkCounts) {
  const base = { startPos: 1, background: false };
  const transcript = {
    agents: agents.map((a) => ({ ...base, ...a })),
    todos: [],
    skills: [],
    ultracode: false,
    bytesRead: 0,
    pendingHistory: false,
  };
  const input = {
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5' },
    effort: 'high',
    cwd: '/p/example',
    context_window: { used_percentage: 16, context_window_size: 1_000_000 },
  };
  const evidence = { transcript, counts: { mcpCount: 4 }, git: null } as unknown as Parameters<typeof renderParity>[3];
  return stripAnsi(renderParity(input, width, paritySettings(OWNER_CONFIG), evidence, now, undefined, work));
}

test('Claude subagents read type + the call description; a finished one carries its fixed run time; no model', (t) => {
  noColour(t);
  const agents = [
    {
      id: 'a',
      type: 'frontend-implementer',
      description: 'Tidy the notice zone',
      model: 'claude-sonnet-5-5',
      start: NOW - 20_000,
    },
    {
      id: 'b',
      type: 'Explore',
      description: 'Find where notices are made',
      model: 'claude-haiku-4-5',
      start: NOW - 790_000,
      end: NOW - 60_000,
    },
  ];
  const wide = claudeBar(agents, 200);
  assert.match(wide, /│ ◐ frontend-implementer Tidy the notice zone │ ✓ Explore Find where notices are made 12m\b/);
  assert.doesNotMatch(wide, /sonnet|haiku|xhigh|\[/);
  // The run time is fixed at the end: the bar a minute later is the same line.
  assert.equal(claudeBar(agents, 200, NOW + 60_000), wide);
  // Two Agent calls of one type with different descriptions are two items, not `×2`.
  const two = claudeBar(
    [agents[0]!, { ...agents[0]!, id: 'c', description: 'Check the docs', start: NOW - 30_000 }],
    200
  );
  assert.match(two, /◐ frontend-implementer Tidy the notice zone │ ◐ frontend-implementer Check the docs/);
  assert.doesNotMatch(two, /×/);
  // No description: the type alone, nothing guessed.
  assert.match(claudeBar([{ ...agents[0]!, description: '' }], 200), /│ ◐ frontend-implementer +MCP 4$/);
  // Narrow: the title is cut at a word, the type stays; then the title goes and the type stays.
  assert.match(claudeBar([agents[0]!], 70), /│ ◐ frontend-implementer Tidy the…$/);
  assert.match(claudeBar([agents[0]!], 62), /│ ◐ frontend-implementer$/);
});

test('machine load omits zeros and fits whole icon/count groups', (t) => {
  noColour(t);
  const bar = (work?: MachineWorkCounts, width = 80) => renderBar({ model: { name: 'M' }, work }, width, NOW).line;
  assert.equal(bar(), 'M');
  assert.equal(bar({ running: 0, queued: 0, roles: {} }), 'M');
  assert.equal(bar({ running: 0, queued: 2, roles: {} }), 'M │ ◷2');
  const count = (running: number) => ({ running, asking: 0 });
  const work = { running: 19, queued: 2, roles: { sonic: count(4), unknown: count(1), other: count(2),
    reviewer: count(1), oracle: count(1), general: count(2), imp: count(3), 'frontend-imp': count(5) } };
  const roles = '⚒3  ✎5  ✦2  ◈1  ⚖1  •3  ⚡4';
  assert.equal(bar(work), `M │ ${roles}  ◷2`);
  const tight = `M │ ${roles.replaceAll('  ', ' ')}`;
  assert.equal(bar(work, visualWidth(`${tight} ◷2`)), `${tight} ◷2`);
  assert.equal(bar(work, visualWidth(tight)), tight);
  assert.equal(bar(work, visualWidth(tight) - 1), 'M');
});

const twoWorkers = { running: 2, queued: 1, roles: { imp: { running: 2, asking: 0 } } };

test('native approvals stay pinned before machine load; `N needs` when several do not fit', (t) => {
  noColour(t);
  const loaded = { counts: [['MCP', 4]] as const };
  const work = twoWorkers;
  const bar = (needs: string[], width: number) =>
    stripAnsi(
      renderBar(
        { model: { name: 'M', effort: 'high' }, context: { percent: 16, shown: '16%', window: 1e6 }, needs, work, loaded },
        width,
        NOW
      ).line
    );
  const needs = ['Approve: Bash', 'Approve: Edit', 'Approve: Write'];
  assert.match(bar(needs, 120), /│ ! Approve: Bash \+2 │ ⚒2  ◷1 +MCP 4$/);
  assert.match(bar(needs.slice(0, 1), 120), /│ ! Approve: Bash │ ⚒2  ◷1/);
  assert.match(bar(needs, 25), /! 3 needs │ ⚒2 ◷1$/);
  assert.doesNotMatch(bar([], 120), /\bneeds\b|asks|!1/);
  setDisplayConfig({ theme: 'terminal' });
  const capsule = (width: number) =>
    stripAnsi(renderBar({ model: { name: 'M' }, needs, work }, width, NOW, 'p10k').line).replace(/[\ue0b0\ue0b2]/g, '');
  assert.match(capsule(120), /! Approve: Bash \+2.*⚒2  ◷1/);
  assert.match(capsule(17), /! 3 needs/);
  assert.doesNotMatch(capsule(17), /⚒|◷/);
});

/** The Claude subagent's events, as the statusline makes them. */
const claudeEvents = (a: { id: string; type: string; description: string; start: number }) => [
  agentEvent('started', { id: a.id, name: a.type, title: a.description }, a.start),
];

test('machine load and a Claude subagent appear side by side in both looks', (t) => {
  noColour(t);
  const work = twoWorkers;
  const sub = { id: 'a', type: 'Explore', description: 'Find where notices are made', start: NOW - 20_000 };
  assert.match(claudeBar([sub], 200, NOW, work), /│ ⚒2  ◷1 │ ◐ Explore Find where notices are made/);
  for (const icons of ['unicode', 'text'] as const) {
    const previous = setDisplayConfig({ theme: 'terminal', icons, barFields: ['model', 'notice'] });
    t.after(() => setDisplayConfig(previous));
    for (const style of BAR_STYLES) {
      const row = stripAnsi(
        renderBar({ model: { name: 'M' }, work, events: claudeEvents(sub) }, 120, NOW, style).line
      );
      assert.ok(row.includes(icons === 'text' ? 'I2  Q1' : '⚒2  ◷1'), `${style}/${icons}`);
      assert.match(row, /◐ Explore/, `${style}/${icons}`);
    }
  }
});

test('Codex subagents read name + task when known, with the run time they ended at; no model', (t) => {
  noColour(t);
  const node = (status: string, extra = {}) =>
    ({
      id: 'n1',
      name: 'explorer',
      role: 'explorer',
      task: 'Search the notice code',
      status,
      startedAt: new Date(NOW - 700_000),
      model: 'gpt-5.6-sol',
      effort: 'high',
      children: [],
      ...extra,
    }) as never;
  const data = (nodes: unknown[]) =>
    makeHudData({
      session: { id: 's1' } as never,
      subagentTree: { rootId: 's1', nodes: nodes as never, totalCount: nodes.length, updatedAt: new Date(NOW) },
    });
  const tracker = new BarNoticeTracker();
  tracker.observe(data([]), NOW - 800_000);
  const nameless = node('running', { id: 'n2', name: 'worker', role: 'worker', task: undefined });
  const started = tracker.observe(data([node('running'), nameless]), NOW - 690_000);
  assert.deepEqual(started.map((n) => [n.subject, n.task]).sort(), [
    ['explorer', 'Search the notice code'],
    ['worker', undefined],
  ]);
  const done = tracker.observe(data([node('completed'), nameless]), NOW);
  assert.equal(done[0]!.kind, 'agent-done');
  assert.equal(done[0]!.ranMs, 700_000);
  assert.deepEqual(
    Object.keys(done[0]!).filter((k) => /model|effort/.test(k)),
    []
  );
  const line = stripAnsi(fitStatusBar(makeHudData({ notices: done }), DEFAULT_LAYOUT, 160, NOW).line);
  assert.match(line, /✓ explorer Search the notice code 11m/);
  assert.doesNotMatch(line, /sol|\[/);
});

test('a long subagent title is cut at a word in the line and capsule looks; the type stays, then the title goes', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal', barFields: ['model', 'notice'] });
  t.after(() => setDisplayConfig(previous));
  const events = [
    agentEvent('done', { id: 'j', name: 'Explore', title: 'Rework the notice zone of every bar' }, NOW - 1000, 754_000),
  ];
  for (const style of ['line', 'p10k'] as const) {
    const draw = (width: number) =>
      stripAnsi(renderBar({ model: { name: 'M' }, events }, width, NOW, style).line)
        .replace(/[\ue0b0\ue0b2]/g, '')
        .trim();
    assert.match(draw(120), /✓ Explore Rework the notice zone of every bar 12m$/);
    assert.match(draw(34), /✓ Explore Rework the… 12m$/);
    assert.match(draw(22), /✓ Explore 12m$/);
    assert.match(draw(16), /✓ Explore$/);
    for (let width = 1; width <= 60; width++) assert.ok(visualWidth(draw(width)) <= width);
  }
});

test('model names are short: route, vendor, date, build and window words go, version hyphens become dots', () => {
  const pairs =
    'claude-opus-5-5[1m]=opus-5.5 claude-haiku-4-5-20251001=haiku-4.5 gpt-6.1-sol=6.1-sol x/custom-2=custom-2';
  for (const pair of `${pairs} zai-glm-5-3-flash=5.3-flash deepseek-v4-1-flash-1017=v4.1-flash gemini-4-argon=4-argon`.split(
    ' '
  ))
    assert.equal(shortModel(pair.split('=')[0]), pair.split('=')[1]);
});
