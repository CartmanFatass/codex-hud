/**
 * Design §4.1: the bar with a delegation tree. The samples in the design are
 * hand-set (their fields are narrower than the engine's reserved columns, and
 * the notice zone claims 32 columns), so the delegation-owned fields are
 * compared exactly and the line around them is checked for what the engine
 * guarantees: the alert survives every width, nothing overflows, the backend
 * counts go first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../fixtures/paths.js';
import { stripAnsi, theme, visualLength } from '../../src/render/colors.js';
import { setDisplayConfig, type Density } from '../../src/render/hud-config.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { fitStatusBar, renderHud } from '../../src/render/header.js';
import { DEFAULT_LAYOUT, type HudData } from '../../src/types.js';
import type { HudDelegationData } from '../../src/core/link/view-model.js';
import { projectDelegation, ProjectionCache } from '../../src/render/delegation/projection.js';
import { alertForms, delegationAlerts, delegationNotice } from '../../src/render/delegation/alerts.js';
import { noticeSentence } from '../../src/render/delegation/bar.js';
import { PUT_AWAY_MS } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { FIXED_NOW, at, makeHudData } from '../fixtures/hud-data.js';
import { fit, sessionData } from '../fixtures/b10b-bar.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationD,
  situationE,
  situationH,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';

const layout = { ...DEFAULT_LAYOUT, mode: 'compact' as const };
const text = (value: string): string => stripAnsi(value);
const squash = (value: string): string => text(value).replace(/\s+/g, ' ').trim();

test('§4.1 at 200 columns: the alert leads, the agents count the whole tree, the backends follow', () => {
  const tick = NOW + 90_000; // the approval has waited 100 s: no longer a notice
  const result = fit(sessionData(situationC().vm, tick), 200, 'full', { tickMs: tick });
  assert.equal(
    squash(result.line),
    '⚑ review-tests approval │ fable-5.1 high │ ━━━━────── 112.3K/272K │ parser-kit main*↑2 │ 7d 61% │ ▸ 3:10 │ 38 tok/s │ Agents 3▸ 1⚑ 1✓ · ⌬2 π1 ◎1 │ Tasks 2/5 MCP 2 skills 9'
  );
  assert.equal(visualLength(result.line), 200);
  assert.deepEqual(result.kept.slice(0, 2), ['attention', 'identity'], 'the alert is the first field');
  assert.equal(result.levels.agents, 'full');
});

test('§4.1 at 120 columns (balanced): the same alert, the counts without the backends', () => {
  const tick = NOW + 90_000;
  const result = fit(sessionData(situationC().vm, tick), 120, 'balanced', { tickMs: tick });
  const line = squash(result.line);
  assert.ok(line.startsWith('⚑ review-tests approval │ fable-5.1'), line);
  assert.match(line, /3▸ 1⚑ 1✓/);
  assert.doesNotMatch(line, /⌬/, 'backend counts are for the full density at 160 columns and up');
  assert.ok(visualLength(result.line) <= 120);
});

test('§4.1 at 80 columns: the alert is still the first field, in its short form, and the counts stay', () => {
  const tick = NOW + 90_000;
  const result = fit(sessionData(situationC().vm, tick), 80, 'balanced', { tickMs: tick });
  assert.ok(squash(result.line).startsWith('⚑ 1 approval │ fable-5.1'), squash(result.line));
  assert.match(squash(result.line), /3▸ 1⚑ 1✓$/);
  assert.ok(visualLength(result.line) <= 80);
  assert.ok(result.kept.includes('attention') && result.kept.includes('agents'));
});

test('the focus density keeps the counts when there is a delegation tree, and only then (rulings round 2, Q1)', () => {
  const tick = NOW + 90_000;
  const focus = fit(sessionData(situationC().vm, tick), 80, 'focus', { tickMs: tick });
  // Without the quota and speed fields the line has room: the alert keeps its full form beside the counts.
  assert.ok(squash(focus.line).startsWith('⚑ review-tests approval │ fable-5.1'), squash(focus.line));
  assert.match(squash(focus.line), /3▸ 1⚑ 1✓$/, 'counts only: the label shrinks away as at 80 columns');
  assert.doesNotMatch(text(focus.line), /Agents/);
  assert.ok(focus.kept.includes('agents'));
  assert.ok(visualLength(focus.line) <= 80);
  // Counts only at every width: the label is never drawn in the focus density (design §4.1).
  for (const width of [40, 60, 80, 100, 120, 160, 200, 240]) {
    const result = fit(sessionData(situationC().vm, tick), width, 'focus', { tickMs: tick });
    assert.doesNotMatch(text(result.line), /Agents/, `${width}: ${text(result.line)}`);
    assert.ok(visualLength(result.line) <= width);
    if (width >= 60) assert.match(squash(result.line), /3▸ 1⚑ 1✓/, `${width}: counts`);
  }
  const roomy = buildBarModules(sessionData(situationC().vm, tick), { density: 'focus', nowMs: tick, width: 240 });
  const agents = roomy.find((m) => m.id === 'agents')!;
  assert.deepEqual(Object.keys(agents.variants), ['full'], 'one form, no label');
  assert.equal(text(agents.variants.full!), '3▸ 1⚑ 1✓');

  // Without a tree (no `delegation`, or null) the focus density is what it always was: no `agents` field.
  for (const delegation of [undefined, null] as const) {
    const legacy = fit({ ...sessionData(situationC().vm, tick), delegation }, 80, 'focus', { tickMs: tick });
    assert.ok(!legacy.kept.includes('agents'), `delegation ${String(delegation)}`);
    assert.ok(!text(legacy.line).includes('3▸'));
  }

  // A tree with nothing to count adds nothing, even in the focus density.
  const { vm: bare } = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }]);
  const empty = fit(sessionData(bare, tick), 80, 'focus', { tickMs: tick });
  assert.doesNotMatch(text(empty.line), /\d▸/, 'no counts to show'); // `▸` alone is the activity clock
  assert.ok(!empty.kept.includes('agents'));
});

test('with a delegation tree the counts outlast the quota at 80 columns, in situations (c), (d), (e) and (h)', () => {
  const tick = NOW + 90_000;
  const expectations: Array<[string, () => ReturnType<typeof situationC>, RegExp, RegExp]> = [
    ['c', situationC, /^⚑ review-tests approval {1,2}│/, /3▸ 1⚑ 1✓$/],
    ['d', situationD, /^⚑1 \?1 · slots 6\/6 {1,2}│/, /3▸ 1· 1⚑ 1\? 9✓$/],
    ['e', situationE, /^⚑1 \?3 ⚠1 {1,2}│/, /1▸ 1⚑ 3\? 1⚠$/],
    ['h', situationH, /^⚑ 1 stop in pane {1,2}│/, /2▸ 1⚑ 1✓$/],
  ];
  for (const [name, build, head, counts] of expectations) {
    const result = fit(sessionData(build().vm, tick), 80, 'focus', { tickMs: tick });
    const line = text(result.line).trim();
    assert.match(line, head, `${name}: ${line}`);
    assert.match(line, counts, `${name}: ${line}`);
    assert.ok(visualLength(result.line) <= 80, `${name}: overflow`);
    assert.ok(result.kept.includes('agents'), `${name}: counts hidden`);
  }
  // The balanced density agrees, with the quota in play: the counts still outlast it.
  for (const [name, build] of [
    ['c', situationC],
    ['d', situationD],
    ['e', situationE],
    ['h', situationH],
  ] as const) {
    const balanced = fit(sessionData(build().vm, tick), 80, 'balanced', { tickMs: tick });
    assert.ok(balanced.kept.includes('agents'), `${name}: counts hidden at balanced`);
  }
  // The legacy order is untouched without a tree: the agents are among the first to go (priority 70, not 87).
  const legacy = fit({ ...sessionData(situationC().vm, tick), delegation: undefined }, 80, 'balanced', {
    tickMs: tick,
  });
  assert.ok(!text(legacy.line).includes('3▸'));
});

test('the alert survives every pane width, in every density', () => {
  for (const density of ['focus', 'balanced', 'full'] as const)
    for (const [name, build] of [
      ['C', situationC],
      ['D', situationD],
      ['E', situationE],
      ['H', situationH],
    ] as const) {
      const data = sessionData(build().vm, NOW);
      for (let width = 6; width <= 220; width += 1) {
        const result = fit(data, width, density);
        assert.ok(result.kept.includes('attention'), `${name} ${density} ${width}: lost the alert`);
        assert.ok(visualLength(result.line) <= width, `${name} ${density} ${width}: overflow`);
        assert.ok(
          /[⚑?⚠✗]/.test(text(result.line)),
          `${name} ${density} ${width}: no alert mark in ${text(result.line)}`
        );
      }
    }
});

test('the backend counts go before anything else gives up room, and only from 160 columns of the full density', () => {
  const tick = NOW + 90_000;
  const data = sessionData(situationC().vm, tick);
  const at160 = buildBarModules(data, { density: 'full', width: 160, nowMs: tick });
  assert.match(text(at160.find((m) => m.id === 'agents')!.variants.full!), /⌬2 π1 ◎1/);
  const at159 = buildBarModules(data, { density: 'full', width: 159, nowMs: tick });
  assert.doesNotMatch(text(at159.find((m) => m.id === 'agents')!.variants.full!), /⌬/);
  const balanced = buildBarModules(data, { density: 'balanced', width: 200, nowMs: tick });
  assert.doesNotMatch(text(balanced.find((m) => m.id === 'agents')!.variants.full!), /⌬/);

  // Squeeze the full line a column at a time: the backends are the first thing to go, and the
  // right cluster is still whole when only they had to.
  const widths = [];
  for (let width = 230; width >= 130; width--) {
    const result = fit(data, width, 'full', { tickMs: tick });
    widths.push({
      width,
      backends: /⌬2 π1 ◎1/.test(text(result.line)),
      config: result.kept.includes('config'),
      agents: result.levels.agents,
    });
  }
  const lost = widths.find((entry) => !entry.backends)!;
  assert.ok(lost.width > 130 && lost.width < 200, `the backends go once the line is tight: ${lost.width}`);
  assert.ok(
    widths.filter((entry) => entry.width > lost.width).every((entry) => entry.backends),
    'wider, they are there'
  );
  assert.equal(lost.agents, 'short');
  assert.equal(lost.config, true, 'the right cluster is still there when only the backends had to go');
  const next = widths.find((entry) => entry.width === lost.width - 1)!;
  assert.equal(next.backends, false);
});

test('the agents count covers the whole tree: natives and jobs, not the root', () => {
  const { vm } = situationC({ reviewPass: true });
  const proj = projectDelegation(vm, new ProjectionCache());
  // impl-parser, scout (native), ask-pro (job) working; review-tests waiting; docs-sync and review-pass done.
  assert.deepEqual(
    { working: proj.counts.working, flag: proj.counts.flag, done: proj.counts.done },
    { working: 3, flag: 1, done: 2 }
  );
  const modules = buildBarModules(sessionData(vm, NOW), { density: 'balanced', nowMs: NOW, width: 120 });
  assert.equal(text(modules.find((m) => m.id === 'agents')!.variants.full!), 'Agents 3▸ 1⚑ 2✓');
});

test('alert forms: one alert says itself in full, then in a count, then in a glyph', () => {
  const alerts = (build: () => ReturnType<typeof situationC>) =>
    delegationAlerts(projectDelegation(build().vm, new ProjectionCache()), NOW, plainSay);
  const one = alertForms(alerts(situationC), plainSay, false)!;
  assert.deepEqual(one, { full: '⚑ review-tests approval', short: '⚑ 1 approval', min: '⚑1' });
  const stop = alertForms(alerts(situationH), plainSay, false)!;
  assert.deepEqual(stop, { full: '⚑ impl-parser stop in pane', short: '⚑ 1 stop in pane', min: '⚑1' });
  const many = alertForms(alerts(situationE), plainSay, false)!;
  assert.deepEqual(many, { full: '⚑1 ?3 ⚠1', short: '⚑1 ?3 ⚠1', min: '⚑1' });
});

test('alert forms: the counts narrow to the class that matters most, ⚑ > ✗ > ⚠ > ?, and display in their own order', () => {
  const forms = (specs: NodeSpec[]) => {
    const { vm } = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }, ...specs]);
    return alertForms(delegationAlerts(projectDelegation(vm, new ProjectionCache()), NOW, plainSay), plainSay, false)!;
  };
  const unc = (id: string): NodeSpec => ({
    id,
    parent: 'main',
    run: { state: 'uncertain', reconciliation: 'scope_unknown' },
    status: { cls: 'uncertain', since: ago(15) },
  });
  const bad = (id: string): NodeSpec => ({ id, parent: 'main', status: S.failed(ago(10)) });
  const flag = (id: string): NodeSpec => ({ id, parent: 'main', status: S.pending('approval', ago(20)) });

  // Uncertain x3 and a failure: the display keeps ⚑ ? ⚠ ✗, the narrowest is the failure. (`?3 ⚠1 ✗1` narrows
  // the same way; the warn class needs a conflicting child, which the direct form below stands in for.)
  const failed = forms([unc('u1'), unc('u2'), unc('u3'), bad('f')]);
  assert.equal(failed.full, '?3 ✗1');
  assert.equal(failed.min, '✗1');
  // A person waiting outranks the failure.
  const both = forms([flag('p'), bad('f1'), bad('f2')]);
  assert.equal(both.full, '⚑1 ✗2');
  assert.equal(both.min, '⚑1');
  // Only uncertain ones: the narrowest is theirs.
  assert.equal(forms([unc('u1'), unc('u2')]).min, '?2');
  // The three classes of the ruling's example, and the slots beside them: the narrowest keeps both, node first.
  const mixed = alertForms(
    {
      nodes: [
        { key: 'a', cls: 'uncertain', name: 'a', word: 'uncertain', at: null },
        { key: 'b', cls: 'uncertain', name: 'b', word: 'uncertain', at: null },
        { key: 'c', cls: 'uncertain', name: 'c', word: 'uncertain', at: null },
        { key: 'd', cls: 'warn', name: 'd', word: 'conflict', at: null },
        { key: 'e', cls: 'fail', name: 'e', word: 'failed', at: null },
      ],
      slots: { held: 6, limit: 6, toClose: 0, toReconcile: 0 },
    },
    plainSay,
    false
  )!;
  assert.equal(mixed.full, '?3 ⚠1 ✗1 · slots 6/6');
  assert.equal(mixed.min, '✗1 6/6');
  const noFail = alertForms(
    {
      nodes: [
        { key: 'a', cls: 'uncertain', name: 'a', word: 'uncertain', at: null },
        { key: 'd', cls: 'warn', name: 'd', word: 'conflict', at: null },
        { key: 'f', cls: 'warn', name: 'f', word: 'conflict', at: null },
      ],
      slots: null,
    },
    plainSay,
    false
  )!;
  assert.equal(noFail.full, '?1 ⚠2');
  assert.equal(noFail.min, '⚠2', 'warn outranks uncertain');
});

test('alert forms: the standing slots alert is not a node and keeps its three forms', () => {
  // (d) with the approval and the uncertain run answered: only the full slots remain.
  const { vm } = buildVm(
    [
      { id: 'main', root: true, harness: 'claude', status: S.working() },
      ...['a', 'b', 'c', 'd'].map((id): NodeSpec => ({
        id,
        parent: 'main',
        harness: 'pi',
        status: S.working(ago(300)),
      })),
      {
        id: 'u',
        parent: 'a',
        harness: 'codex',
        run: { state: 'uncertain', reconciliation: 'scope_unknown' },
        status: S.working(ago(300)),
      },
    ],
    { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4, uncertain: 1 } }
  );
  const proj = projectDelegation(vm, new ProjectionCache());
  const forms = alertForms(delegationAlerts(proj, NOW, plainSay), plainSay, false)!;
  // The uncertain node is a node alert; it counts, and the slots follow it without a mark of their own (the
  // badge already leads with one, rulings round 2, Q3).
  assert.equal(forms.full, '? u uncertain · slots 6/6 · 1 to reconcile');
  assert.equal(forms.short, '? 1 uncertain · slots 6/6');
  assert.equal(forms.min, '?1 6/6');

  const { vm: slotsOnly } = buildVm(
    [
      { id: 'main', root: true, harness: 'claude', status: S.working() },
      { id: 'a', parent: 'main', harness: 'pi', status: S.working(ago(60)) },
    ],
    { capacity: { active: 6, limit: 6, mine: 1, mineLimit: 4, uncertain: 1 } }
  );
  const only = alertForms(
    delegationAlerts(projectDelegation(slotsOnly, new ProjectionCache()), NOW, plainSay),
    plainSay,
    false
  )!;
  assert.deepEqual(only, { full: '⚑ slots 6/6 · 1 to reconcile', short: '⚑ slots 6/6', min: '⚑ 6/6' });

  // The owner's limit counts when it is the one that is met.
  const { vm: mine } = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }], {
    capacity: { active: 4, limit: 6, mine: 4, mineLimit: 4 },
  });
  const owner = alertForms(
    delegationAlerts(projectDelegation(mine, new ProjectionCache()), NOW, plainSay),
    plainSay,
    false
  )!;
  assert.equal(owner.short, '⚑ slots 4/4');

  // Not full: no slots alert at all.
  const { vm: roomy } = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }], {
    capacity: { active: 2, limit: 6, mine: 2, mineLimit: 4 },
  });
  assert.equal(
    alertForms(delegationAlerts(projectDelegation(roomy, new ProjectionCache()), NOW, plainSay), plainSay, false),
    null
  );
});

test('alert precedence: a person first, then failures, conflicts, uncertain; the newest of a kind first', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'old-flag', parent: 'main', status: S.pending('approval', ago(300)) },
    { id: 'new-flag', parent: 'main', status: S.pending('question', ago(20)) },
    {
      id: 'unc',
      parent: 'main',
      run: { state: 'uncertain', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', since: ago(15) },
    },
    { id: 'bad', parent: 'main', status: S.failed(ago(10)) },
  ]);
  const alerts = delegationAlerts(projectDelegation(vm, new ProjectionCache()), NOW, plainSay);
  assert.deepEqual(
    alerts.nodes.map((a) => `${a.cls}:${a.name}`),
    ['flag:new-flag', 'flag:old-flag', 'fail:bad', 'uncertain:unc']
  );
  assert.equal(alertForms(alerts, plainSay, false)!.full, '⚑2 ?1 ✗1');
});

test('a failure lights the bar only while its row is on the list', () => {
  const finished = (secondsAgo: number) =>
    buildVm([
      { id: 'main', root: true, harness: 'claude', status: S.working() },
      {
        id: 'lint-fix',
        parent: 'main',
        harness: 'pi',
        run: { state: 'ended', endedAt: ago(secondsAgo) },
        status: S.exited(ago(secondsAgo)),
        report: { status: 'failed', summary: 'Lint rule 12 unresolved.', at: ago(secondsAgo) },
      },
    ]).vm;
  const lit = (secondsAgo: number) =>
    delegationAlerts(projectDelegation(finished(secondsAgo), new ProjectionCache()), NOW, plainSay).nodes.length;
  assert.equal(lit(60), 1);
  assert.equal(lit(PUT_AWAY_MS / 1000 - 1), 1);
  assert.equal(lit(PUT_AWAY_MS / 1000 + 1), 0, 'history is not a to-do (§3.2)');
});

test('a conflicting child is one alert however many parents claim it', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'other', parent: 'main', harness: 'claude', status: S.working() },
    {
      id: 'impl-c',
      parent: 'main',
      alsoClaimedBy: ['other'],
      relationOnly: true,
      conflict: { count: 2, since: ago(360) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.equal(proj.counts.warn, 1);
  const alerts = delegationAlerts(proj, NOW, plainSay);
  assert.equal(alerts.nodes.filter((a) => a.cls === 'warn').length, 1);
});

test("notices: the newest delegation event of the last minute, with the design's words", () => {
  const notice = (build: () => ReturnType<typeof buildVm>, tick = NOW) =>
    delegationNotice(projectDelegation(build().vm, new ProjectionCache()), tick, plainSay);
  const reported = (visible: boolean, pane = visible) =>
    buildVm([
      { id: 'main', root: true, harness: 'claude', status: S.working() },
      {
        id: 'docs-sync',
        parent: 'main',
        run: { state: 'running', mode: visible ? 'visible' : 'headless' },
        status: S.exited(ago(20)),
        report: { status: 'completed', summary: 'Done.', at: ago(20) },
        pane: pane ? 'pane 5' : undefined,
      },
    ]);
  assert.deepEqual(
    notice(() => reported(false)),
    { kind: 'reported', glyph: 'done', text: 'docs-sync reported', at: ago(20) }
  );
  assert.equal(notice(() => reported(true))!.text, 'docs-sync reported · close its pane');
  assert.equal(notice(() => reported(true))!.kind, 'closePane');

  const failed = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'lint-fix', parent: 'main', harness: 'pi', status: S.failed(ago(5)) },
  ]);
  assert.equal(
    delegationNotice(projectDelegation(failed.vm, new ProjectionCache()), NOW, plainSay)!.text,
    'lint-fix failed'
  );

  const uncertain = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'impl-b',
      parent: 'main',
      run: { state: 'uncertain', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', since: ago(8) },
    },
  ]);
  assert.equal(
    delegationNotice(projectDelegation(uncertain.vm, new ProjectionCache()), NOW, plainSay)!.text,
    'impl-b uncertain'
  );

  const approval = situationC().vm;
  assert.equal(
    delegationNotice(projectDelegation(approval, new ProjectionCache()), NOW, plainSay)!.text,
    'review-tests approval'
  );

  // The cancel was accepted 120 s before NOW: told once, inside its minute.
  const stop = situationH().vm;
  assert.equal(
    delegationNotice(projectDelegation(stop, new ProjectionCache()), NOW - 80_000, plainSay)!.text,
    'impl-parser still running · stop in its pane'
  );
  assert.equal(delegationNotice(projectDelegation(stop, new ProjectionCache()), NOW, plainSay), null, 'and not again');

  const quiet = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'bench', parent: 'main', run: { state: 'ended', endedAt: ago(30) }, status: S.exited(ago(30)) },
  ]);
  assert.equal(
    delegationNotice(projectDelegation(quiet.vm, new ProjectionCache()), NOW, plainSay)!.text,
    'bench ended · no report'
  );

  // After the minute, and when the time is not known, nothing is told.
  assert.equal(
    notice(() => reported(false), NOW + 60_000),
    null
  );
  const unknownTime = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'x',
      parent: 'main',
      status: { cls: 'pending', reason: 'approval', pending: 'approval', since: null, basis: 'unknown' },
    },
  ]);
  assert.equal(
    delegationNotice(projectDelegation(unknownTime.vm, new ProjectionCache()), NOW, plainSay),
    null,
    'an unknown time is not "just now"'
  );
});

/** The notice zone's full text for a bar at `tick`. */
function noticeText(data: HudData & HudDelegationData, tick: number): string {
  return text(
    buildBarModules(data, { density: 'balanced', nowMs: tick, width: 120 }).find((m) => m.id === 'notice')!.variants
      .full ?? ''
  );
}

