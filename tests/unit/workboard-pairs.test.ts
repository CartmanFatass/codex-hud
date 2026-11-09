import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { renderMonitor, initialMonitorState } from '../../src/render/monitor.js';
import { visualLength } from '../../src/render/colors.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';

for (const pairs of [50, 100])
  test(`review R2 recheck: ${pairs} real QA pairs catch up incrementally and stay fresh with zero warm reparses`, async (t) => {
    const f = r5Fixture(t),
      workspace = join(f.home, 'workspace'),
      directory = join(workspace, 'tmp', 'tasks', 'SYN');
    fs.mkdirSync(directory, { recursive: true });
    const p = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
    t.after(() => p.dispose());
    const putPair = (n: number, reverse = false) => {
      const q = join(directory, 'qa', `q${n}.md`),
        a = join(directory, 'qa', `q${n}.answer.md`),
        at = f.now() - (reverse ? 10000 : 60000);
      f.put(
        q,
        `# Question\n\nWhich synthetic choice?\n\nOptions:\n- A) ${reverse ? 'Remove' : 'Keep'}\n- B) ${reverse ? 'Keep' : 'Remove'}\n\nDefault if unanswered: ${reverse ? 'B' : 'A'}`
      );
      f.put(a, reverse ? 'B' : 'A');
      fs.utimesSync(q, new Date(at - 1000), new Date(at - 1000));
      fs.utimesSync(a, new Date(at), new Date(at));
    };
    for (let n = 1; n <= pairs; n++) putPair(n);
    const board = () => {
      const result = p.compose(f.emptyTree(), null, f.now());
      return { tree: result.tree, workboard: p.workboard(result.tree, result.legacy) };
    };
    for (let n = 0; n < 300; n++) {
      await p.refresh();
      assert.ok(p.artifactCost!.probes <= 64);
      assert.ok(p.artifactCost!.files <= 8);
    }
    for (let n = 0; n < 100; n++) {
      await p.refresh();
      const data = board();
      assert.equal(data.workboard.decisions.length, pairs);
      assert.ok(data.workboard.decisions.every((d) => !d.stale && !d.departure));
      assert.equal(data.workboard.coverage.incomplete, false);
      const cost = p.artifactCost!;
      assert.equal(cost.files, 0);
      assert.equal(cost.bytes, 0);
      assert.equal(cost.enumerations, 0);
      assert.equal(cost.parses, 0);
      assert.ok(cost.probes <= 64);
    }
    // A population-wide rewrite must retain independent coherent calls while pairs finish on separate slices.
    for (let n = 1; n <= pairs; n++) putPair(n, true);
    for (let n = 0; n < 200; n++) {
      await p.refresh();
      assert.ok(board().workboard.decisions.every((d) => !d.departure));
      assert.ok(p.artifactCost!.probes <= 64);
    }
    const data = board();
    assert.equal(data.workboard.decisions.length, pairs);
    assert.ok(data.workboard.decisions.every((d) => d.title === 'B' && !d.stale));
    assert.equal(data.workboard.coverage.incomplete, false);
    assert.equal(p.artifactCost!.parses, 0);
    const frame = renderMonitor({ ...data, state: initialMonitorState(), width: 56, height: 32, nowMs: f.now() });
    for (const line of frame.lines) assert.equal(visualLength(line), 56);
  });
