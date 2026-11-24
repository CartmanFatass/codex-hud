import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectObjectiveEvidence, objectivePath, readObjectives } from '../../dist/collectors/objectives.js';
import { STATE_BYTES } from '../../dist/collectors/state-ledger.js';
import { visualLength } from '../../dist/render/colors.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { NOW, plain, projectFixture } from '../fixtures/project-page.mjs';

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

test('bounded Objective reader skips malformed sections and ignores unknown fields', (t) => {
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
    const row = frame.workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'finish');
    frame.state.project.nav.cursor = row.item;
    const { state } = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame });
    assert.match(plain(f.render(120, lang, state, 56, withObjectives)).join('\n'), /Published a synthetic guide/);
  }
});

test('Home and Project open an Objective detail and route only its openable evidence', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const path = join(f.cwd, 'docs/notes.md'), report = join(f.sliceJob, 'report.md');
  f.put(path, '# Synthetic notes');
  f.put(objectivePath(f.cwd), sample.replace('123abcd',
    `123abcd, docs/missing.md, $HUD_HOME/jobs/j0000000000000002/report.md, ${report}`));
  const statePath = join(f.cwd, 'docs/handoff/STATE.md');
  const remaining = '## Waiting for the owner\n- [r2] Review alternative (objective hold)\n- [r3] Choose a chart (work waits)\n';
  f.put(statePath, remaining + '- [r1] Pick a method (objective measure) (work waits)\n');
  const data = await f.collector.collect(true, f.board, NOW);
  assert.equal(data.waiting.find(({ request }) => request === 'r1').objective, 'measure');
  assert.equal(data.objectives.objectives.find(({ id }) => id === 'measure').state, 'active');
  const homePortfolio = await new HomePortfolioCollector(f.hud).read([{ root: f.cwd, name: 'Study' }], f.board, NOW);
  const [openKey] = new WorkbenchInputDecoder('workboard').push(Buffer.from('o'));
  const key = (frame, input) => handleMonitorInput(frame.state, { type: 'key', key: input }, { frame });
  for (const activeTab of ['project', 'home']) {
    const draw = (state, lang = 'en') => f.render(120, lang, state, 24, data, true, 'unicode', 'none', { homePortfolio });
    const list = draw({ ...draw().state, activeTab });
    const entry = list.workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'measure');
    assert.match(entry.text, /blocked/);
    assert.ok(!list.workboard.rows.some((r) => r.objectiveTarget?.objective.id === 'hold' && r.objectiveTarget.blocked));
    if (activeTab === 'home') {
      list.state.home.cursor = list.workboard.rows.find((r) => r.item?.startsWith('home:result:')).item;
      assert.equal(key(list, 'enter').state.subpage.target.objective.id, 'finish');
      list.state.home.cursor = entry.item;
    } else list.state.project.nav.cursor = entry.item;
    const { state, action } = key(list, 'enter');
    assert.equal(action, undefined);
    assert.equal(state.subpage.kind, 'objective');
    const { objective } = state.subpage.target;
    state.subpage.evidence = collectObjectiveEvidence(objective, state.subpage.target.root, f.hud);
    let detail = draw(state);
    for (const lang of ['en', 'zh']) {
      const frame = draw(state, lang);
      assert.ok(frame.lines.every((line) => visualLength(line) === 120));
      const text = plain(frame).join('\n');
      assert.match(text, lang === 'en' ? /Evidence[\s\S]*missing · docs\/missing\.md/ : /依据[\s\S]*缺 · docs\/missing\.md/);
      assert.match(text, lang === 'en' ? /State\s+active · blocked/ : /状态\s+进行中 · 受阻/);
      assert.match(text, /https:\/\/example\.org\/notes\n\s+123abcd/);
    }
    for (const expected of [{ type: 'open-files', files: [path] }, undefined,
      { type: 'git-show', cwd: f.cwd, hash: '123abcd' }, undefined,
      { type: 'open-files', files: [report] }, { type: 'open-files', files: [report] }]) {
      assert.deepEqual(handleMonitorInput(detail.state, openKey, { frame: detail }).action, expected);
      detail = draw(key(detail, 'down').state);
    }
    const back = key(detail, 'escape').state;
    assert.equal(back.subpage, undefined);
    assert.equal(back.activeTab, activeTab);
    assert.equal((activeTab === 'home' ? back.home : back.project.nav).cursor, entry.item);
  }
  f.put(statePath, remaining);
  const refreshed = await f.collector.collect(true, f.board, NOW);
  const fresh = f.render(120, 'en', undefined, 24, refreshed);
  assert.doesNotMatch(fresh.workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'measure').text, /blocked/);
});
