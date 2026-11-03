/**
 * B10B-s2: the summary row (design §4.2; rulings B10B-s2 Q4, Q5): counts and chips never shed; `put away`, then
 * `workers, jobs`, then the spend are; one coverage chip by precedence; the unreadable ledger's 30 seconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi } from '../../src/render/colors.js';
import { paneHead } from '../../src/render/control-bar.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import {
  coverageChip,
  delegationAgentsRows,
  LEDGER_WARN_MS,
  listedWorkers,
  resetLedgerStamp,
  summaryCounts,
} from '../../src/render/delegation/panel.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import { planRows } from '../../src/render/delegation/rows.js';
import { plainSay } from '../../src/render/delegation/style.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { cells, cellsOf } from '../fixtures/b10b-sgr.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { palette } from '../../src/render/palette.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationD,
  situationE,
  situationG,
  type NodeSpec,
} from '../fixtures/b10b-delegation.js';

const g = glyphSet(false);
const ROOT: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(60)), label: null };

function forms(vm: DelegationViewModel, nowMs = NOW, showHistory = false): string[] {
  const proj = projectDelegation(vm, new ProjectionCache());
  const plan = planRows(proj, { nowMs, showHistory });
  const counts = summaryCounts(proj, plan, nowMs, g, plainSay, showHistory);
  return [counts(true, true), counts(false, true), counts(true, false), counts(false, false)].map(stripAnsi);
}

test('summary: the sampled strings of (c), (d), (e) and (g); no rate anywhere', () => {
  assert.equal(forms(situationC({ reviewPass: true }).vm)[0], '3▸ 1⚑ 2✓ · 3 workers, 1 job · ≥$0.12');
  assert.equal(forms(situationD().vm)[0], '3▸ 1· 1⚑ 1? 9✓ · slots 6/6 · 6 workers · 9 put away');
  assert.equal(forms(situationE().vm)[0], '1▸ 1⚑ 3? 1⚠ · 5 workers, 1 job', 'the conflict child is a worker, once');
  assert.equal(forms(situationG().vm)[0], '1▸ 1✗ 5✓ · 1 worker · 6 put away');
  // `a`: nothing is put away, every worker is on the list.
  assert.equal(forms(situationG().vm, NOW, true)[0], '1▸ 1✗ 5✓ · 7 workers');
});

test('summary: shedding order put away, then workers, then spend; counts and chips stay', () => {
  const { vm } = buildVm(
    [
      ROOT,
      { id: 'w', parent: 'main', status: S.working(ago(30)), costUsd: 0.12 },
      { id: 'j', parent: 'main', kind: 'job', run: false, status: S.working(ago(30)) },
      {
        id: 'old',
        parent: 'main',
        run: { state: 'ended', mode: 'headless', endedAt: ago(900) },
        status: S.exited(ago(900)),
        report: { status: 'completed', summary: 'ok', at: ago(900) },
      },
    ],
    { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4 } }
  );
  assert.deepEqual(forms(vm), [
    '2▸ 1✓ · slots 6/6 · 1 worker, 1 job · 1 put away · ≥$0.12',
    '2▸ 1✓ · slots 6/6 · 1 worker, 1 job · ≥$0.12',
    '2▸ 1✓ · slots 6/6 · ≥$0.12',
    '2▸ 1✓ · slots 6/6',
  ]);
  // The panel's own row picks the fullest form that fits.
  const row = (width: number) =>
    stripAnsi(delegationAgentsRows(vm, { width, nowMs: NOW, style: 'compact' })[0].text).trim();
  assert.equal(row(60), '2▸ 1✓ · slots 6/6 · 1 worker, 1 job · 1 put away · ≥$0.12');
  assert.equal(row(48), '2▸ 1✓ · slots 6/6 · 1 worker, 1 job · ≥$0.12');
  assert.equal(row(32), '2▸ 1✓ · slots 6/6 · ≥$0.12');
  assert.equal(row(24), '2▸ 1✓ · slots 6/6');
  // The pane's heading uses the same forms (`paneHead` tries them in its own order).
  const counts = delegationAgentsRows(vm, { width: 40, nowMs: NOW, style: 'compact' })[0].counts!;
  const heading = stripAnsi(paneHead('agents', 40, { info: counts, focused: true, zoomed: false, named: false }));
  assert.ok(heading.includes('2▸ 1✓ · slots 6/6'), heading);
});

test('summary: workers count delegated sessions and intents on the list, not natives, not the put away', () => {
  const { vm } = buildVm([
    ROOT,
    { id: 'w1', parent: 'main', status: S.working(ago(30)) },
    { id: 'n1', parent: 'w1', native: true, status: S.working(ago(30)) },
    { id: 'i1', parent: 'main', kind: 'intent', linkState: 'pending', run: { state: 'starting', mode: 'headless' } },
    {
      id: 'done',
      parent: 'main',
      run: { state: 'ended', mode: 'headless', endedAt: ago(600) },
      status: S.exited(ago(600)),
      report: { status: 'completed', summary: 'ok', at: ago(600) },
    },
    {
      id: 'kid',
      parent: 'done',
      run: { state: 'ended', mode: 'headless', endedAt: ago(700) },
      status: S.exited(ago(700)),
      report: { status: 'completed', summary: 'ok', at: ago(700) },
    },
  ]);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.deepEqual(listedWorkers(proj, NOW, false), { workers: 2, jobs: 0 }, 'a put-away subtree is not on the list');
  assert.deepEqual(listedWorkers(proj, NOW, true), { workers: 4, jobs: 0 });
  // A conflict child claimed by two parents is one worker.
  const e = projectDelegation(situationE().vm, new ProjectionCache());
  assert.equal(listedWorkers(e, NOW, false).workers, 5);
});

test('coverage chip: precedence, and `N not loaded` counts the omitted conflict rows', () => {
  resetLedgerStamp();
  const chip = (patch: (vm: DelegationViewModel) => void) => {
    const { vm } = buildVm([ROOT, { id: 'w', parent: 'main', status: S.working(ago(30)) }]);
    patch(vm);
    return coverageChip(projectDelegation(vm, new ProjectionCache()), NOW, plainSay);
  };
  assert.equal(
    chip(() => {}),
    null
  );
  assert.deepEqual(
    chip((vm) => (vm.tree.counts.knownUnloaded = 2)),
    { text: '2 not loaded', warning: false }
  );
  assert.deepEqual(
    chip((vm) => ((vm.tree.counts.knownUnloaded = 1), (vm.tree.counts.omitted = 2))),
    {
      text: '3 not loaded',
      warning: false,
    }
  );
  assert.deepEqual(
    chip((vm) => (vm.tree.coverage.state = 'partial')),
    { text: 'tree partial', warning: false }
  );
  assert.deepEqual(
    chip((vm) => (vm.tree.counts.unknownDescendants = true)),
    { text: 'tree partial', warning: false }
  );
  assert.deepEqual(
    chip((vm) => ((vm.tree.coverage.state = 'partial'), (vm.tree.counts.knownUnloaded = 1))),
    { text: '1 not loaded', warning: false },
    'not loaded and tree partial are exclusive'
  );
  assert.deepEqual(
    chip(
      (vm) => (
        (vm.tree.ledger = { state: 'degraded', ledgerId: null, asOfSeq: null, reason: 'ledger_busy' }),
        (vm.tree.counts.knownUnloaded = 1)
      )
    ),
    { text: 'ledger busy', warning: false }
  );
  // Omitted conflict rows: claims past the node budget have no row, so they are "not loaded".
  const specs: NodeSpec[] = [ROOT];
  for (let i = 0; i < 205; i++) specs.push({ id: `w${i}`, parent: 'main', status: S.working(ago(30)) });
  specs.push({
    id: 'x',
    parent: 'main',
    alsoClaimedBy: ['w1'],
    relationOnly: true,
    conflict: { count: 2, since: ago(60) },
  });
  const { vm } = buildVm(specs);
  const proj = projectDelegation(vm, new ProjectionCache());
  assert.ok(proj.omittedConflictRows > 0);
  assert.deepEqual(coverageChip(proj, NOW, plainSay), {
    text: `${proj.omittedConflictRows} not loaded`,
    warning: false,
  });
});

test('coverage chip: an unreadable ledger is muted for 30 seconds, then warning; busy never warns', () => {
  resetLedgerStamp();
  const degraded = (reason: string) => {
    const { vm } = buildVm([ROOT]);
    vm.tree.ledger = { state: 'degraded', ledgerId: null, asOfSeq: null, reason };
    return projectDelegation(vm, new ProjectionCache());
  };
  const down = degraded('ledger_unavailable');
  assert.deepEqual(coverageChip(down, NOW, plainSay), { text: 'ledger unavailable', warning: false });
  assert.equal(coverageChip(down, NOW + LEDGER_WARN_MS - 1, plainSay)!.warning, false);
  assert.equal(coverageChip(down, NOW + LEDGER_WARN_MS, plainSay)!.warning, true);
  // Busy clears the stamp: the next unreadable spell starts its own 30 seconds.
  assert.deepEqual(coverageChip(degraded('ledger_busy'), NOW + LEDGER_WARN_MS + 1, plainSay), {
    text: 'ledger busy',
    warning: false,
  });
  assert.equal(coverageChip(down, NOW + LEDGER_WARN_MS + 2, plainSay)!.warning, false);
  assert.equal(coverageChip(down, NOW + 2 * LEDGER_WARN_MS + 2, plainSay)!.warning, true);
  // Available again clears it too.
  const { vm } = buildVm([ROOT]);
  coverageChip(projectDelegation(vm, new ProjectionCache()), NOW + 3 * LEDGER_WARN_MS, plainSay);
  assert.equal(coverageChip(down, NOW + 3 * LEDGER_WARN_MS + 1, plainSay)!.warning, false);
  // The warning is painted warning, the muted state muted.
  const previous = setDisplayConfig({ theme: 'mocha' });
  try {
    resetLedgerStamp();
    const rows = (nowMs: number) => delegationAgentsRows(down.vm, { width: 40, nowMs, style: 'compact' })[0].text;
    const muted = cellsOf(rows(NOW), 'ledger')[0].fg;
    const warned = cellsOf(rows(NOW + LEDGER_WARN_MS), 'ledger')[0].fg;
    assert.equal(muted, cells(palette().muted('x'))[0].fg);
    assert.equal(warned, cells(palette().warning('x'))[0].fg);
  } finally {
    setDisplayConfig(previous);
    resetLedgerStamp();
  }
});

test('the summary row is a heading, never a selectable row (rulings Q5)', () => {
  const c = situationC();
  const rows = delegationAgentsRows(c.vm, { width: 48, nowMs: NOW, style: 'compact' });
  assert.equal(rows[0].item, undefined);
  assert.ok(rows[0].counts);
});
