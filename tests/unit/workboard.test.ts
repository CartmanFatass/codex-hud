import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { TaskObservationCollector } from '../../src/collectors/task-observations.js';
import { homeCalls } from '../../src/collectors/workboard.js';
import { targetKey, type WorkTarget } from '../../src/collectors/workboard-types.js';
import { initialMonitorState, renderMonitor, handleMonitorInput, type MonitorState } from '../../src/render/monitor.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { monitorKey, commandSequence } from '../../src/utils/panel-command.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { r5Fixture, ROOT_R5, FIXED_R5_NOW } from '../fixtures/r5-jobs.js';

function fixture(t: TestContext) {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace');
  fs.mkdirSync(join(workspace, 'tmp', 'tasks'), { recursive: true });
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  t.after(() => pipeline.dispose());
  const task = (name = 'T1') => {
    const directory = join(workspace, 'tmp', 'tasks', name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  const put = (file: string, text: unknown, at = FIXED_R5_NOW - 60000) => {
    f.put(file, text);
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  const qa = (
    directory: string,
    n: number,
    answer: string,
    options = ['A) Keep a shim', 'B) Remove the shim'],
    suggested = 'A'
  ) => {
    put(
      join(directory, 'qa', `q${n}.md`),
      `# Question q${n} from implementer\n\nWhich approach?\n\nOptions:\n${options.map((o) => '- ' + o).join('\n')}\n\nDefault if unanswered: ${suggested}\n\nContext: Synthetic compatibility constraint.\n\nAnswer: write elsewhere (not a locator)\n`,
      FIXED_R5_NOW - 120000
    );
    put(join(directory, 'qa', `q${n}.answer.md`), answer);
  };
  const status = (directory: string, patch: Record<string, unknown> = {}) =>
    put(join(directory, 'STATUS.json'), {
      version: 1,
      task_dir: directory,
      slot: 'primary',
      role: 'implementer',
      model: 'synthetic-model',
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
      ...patch,
    });
  const collect = async (ticks = 30) => {
    for (let i = 0; i < ticks; i++) await pipeline.refresh();
    const composition = pipeline.compose(f.emptyTree(), null, f.now());
    return {
      board: pipeline.workboard(composition.tree, composition.legacy),
      tree: composition.tree,
      cost: pipeline.artifactCost!,
    };
  };
  const draw = async (state: MonitorState = initialMonitorState(), width = 56, height = 80) => {
    const data = await collect();
    const frame = renderMonitor({ tree: data.tree, workboard: data.board, state, width, height, nowMs: f.now() });
    return { ...data, frame, text: frame.lines.map(stripAnsi).join('\n') };
  };
  return { ...f, workspace, pipeline, task, put, qa, status, collect, draw };
}

test('workboard real QA files: equality, explicit choices, conservative free text, quotation, negation and multipart yes', async (t) => {
  const f = fixture(t),
    d = f.task();
  for (const [n, a] of [
    'A',
    'B',
    'Remove the shim',
    'unstructured free text',
    'not A',
    '"B"',
    'yes',
    'B, but also A',
  ].entries())
    f.qa(d, n + 1, a);
  let data = await f.draw();
  assert.equal(data.board.decisions.length, 8);
  assert.deepEqual(
    data.board.decisions.map((d) => d.departure),
    [false, true, true, false, false, false, false, false]
  );
  assert.equal(data.board.decisions[1].instead, 'A');
  assert.match(data.text, /≠|~/);
  assert.match(data.text, /instead:/);
  assert.doesNotMatch(data.text, /consumed|adopted/i);
  f.put(join(d, 'qa', 'q2.answer.md'), '');
  f.put(join(d, 'qa', 'q3.answer.md'), 'B', FIXED_R5_NOW - 180000);
  fs.unlinkSync(join(d, 'qa', 'q1.answer.md'));
  data = await f.draw();
  assert.equal(data.board.decisions.length, 5);
  assert.ok(data.board.decisions.every((d) => !d.departure));
});

test('workboard real review/design files: exact first line, numeric rounds, explicit recommendation not adoption, and optional one-way', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.put(join(d, 'review-10.md'), 'Verdict: accept\r\n\nSynthetic review.');
  f.put(join(d, 'review-2.md'), 'Verdict: changes-required\n\nSynthetic review.');
  f.put(join(d, 'review-1.md'), '# Review\nVerdict: accept');
  f.put(join(d, 'review-3.md'), 'Verdict: ACCEPT');
  f.put(
    join(d, 'design.md'),
    '# Design\n\n## Recommendation\n\nKeep the old table read-only.\n\nOne-way: true\nAlternative: Drop it now\nRationale: Preserve synthetic history.'
  );
  f.put(join(d, 'notes.md'), 'The prose mentions one-way: true, but declares nothing.');
  const { board, text } = await f.draw();
  assert.deepEqual(
    board.decisions.filter((d) => d.kind === 'review').map((d) => [d.round, d.verdict]),
    [
      [2, 'changes-required'],
      [10, 'accept'],
    ]
  );
  assert.equal(board.decisions.filter((d) => d.kind === 'recommendation').length, 1);
  assert.equal(board.decisions.filter((d) => d.oneWay).length, 1);
  assert.match(text, /recommendation/);
  assert.match(text, /one-way/);
  assert.doesNotMatch(text, /merged|adopted/);
  assert.ok(board.lanes.every((l) => l.phase !== 'merged'));
});

test('workboard real direct custom primary output validates containment and model/effort without inventing a native subject', async (t) => {
  const f = fixture(t),
    d = f.task('Architect');
  f.put(join(d, 'brief.md'), '# Synthetic written title');
  f.status(d, {
    role: 'architect',
    output_path: join(d, 'architect-1.md'),
    output_written: true,
    state: 'idle_grace',
    settled_at: '2026-11-09T11:50:00Z',
  });
  f.put(join(d, 'architect-1.md'), '**Recommendation:** Keep one explicit boundary.');
  const data = await f.draw();
  const w = data.board.workers[0];
  assert.equal(data.board.lanes[0].phase, 'awaiting-acceptance');
  assert.equal(w.role, 'oracle');
  assert.equal(w.model, 'synthetic-model');
  assert.equal(w.effort, 'high');
  assert.equal(w.nodeId, undefined);
  assert.equal(data.tree.nodes.length, 0);
  assert.equal(data.board.decisions[0].kind, 'recommendation');
  assert.equal(w.task, 'Synthetic written title');
  assert.ok(!data.frame.controls.some((c) => c.kind === 'open-session' || c.kind === 'delegation-open'));
});

test('workboard identities: two workspaces stay apart, matching facade label never joins task directory, all-roots does not crawl cwd', async (t) => {
  const f = fixture(t),
    d = f.task('Same');
  f.put(join(d, 'brief.md'), '# Same');
  f.qa(d, 1, 'B');
  const a = f.association(1, { task_label: 'Same', cwd: f.workspace });
  f.dispatch(a);
  const data = await f.collect();
  assert.equal(data.board.lanes.length, 2);
  assert.notEqual(data.board.lanes[0].id, data.board.lanes[1].id);
  const other = join(f.home, 'other');
  fs.mkdirSync(join(other, 'tmp', 'tasks', 'Same'), { recursive: true });
  f.qa(join(other, 'tmp', 'tasks', 'Same'), 1, 'B');
  const observer = new TaskObservationCollector(other);
  t.after(() => observer.dispose());
  let second = observer.refresh();
  for (let n = 0; n < 20; n++) second = observer.refresh();
  assert.notEqual(second.lanes[0].id, data.board.lanes.find((l) => l.identity.kind === 'task-directory')!.id);
  const all = new PanelJobPipeline(f.home, null, { live: false });
  t.after(() => all.dispose());
  for (let n = 0; n < 20; n++) await all.refresh();
  const projected = all.compose(f.emptyTree(), null, f.now()),
    board = all.workboard(projected.tree);
  assert.ok(board.lanes.every((l) => l.identity.kind !== 'task-directory'));
  assert.ok(board.coverage.diagnostics.includes('workspace_not_bound'));
});

test('workboard unsafe source files and replaced ancestors: symlink, FIFO, escape never admitted; source removal and dispose clear eligibility', async (t) => {
  const f = fixture(t),
    d = f.task('Safe');
  f.qa(d, 1, 'B');
  f.put(join(d, 'review-1.md'), 'Verdict: accept');
  fs.symlinkSync(join(d, 'review-1.md'), join(d, 'review-2.md'));
  execFileSync('mkfifo', [join(d, 'review-3.md')]);
  f.status(d, { output_path: join(f.home, 'escape.md'), output_written: true });
  f.put(join(f.home, 'escape.md'), '# Recommendation\n\nNot admitted');
  let data = await f.collect();
  assert.equal(data.board.workers.length, 0);
  assert.equal(data.board.decisions.filter((d) => d.kind === 'review').length, 1);
  assert.equal(data.board.coverage.incomplete, true);
  const moved = join(f.home, 'moved-task');
  fs.renameSync(d, moved);
  fs.mkdirSync(d);
  f.qa(d, 1, 'A');
  data = await f.collect();
  assert.ok(data.board.decisions.every((d) => d.stale));
  assert.equal(data.board.workers.length, 0);
  fs.rmSync(d, { recursive: true });
  fs.rmSync(moved, { recursive: true });
  data = await f.collect();
  assert.equal(data.board.lanes.length, 0);
  f.pipeline.dispose();
  assert.equal(f.pipeline.workboard(f.emptyTree()).workers.length, 0);
});

test('workboard bounded warm refresh has zero body reads, enumeration and parsing; in-place edits, rename, creation and identical touches', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.qa(d, 1, 'A');
  f.put(join(d, 'brief.md'), '# Synthetic task');
  let data = await f.collect();
  assert.equal(data.board.decisions.length, 1);
  const warm = await f.collect(1);
  assert.equal(warm.cost.files, 0);
  assert.equal(warm.cost.enumerations, 0);
  assert.equal(warm.cost.parses, 0);
  assert.ok(warm.cost.probes > 0 && warm.cost.probes <= 64);
  const answer = join(d, 'qa', 'q1.answer.md');
  fs.writeFileSync(answer, 'B');
  data = await f.collect();
  assert.equal(data.board.decisions[0].departure, true);
  f.put(join(d, 'qa', 'replacement'), 'A');
  fs.renameSync(join(d, 'qa', 'replacement'), answer);
  data = await f.collect();
  assert.equal(data.board.decisions[0].departure, false);
  f.qa(d, 2, 'B');
  data = await f.collect();
  assert.equal(data.board.decisions.length, 2);
  const at = data.board.decisions[0].evidence.at(-1)!.at;
  fs.utimesSync(answer, new Date(), new Date());
  data = await f.collect();
  assert.equal(data.board.decisions[0].evidence.at(-1)!.at, at);
});

test('workboard bounded collection progresses fairly beyond one directory slice and shared budgets are charged', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 45; n++) {
    const d = f.task(`Task-${n}`);
    f.qa(d, 1, 'A');
  }
  for (let n = 0; n < 5; n++) f.dispatch(f.association(n + 1));
  let bytes = 0,
    entries = 0;
  for (let n = 0; n < 300; n++) {
    await f.pipeline.refresh((b, e) => {
      bytes = b;
      entries = e;
    });
    const cost = f.pipeline.artifactCost!;
    assert.ok(cost.files <= 8);
    assert.ok(cost.bytes <= 256 * 1024);
    assert.ok(cost.probes <= 64);
    assert.ok(bytes <= 1024 * 1024);
    assert.ok(entries <= 128 + 32 + 64);
  }
  const composed = f.pipeline.compose(f.emptyTree(), null, f.now()),
    board = f.pipeline.workboard(composed.tree);
  assert.equal(board.lanes.filter((l) => l.identity.kind === 'task-directory').length, 45);
  assert.equal(board.decisions.length, 45);
});

