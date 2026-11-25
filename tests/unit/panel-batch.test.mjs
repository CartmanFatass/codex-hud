/** The owner's batch row in the panel: one `X`, one confirmation for the whole batch. Synthetic data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { batchIndex, saveBatch } from '../../dist/mcp/batch-state.js';
import { createPanelActions } from '../../dist/panel/actions.js';
import { PanelJobPipeline } from '../../dist/panel/job-pipeline.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { procStat } from '../../dist/utils/proc.js';

const PANE = 'w4E:p1', WORKING = 'b1111111111111111', PAUSED = 'b2222222222222222', ENDED = 'b3333333333333333',
  OLD = 'b4444444444444444', ELSEWHERE = 'b5555555555555555';
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const decoder = new WorkbenchInputDecoder('workboard');
const press = (frame, bytes) => handleMonitorInput(frame.state, decoder.push(Buffer.from(bytes))[0], { frame });
const plain = (frame) => frame.lines.map(stripAnsi).join('\n');

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'panel-batch-')), home = join(root, 'hud'), cwd = join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  const put = (flow, state, states, extra = {}) => {
    fs.mkdirSync(join(home, 'flows', flow), { recursive: true });
    const items = states.map((s, k) => ({ item: k + 1, state: s, preset: null, pilot: k === 0 }));
    // This process stands in for a live runner, so a control never spawns one.
    const batch = { flow, pane: 'w9:p9', project_root: cwd, cwd, key: flow, created_at: Number(flow[1]), state, epoch: 0, streak: 0,
      settled: 0, failures: 0, notices: {}, totals: {}, pid: process.pid, start: procStat(process.pid).start,
      steps: { items: { state: state === 'completed' ? 'done' : 'running' } },
      scale: { role: 'sonic', count: states.length, cap: 4, max_parallel: 2, presets: [null], input_bytes: { max: 1, median: 1, total: 1 } }, ...extra };
    saveBatch(home, batch, items);
  };
  const mix = (n) => Object.entries(n).flatMap(([state, count]) => Array(count).fill(state));
  put(WORKING, 'working', mix({ done: 3, failed: 1, running: 2, waiting: 134 }));
  put(PAUSED, 'paused', mix({ done: 1, failed: 2, waiting: 5 }), { reason: 'failure circuit breaker' });
  put(ENDED, 'completed', mix({ done: 4 }));
  put(OLD, 'completed', mix({ done: 1 }));
  fs.utimesSync(join(home, 'flows', `${OLD}.json`), new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
  put(ELSEWHERE, 'working', mix({ waiting: 1 }), { project_root: join(root, 'other') });
  const pipeline = new PanelJobPipeline(home, { pane: PANE, project: cwd });
  t.after(() => { pipeline.dispose(); setDisplayConfig(display); fs.rmSync(root, { recursive: true, force: true }); });
  await pipeline.refresh();
  const draw = (state, width = 80, height = 24) => renderMonitor({ state, width, height, nowMs: Date.now(),
    workboard: pipeline.workboard(tree), jobsObserved: pipeline.jobsObserved });
  const jobs = () => draw({ ...initialMonitorState(), subpage: { kind: 'jobs', scroll: 0 } });
  const on = (frame, flow, width) => draw({ ...frame.state, subpage: { ...frame.state.subpage, cursor: `batch:${flow}` } }, width);
  return { home, cwd, pipeline, draw, jobs, on };
}

test('Jobs lists this project’s batches above the jobs, unfinished first, with the pause reason', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.pipeline.workboard(tree).batches.map((b) => b.flow), [PAUSED, WORKING, ENDED]);
  const frame = f.jobs(), text = plain(frame);
  assert.match(text, /b2222222 {2}Batch · 1\/8 done · 2 failed · 5 waiting +sonic · paused/);
  assert.match(text, /failure circuit breaker/);
  assert.match(text, /b1111111 {2}Batch · 3\/140 done · 1 failed · 2 running · 134 waiting +working/);
  assert.match(text, /b3333333 {2}Batch · 4\/4 done +sonic · done/);
  assert.doesNotMatch(text, /b4444444|b5555555|No jobs/);
  assert.match(frame.lines.at(-1), /X resume\/stop {2}n subagents {2}Esc back/);
  assert.doesNotMatch(frame.lines.at(-1), /details/);
});

test('one X asks once for the whole batch; p, r and s act, every other key cancels, an ended batch takes none', async (t) => {
  const f = await fixture(t);
  const working = f.on(f.jobs(), WORKING);
  assert.match(working.lines.at(-1), /X pause\/stop/);
  const asked = f.draw(press(working, 'X').state);
  assert.match(plain(asked), /Batch b1111111: stop cancels 134 waiting; 2 running finish\./);
  assert.match(plain(asked), /p pause {2}s stop {2}Esc cancel/);
  assert.deepEqual(press(asked, 'p').action, { type: 'batch-control', flow: WORKING, control: 'pause' });
  assert.deepEqual(press(asked, 's').action, { type: 'batch-control', flow: WORKING, control: 'stop' });
  for (const other of ['r', 'y', '\r', 'X']) {
    const out = press(asked, other);
    assert.deepEqual([out.action, out.state.overlay, out.state.subpage.kind], [undefined, undefined, 'jobs'], JSON.stringify(other));
  }
  const escaped = handleMonitorInput(asked.state, { type: 'key', key: 'escape' }, { frame: asked });
  assert.deepEqual([escaped.action, escaped.state.overlay, escaped.state.subpage.kind], [undefined, undefined, 'jobs']);

  const paused = f.draw(press(f.on(f.jobs(), PAUSED), 'X').state);
  assert.match(plain(paused), /Batch b2222222: stop cancels 5 waiting\. *\n {2}r resume {2}s stop {2}Esc cancel/);
  assert.deepEqual(press(paused, 'r').action, { type: 'batch-control', flow: PAUSED, control: 'resume' });
  assert.equal(press(paused, 'p').action, undefined);

  const ended = f.on(f.jobs(), ENDED);
  assert.doesNotMatch(ended.lines.at(-1), /X /);
  assert.equal(press(ended, 'X').state.overlay, undefined);
});

test('batch rows and the prompt fit their width in both languages, with every key whole', async (t) => {
  const f = await fixture(t);
  const keys = { en: ['p pause', 's stop', 'Esc cancel'], zh: ['p 暂停', 's 停止', 'Esc 取消'] };
  for (const lang of ['en', 'zh']) {
    const previous = setLanguage(lang);
    try {
      for (const width of [24, 40, 56, 80, 120]) {
        const list = f.on(f.jobs(), WORKING, width), asked = f.draw(press(list, 'X').state, width);
        for (const frame of [list, asked]) assert.ok(frame.lines.every((line) => visualLength(line) === width), `${lang} ${width}`);
        for (const key of keys[lang]) assert.ok(plain(asked).includes(key), `${lang} ${width}: ${key}`);
        for (const id of ['b1111111', 'b2222222']) assert.match(plain(list), new RegExp(`${id} +(Batch|批次)`));
        assert.match(plain(list), lang === 'zh' ? /已暂停/ : /paused/);
      }
      if (lang === 'zh') {
        const text = plain(f.jobs());
        assert.match(text, /批次 · 1\/8 完成 · 2 失败 · 5 排队中/);
        assert.match(text, /失败过多，已自动暂停/);
        assert.match(text, /X 继续／停止/);
      }
    } finally { setLanguage(previous); }
  }
});

test('the panel action runs the engine control once for the batch: pause, stop during the pause, then nothing left', async (t) => {
  const f = await fixture(t);
  const notices = [];
  let collected;
  const actions = createPanelActions(f.home, f.cwd, {}, { state: initialMonitorState(), repaint() {}, notice: (text) => notices.push(text),
    collect: () => collected() });
  const run = async (control) => {
    const done = new Promise((resolve) => { collected = resolve; });
    actions.execute({ type: 'batch-control', flow: WORKING, control }, initialMonitorState());
    await done;
    return batchIndex(f.home, WORKING).batch;
  };
  assert.deepEqual([(await run('pause')).state, notices], ['paused', []]);
  const stopped = await run('stop');
  assert.deepEqual([stopped.state, stopped.totals], ['stopped', { done: 3, failed: 1, running: 2, waiting: 0, cancelled: 134 }]);
  await f.pipeline.refresh();
  assert.match(plain(f.jobs()), /b1111111 {2}Batch · 3\/140 done · 1 failed · 2 running · 134 cancelled +stopping/);
  await run('resume');
  assert.deepEqual(notices, ['Batch unchanged: stopping']);
});
