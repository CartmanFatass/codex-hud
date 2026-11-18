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
import { BAR_STYLES, setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { renderParity } from '../../src/statusline-parity/render.js';
import { compactWindow } from '../../src/statusline-parity/collect.js';
import { workSignals, type WorkSignals } from '../../src/render/work-summary.js';
import { BarNoticeTracker } from '../../src/collectors/bar-notices.js';
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
    events: [agentEvent('started', { name: 'Explore', title: 'Audit' }, FOOTER_NOW - 20_000)],
  });
  const codex = fitStatusBar(
    makeHudData({
      project: { ...makeHudData().project, skillsCount: 10 },
      notices: [{ kind: 'agent-started', subject: 'Explore', task: 'Audit', at: new Date(FOOTER_NOW - 20_000) }],
    }),
    DEFAULT_LAYOUT,
    120,
    FOOTER_NOW
  ).line;
  // model [effort] │ context (its meter is the first thing to go) │ repo branch │ [quota] │ notice (an agent's name, no
  // age), then what was loaded (which gives way to a long notice). pi's session cost is switched off here.
  const shape =
    /^[^│]+ │ (?:[█░]+ +)?\d+%\/[\d.]+[KM] │ [^│]+ │ (?:\d+[hd] (?:[█░]+ )?\d+%[^│]* │ )?◐ Explore Audit(?: +MCP \d+  skills \d+)?$/;
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
  // Narrower: the context's bar goes, then the quota's reset, then its bar (leaving `5h 8%`), then the segments.
  const shrunk = [39, 31, 20, 12].map((w) => stripAnsi(draw({ context, quota }, w)).replace('M │ 40%/400K', '·'));
  assert.deepEqual(shrunk, ['· │ 5h █░░░░░░░░░ 8% (1h19m)', '· │ 5h █░░░░░░░░░ 8%', '· │ 5h 8%', '·']);
  // Colours (the terminal theme): the context green; the quota bright magenta from 75 (bright blue below, red from 90).
  setDisplayConfig({ theme: 'terminal' });
  const has = (facts: BarFacts, ...codes: string[]) => codes.every((code) => draw(facts).includes(code));
  assert.ok(has({ context }, '\x1b[32m████\x1b[0m', '\x1b[32m40%\x1b[0m'));
  assert.ok(has({ quota: { windows: [win('5h', 80)] } }, '\x1b[95m████████\x1b[0m', '\x1b[95m80%\x1b[0m'));
});

// ─── What a notice says: the work, not the model (bar-notice 01) ─────────────────────────────────────────────────

/** A synthetic Claude transcript with the given Agent calls, drawn through the statusline's real renderer. */
function claudeBar(agents: Array<Record<string, unknown>>, width: number, now = NOW, work?: WorkSignals) {
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

test('HUD jobs read role + brief heading (else the package); two imps are two items; the run time is fixed', (t) => {
  noColour(t);
  const worker = (id: string, extra: Record<string, unknown>) =>
    ({ id: `thin-job:${id}`, role: 'imp', startedAt: NOW - 10_000, settledAt: null, work: {}, ...extra }) as never;
  const lane = (label: string, workers: unknown[]) => ({ id: `thin-job:package:${label}`, label, workers }) as never;
  const finished = worker('cccccc', { briefTitle: 'Fix the panel', startedAt: NOW - 725_000, settledAt: NOW - 5_000 });
  const lanes = [
    lane('pkg-a', [worker('aaaaaa', { briefTitle: '状态栏TPS' })]),
    lane('pkg-b', [worker('bbbbbb', {}), finished]),
  ];
  const zone = (jobs: unknown[], width = 160, at = NOW) =>
    stripAnsi(renderBar({ model: { name: 'M' }, events: workSignals(jobs as never, NOW).events }, width, at).line);
  // Two different imp jobs are two items; the finished one carries its run time, fixed at its end.
  assert.equal(zone([lanes[0]!, lane('pkg-b', [finished])]), 'M │ [✓] imp Fix the panel 12m │ [◐] imp 状态栏TPS');
  assert.equal(
    zone([lanes[0]!, lane('pkg-b', [finished])], 160, NOW + 60_000),
    'M │ [✓] imp Fix the panel 12m │ [◐] imp 状态栏TPS'
  );
  // No brief heading: the package names it.
  assert.equal(zone([lanes[1]!]), 'M │ [✓] imp Fix the panel 12m │ [◐] imp pkg-b');
  assert.doesNotMatch(zone(lanes), /sonnet|gpt|\[\d|×/);
  // The same words of one kind group; a package label that only repeats the role or the job id says nothing.
  assert.equal(
    zone([lane('pkg-a', [worker('d1', { briefTitle: 'Same' }), worker('d2', { briefTitle: 'Same' })])]),
    'M │ [◐] imp Same ×2'
  );
  assert.equal(zone([lane('imp', [worker('e1', {})]), lane('ffffff', [worker('ffffff', {})])]), 'M │ [◐] imp ×2');
});

/** A synthetic HUD job (a thin-job worker) and its lane, for `workSignals`. */
const hudJob = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id: `thin-job:${id}`, role: 'imp', startedAt: NOW - 10_000, settledAt: null, work: {}, ...extra }) as never;
const hudLane = (label: string, workers: unknown[]) => ({ id: `thin-job:package:${label}`, label, workers }) as never;