test('workboard read failure retains last good as stale, deletion removes it, root switch and workspace switch reset', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.qa(d, 1, 'B');
  let data = await f.collect();
  assert.equal(data.board.decisions[0].departure, true);
  const answer = join(d, 'qa', 'q1.answer.md');
  fs.chmodSync(answer, 0);
  data = await f.collect();
  assert.equal(data.board.decisions[0].stale, true);
  assert.equal(data.board.coverage.incomplete, true);
  fs.chmodSync(answer, 0o600);
  data = await f.collect();
  assert.equal(data.board.decisions[0].stale, false);
  fs.unlinkSync(answer);
  data = await f.collect();
  assert.equal(data.board.decisions.length, 0);
  f.pipeline.setRoot('other/root');
  assert.equal(f.pipeline.workboard(f.emptyTree()).decisions.length, 0);
});

test('workboard Home badge admits ended needs-human only: QA, failure, blocked, timeout and running human output excluded', async (t) => {
  const f = fixture(t);
  const web = {
    id: 'web',
    executor: 'jev' as const,
    harness: null,
    model: 'target',
    effort: null,
    env_profile: null,
    recipe: null,
  };
  f.jev(f.association(1, { backend: web, role: 'jev' }), 'completed', { status: 'needs_human' }, false, {
    run: { startedAt: '2026-11-09T11:00:00Z', endedAt: '2026-11-09T11:50:00Z' },
  });
  f.jev(f.association(2, { backend: web }), 'running', { status: 'needs_human' });
  f.jev(f.association(3, { backend: web }), 'completed', { status: 'timed_out' }, false, {
    run: { endedAt: '2026-11-09T11:50:00Z' },
  });
  f.jev(f.association(4, { backend: web }), 'completed', { status: 'blocked', steps: 1, goal: 'Synthetic' }, false, {
    tag: 'browse',
    run: { endedAt: '2026-11-09T11:50:00Z' },
  });
  const qaJob = f.association(5);
  f.dispatch(qaJob, 'waiting_orchestrator');
  f.put(join(f.home, 'jobs', qaJob.job, 'qa', 'q1.md'), 'Synthetic worker question');
  f.dispatch(f.association(6), 'failed');
  const data = await f.draw();
  assert.equal(data.board.workers.filter((w) => w.homeNeedsHuman).length, 1);
  assert.match(data.text, /Home \?1/);
  assert.match(data.text, /Ended needing a human/);
  assert.match(data.text, /10m/);
  const partial = renderMonitor({
    tree: data.tree,
    workboard: { ...data.board, workers: [], coverage: { ...data.board.coverage, incomplete: true } },
    state: initialMonitorState(),
    width: 56,
    height: 20,
    nowMs: f.now(),
  });
  assert.doesNotMatch(partial.lines.map(stripAnsi).join('\n'), /nothing needs you/);
});

