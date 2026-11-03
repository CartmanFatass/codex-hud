/**
 * B10B-s2: the delegation line, the focus line and the top parent row (design §3.4, §3.5, §4.6; rulings B10B-s2
 * Q2, Q3, Q9). Each element only when its fact is known; the fixed shedding order; nothing invented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import { delegationLinePlain, focusLine, focusText, parentRow } from '../../src/render/delegation/lines.js';
import {
  ProjectionCache,
  projectDelegation,
  type DelegationProjection,
} from '../../src/render/delegation/projection.js';
import { PLAIN_INK } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import { NOW, S, ago, buildVm, situationParent, type NodeSpec } from '../fixtures/b10b-delegation.js';

const g = glyphSet(false);
const ROOT: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(60)), label: null };

function project(specs: NodeSpec[]): { proj: DelegationProjection; keys: Record<string, string> } {
  const built = buildVm(specs);
  return { proj: projectDelegation(built.vm, new ProjectionCache()), keys: built.keys };
}
function line(spec: Partial<NodeSpec>, width = 80): string {
  const { proj, keys } = project([ROOT, { id: 'w', parent: 'main', role: 'implementer', ...spec }]);
  return delegationLinePlain(proj.byKey.get(keys.w)!, proj, width, NOW, g, plainSay);
}
function focus(spec: Partial<NodeSpec>, width = 80): string | null {
  const { proj, keys } = project([ROOT, { id: 'w', parent: 'main', ...spec }]);
  const f = focusLine(proj.byKey.get(keys.w)!, NOW, g, plainSay);
  return f ? stripAnsi(focusText(f, width, width, g, PLAIN_INK)) : null;
}

test('delegation line: role, host, the bound time; `pane N` only from a verified host', () => {
  assert.equal(
    line({ run: { state: 'running', mode: 'headless' }, boundAt: ago(840) }),
    'implementer · ⊟ headless · bound 14m'
  );
  assert.equal(
    line({ run: { state: 'running', mode: 'visible' }, pane: 'pane 4', boundAt: ago(840) }),
    'implementer · pane 4 · bound 14m'
  );
  assert.equal(
    line({ run: { state: 'running', mode: 'visible' }, pane: '7', boundAt: ago(60) }),
    'implementer · pane 7 · bound 1m'
  );
  // A visible run without a verified pane says nothing about where it is.
  assert.equal(line({ run: { state: 'running', mode: 'visible' }, boundAt: ago(60) }), 'implementer · bound 1m');
  // Bound at an unknown time: the word alone, never an invented age.
  assert.equal(
    line({ run: { state: 'running', mode: 'headless' }, boundAt: null }),
    'implementer · ⊟ headless · bound'
  );
});

test('delegation line: the handshake while the link is pending or claimed; reported once there is a report', () => {
  assert.equal(
    line({ linkState: 'pending', run: { state: 'starting', mode: 'headless' } }),
    'implementer · ⊟ headless · handshake'
  );
  assert.equal(
    line({ linkState: 'claimed', run: { state: 'starting', mode: 'headless' } }),
    'implementer · ⊟ headless · handshake claimed'
  );
  assert.equal(
    line({
      run: { state: 'ended', mode: 'headless', endedAt: ago(100) },
      status: S.exited(ago(100)),
      report: { status: 'completed', summary: 'ok', at: ago(120) },
    }),
    'implementer · reported 2m',
    'a terminal run has no host'
  );
});

test('delegation line: run N past the first, heartbeat from 80 columns, cost, slot held, close pane', () => {
  assert.equal(line({ runSeq: 2, boundAt: ago(60) }, 79), 'implementer · ⊟ headless · bound 1m · run 2');
  assert.equal(line({ runSeq: 1, boundAt: ago(60) }, 79), 'implementer · ⊟ headless · bound 1m', 'no `run 1`');
  assert.equal(
    line({ run: { state: 'running', mode: 'headless', heartbeatAt: ago(3) }, boundAt: ago(60) }, 80),
    'implementer · ⊟ headless · bound 1m · heartbeat 3s'
  );
  assert.equal(
    line({ run: { state: 'running', mode: 'headless', heartbeatAt: ago(3) }, boundAt: ago(60) }, 79),
    'implementer · ⊟ headless · bound 1m',
    'under 80 columns: no heartbeat'
  );
  assert.equal(line({ costUsd: 0.12, boundAt: ago(60) }), 'implementer · ⊟ headless · bound 1m · $0.12');
  // Estimated cost is `~`.
  const { proj, keys } = project([
    ROOT,
    { id: 'w', parent: 'main', role: 'implementer', costUsd: 0.5, boundAt: ago(60) },
  ]);
  const node = proj.vm.tree.nodes.find((n) => n.key === keys.w)!;
  (node.observation!.spent.costUsd as { quality: string }).quality = 'estimated';
  const estimated = projectDelegation(structuredClone(proj.vm), new ProjectionCache());
  assert.equal(
    delegationLinePlain(estimated.byKey.get(keys.w)!, estimated, 80, NOW, g, plainSay),
    'implementer · ⊟ headless · bound 1m · ~$0.50'
  );
  assert.equal(
    line({
      run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(60) },
      boundAt: ago(840),
    }),
    'implementer · ⊟ headless · bound 14m · slot held'
  );
  assert.equal(
    line({
      run: { state: 'running', mode: 'visible' },
      pane: 'pane 5',
      status: S.exited(ago(480)),
      report: { status: 'completed', summary: 'done', at: ago(480) },
    }),
    'implementer · pane 5 · reported 8m · close pane'
  );
});

test('delegation line: `in <dir>` by worktree root, then by cwd, `in ?` when neither compares', () => {
  assert.equal(
    line({ boundAt: ago(60), workspace: { worktreeRoot: '/work/fix-cjk' } }),
    'implementer · ⊟ headless · bound 1m · in fix-cjk'
  );
  assert.equal(
    line({ boundAt: ago(60), workspace: { worktreeRoot: '/work/wt-2', worktree: 'fix-cjk' } }),
    'implementer · ⊟ headless · bound 1m · in fix-cjk',
    'the worktree name when there is one'
  );
  assert.equal(
    line({ boundAt: ago(60), workspace: { worktreeRoot: '/work/parser-kit/' } }),
    'implementer · ⊟ headless · bound 1m',
    'normalised: same'
  );
  assert.equal(
    line({ boundAt: ago(60), workspace: { worktreeRoot: null, cwd: '/work/other' } }),
    'implementer · ⊟ headless · bound 1m · in other',
    'no worktree root: the working directory'
  );
  assert.equal(
    line({ boundAt: ago(60), workspace: null }),
    'implementer · ⊟ headless · bound 1m · in ?',
    'unknown is not equal'
  );
  // Never on a native child (no delegation line at all) or an intent.
  const { proj, keys } = project([
    ROOT,
    {
      id: 'i',
      parent: 'main',
      kind: 'intent',
      role: 'implementer',
      linkState: 'pending',
      run: { state: 'starting', mode: 'headless' },
      workspace: null,
    },
  ]);
  assert.equal(
    delegationLinePlain(proj.byKey.get(keys.i)!, proj, 80, NOW, g, plainSay),
    'implementer · ⊟ headless · handshake'
  );
});

test('delegation line: shedding right to left at 80, 56, 48, 40 and 32; slot held and close pane stay', () => {
  const spec: Partial<NodeSpec> = {
    run: { state: 'uncertain', mode: 'visible', reconciliation: 'scope_unknown', heartbeatAt: ago(3) },
    status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(60) },
    pane: 'pane 4',
    runSeq: 2,
    boundAt: ago(840),
    costUsd: 0.12,
    workspace: { worktreeRoot: '/work/fix-cjk' },
  };
  const expected: Array<[number, string]> = [
    [120, 'implementer · pane 4 · bound 14m · run 2 · heartbeat 3s · $0.12 · in fix-cjk · slot held'],
    [80, 'implementer · pane 4 · bound 14m · run 2 · heartbeat 3s · $0.12 · slot held'],
    [70, 'implementer · pane 4 · bound 14m · run 2 · $0.12 · slot held'],
    [56, 'implementer · pane 4 · bound 14m · run 2 · slot held'],
    [48, 'implementer · pane 4 · 14m · run 2 · slot held'],
    [40, 'implementer · pane 4 · run 2 · slot held'],
    [32, 'implementer · pane 4 · slot held'],
    [24, 'implementer · slot held'],
    [18, 'imple… · slot held'],
  ];
  for (const [width, text] of expected) {
    const { proj, keys } = project([ROOT, { id: 'w', parent: 'main', role: 'implementer', ...spec }]);
    assert.equal(delegationLinePlain(proj.byKey.get(keys.w)!, proj, width, NOW, g, plainSay), text, `${width} columns`);
    assert.ok(visualLength(text) <= width);
  }
});

test('delegation line: an extra intent root says `parent unconfirmed` and nothing else', () => {
  const { proj, keys } = project([
    ROOT,
    {
      id: 'x',
      kind: 'intent',
      parent: null,
      role: 'implementer',
      linkState: 'pending',
      run: { state: 'starting', mode: 'headless' },
    },
  ]);
  assert.equal(delegationLinePlain(proj.byKey.get(keys.x)!, proj, 80, NOW, g, plainSay), 'parent unconfirmed');
});

test('focus line: pending word, uncertain cause and missing items, conflict, report, terminal facts', () => {
  assert.equal(focus({ status: S.pending('approval', ago(10)) }), '⚑ approval');
  assert.equal(focus({ status: S.pending('needs_human', ago(10)) }), '⚑ needs human');
  assert.equal(
    focus({
      run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(60) },
      missing: ['scope_unknown', 'exit_receipt'],
    }),
    '? uncertain: scope unknown · exit receipt',
    'the missing item that is not the cause, humanised'
  );
  assert.equal(
    focus({
      run: { state: 'uncertain', mode: 'visible', reconciliation: 'supervisor_dead' },
      status: { cls: 'uncertain', reason: 'supervisor_dead', since: ago(60) },
      missing: ['supervisor_dead'],
    }),
    '? supervisor lost'
  );
  assert.equal(focus({ status: S.stale(ago(48), ago(48)) }), '? stale');
  assert.equal(
    focus({
      run: {
        state: 'ended',
        mode: 'headless',
        endedAt: ago(100),
        exit: { code: 1, signal: null, source: 'wait_status' },
      },
      status: S.exited(ago(100)),
      report: { status: 'failed', summary: 'Lint rule 12 unresolved.', at: ago(110) },
    }),
    '! Lint rule 12 unresolved. · exit 1'
  );
  assert.equal(
    focus({
      run: { state: 'ended', mode: 'headless', endedAt: ago(100), requestedCause: 'runtime_limit' },
      status: S.exited(ago(100)),
    }),
    'ended · no report · runtime limit · exit unknown'
  );
  assert.equal(
    focus({
      run: { state: 'ended', mode: 'visible', endedAt: ago(100) },
      status: S.exited(ago(100)),
      terminalNote: 'cancel_timing_unknown',
    }),
    'ended · no report · exit unknown · cancel timing unknown'
  );
  assert.equal(
    focus({
      run: {
        state: 'ended',
        mode: 'headless',
        endedAt: ago(100),
        exit: { code: null, signal: 'TERM', source: 'wait_status' },
      },
      status: S.exited(ago(100)),
    }),
    '! failed · signal TERM',
    'a signal with a source is a failure (§3.3 row 4)'
  );
  // Nothing to say: no line (no brief, no action, no placeholder).
  assert.equal(focus({ status: S.working(ago(60)) }), null);
});

test('parent row: the four forms, one row, exactly the width', () => {
  const draw = (form: Parameters<typeof situationParent>[0], width: number) => {
    const built = situationParent(form);
    const proj = projectDelegation(built.vm, new ProjectionCache());
    const text = parentRow(proj, width, NOW, g, plainSay)!;
    assert.equal(visualLength(text), width, `${form} ${width}`);
    return stripAnsi(text).trimEnd();
  };
  assert.equal(draw('confirmed', 56), '↑ parent ✳ main · pane 2 · bound 12m');
  assert.equal(draw('offline', 64), '↑ parent ✳ main · pane 2 · offline 3m · continue · bound 12m');
  assert.equal(draw('unconfirmed', 56), '↑ parent ? unconfirmed · caller c0ffee12');
  assert.equal(draw('cancel', 80), '↑ parent ✳ main · pane 2 · asked to cancel 2m · stop here · bound 12m');
  // Shedding: bound, then stop here, then pane, then the state word, then the name is cut.
  assert.equal(draw('cancel', 48), '↑ parent ✳ main · pane 2 · asked to cancel 2m');
  assert.equal(draw('offline', 48), '↑ parent ✳ main · pane 2 · offline 3m · continue');
  assert.equal(draw('offline', 40), '↑ parent ✳ main · offline 3m · continue');
  assert.equal(draw('offline', 32), '↑ parent ✳ main');
  assert.equal(draw('unconfirmed', 32), '↑ parent ? unconfirmed');
  // No as-child link and no parent: no row.
  const plain = buildVm([ROOT]);
  assert.equal(parentRow(projectDelegation(plain.vm, new ProjectionCache()), 48, NOW, g, plainSay), null);
});

test('parent row: a gone parent says `exited`; alive says no activity word', () => {
  const built = situationParent('confirmed');
  const root = built.vm.tree.nodes[0];
  root.parent = { ...root.parent!, liveness: 'gone' };
  const proj = projectDelegation(built.vm, new ProjectionCache());
  assert.equal(
    stripAnsi(parentRow(proj, 60, NOW, g, plainSay)!).trimEnd(),
    '↑ parent ✳ main · pane 2 · exited · bound 12m'
  );
});

test('focus line: short of room it drops exit unknown, then the timing note, then the cause, before it cuts (F4)', () => {
  const spec: Partial<NodeSpec> = {
    run: { state: 'ended', mode: 'visible', endedAt: ago(100), requestedCause: 'runtime_limit' },
    status: S.exited(ago(100)),
    terminalNote: 'cancel_timing_unknown',
  };
  assert.equal(focus(spec, 80), 'ended · no report · runtime limit · exit unknown · cancel timing unknown');
  assert.equal(focus(spec, 60), 'ended · no report · runtime limit · cancel timing unknown');
  assert.equal(focus(spec, 50), 'ended · no report · runtime limit');
  assert.equal(focus(spec, 30), 'ended · no report');
  assert.equal(focus(spec, 12), 'ended · no …', 'only the unsheddable words are cut');
  // A known exit outlives the note and the cause; a missing item of an uncertain run goes too.
  const failed: Partial<NodeSpec> = {
    run: {
      state: 'ended',
      mode: 'headless',
      endedAt: ago(100),
      exit: { code: 2, signal: null, source: 'wait_status' },
    },
    status: S.exited(ago(100)),
    report: { status: 'failed', summary: 'Lint rule twelve unresolved.', at: ago(110) },
  };
  assert.equal(focus(failed, 40), '! Lint rule twelve unresolved. · exit 2');
  assert.equal(focus(failed, 32), '! Lint rule twelve unresolved.');
  const uncertain: Partial<NodeSpec> = {
    run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown' },
    status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(60) },
    missing: ['exit_receipt'],
  };
  assert.equal(focus(uncertain, 30), '? uncertain: scope unknown');
});