/** A visible cancel waiting on its pane (a node `⚑`) beside an approval (a second one): the badge counts. */
function twoFlags(): ReturnType<typeof buildVm> {
  return buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    {
      id: 'impl-parser',
      parent: 'main',
      harness: 'codex',
      run: { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(30) },
      status: { cls: 'interrupted', reason: 'cancelling', since: ago(30), outcome: 'none' },
      pane: 'pane 4',
      createdAt: ago(900),
    },
    { id: 'review-tests', parent: 'main', harness: 'pi', status: S.pending('approval', ago(300)), createdAt: ago(400) },
  ]);
}

test('the bar tells the newest of its own notice and the delegation one', () => {
  const base = sessionData(twoFlags().vm, NOW);
  assert.match(noticeText(base, NOW), /^⚑ impl-parser still running · stop in its pane · \d+s ago$/);
  const newer = { ...base, notices: [{ kind: 'agent-done' as const, at: new Date(NOW - 1000), subject: 'scout' }] };
  assert.match(noticeText(newer, NOW), /^✓ scout finished/, 'a newer legacy notice wins');
  const older = { ...base, notices: [{ kind: 'agent-done' as const, at: new Date(NOW - 50_000), subject: 'scout' }] };
  assert.match(noticeText(older, NOW), /^⚑ impl-parser/, 'an older one does not');
});