test('workboard daily calls: three plus earlier, two-hour fold, one-way pin, local-midnight rollover without rereads', async (t) => {
  const f = fixture(t),
    d = f.task();
  for (let n = 1; n <= 6; n++) f.qa(d, n, 'A');
  f.qa(d, 7, 'B\n\nOne-way: true');
  f.put(join(d, 'qa', 'q7.answer.md'), 'B\n\nOne-way: true', FIXED_R5_NOW - 3 * 3600000);
  // Keep the pair current while the one-way event is old.
  f.put(
    join(d, 'qa', 'q7.md'),
    '# Question\n\nOptions:\n- A) Keep a shim\n- B) Remove the shim\n\nDefault if unanswered: A',
    FIXED_R5_NOW - 4 * 3600000
  );
  let data = await f.draw();
  assert.match(data.text, /\+3 earlier/);
  assert.match(data.text, /one-way/);
  assert.equal(homeCalls(data.board, f.now()).worth.length, 1);
  f.advance(3 * 3600000);
  data = await f.draw();
  assert.match(data.text, /6 older today/);
  assert.match(data.text, /one-way/);
  const tomorrow = new Date(f.now());
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const next = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: initialMonitorState(),
    width: 56,
    height: 60,
    nowMs: tomorrow.getTime(),
  });
  assert.doesNotMatch(next.lines.map(stripAnsi).join('\n'), /one-way/);
  assert.equal(homeCalls(data.board, tomorrow.getTime()).today, 0);
});

