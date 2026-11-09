import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../src/tree-page.js';
import {
  initialMonitorState,
  renderMonitor,
  handleMonitorInput,
  type MonitorControl,
} from '../../src/render/monitor.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage, t as word } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { targetKey, type WorkTarget } from '../../src/collectors/workboard-types.js';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';

test('fix4: whole-task-directory outage and safe recovery restore workers and fresh calls with unchanged bodies', async (t) => {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace'),
    directory = join(workspace, 'tmp', 'tasks', 'SYN');
  f.put(join(directory, 'brief.md'), '# Synthetic task');
  f.put(join(directory, 'review-1.md'), 'Verdict: accept');
  f.put(join(directory, 'STATUS.json'), {
    version: 1,
    task_dir: directory,
    slot: 'primary',
    role: 'implementer',
    model: 'synthetic',
    thinking: 'high',
    session_id: 'synthetic-primary',
    output_path: join(directory, 'report.md'),
    output_written: false,
    state: 'working',
    helper_pending: null,
    started_at: '2026-11-09T11:30:00Z',
    settled_at: null,
    idle_deadline_at: null,
    ended_at: null,
    exit_reason: null,
    error: null,
  });
  const originals = ['brief.md', 'STATUS.json', 'review-1.md'].map((name) => {
    const path = join(directory, name),
      stat = fs.statSync(path);
    return { path, body: fs.readFileSync(path), mtimeMs: stat.mtimeMs, ino: stat.ino };
  });
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  const sample = async () => {
    let reads = 0;
    for (let n = 0; n < 40; n++) {
      await pipeline.refresh();
      reads += pipeline.artifactCost!.files;
      assert.ok(pipeline.artifactCost!.files <= 8);
      assert.ok(pipeline.artifactCost!.probes <= 64);
    }
    const composed = pipeline.compose(f.emptyTree(), null, f.now());
    const board = pipeline.workboard(composed.tree, composed.legacy);
    const call = board.decisions[0],
      target: WorkTarget | undefined = call
        ? { kind: 'decision', laneId: call.laneId, decisionId: call.id }
        : undefined;
    const frame = renderMonitor({
      tree: composed.tree,
      workboard: board,
      state: {
        ...initialMonitorState(),
        mainTab: 'work',
        workTarget: target,
        boardExpanded: new Set(target ? [targetKey(target)] : []),
      },
      width: 56,
      height: 40,
      nowMs: f.now(),
    });
    return { board, frame, text: frame.lines.map(stripAnsi).join('\n'), reads };
  };
  try {
    const before = await sample();
    assert.equal(before.board.workers.length, 1);
    assert.equal(before.board.decisions.length, 1);
    assert.equal(before.board.decisions[0].stale, false);
    assert.equal(before.board.coverage.incomplete, false);
    assert.match(before.text, /imp/);
    assert.match(before.text, /Review accepted/);
    fs.chmodSync(directory, 0);
    const outage = await sample();
    assert.equal(outage.board.workers.length, 0);
    assert.equal(outage.board.decisions[0].stale, true);
    assert.equal(outage.board.coverage.incomplete, true);
    assert.match(outage.text, /stale evidence/);
    assert.doesNotMatch(outage.text, /synthetic·high/);
    fs.chmodSync(directory, 0o700);
    const recovered = await sample();
    assert.equal(recovered.board.workers.length, 1, 'unchanged cached primary returns after directory recovery');
    assert.deepEqual(recovered.board.workers, before.board.workers);
    assert.deepEqual(recovered.board.decisions, before.board.decisions);
    assert.equal(recovered.board.coverage.incomplete, false);
    assert.deepEqual(recovered.board.coverage.diagnostics, []);
    assert.match(recovered.text, /imp/);
    assert.match(recovered.text, /Review accepted/);
    assert.doesNotMatch(recovered.text, /stale evidence/);
    assert.ok(recovered.reads > 0, 'retained evidence was safely revalidated before becoming current');
    for (const original of originals) {
      assert.deepEqual(fs.readFileSync(original.path), original.body);
      const stat = fs.statSync(original.path);
      assert.equal(stat.mtimeMs, original.mtimeMs);
      assert.equal(stat.ino, original.ino);
    }
    const warm = await sample();
    assert.equal(warm.reads, 0);
    assert.equal(pipeline.artifactCost!.parses, 0);
    assert.deepEqual(warm.board.workers, before.board.workers);
    assert.equal(warm.board.coverage.incomplete, false);
  } finally {
    fs.chmodSync(directory, 0o700);
    pipeline.dispose();
  }
});

test('fix4: clicking the painted Home activation hint uses Enter handoff at its real narrow/wide EN/ZH coordinates', async (t) => {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace'),
    directory = join(workspace, 'tmp', 'tasks', 'SYN');
  f.put(
    join(directory, 'qa', 'q1.md'),
    '# Question\n\nWhich boundary?\n\nOptions:\n- A) Keep\n- B) Remove\n\nDefault if unanswered: A'
  );
  f.put(join(directory, 'qa', 'q1.answer.md'), 'B');
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  const oldLanguage = setLanguage('en'),
    oldDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    for (let n = 0; n < 40; n++) await pipeline.refresh();
    const composed = pipeline.compose(f.emptyTree(), null, f.now()),
      board = pipeline.workboard(composed.tree, composed.legacy);
    const decision = board.decisions[0],
      target: WorkTarget = { kind: 'decision', laneId: decision.laneId, decisionId: decision.id };
    for (const language of ['en', 'zh'] as const)
      for (const width of [44, 56, 110]) {
        setLanguage(language);
        const frame = renderMonitor({
          tree: composed.tree,
          workboard: board,
          state: { ...initialMonitorState(), homeTarget: target, boardFolded: new Set([target.laneId]) },
          width,
          height: 40,
          nowMs: f.now(),
        });
        const hint = word('Enter: open in Work'),
          y = frame.lines.findIndex((line) => stripAnsi(line).includes(hint));
        assert.ok(y >= 0);
        const painted = stripAnsi(frame.lines[y]),
          x = visualLength(painted.slice(0, painted.indexOf(hint))) + 3;
        const control: MonitorControl | undefined = frame.controls.find(
          (c) => c.kind === 'board-activate' && c.item === targetKey(target)
        );
        assert.ok(control);
        assert.equal(control.y, y);
        assert.ok(x >= control.x && x < control.x + control.width);
        const ctx = { tree: composed.tree, frame, standalone: true, nowMs: f.now() };
        const clicked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x, y }, ctx);
        const entered = handleMonitorInput(frame.state, { type: 'key', key: 'activate' }, ctx);
        assert.equal(clicked.state.mainTab, 'work');
        assert.deepEqual(clicked.state.workTarget, target);
        assert.deepEqual(clicked.state.workTarget, entered.state.workTarget);
        assert.deepEqual(clicked.state.boardFolded, entered.state.boardFolded);
        assert.equal(clicked.state.boardFolded?.has(target.laneId), false);
        assert.equal(clicked.state.boardExpanded?.has(targetKey(target)) ?? false, false);
        assert.equal(clicked.state.tree.selectedId, null);
        assert.equal(clicked.action, undefined);
        const work = renderMonitor({
          tree: composed.tree,
          workboard: board,
          state: clicked.state,
          width,
          height: 40,
          nowMs: f.now(),
        });
        assert.ok(work.workboard!.rows.some((row) => row.item === targetKey(target)));
      }
  } finally {
    pipeline.dispose();
    setLanguage(oldLanguage);
    setDisplayConfig(oldDisplay);
  }
});