test('the notice zone does not say again what the badge already names in full (§4.1)', () => {
  const tick = NOW - 80_000; // the cancel of situation (h) was accepted 40 s before this tick
  // One node alert: the badge reads `⚑ impl-parser stop in pane`, so the notice for it is left out.
  assert.equal(noticeText(sessionData(situationH().vm, tick), tick), '');
  assert.equal(noticeSentence(situationH().vm, tick, false, { flag: 0, fail: 0 }), null);
  // Two node alerts, or one beside the bar's own approval: the badge is counts, the notice adds the name.
  assert.match(
    text(noticeSentence(situationH().vm, tick, false, { flag: 1, fail: 0 })!.text),
    /^⚑ impl-parser still running · stop in its pane/
  );
  // The pending notice is left out the same way, and told when the badge counts.
  const c = situationC().vm;
  assert.equal(noticeSentence(c, NOW, false, { flag: 0, fail: 0 }), null);
  assert.match(text(noticeSentence(c, NOW, false, { flag: 0, fail: 1 })!.text), /^⚑ review-tests approval/);
  // The frame the follow-up asked for: situation (d) at 200 columns, two node alerts, the approval told beside them.
  const d = fit(sessionData(situationD().vm, NOW), 200, 'full', { tickMs: NOW });
  assert.match(squash(d.line), /^⚑1 \?1 · slots 6\/6 · 1 to reconcile .*│ ⚑ t-07 approval · 10s ago$/);
  // And (c) at 200 columns right after the approval does not print it twice.
  const fresh = squash(fit(sessionData(situationC().vm, NOW), 200, 'full', { tickMs: NOW }).line);
  assert.equal(fresh.split('review-tests approval').length - 1, 1, fresh);
});