test('workboard input uses real decoder and frame: Home Enter targets worker/decision/lane; Work Enter inert, v/4 inspect, Escape returns', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.status(d);
  f.qa(d, 1, 'B');
  let data = await f.draw();
  const lane = data.board.lanes[0];
  const targets: WorkTarget[] = [
    { kind: 'lane', laneId: lane.id },
    { kind: 'worker', laneId: lane.id, workerId: lane.workers[0].id },
    { kind: 'decision', laneId: lane.id, decisionId: lane.decisions[0].id },
  ];
  for (const target of targets) {
    const state = { ...initialMonitorState(), homeTarget: target };
    data = await f.draw(state);
    const enter = new WorkbenchInputDecoder('workboard').push(Buffer.from('\r'))[0];
    const jump = handleMonitorInput(data.frame.state, enter, {
      tree: data.tree,
      frame: data.frame,
      nowMs: f.now(),
      standalone: true,
    });
    assert.equal(jump.state.mainTab, 'work');
    assert.deepEqual(jump.state.workTarget, target);
    assert.equal(jump.state.tree.selectedId, null);
    assert.equal(jump.action, undefined);
    const work = await f.draw(jump.state);
    assert.ok(work.frame.workboard!.rows.some((r) => r.item === targetKey(target)));
    const inert = handleMonitorInput(work.frame.state, enter, { tree: data.tree, frame: work.frame });
    assert.equal(inert.action, undefined);
    assert.equal(inert.state.focus, 'agents');
    const inspect = handleMonitorInput(
      work.frame.state,
      { type: 'key', key: monitorKey('inspect') },
      { tree: data.tree, frame: work.frame }
    );
    assert.equal(inspect.state.focus, 'details');
    const detail = await f.draw(inspect.state);
    const decoder = new WorkbenchInputDecoder('workboard');
    assert.deepEqual(decoder.push(Buffer.from('\x1b')), []);
    const esc = decoder.flushEscape()[0];
    const back = handleMonitorInput(detail.frame.state, esc, {
      tree: data.tree,
      frame: detail.frame,
      standalone: true,
    });
    assert.equal(back.state.focus, 'agents');
    assert.equal(back.state.mainTab, 'work');
  }
  const decoder = new WorkbenchInputDecoder('workboard', { forward: true });
  assert.equal(decoder.push(Buffer.from('2'))[0].type, 'key');
  assert.deepEqual(decoder.push(Buffer.from(commandSequence('pane-2'))), [{ type: 'command', command: 'pane-2' }]);
  assert.equal(monitorKey('pane-1'), 'home-tab');
  assert.equal(monitorKey('pane-2'), 'work-tab');
  assert.equal(monitorKey('pane-3'), 'changes');
  assert.equal(monitorKey('pane-4'), 'details');
  assert.equal(monitorKey('timeline'), 'timeline');
});

