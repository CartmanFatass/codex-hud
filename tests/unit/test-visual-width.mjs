import assert from 'node:assert/strict';

import { visualLength, visualWidth, truncateAnsi, stripAnsi } from '../../dist/render/colors.js';

// CJK wide characters count as 2 columns, not UTF-16 units.
assert.equal('中文测试'.length, 4, 'sanity: UTF-16 length differs from display width');
assert.equal(visualLength('中文测试'), 8);
assert.equal(visualLength('a中b'), 4);
// The reviewer's example: 9 UTF-16 units but 13 terminal columns.
assert.equal(visualLength('└─ ◐ 中文测试'), 13);

// Combining marks and zero-width code points occupy no column.
assert.equal(visualLength('e\u0301'), 1);
assert.equal(visualLength('a\u200bb'), 2);

// Emoji pictographs occupy 2 columns and survive surrogate-pair iteration.
assert.equal(visualWidth('\u{1F600}'), 2);
assert.equal(visualLength('x\u{1F600}y'), 4);

// Truncation respects columns and never splits a wide character.
assert.equal(truncateAnsi('中文测试中文', 5), '中文…');
assert.equal(visualLength(truncateAnsi('中文测试中文', 5)), 5);
assert.equal(truncateAnsi('abc', 2), 'a…');
// ANSI sequences survive intact.
assert.equal(stripAnsi(truncateAnsi('\x1b[31m中文测试\x1b[0m', 5)), '中文…');
assert.ok(truncateAnsi('\x1b[31m中文测试\x1b[0m', 5).startsWith('\x1b[31m'));

// Width-0 content edge cases.
assert.equal(truncateAnsi('中文', 0), '');
// The result never exceeds the column budget: with 2 columns only the
// ellipsis fits, since a CJK glyph alone already takes both.
assert.equal(truncateAnsi('中文', 2), '…');
assert.equal(truncateAnsi('中文', 3), '中…');
assert.equal(visualLength(truncateAnsi('中文', 3)), 3);

console.log('test-visual-width: PASS');