test('a pinned need names its job; several: the first and +N, then `N needs`; nothing open, nothing pinned', (t) => {
  noColour(t);
  const asking = (id: string, briefTitle: string) => hudJob(id, { briefTitle, homeNeedsHuman: true });
  const lanes = [
    hudLane('pkg', [asking('aaaaaa', '首页修正'), asking('bbbbbb', 'Fix the panel'), asking('cccccc', '状态栏TPS')]),
  ];
  assert.deepEqual(workSignals(lanes, NOW).needs, [
    'imp 首页修正 asks',
    'imp Fix the panel asks',
    'imp 状态栏TPS asks',
  ]);
  assert.deepEqual(workSignals([hudLane('pkg', [hudJob('dddddd')])], NOW).needs, []);
  const loaded = { counts: [['MCP', 4]] as const };
  const bar = (needs: string[], width: number) =>
    stripAnsi(
      renderBar(
        { model: { name: 'M', effort: 'high' }, context: { percent: 16, shown: '16%', window: 1e6 }, needs, loaded },
        width,
        NOW
      ).line
    );
  const three = workSignals(lanes, NOW).needs;
  // Wide, with the vitals; medium, the vitals shortened; narrow, the count only.
  assert.match(bar(three, 120), /^M high │ ██░░░░░░░░ 16%\/1M │ ! imp 首页修正 asks \+2 +MCP 4$/);
  assert.match(bar(three, 44), /^M high │ 16%\/1M │ ! imp 首页修正 asks \+2$/);
  assert.match(bar(three, 30), /^M high │ 16%\/1M │ ! 3 needs$/);
  // One need says its job alone; Codex's approvals join the same list.
  assert.match(bar(three.slice(0, 1), 120), /│ ! imp 首页修正 asks +MCP 4$/);
  assert.match(bar(['Approve: Bash', ...three.slice(0, 1)], 120), /│ ! Approve: Bash \+1 +MCP 4$/);
  assert.doesNotMatch(bar([], 120), /!/);
  // The p10k capsule and a look say the same.
  for (const style of ['p10k', 'gauge'] as const) {
    const draw = (width: number) =>
      stripAnsi(renderBar({ model: { name: 'M' }, needs: three }, width, NOW, style).line).replace(
        /[\ue0b0\ue0b2]/g,
        ''
      );
    assert.match(draw(120), /! imp 首页修正 asks \+2/);
    assert.match(draw(24), /! 3 needs/);
  }
});

/** The Claude subagent's events, as the statusline makes them. */
const claudeEvents = (a: { id: string; type: string; description: string; start: number }) => [
  agentEvent('started', { id: a.id, name: a.type, title: a.description }, a.start),
];

test('a HUD job and a Claude subagent differ in every look: a boxed mark `[◐]` against `◐`', (t) => {
  noColour(t);
  const jobs = workSignals([hudLane('pkg', [hudJob('aaaaaa', { briefTitle: '首页修正' })])], NOW);
  const sub = { id: 'a', type: 'Explore', description: 'Find where notices are made', start: NOW - 20_000 };
  assert.match(claudeBar([sub], 200, NOW, jobs), /│ \[◐\] imp 首页修正 │ ◐ Explore Find where notices are made/);
  // Finished or failed, the same: the state glyph stays, boxed for the job.
  const ended = workSignals(
    [
      hudLane('pkg', [
        hudJob('bbbbbb', { briefTitle: 'Fix', settledAt: NOW - 5000 }),
        hudJob('cccccc', { briefTitle: 'Bad', settledAt: NOW - 6000, work: { failed: true } }),
      ]),
    ],
    NOW
  );
  assert.match(claudeBar([], 200, NOW, ended), /│ \[✓\] imp Fix 5s │ \[✗\] imp Bad 4s/);
  // Every look carries it, in icons text too.
  for (const icons of ['unicode', 'text'] as const) {
    const previous = setDisplayConfig({ theme: 'terminal', icons, barFields: ['model', 'notice'] });
    t.after(() => setDisplayConfig(previous));
    for (const style of BAR_STYLES) {
      const row = stripAnsi(
        renderBar({ model: { name: 'M' }, events: [...jobs.events, ...claudeEvents(sub)] }, 120, NOW, style).line
      );
      assert.match(row, /\[◐\] imp/, `${style}/${icons}`);
      assert.match(row, /(^|[^\[])◐ Explore/, `${style}/${icons}`);
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

test('a long title is cut at a word in the line and capsule looks; the role stays, then the title goes', (t) => {
  const previous = setDisplayConfig({ theme: 'terminal', barFields: ['model', 'notice'] });
  t.after(() => setDisplayConfig(previous));
  const events = [
    agentEvent('done', { id: 'j', name: 'imp', title: 'Rework the notice zone of every bar' }, NOW - 1000, 754_000),
  ];
  for (const style of ['line', 'p10k'] as const) {
    const draw = (width: number) =>
      stripAnsi(renderBar({ model: { name: 'M' }, events }, width, NOW, style).line)
        .replace(/[\ue0b0\ue0b2]/g, '')
        .trim();
    assert.match(draw(120), /✓ imp Rework the notice zone of every bar 12m$/);
    assert.match(draw(30), /✓ imp Rework the… 12m$/);
    assert.match(draw(18), /✓ imp 12m$/);
    assert.match(draw(12), /✓ imp$/);
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