test('every kind of notice is left out for the one node the badge names in full, and told when it counts (rulings round 2, Q2)', () => {
  const single = (spec: NodeSpec) =>
    buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }, spec]).vm;
  const failed = single({ id: 'bench', parent: 'main', status: S.failed(ago(10)) });
  const uncertain = single({
    id: 'sync-job',
    parent: 'main',
    run: { state: 'uncertain', reconciliation: 'scope_unknown' },
    status: { cls: 'uncertain', since: ago(15) },
  });
  // The badge says `✗ bench failed` / `? sync-job uncertain`; the notice would only repeat it.
  assert.equal(
    alertForms(delegationAlerts(projectDelegation(failed, new ProjectionCache()), NOW, plainSay), plainSay, false)!
      .full,
    '✗ bench failed'
  );
  assert.equal(noticeSentence(failed, NOW, false, { flag: 0, fail: 0 }), null);
  assert.equal(noticeText(sessionData(failed, NOW), NOW), '');
  assert.equal(
    alertForms(delegationAlerts(projectDelegation(uncertain, new ProjectionCache()), NOW, plainSay), plainSay, false)!
      .full,
    '? sync-job uncertain'
  );
  assert.equal(noticeSentence(uncertain, NOW, false, { flag: 0, fail: 0 }), null);
  assert.equal(noticeText(sessionData(uncertain, NOW), NOW), '');
  // With the badge in counts form (the bar's own alert lit beside it) the notice adds the name.
  assert.match(text(noticeSentence(failed, NOW, false, { flag: 1, fail: 0 })!.text), /^! bench failed/);
  assert.match(text(noticeSentence(uncertain, NOW, false, { flag: 1, fail: 0 })!.text), /^\? sync-job uncertain/);
  // Two node alerts: the badge is counts, so both kinds can be told (the newer one is).
  const two = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working() },
    { id: 'bench', parent: 'main', status: S.failed(ago(10)) },
    {
      id: 'sync-job',
      parent: 'main',
      run: { state: 'uncertain', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', since: ago(30) },
    },
  ]).vm;
  assert.match(text(noticeSentence(two, NOW, false, { flag: 0, fail: 0 })!.text), /^! bench failed/);
});