test('workboard main pages have no generation, recovery, status-level or Switch controls; summary is read-only in Inspector', async (t) => {
  const f = fixture(t),
    a = f.association(1);
  f.dispatch(a);
  let data = await f.draw();
  for (const mainTab of ['home', 'work'] as const) {
    data = await f.draw({ ...initialMonitorState(), mainTab });
    assert.equal(data.frame.statusCard, undefined);
    assert.ok(
      data.frame.controls.every(
        (c) => !['brief', 'level', 'delegation-recover', 'delegation-open', 'open-session', 'switch'].includes(c.kind)
      )
    );
    for (const key of ['resume-reconcile', 'reset', 'brief-toggle', 'open-session'])
      assert.equal(
        handleMonitorInput(data.frame.state, { type: 'key', key }, { tree: data.tree, frame: data.frame }).action,
        undefined
      );
  }
  const summary = handleMonitorInput(
    data.frame.state,
    { type: 'key', key: 'summary' },
    { tree: data.tree, frame: data.frame }
  );
  const frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: summary.state,
    width: 56,
    height: 30,
    nowMs: f.now(),
    brief: { overall: 'Synthetic goal' },
  });
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Main summary/);
});

for (const width of [16, 32, 44, 56, 110])
  for (const lang of ['en', 'zh'] as const)
    for (const colour of [false, true])
      for (const ascii of [false, true])
        test(`workboard exact cells ${width} ${lang} ${colour ? 'colour' : 'mono'} ${ascii ? 'ASCII' : 'glyphs'}`, async (t) => {
          const prev = setDisplayConfig({ theme: colour ? 'titanium' : 'none', icons: ascii ? 'text' : 'unicode' }),
            old = setLanguage(lang);
          t.after(() => {
            setDisplayConfig(prev);
            setLanguage(old);
          });
          const f = fixture(t),
            d = f.task('长任务名Long');
          f.put(join(d, 'brief.md'), '# 合成中文标题与很长的工作说明 Synthetic title');
          f.status(d);
          f.qa(d, 1, 'B\n\nOne-way: true');
          for (const mainTab of ['home', 'work'] as const) {
            const data = await f.draw({ ...initialMonitorState(), mainTab }, width);
            assert.equal(data.frame.lines.length, 80);
            for (const line of data.frame.lines) {
              assert.equal(visualLength(line), width);
              assert.ok(!line.includes('\x1b[2J'));
              if (ascii) assert.doesNotMatch(stripAnsi(line), /[┃│━─≠◷✓▸›·→↑↓]/);
            }
          }
        });

