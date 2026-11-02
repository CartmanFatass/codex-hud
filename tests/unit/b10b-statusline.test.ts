/**
 * Design §4.12: the statusline's delegation parts. The count that ends the
 * first line and the second line of items are compared with the design's 80
 * and 120 column samples (the 80 sample drops the `+1✓` the engine's rule
 * keeps, see the report), then the ladder, the height, the setting that turns
 * the line off, ASCII, CJK, Chinese words and the joined first line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import {
  countsText,
  joinFirstLine,
  statuslineDelegation,
  type StatuslineDelegation,
} from '../../src/render/delegation/statusline.js';
import { glyphSet } from '../../src/render/delegation/glyphs.js';
import { projectDelegation } from '../../src/render/delegation/projection.js';
import { plainSay } from '../../src/render/delegation/style.js';
import {
  NOW,
  S,
  ago,
  buildVm,
  situationC,
  situationD,
  situationE,
  situationG,
  situationH,
} from '../fixtures/b10b-delegation.js';

const plain = (value: string | null): string => stripAnsi(value ?? '');

function run(
  build: () => { vm: Parameters<typeof statuslineDelegation>[0] },
  width: number,
  extra: { ascii?: boolean; delegationLine?: boolean } = {}
): StatuslineDelegation {
  return statuslineDelegation(build().vm, { width, nowMs: NOW, say: plainSay, ...extra });
}

test('the counts end the first line: 2 working, 1 flag, 1 done', () => {
  const r = run(situationC, 80);
  assert.equal(plain(r.counts), '⧉ 2▸ 1⚑ 1✓');
});

test('80 columns: the design sample, plus the finished item the engine keeps', () => {
  const r = run(situationC, 80);
  assert.equal(plain(r.line2), '⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser 12m · ▸ ◎ ask-pro 4m · +1✓');
  // The design's own line is this one without the trailing `+1✓`: 3 items fit, the `+1✓` is what the count adds.
  assert.ok(plain(r.line2).startsWith('⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser 12m · ▸ ◎ ask-pro 4m'));
  assert.ok(visualLength(plain(r.line2)) <= 80);
  assert.equal(r.height, 2);
});

test('120 columns: the design sample exactly, with the pane', () => {
  const r = run(situationC, 120);
  assert.equal(plain(r.line2), '⧉ ⚑ π review-tests approval 10s · ▸ ⌬ impl-parser pane 4 12m · ▸ ◎ ask-pro 4m · +1✓');
  assert.equal(r.height, 2);
});

test('200 columns: each item carries its pane and mode', () => {
  const r = run(situationC, 200);
  assert.equal(
    plain(r.line2),
    '⧉ ⚑ π review-tests approval headless 10s · ▸ ⌬ impl-parser pane 4 12m · ▸ ◎ ask-pro 4m · +1✓'
  );
  assert.ok(visualLength(plain(r.line2)) <= 200);
});

test('the line is never wider than the width, at any width', () => {
  for (const build of [situationC, situationD, situationE, situationG, situationH]) {
    for (let width = 12; width <= 200; width += 4) {
      for (const ascii of [false, true]) {
        const r = run(build, width, { ascii });
        if (r.line2 !== null) assert.ok(visualLength(plain(r.line2)) <= width, `${build.name} ${width} ${ascii}`);
        assert.equal(r.height, r.line2 === null ? 1 : 2);
      }
    }
  }
});

test('the ladder: pane and mode go first, then ages, then actives into +N▸, trouble last of all', () => {
  const widths = [200, 130, 100, 80, 60, 40, 30];
  const lines = widths.map((w) => plain(run(situationD, w).line2));
  // 200: pane / mode and every age.
  assert.match(lines[0], /t-07 approval headless 10s/);
  assert.match(lines[0], /t-13 starting headless 12s/);
  // 100-159 shows the pane, never the mode; 80 shows neither.
  assert.doesNotMatch(lines[2], /headless/);
  assert.match(lines[3], /t-07 approval · \? ⌬ t-11 uncertain · ▸ ⌬ t-01 · ▸ π t-09 · \+1▸ \+1· \+9✓/);
  // Smaller still: the actives fold, the troubled stay as items.
  assert.match(lines[4], /^⧉ ⚑ π t-07 approval · \? ⌬ t-11 uncertain · \+3▸ \+1· \+9✓$/);
  // Last: the troubled become counts.
  assert.equal(lines[6], '⧉ 1⚑ 1? · +3▸ +1· +9✓');
  for (const line of lines) assert.ok(line.length > 0);
  // Each step is no wider than its budget and no step grows as the width shrinks.
  const widthsOf = lines.map((l) => visualLength(l));
  for (let i = 1; i < widthsOf.length; i++) assert.ok(widthsOf[i] <= widthsOf[i - 1]);
});

test('trouble items come newest first, ahead of the actives (§3.2); a conflict is one item however many parents claim it', () => {
  const r = run(situationE, 160);
  assert.equal(
    plain(r.line2),
    '⧉ ? π rev-a stale 48s · ⚠ ⌬ impl-c conflict ~6m · ? ⌬ impl-d supervisor lost 7m · ⚑ ◎ ask-pro needs human 9m · ? ⌬ impl-b uncertain 14m · ▸ ⌬ impl-a 2m'
  );
  // impl-c is claimed by two parents (two conflict rows in the projection) and is told once, as one `⚠` in the count.
  assert.equal(plain(r.line2).split('impl-c').length - 1, 1);
  assert.match(plain(r.counts), /1⚠/);
});

test('the ladder drops the troubled items words before it turns them into counts, in the order ⚑ ? ⚠ ✗', () => {
  // Words gone, marker + harness + name stay; the actives were already folded into +N▸ before this rung.
  assert.equal(
    plain(run(situationE, 80).line2),
    '⧉ ? π rev-a · ⚠ ⌬ impl-c · ? ⌬ impl-d · ⚑ ◎ ask-pro · ? ⌬ impl-b · +1▸'
  );
  assert.equal(plain(run(situationE, 140).line2).includes('impl-d supervisor lost'), true, 'wide enough: words stay');
  // Last of all the troubled become counts.
  assert.equal(plain(run(situationE, 60).line2), '⧉ 1⚑ 3? 1⚠ · +1▸');
  assert.equal(plain(run(situationE, 80).counts), '⧉ 1▸ 1⚑ 3? 1⚠');
  // Every rung is wider than the next and never exceeds its width.
  let last = Infinity;
  for (let width = 200; width >= 20; width -= 2) {
    const line = plain(run(situationE, width).line2);
    if (!line) continue;
    assert.ok(visualLength(line) <= width && visualLength(line) <= last + 0, `${width}: ${line}`);
    last = visualLength(line);
  }
});

test('close pane and stop in pane are alive in fact: kept as items, ahead of +N, never folded', () => {
  const r = run(situationH, 80);
  assert.equal(plain(r.line2), '⧉ ⚑ ⌬ impl-parser stop in pane · ✓ ⌬ docs-sync close pane · +2▸');
  const wide = run(situationH, 120);
  assert.equal(
    plain(wide.line2),
    '⧉ ⚑ ⌬ impl-parser stop in pane 2m · ▸ π review-tests 5m · ▸ ◎ ask-pro 4m · ✓ ⌬ docs-sync close pane 8m'
  );
  // The pane label is not said twice: the word already names the pane.
  assert.doesNotMatch(plain(wide.line2), /stop in pane pane/);
  assert.doesNotMatch(plain(wide.line2), /close pane pane/);
  // Even when the actives fold away, the close-pane item stays.
  for (let width = 60; width <= 120; width += 10) assert.match(plain(run(situationH, width).line2), /close pane/);
});

test('a full set of slots appends `· 6/6` to the count, and adds no item', () => {
  const r = run(situationD, 120);
  assert.equal(plain(r.counts), '⧉ 3▸ 1· 1⚑ 1? 9✓ · 6/6');
  assert.doesNotMatch(plain(r.line2), /6\/6/);
  assert.equal(plain(run(situationC, 120).counts).includes('/'), false);
});

test('the remainder counts agree with the first line: ✗ for a failure, ■ counted with ✓', () => {
  const r = run(situationG, 120);
  assert.equal(plain(r.counts), '⧉ 1▸ 1✗ 5✓');
  assert.equal(plain(r.line2), '⧉ ▸ ⌬ impl-parser 12m · +1✗ +5✓');
});

test('height: 1 without live or troubled delegations, 2 with them', () => {
  const finished = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null },
    {
      id: 'w',
      parent: 'main',
      harness: 'codex',
      run: { state: 'ended', mode: 'headless', endedAt: ago(900) },
      status: S.exited(ago(900)),
      createdAt: ago(1500),
    },
  ]);
  const r = statuslineDelegation(finished.vm, { width: 120, nowMs: NOW, say: plainSay });
  assert.equal(plain(r.counts), '⧉ 1✓');
  assert.equal(r.line2, null);
  assert.equal(r.height, 1);
  assert.equal(run(situationC, 120).height, 2);
});

test('a root alone, with nothing delegated, adds no count and no line', () => {
  const root = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working(ago(10)), label: null }]);
  const r = statuslineDelegation(root.vm, { width: 80, nowMs: NOW });
  assert.deepEqual(r, { counts: '', line2: null, height: 1 });
});

test('delegationLine=false keeps the count and drops the second line', () => {
  const r = run(situationC, 120, { delegationLine: false });
  assert.equal(plain(r.counts), '⧉ 2▸ 1⚑ 1✓');
  assert.equal(r.line2, null);
  assert.equal(r.height, 1);
});

test('too narrow for any item: only the first line (height 1)', () => {
  const r = run(situationC, 8);
  assert.equal(r.line2, null);
  assert.equal(r.height, 1);
  assert.equal(plain(r.counts), '⧉ 2▸ 1⚑ 1✓');
});

test('ASCII fallback: no non-ASCII character in the count or the line, same shape', () => {
  for (const build of [situationC, situationD, situationE, situationG, situationH]) {
    for (const width of [40, 80, 120, 200]) {
      const r = run(build, width, { ascii: true });
      assert.doesNotMatch(plain(r.counts), /[^\x20-\x7e]/, `${build.name} counts`);
      if (r.line2) assert.doesNotMatch(plain(r.line2), /[^\x20-\x7e]/, `${build.name} ${width}`);
    }
  }
  const r = run(situationC, 120, { ascii: true });
  assert.equal(plain(r.counts), '# 2> 1@ 1+');
  assert.equal(plain(r.line2), '# @ P review-tests approval 10s - > X impl-parser pane 4 12m - > J ask-pro 4m - +1+');
});

test('CJK names: widths are measured in columns and the line still fits', () => {
  const { vm } = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(10)), label: null },
    {
      id: 'a',
      parent: 'main',
      harness: 'codex',
      label: '解析器重构任务',
      status: S.pending('approval', ago(20)),
      createdAt: ago(300),
    },
    {
      id: 'b',
      parent: 'main',
      harness: 'pi',
      label: '审查测试用例与边界条件',
      status: S.working(ago(300)),
      createdAt: ago(310),
    },
  ]);
  for (const width of [30, 40, 60, 80, 120]) {
    const r = statuslineDelegation(vm, { width, nowMs: NOW, say: plainSay });
    assert.ok(r.line2 === null || visualLength(plain(r.line2)) <= width, String(width));
  }
  const r = statuslineDelegation(vm, { width: 80, nowMs: NOW, say: plainSay });
  assert.match(plain(r.line2), /⚑ ⌬ 解析器重构任务 approval/);
  // A name wider than the cap is cut by columns, not code points.
  const long = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(10)), label: null },
    {
      id: 'a',
      parent: 'main',
      harness: 'codex',
      label: '解'.repeat(20),
      status: S.working(ago(60)),
      createdAt: ago(100),
    },
  ]);
  const cut = plain(statuslineDelegation(long.vm, { width: 120, nowMs: NOW, say: plainSay }).line2);
  assert.ok(visualLength(cut) <= 120);
  assert.ok(!cut.includes('解'.repeat(20)));
});

test('Chinese words come from the table, the markers and names do not change', () => {
  const previous = setLanguage('zh');
  try {
    const r = statuslineDelegation(situationC().vm, { width: 120, nowMs: NOW });
    const line = plain(r.line2);
    assert.match(line, /review-tests 审批 10s/);
    assert.match(line, /▸ ⌬ impl-parser pane 4 12m/);
    assert.equal(plain(r.counts), '⧉ 2▸ 1⚑ 1✓');
    const h = plain(statuslineDelegation(situationH().vm, { width: 120, nowMs: NOW }).line2);
    assert.match(h, /⚑ ⌬ impl-parser 手动停止 2m/);
    assert.match(h, /✓ ⌬ docs-sync 请关窗格 8m/);
    assert.ok(visualLength(h) <= 120);
  } finally {
    setLanguage(previous);
  }
});

test('countsText is the count alone, and empty when nothing was delegated', () => {
  const g = glyphSet(false);
  assert.equal(plain(countsText(projectDelegation(situationC().vm), g)), '⧉ 2▸ 1⚑ 1✓');
  const root = buildVm([{ id: 'main', root: true, harness: 'claude', status: S.working(ago(10)), label: null }]);
  assert.equal(countsText(projectDelegation(root.vm), g), '');
});

test('joinFirstLine keeps the count at the end and cuts the session facts first', () => {
  const first = 'fable-5.1 high │ ctx 41% │ $1.24';
  const counts = '⧉ 2▸ 1⚑';
  const wide = joinFirstLine(first, counts, 80);
  assert.equal(plain(wide), `${first} │ ${counts}`);
  const narrow = joinFirstLine(first, counts, 30);
  assert.equal(visualLength(plain(narrow)), 30);
  assert.ok(plain(narrow).endsWith(` │ ${counts}`));
  assert.ok(plain(narrow).includes('…'));
  // Exactly fitting is not cut.
  const exact = joinFirstLine(first, counts, visualLength(first) + 3 + visualLength(counts));
  assert.equal(plain(exact), `${first} │ ${counts}`);
  // No count: the line is the first line, cut only when it must be.
  assert.equal(plain(joinFirstLine(first, '', 80)), first);
  assert.equal(visualLength(plain(joinFirstLine(first, '', 8))), 8);
  // No room even for the count: the count is cut, never the width exceeded.
  assert.ok(visualLength(plain(joinFirstLine(first, counts, 5))) <= 5);
  // ASCII uses ` | ` and `~`.
  const a = plain(joinFirstLine(first, '# 2> 1@', 24, true));
  assert.equal(visualLength(a), 24);
  assert.match(a, / \| # 2> 1@$/);
  assert.doesNotMatch(a, /[^\x20-\x7e]/);
});

test('§3.4: an item whose age cannot be measured has no age, never `0s`', () => {
  const tree = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null },
    {
      id: 'u',
      parent: 'main',
      run: { state: 'uncertain', reconciliation: 'scope_unknown' },
      status: { cls: 'uncertain', since: ago(100), evidenceAt: NOW + 60_000 },
      createdAt: ago(300),
    },
    {
      id: 'x',
      parent: 'main',
      status: { cls: 'unknown', since: ago(100), basis: 'event', evidenceAt: ago(50), clockAnomaly: true },
      createdAt: ago(200),
    },
    { id: 'w', parent: 'main', status: S.pending('approval', NOW + 90_000), createdAt: ago(100) },
  ]);
  const line = plain(statuslineDelegation(tree.vm, { width: 200, nowMs: NOW, say: plainSay }).line2);
  assert.match(line, /\bu uncertain\b/);
  assert.match(line, /\bx unknown\b/);
  assert.match(line, /\bw approval\b/);
  assert.doesNotMatch(line, /\b0s\b|\b\d+[smhd]\b/, line);
});

test('ASCII: the statusline holds nothing but ASCII, a capped name included', () => {
  const tree = buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(30)), label: null },
    {
      id: 'w',
      parent: 'main',
      label: 'a-very-long-synthetic-worker-name-here',
      status: S.pending('approval', ago(10)),
      createdAt: ago(100),
    },
    { id: 'k', parent: 'main', harness: 'pi', status: S.working(ago(60)), createdAt: ago(90) },
  ]);
  for (const width of [60, 80, 120, 200]) {
    const r = statuslineDelegation(tree.vm, { width, nowMs: NOW, say: plainSay, ascii: true });
    const line = plain(r.line2);
    assert.match(line, /^[\x20-\x7e]*$/, `${width}: ${line}`);
    assert.match(plain(r.counts), /^[\x20-\x7e]*$/);
  }
  const wide = plain(statuslineDelegation(tree.vm, { width: 200, nowMs: NOW, say: plainSay, ascii: true }).line2);
  assert.match(wide, /a-very-long-synthetic-w~ approval/, 'the cut ends with the ASCII ellipsis');
  // Unicode keeps its own.
  assert.match(
    plain(statuslineDelegation(tree.vm, { width: 200, nowMs: NOW, say: plainSay, ascii: false }).line2),
    /synthetic-w…/
  );
});