test('ASCII: the whole set switches, never one symbol', () => {
  const tick = NOW + 90_000;
  const data = sessionData(situationC().vm, tick);
  const modules = buildBarModules(data, { density: 'full', width: 220, nowMs: tick, ascii: true });
  assert.equal(text(modules.find((m) => m.id === 'attention')!.variants.full!).trim(), '@ review-tests approval');
  assert.equal(text(modules.find((m) => m.id === 'attention')!.variants.min!).trim(), '@1');
  const agents = text(modules.find((m) => m.id === 'agents')!.variants.full!);
  assert.equal(agents, 'Agents 3> 1@ 1+ - X2 P1 J1');
  assert.doesNotMatch(agents, /[^\x20-\x7e]/);
  const e = buildBarModules(sessionData(situationE().vm, tick), {
    density: 'full',
    width: 220,
    nowMs: tick,
    ascii: true,
  });
  assert.equal(text(e.find((m) => m.id === 'attention')!.variants.full!).trim(), '@1 ?3 ^1');
});

test('delegation null, undefined or absent: the bar is what it always was, byte for byte', () => {
  const pinned = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/fixtures/b10b-legacy-bar.json'), 'utf8')) as Record<
    string,
    string
  >;
  const variants: Record<string, HudData> = {
    default: makeHudData(),
    approval: makeHudData({ pendingApproval: { kind: 'exec', callId: 'c1', since: at(-95), summary: 'x' } }),
    noTree: makeHudData({ subagentTree: undefined, subagents: [] }),
    working: makeHudData({
      activity: { state: 'working', turnStartedAt: at(-190), updatedAt: at(-1) } as HudData['activity'],
      outputRate: { tokensPerSecond: 38, sampledAt: at(-2) } as HudData['outputRate'],
    }),
    notice: makeHudData({ notices: [{ kind: 'agent-done', at: at(-20), subject: 'docs-sync' }] }),
    failedTool: makeHudData({
      toolActivity: {
        recentCalls: [{ id: 'c9', name: 'Edit', target: 'a.ts', status: 'error', timestamp: at(-5) }],
      } as unknown as HudData['toolActivity'],
    }),
  };
  const clock = Date.now;
  Date.now = () => FIXED_NOW.getTime();
  const previous = setDisplayConfig({});
  try {
    let compared = 0;
    for (const [name, data] of Object.entries(variants))
      for (const density of ['focus', 'balanced', 'full'] as const)
        for (const width of [20, 32, 40, 60, 80, 100, 120, 160, 200, 240]) {
          setDisplayConfig({ density });
          const render = (d: HudData & HudDelegationData) =>
            renderHud(d, { width, showDetails: false, layout: { ...DEFAULT_LAYOUT, mode: 'compact', barWidth: 10 } });
          const absent = render(data);
          assert.deepEqual(render({ ...data, delegation: null }), absent, `${name}/${density}/${width}: null`);
          assert.deepEqual(
            render({ ...data, delegation: undefined }),
            absent,
            `${name}/${density}/${width}: undefined`
          );
          assert.equal(
            JSON.stringify(
              buildBarModules({ ...data, delegation: null }, { density, width, nowMs: FIXED_NOW.getTime() })
            ),
            JSON.stringify(buildBarModules(data, { density, nowMs: FIXED_NOW.getTime() })),
            `${name}/${density}/${width}: modules`
          );
          const key = `${name}/${density}/${width}`;
          if (key in pinned) {
            assert.equal(text(absent[0]), pinned[key], `${key}: differs from the output of the code before delegation`);
            compared++;
          }
        }
    assert.ok(compared >= 30, `compared ${compared} pinned lines`);
  } finally {
    setDisplayConfig(previous);
    Date.now = clock;
  }
});

