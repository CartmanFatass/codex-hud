/**
 * B10B-s2: the panel's delegation view (design §3.1, §3.4, §3.5, §4.2–§4.13; rulings B10B-s2 Q1, Q2, Q4, Q10).
 *
 *  - the hook: `data.delegation` non-null is the delegation view, null and undefined are byte-identical to the
 *    legacy panel;
 *  - each scenario (a)-(h) at its stated width, compact and rich;
 *  - every row exactly `width` columns at every panel width, EN, ZH (CJK counts 2) and ASCII.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { initialMonitorState, renderMonitor, type MonitorData } from '../../src/render/monitor.js';
import { agentsView } from '../../src/render/monitor-panes.js';
import { delegationAgentsRows, type DelegationPanelOptions } from '../../src/render/delegation/panel.js';
import { ProjectionCache, projectDelegation } from '../../src/render/delegation/projection.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import { FIXED_NOW, makeHudData, makeNestedTree } from '../fixtures/hud-data.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationA,
  situationB,
  situationC,
  situationD,
  situationE,
  situationG,
  situationH,
  situationParent,
  type Built,
} from '../fixtures/b10b-delegation.js';

const plain = (vm: DelegationViewModel, options: Partial<DelegationPanelOptions> & { width: number }): string[] =>
  delegationAgentsRows(vm, { nowMs: NOW, style: 'compact', ...options }).map((row) => stripAnsi(row.text));
const key = (built: Built, id: string) => built.keys[id];

function monitorInput(delegation: DelegationViewModel | null | undefined, style: 'rich' | 'compact'): MonitorData {
  const state = initialMonitorState();
  state.style = style;
  const hud = makeHudData();
  return {
    tree: makeNestedTree(),
    state,
    width: 48,
    height: 30,
    nowMs: FIXED_NOW.getTime(),
    hud: delegation === undefined ? hud : { ...hud, delegation },
  };
}

test('hook: a null or absent view model draws the legacy panel byte for byte', () => {
  for (const style of ['rich', 'compact'] as const) {
    const legacy = renderMonitor(monitorInput(undefined, style)).lines;
    assert.deepEqual(renderMonitor(monitorInput(null, style)).lines, legacy, `${style}: null`);
    const withUndefined = monitorInput(undefined, style);
    withUndefined.hud = { ...withUndefined.hud!, delegation: undefined };
    assert.deepEqual(renderMonitor(withUndefined).lines, legacy, `${style}: undefined`);
  }
});

test('hook: a non-null view model is the agents view, natives only included (no content heuristic)', () => {
  const b = situationB();
  for (const style of ['rich', 'compact'] as const) {
    const input = monitorInput(b.vm, style);
    const rows = agentsView(input, input.state, 48, NOW, true).map((row) => stripAnsi(row.text));
    assert.ok(
      rows.some((r) => r.includes('implementer')),
      `${style}: the native from the view model is drawn`
    );
    // Nothing of the legacy tree is drawn when the view model is there.
    assert.ok(!rows.some((r) => r.includes('explorer') || r.includes('ghost')), `${style}: no legacy rows`);
    const legacy = agentsView(monitorInput(undefined, style), input.state, 48, NOW, true).map((row) =>
      stripAnsi(row.text)
    );
    assert.ok(
      legacy.some((r) => r.includes('explorer')),
      `${style}: the legacy view would have drawn them`
    );
    assert.ok(rows[0].includes('2▸ 1✗ 1✓'), `${style}: the delegation summary row: ${rows[0]}`);
    const frame = renderMonitor(input).lines.map(stripAnsi);
    assert.ok(
      frame.some((r) => r.includes('failed_子')),
      `${style}: through renderMonitor`
    );
  }
});

test('the parent row is pinned above the heading: it stays at the top however far the view is scrolled', () => {
  const built = situationParent('offline');
  const input = monitorInput(built.vm, 'compact');
  input.height = 8;
  input.state.scroll.agents = 50;
  const frame = renderMonitor(input).lines.map(stripAnsi);
  const at = frame.findIndex((line) => line.startsWith('↑ parent ✳ main'));
  assert.ok(at > 0, frame.join('\n'));
  assert.match(frame[at + 1], /1▸/, 'the heading right under it');
  const pane = renderMonitor(input).panes.find((p) => p.id === 'agents')!;
  assert.equal(pane.pinned, 2);
});

test('no viewpoint root: the summary row, and the empty lines only while the ledger is readable', () => {
  const { vm } = buildVm([{ id: 'w', parent: 'gone', harness: 'codex', status: S.working() }]);
  vm.tree.nodes.length = 0;
  vm.tree.relations.length = 0;
  const empty = () => [{ text: 'EMPTY' }];
  assert.deepEqual(
    delegationAgentsRows(vm, { width: 40, nowMs: NOW, style: 'compact', empty }).map((r) => r.text.trim()),
    ['', 'EMPTY']
  );
  vm.tree.ledger = { state: 'degraded', ledgerId: null, asOfSeq: null, reason: 'ledger_unavailable' };
  const rows = delegationAgentsRows(vm, { width: 40, nowMs: NOW, style: 'compact', empty }).map((r) =>
    stripAnsi(r.text).trim()
  );
  assert.deepEqual(rows, ['ledger unavailable'], 'an unreadable ledger is not "no agents"');
});

test('(a) one session, 48 rich: the root card, head and foot, no agents counts', () => {
  const rows = plain(situationA().vm, { width: 48, style: 'rich' });
  assert.equal(rows[0].trim(), '', 'no counts: nothing under the root');
  assert.match(rows[1], /^┌ ▸ main ─+/);
  assert.match(rows[2], /^└ ◷3m10s ─+41%─+$/);
  assert.equal(rows.length, 3, 'no brief, action or rate line: the view model has none (Q2)');
});

test('(b) natives only, 48: root card, root natives as cards, deeper natives as sub-rows, failures first', () => {
  const rich = plain(situationB().vm, { width: 48, style: 'rich' });
  assert.equal(rich[0].trim(), '2▸ 1✗ 1✓', 'natives are in the counts (Q4)');
  assert.match(rich[1], /^┌ ▸ {3}main ─/, 'a single-harness tree with kind icons keeps a blank slot for the root');
  assert.match(rich[3], /^ {2}┌ ▸ ⚒ implementer ─/);
  assert.match(rich[4], /^ {2}│ ! ⚗ failed_子 · failed +40s$/);
  assert.match(rich[5], /^ {2}│ ▸ ⌕ running_子 +◷1m10s$/);
  assert.match(rich[7], /^ {2}┌ ✓ ⌕ scout ─/);
  const compact = plain(situationB().vm, { width: 48 });
  assert.match(compact[3], /^ │ ├ ! ⚗ failed_子 · failed +40s$/);
});

test('(c) cross-harness, 48: summary, cards, micro card under the selection', () => {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  const compact = plain(c.vm, { width: 48, selectedId: key(c, 'review-tests') });
  assert.equal(compact[0].trim(), '3▸ 1⚑ 2✓ · 3 workers, 1 job · ≥$0.12');
  assert.match(compact[2], /^›├ ⚑ π review-tests ⊟ · approval +10s$/);
  assert.equal(compact[3].trimEnd(), '││   worker · ⊟ headless · bound 6m · $0.12');
  assert.equal(compact[4].trimEnd(), '││   ⚑ approval', 'the pending word alone (Q2)');
  const rich = plain(c.vm, { width: 48, style: 'rich' });
  const impl = rich.findIndex((r) => r.includes('impl-parser'));
  assert.equal(rich[impl + 1].trimEnd(), '  │ worker · pane 4 · bound 12m');
  assert.match(rich[impl + 2], /^ {2}│ ▸ ⌕ scout 中文 boundaries +◷1m00s$/, 'the native sub-row');
  assert.match(rich[impl + 3], /^ {2}│ ✓ ◈ review-pass +1m$/);
  assert.match(rich[impl + 4], /^ {2}└ ◷12m04s ─+56%─+$/, 'the foot: clock and meter, no rate');
  const docs = rich.findIndex((r) => r.includes('docs-sync'));
  assert.equal(rich[docs + 1].trimEnd(), '  │ worker · reported 2m', 'a finished run has no host');
  assert.equal(rich[docs + 2].trimEnd(), '  │ ✓ Synced two reference sections.');
});

test('(d) slots full, 48: the slots chip, the uncertain worker holds its slot, the done bucket folds', () => {
  const d = situationD();
  const rows = plain(d.vm, { width: 48, selectedId: key(d, 't-11') });
  assert.match(rows[0], /^ 3▸ 1· 1⚑ 1\? 9✓ · slots 6\/6 · 6 workers/);
  assert.equal(rows[4].trimEnd(), '││   worker · ⊟ headless · bound 25m · slot held');
  assert.equal(rows[5].trimEnd(), '││   ? uncertain: scope unknown');
  assert.match(rows.at(-1)!, /✓ 9 done · t-02 .* ⊕9$/);
});

test('(e) trouble, 48: supervisor lost is its own word; the conflict child is one worker', () => {
  const e = situationE();
  const rows = plain(e.vm, { width: 48, selectedId: key(e, 'impl-d') });
  assert.equal(rows[0].trim(), '1▸ 1⚑ 3? 1⚠ · 5 workers, 1 job');
  assert.equal(rows[6].trimEnd(), '││   worker · bound 20m · slot held');
  assert.equal(rows[7].trimEnd(), '││   ? supervisor lost', 'the cause is the word itself: no "supervisor dead"');
  const rich = plain(e.vm, { width: 48, style: 'rich' });
  const c = rich.findIndex((r) => r.includes('impl-c'));
  assert.equal(rich[c + 1].trimEnd(), '  │ ⚠ conflict: 2 records · since ~6m');
});

test('(g) history, 48: one worker on the list, the rest put away; the ended row tells why', () => {
  const g = situationG();
  assert.equal(plain(g.vm, { width: 48 })[0].trim(), '1▸ 1✗ 5✓ · 1 worker · 6 put away');
  const rows = plain(g.vm, { width: 80, showHistory: true, selectedId: key(g, 'soak') });
  const soak = rows.findIndex((r) => r.includes('soak'));
  assert.equal(rows[soak + 2].trimEnd(), '││   ended · no report · runtime limit · exit unknown');
});

test('(h) visible run endings, 48 and 32: the contract sentence, its short forms, close pane', () => {
  const h = situationH();
  const rich = plain(h.vm, { width: 48, style: 'rich', selectedId: key(h, 'impl-parser') });
  const at = rich.findIndex((r) => r.includes('impl-parser'));
  assert.deepEqual(
    rich.slice(at + 2, at + 5).map((r) => r.trimEnd()),
    [
      '  │ ⚑ Still running — automatic cancellation is',
      '  │   unavailable. Stop this run in its terminal',
      '  │   pane.',
    ],
    'the sentence wraps by words to three lines at 48'
  );
  const docs = rich.findIndex((r) => r.includes('docs-sync'));
  assert.equal(rich[docs + 1].trimEnd(), '  │ worker · pane 5 · reported 8m · close pane');
  assert.equal(
    plain(h.vm, { width: 48, selectedId: key(h, 'impl-parser') })[4].trimEnd(),
    '││   ⚑ Still running — stop this run in its pane'
  );
  const narrow = plain(h.vm, { width: 32, selectedId: key(h, 'impl-parser') });
  assert.equal(narrow[4].trimEnd(), '││   ⚑ running · stop in pane');
  assert.match(narrow[7], /^ └ ✓ ⌬ docs-sync +8m$/, '`close pane` yields at 32 columns');
  const wide = plain(h.vm, { width: 80, style: 'rich', selectedId: key(h, 'impl-parser') });
  const w = wide.findIndex((r) => r.includes('impl-parser'));
  assert.ok(wide[w + 3].includes('pane.'), 'two lines at 80');
  assert.match(wide[w + 4], /^ {2}└ /, wide.join('\n'));
});

test('every row is exactly the panel width: every scenario, both layouts, 32-80, EN, ZH and ASCII', () => {
  const situations: Array<[string, () => Built]> = [
    ['a', situationA],
    ['b', situationB],
    ['c', () => situationC({ reviewPass: true, nativeMeta: true })],
    ['d', situationD],
    ['e', situationE],
    ['g', situationG],
    ['h', situationH],
  ];
  for (const language of ['en', 'zh'] as const) {
    const previous = setLanguage(language);
    try {
      for (const [name, make] of situations) {
        const built = make();
        for (const width of [32, 36, 40, 44, 48, 52, 56, 64, 80])
          for (const style of ['rich', 'compact'] as const)
            for (const ascii of [false, true])
              for (const selected of [null, ...Object.values(built.keys)]) {
                const rows = delegationAgentsRows(built.vm, {
                  width,
                  nowMs: NOW,
                  style,
                  ascii,
                  selectedId: selected,
                  showHistory: true,
                });
                for (const row of rows)
                  assert.equal(
                    visualLength(row.text),
                    width,
                    `${language} ${name} ${style} ${width} ${ascii ? 'ascii' : ''} ${selected}: ${stripAnsi(row.text)}`
                  );
              }
      }
    } finally {
      setLanguage(previous);
    }
  }
});

test('CJK: a ZH word and a CJK name count two columns each, and the line is cut by columns', () => {
  const previous = setLanguage('zh');
  try {
    const h = situationH();
    const rows = plain(h.vm, { width: 32, selectedId: key(h, 'impl-parser') });
    assert.equal(rows[4].trimEnd(), '││   ⚑ 运行中 · 手动停止');
    assert.equal(visualLength(rows[3]), 32);
    const b = situationB();
    const rich = plain(b.vm, { width: 40, style: 'rich' });
    const failed = rich.find((r) => r.includes('failed_子'))!;
    assert.equal(visualLength(failed), 40);
    assert.ok(failed.includes('失败'), failed);
  } finally {
    setLanguage(previous);
  }
});

test('ASCII: the whole glyph table switches, the contract dash included', () => {
  const h = situationH();
  const rows = plain(h.vm, { width: 48, ascii: true, selectedId: key(h, 'impl-parser') });
  assert.equal(rows[0].trim(), '2> 1@ 1+ - 3 workers, 1 job');
  assert.equal(rows[4].trimEnd(), '||   @ Still running - stop this run in its pane');
  for (const row of rows) assert.doesNotMatch(row, /[⚑▸✓·━─│├└⌬π◎⊟—]/u, row);
  const rich = plain(h.vm, { width: 48, ascii: true, style: 'rich' });
  assert.ok(
    rich.every((row) => !/[⚑▸✓·⌬π◎⊟—]/u.test(row)),
    rich.join('\n')
  );
});

test('a fresh projection and a cached one draw the same panel', () => {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  const first = plain(c.vm, { width: 48, style: 'rich' });
  projectDelegation(c.vm, new ProjectionCache());
  assert.deepEqual(plain(structuredClone(c.vm), { width: 48, style: 'rich' }), first);
  assert.equal(ago(0), NOW);
});
