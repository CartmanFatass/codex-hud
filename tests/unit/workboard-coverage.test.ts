import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';

test('review R3: every multi-source catch-up slice retains global pending membership/files; warm rotation is not pending', async (t) => {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace'),
    base = join(workspace, 'tmp', 'tasks'),
    d = join(base, 'ZZZ');
  for (let n = 0; n < 80; n++) fs.mkdirSync(join(base, `T${String(n).padStart(3, '0')}`), { recursive: true });
  // A regular file is observed, not falsely admitted as a task or perpetually called undiscovered.
  f.put(join(base, 'README.md'), 'Synthetic task inventory');
  for (let n = 1; n <= 100; n++) {
    const q = join(d, 'qa', `q${n}.md`),
      a = join(d, 'qa', `q${n}.answer.md`);
    f.put(q, '# Question\n\nWhich synthetic boundary?\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A');
    f.put(a, 'A');
    fs.utimesSync(q, new Date(f.now() - 120000), new Date(f.now() - 120000));
    fs.utimesSync(a, new Date(f.now() - 60000), new Date(f.now() - 60000));
  }
  const p = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  t.after(() => p.dispose());
  const board = () => {
    const v = p.compose(f.emptyTree(), null, f.now());
    return { tree: v.tree, workboard: p.workboard(v.tree, v.legacy) };
  };
  let partialSlices = 0;
  for (let tick = 0; tick < 400; tick++) {
    await p.refresh();
    const data = board();
    assert.ok(p.artifactCost!.probes <= 64);
    if (
      data.workboard.lanes.length < 81 ||
      data.workboard.decisions.length < 100 ||
      data.workboard.decisions.some((d) => d.stale)
    ) {
      partialSlices++;
      assert.equal(data.workboard.coverage.incomplete, true, `false complete at tick ${tick}`);
      const text = renderMonitor({ ...data, state: initialMonitorState(), width: 56, height: 30, nowMs: f.now() })
        .lines.map(stripAnsi)
        .join('\n');
      assert.doesNotMatch(text, /nothing needs you/);
      assert.match(text, /coverage incomplete/);
    }
  }
  assert.ok(partialSlices > 0);
  for (let tick = 0; tick < 100; tick++) {
    await p.refresh();
    const data = board();
    assert.equal(data.workboard.lanes.length, 81);
    assert.equal(data.workboard.decisions.length, 100);
    assert.ok(data.workboard.decisions.every((d) => !d.stale));
    assert.equal(data.workboard.coverage.incomplete, false);
    assert.equal(p.artifactCost!.parses, 0);
    assert.equal(p.artifactCost!.files, 0);
    assert.equal(p.artifactCost!.enumerations, 0);
    assert.ok(p.artifactCost!.probes <= 64);
  }
});
