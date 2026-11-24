import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { objectivePath, readObjectives } from '../../dist/collectors/objectives.js';
import { STATE_BYTES } from '../../dist/collectors/state-ledger.js';
import { visualLength } from '../../dist/render/colors.js';
import { NOW, onPage, plain, projectFixture } from '../fixtures/project-page.mjs';

const sample = `# Objectives
**Stance:** active · **Priority:** high

## finish: Publish the guide
**State:** done
**Result:** Published a synthetic guide.

## hold: Compare an alternative
**State:** paused
**Next:** Wait for sample readings.

## measure: Measure the sample
**State:** active
**Features:** native-tree, missing
**Next:** Repeat the sample.
**Result:** Recorded a baseline.
**Evidence:** docs/notes.md, https://example.org/notes, 123abcd
**Future field:**  keep  these spaces${'  '}

## invalid: Missing a required field
**Next:** Not an Objective.
`;

test('bounded Objective reader keeps unknown fields and skips malformed sections', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = objectivePath(root);
  assert.equal(readObjectives(root), undefined);
  fs.mkdirSync(join(root, '.hud'));
  fs.writeFileSync(path, sample);
  const { stance, priority, objectives, diagnostics } = readObjectives(root);
  assert.deepEqual([stance, priority], ['active', 'high']);
  assert.deepEqual(objectives.map(({ id, state }) => [id, state]), [['finish', 'done'], ['hold', 'paused'], ['measure', 'active']]);
  assert.deepEqual(objectives[2], {
    id: 'measure', title: 'Measure the sample', state: 'active', features: ['native-tree', 'missing'],
    next: 'Repeat the sample.', result: 'Recorded a baseline.', evidence: ['docs/notes.md', 'https://example.org/notes', '123abcd'],
    unknownFields: ['**Future field:**  keep  these spaces  '],
  });
  assert.deepEqual(diagnostics, ['Malformed Objective section 4']);
  fs.writeFileSync(path, '## same: One\n**State:** active\n## same: Two\n**State:** done\n');
  const repeated = readObjectives(root);
  assert.deepEqual([repeated.stance, repeated.priority, repeated.objectives.length, repeated.diagnostics.length], ['unknown', 'normal', 0, 2]);
  fs.writeFileSync(path, sample + ' '.repeat(STATE_BYTES));
  assert.deepEqual(readObjectives(root).objectives, []);
  assert.match(readObjectives(root).diagnostics[0], /exceeds/);
});

test('Project hub renders Objective details and a linked checklist at 120 columns in English and Chinese', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  f.put(join(f.cwd, '.scratch/native-tree/issues/01-sample.md'), '# 01: Sample\n**Status:** ready-for-agent\n**Blocked by:** none\n- [x] Observe\n- [ ] Repeat\n');
  f.put(objectivePath(f.cwd), sample);
  const withObjectives = await f.collector.collect(true, f.board, NOW);
  const words = {
    en: ['Needs you', 'Objectives', 'active', 'paused', 'done', 'Result: Recorded a baseline.', 'Next: Repeat the sample.'],
    zh: ['需要你处理', '目标', '进行中', '已暂停', '完成', '结果：Recorded a baseline.', '下一步：Repeat the sample.'],
  };
  for (const [lang, [needs, heading, active, paused, done, result, next]] of Object.entries(words)) {
    const baseline = plain(f.render(120, lang));
    assert.ok(!baseline.some((line) => line.startsWith(heading)));
    const frame = f.render(120, lang, undefined, 56, withObjectives), lines = plain(frame);
    for (const line of frame.lines) assert.equal(visualLength(line), 120);
    const order = [needs, heading, 'measure: Measure the sample', 'hold: Compare an alternative', 'finish: Publish the guide']
      .map((word) => lines.findIndex((line) => line.includes(word)));
    assert.ok(order.every((n, i) => n > (order[i - 1] ?? -1)), lines.join('\n'));
    for (const [i, state] of [active, paused, done].entries()) assert.ok(lines[order[i + 2]].endsWith(state));
    const text = lines.join('\n');
    assert.ok(text.includes(result) && text.includes(next));
    assert.deepEqual(text.match(/\S+ \d+\/\d+/g), ['native-tree 1/2']);
    assert.doesNotMatch(text, /Published a synthetic guide/);
    const unfolded = onPage(undefined, { project: { folded: new Set(['objective:finish']) } });
    assert.match(plain(f.render(120, lang, unfolded, 56, withObjectives)).join('\n'), /Published a synthetic guide/);
  }
});