test('with a delegation tree the bar renders the agents from it, and the legacy subagent tree is not counted twice', () => {
  const tick = NOW;
  const data = { ...sessionData(situationC().vm, tick), subagentTree: makeHudData().subagentTree };
  const modules = buildBarModules(data, { density: 'balanced', nowMs: tick, width: 120 });
  assert.equal(text(modules.find((m) => m.id === 'agents')!.variants.full!), 'Agents 3▸ 1⚑ 1✓');
  // The legacy fixture tree has a failed agent: it is not the delegation tree's, so it raises no second alert.
  const attention = text(modules.find((m) => m.id === 'attention')!.variants.full!).trim();
  assert.equal(attention, '⚑ review-tests approval');
  assert.ok(fitStatusBar(data, layout, 120, tick).line.length > 0);
});

test('a delegation tree with nothing to say adds nothing', () => {
  const { vm } = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working() }]);
  const data = sessionData(vm, NOW);
  const modules = buildBarModules(data, { density: 'balanced', nowMs: NOW, width: 120 });
  assert.deepEqual(modules.find((m) => m.id === 'agents')!.variants, {});
  assert.deepEqual(modules.find((m) => m.id === 'attention')!.variants, {});
});

test('ASCII: no notice, alert or capped name holds a Unicode character the renderer wrote (§5.3)', () => {
  const ascii = (value: string, what: string) => assert.match(value, /^[\x20-\x7e]*$/, `${what}: ${value}`);
  const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working() };
  const kinds: Array<[string, ReturnType<typeof buildVm>, number]> = [
    [
      'closePane',
      buildVm([
        root,
        {
          id: 'docs-sync',
          parent: 'main',
          run: { state: 'running', mode: 'visible' },
          status: S.exited(ago(20)),
          report: { status: 'completed', summary: 'Done.', at: ago(20) },
          pane: 'pane 5',
        },
      ]),
      NOW,
    ],
    [
      'reported',
      buildVm([
        root,
        {
          id: 'docs-sync',
          parent: 'main',
          run: { state: 'running', mode: 'headless' },
          status: S.exited(ago(20)),
          report: { status: 'completed', summary: 'Done.', at: ago(20) },
        },
      ]),
      NOW,
    ],
    ['stopRequested', situationH(), NOW - 80_000],
    [
      'endedNoReport',
      buildVm([
        root,
        { id: 'bench', parent: 'main', run: { state: 'ended', endedAt: ago(30) }, status: S.exited(ago(30)) },
      ]),
      NOW,
    ],
    ['failed', buildVm([root, { id: 'lint-fix', parent: 'main', harness: 'pi', status: S.failed(ago(5)) }]), NOW],
    [
      'uncertain',
      buildVm([
        root,
        {
          id: 'impl-b',
          parent: 'main',
          run: { state: 'uncertain', reconciliation: 'scope_unknown' },
          status: { cls: 'uncertain', since: ago(8) },
        },
      ]),
      NOW,
    ],
    ['pending', buildVm([root, { id: 'review-tests', parent: 'main', status: S.pending('approval', ago(8)) }]), NOW],
  ];
  const seen = new Set<string>();
  for (const [kind, built, tick] of kinds) {
    const proj = projectDelegation(built.vm, new ProjectionCache());
    const notice = delegationNotice(proj, tick, plainSay, null, true);
    assert.equal(notice?.kind, kind);
    ascii(notice!.text, kind);
    seen.add(notice!.kind);
    // As the bar draws it, with the glyph and the age.
    ascii(text(noticeSentence(built.vm, tick, true, { flag: 1, fail: 0 })!.text), `${kind} painted`);
  }
  assert.equal(seen.size, kinds.length, 'every notice kind');
  assert.equal(
    delegationNotice(projectDelegation(kinds[0][1].vm, new ProjectionCache()), NOW, plainSay, null, true)!.text,
    'docs-sync reported - close its pane'
  );
  // The same notice in Unicode keeps the middle dot.
  assert.equal(
    delegationNotice(projectDelegation(kinds[0][1].vm, new ProjectionCache()), NOW, plainSay, null, false)!.text,
    'docs-sync reported · close its pane'
  );

  // A long label is cut with the glyph set's own ellipsis.
  const long = buildVm([
    root,
    {
      id: 'w',
      parent: 'main',
      label: 'a-very-long-synthetic-worker-name-here',
      status: S.pending('approval', ago(10)),
    },
  ]);
  const proj = projectDelegation(long.vm, new ProjectionCache());
  const forms = (useAscii: boolean) => alertForms(delegationAlerts(proj, NOW, plainSay, useAscii), plainSay, useAscii)!;
  ascii(forms(true).full, 'alert');
  assert.equal(forms(true).full, '@ a-very-long-synthetic-w~ approval');
  assert.equal(forms(false).full, '⚑ a-very-long-synthetic-w… approval');
  // And through the bar itself.
  const modules = buildBarModules(sessionData(long.vm, NOW), { density: 'full', width: 220, nowMs: NOW, ascii: true });
  ascii(text(modules.find((m) => m.id === 'attention')!.variants.full!).trim(), 'attention module');
});