test('workboard render-on-change quiet timing evidence, three runs on this host (not WSL qualification)', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.status(d);
  f.qa(d, 1, 'B');
  const data = await f.collect();
  for (let run = 0; run < 3; run++) {
    const samples: number[] = [];
    for (let n = 0; n < 120; n++) {
      const start = performance.now();
      renderMonitor({
        tree: data.tree,
        workboard: data.board,
        state: initialMonitorState(),
        width: 56,
        height: 50,
        nowMs: f.now(),
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        measurement: 'workboard-full-render',
        host: process.platform,
        run,
        n: samples.length,
        p50: samples[59],
        p95: samples[113],
        p99: samples[118],
        max: samples[119],
      })
    );
  }
});

test('workboard primary read failure is stale, clean sources do not write, and workspace reset clears decisions', async (t) => {
  const f = fixture(t),
    d = f.task();
  f.status(d);
  f.qa(d, 1, 'A\n\n```\nOne-way: true\n```');
  const footprint = (path: string): string =>
    JSON.stringify(
      fs
        .readdirSync(path, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const file = join(e.parentPath, e.name);
          return [file, fs.readFileSync(file, 'utf8')];
        })
    );
  const before = footprint(f.workspace);
  let data = await f.collect();
  assert.equal(footprint(f.workspace), before);
  assert.equal(data.board.decisions[0].oneWay, false);
  fs.chmodSync(join(d, 'STATUS.json'), 0);
  data = await f.collect();
  assert.equal(data.board.workers[0].stale, true);
  assert.equal(data.board.coverage.incomplete, true);
  fs.chmodSync(join(d, 'STATUS.json'), 0o600);
  data = await f.collect();
  assert.equal(data.board.workers[0].stale, false);
  const observer = new TaskObservationCollector(f.workspace);
  t.after(() => observer.dispose());
  for (let n = 0; n < 20; n++) observer.refresh();
  observer.setWorkspace(null);
  assert.equal(observer.refresh().lanes.length, 0);
});

test('workboard exact-width empty, partial, no-one-way and missing-title/phase states in both languages', async (t) => {
  for (const scenario of ['empty', 'partial', 'missing', 'routine']) {
    const f = fixture(t);
    if (scenario === 'partial') {
      const d = f.task();
      fs.symlinkSync(join(d, 'absent'), join(d, 'notes.md'));
    }
    if (scenario === 'missing') f.task('Unnamed-scratch');
    if (scenario === 'routine') f.qa(f.task(), 1, 'A');
    const data = await f.collect();
    for (const lang of ['en', 'zh'] as const) {
      const old = setLanguage(lang);
      try {
        for (const width of [44, 56, 110])
          for (const mainTab of ['home', 'work'] as const) {
            const frame = renderMonitor({
              tree: data.tree,
              workboard: data.board,
              state: { ...initialMonitorState(), mainTab },
              width,
              height: 40,
              nowMs: f.now(),
            });
            for (const line of frame.lines) assert.equal(visualLength(line), width);
            const text = frame.lines.map(stripAnsi).join('\n');
            assert.doesNotMatch(text, /one-way|不可逆/);
            if (scenario === 'partial') assert.doesNotMatch(text, /nothing needs you|目前无需你处理/);
            if (scenario === 'missing') assert.match(text, /Unnamed-scratch/);
          }
      } finally {
        setLanguage(old);
      }
    }
  }
});

for (const standalone of [true, false])
  test(`workboard live tree-page always supplies sidecar (${standalone ? 'standalone' : 'embedded'})`, async (t) => {
    const f = fixture(t),
      d = f.task('LIVE');
    f.put(join(d, 'brief.md'), '# Synthetic live workspace');
    const settings = join(f.home, 'settings.json');
    f.put(settings, JSON.stringify({ language: 'en', theme: 'none', refreshMs: 100 }));
    const child = spawn(process.execPath, ['dist/tree-page.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: f.home,
        HUD_HOME: f.home,
        CODEX_HOME: join(f.home, 'codex'),
        CODEX_HUD_CWD: f.workspace,
        CODEX_HUD_PANEL_ROOT: ROOT_R5,
        CODEX_HUD_STANDALONE_PANEL: standalone ? '1' : '0',
        CODEX_HUD_SETTINGS_PATH: settings,
        CODEX_HUD_TMUX_BIN: '/bin/false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (b) => (text += b.toString()));
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !text.includes('Home')) await new Promise((r) => setTimeout(r, 20));
    assert.match(text, /Home/, stderr);
    assert.match(text, /Work/);
    assert.doesNotMatch(text, /Agents|Pause models|Status card/);
    child.stdin.write(commandSequence('quit'));
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  });
