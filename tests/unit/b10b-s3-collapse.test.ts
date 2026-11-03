/**
 * B10B-s3: a collapsed rich card says what it holds on its head (B10B-s2 review F6; design §3.4 "折叠的子树写
 * +3 (1⚑ 2▸)，< 40 列写 +3⚑", §3.5). `h` collapses through `state.tree.collapsed` by row key; the card's children
 * (its native sub-rows and its child cards) leave the list and the head carries their count.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import { NOW, situationC } from '../fixtures/b10b-delegation.js';

function card(width: number, collapsed: ReadonlySet<string>, ascii = false): string[] {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  const rows = delegationAgentsRows(c.vm, { width, nowMs: NOW, style: 'rich', collapsed, ascii });
  for (const row of rows) assert.equal(visualLength(row.text), width, `exactly ${width} columns`);
  return rows.map((row) => stripAnsi(row.text));
}
const KEY = situationC().keys['impl-parser'];

test('a collapsed card writes +N (…) after its name and loses its sub-rows; an open one writes none', () => {
  for (const width of [80, 56, 48]) {
    const open = card(width, new Set());
    const folded = card(width, new Set([KEY]));
    const head = folded.find((line) => line.includes('impl-parser'))!;
    assert.match(head, /impl-parser \+2 \(1▸ 1✓\) ─+/, `${width}: ${head}`);
    assert.ok(!open.find((line) => line.includes('impl-parser'))!.includes('+2'), 'open: no fold on the head');
    assert.ok(
      open.some((line) => line.includes('scout')),
      'open: the native sub-row is there'
    );
    assert.ok(!folded.some((line) => line.includes('scout')), 'folded: the sub-row is gone');
    assert.equal(folded.length, open.length - 2, 'folded: the two sub-rows leave');
  }
});

test('the card keeps its badge and its frame when the fold is written (head exactly the width)', () => {
  const head = card(48, new Set([KEY])).find((line) => line.includes('impl-parser'))!;
  assert.match(head, /^ {2}┌ ▸ ⌬ impl-parser \+2 \(1▸ 1✓\) ─+ \S+ 6\.1sol$/);
});

test('under 40 columns the long form gives way to the short one before the name is cut', () => {
  const folded = card(32, new Set([KEY]));
  const head = folded.find((line) => line.includes('impl-parser'))!;
  assert.match(head, /impl-parser \+2[⌕▸]? ?/, head);
  assert.ok(!head.includes('…'), 'the name is whole');
});

test('ASCII: the fold is written in the ASCII marks', () => {
  const head = card(48, new Set([KEY]), true).find((line) => line.includes('impl-parser'))!;
  assert.match(head, /impl-parser \+2 \(1> 1\+\)/);
});

test('ZH: the same head, the counts are marks and need no words', () => {
  const previous = setLanguage('zh');
  try {
    const head = card(48, new Set([KEY])).find((line) => line.includes('impl-parser'))!;
    assert.match(head, /impl-parser \+2 \(1▸ 1✓\)/);
  } finally {
    setLanguage(previous);
  }
});

test('collapsing the root card folds the whole tree under it into its head', () => {
  const c = situationC({ reviewPass: true, nativeMeta: true });
  const rows = delegationAgentsRows(c.vm, {
    width: 48,
    nowMs: NOW,
    style: 'rich',
    collapsed: new Set([c.keys['main']]),
  }).map((row) => stripAnsi(row.text));
  assert.equal(rows.length, 3, 'summary, then the root card: head and foot');
  assert.match(rows[1], /main \+6 \(1⚑ 3▸ 2✓\)/);
});

test('a card drawn open does not keep its old head once collapsed, and back (the caches read the fold)', () => {
  // The root card has no sub-rows of its own, so the fold is the only thing that changes in what it draws.
  const root = situationC({ reviewPass: true, nativeMeta: true }).keys['main'];
  const open = card(48, new Set());
  const folded = card(48, new Set([root]));
  const again = card(48, new Set());
  assert.match(folded[1], /main \+6 \(1⚑ 3▸ 2✓\)/);
  assert.ok(!open[1].includes('+6'));
  assert.deepEqual(again, open);
  // A different fold on the same card is a different head.
  const two = card(48, new Set([root, KEY]));
  assert.deepEqual(two, folded, 'the root fold hides the rest: same lines');
});
