import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { PanelJobPipeline } from '../../dist/panel/job-pipeline.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';

const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const plain = (frame) => frame.lines.map(stripAnsi).join('\n');
const decoder = new WorkbenchInputDecoder('workboard');
const press = (frame, byte) => handleMonitorInput(frame.state, decoder.push(Buffer.from(byte))[0], { frame });
const key = (frame, name) => handleMonitorInput(frame.state, { type: 'key', key: name }, { frame });

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hud-home-jobs-'));
  const home = join(root, 'hud'), cwd = join(root, 'project'), nowMs = Date.now();
  const put = (path, body) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const job = (n, status, pane = 'w4E:p1', parent) => {
    const id = `j${String(n).padStart(16, '0')}`, dir = join(home, 'jobs', id);
    put(join(dir, 'job.json'), { job: id, role: parent ? 'sonic' : 'imp', caller_pane: pane,
      cwd, created_at: new Date(nowMs - 86_000_000 + 100 * n).toISOString(), parent_job: parent });
    put(join(dir, 'STATUS.json'), { state: status, ...(status === 'done' && { settled_at: new Date(nowMs - 70_000_000).toISOString() }) });
    put(join(dir, 'brief.md'), `# Synthetic worker ${n}`);
    return { dir, id };
  };
  const working = job(1, 'working');
  job(2, 'queued'); job(3, 'done'); job(4, 'working', 'w4E:p2'); job(5, 'working', 'w4E:p1', working.id);
  put(join(working.dir, 'qa/q1.md'), '# Question\n\nKeep the original parser?\n\nOptions:\n- Keep it\n- Replace it\n\nDefault if unanswered: Keep it\n');
  put(join(working.dir, 'report.md'), '# Report\n\nSynthetic preliminary report.');
  put(join(cwd, 'STATE.md'), '# State\n\n## Waiting for the owner\n- Approve the sample fixture\n\n## Now\n- Validating the example set\n\n## Next\n- Publish the sample run\n');
  const pipeline = new PanelJobPipeline(home, { pane: 'w4E:p1', project: cwd });
  t.after(() => { pipeline.dispose(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(pipeline.load(), undefined, 'before collection a zero is not known');
  await pipeline.refresh();
  const workboard = pipeline.workboard(tree);
  // An available display translation must never hide the original question.
  const worker = workboard.workers.find(w => w.id.endsWith(working.id));
  worker.work.requestInfo.display = { question: 'Synthetic translation', options: [], suggested: '' };
  const project = await new ProjectCollector(cwd, home).collect('home', workboard, nowMs);
  const draw = (state, width = 80) => renderMonitor({ state, width, height: 27, nowMs, workboard, project, paneLoad: pipeline.load() });
  return { draw, worker, dir: working.dir, workboard, project };
}

test('Home shows explicit STATE requests, Now, Next and the calling pane load, without workers', async (t) => {
  const { draw } = await fixture(t);
  const previous = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  t.after(() => setDisplayConfig(previous));
  const frame = draw(initialMonitorState());
  assert.match(plain(frame), /Waiting[\s\S]*Approve the sample fixture[\s\S]*Now[\s\S]*Validating the example set[\s\S]*Next[\s\S]*Publish the sample run[\s\S]*This pane · 2 running · 1 queued/);
  assert.doesNotMatch(plain(frame), /Synthetic worker|Keep the original parser|done today|Latest|Stalled/);
  assert.equal(frame.workboard.targets.size, 0);
  assert.equal(acceptsMonitorInput(frame.state, { type: 'key', text: '/', key: '' }), false);
  assert.equal(press(frame, 'X').state.overlay, undefined);
});

test('Jobs has exactly one row per retained job; Enter and mouse open Inspector evidence and actions', async (t) => {
  const { draw, worker, dir } = await fixture(t);
  const home = draw(initialMonitorState());
  let list = draw(press(home, 'v').state);
  assert.equal(list.state.subpage.kind, 'jobs');
  const rows = list.workboard.rows;
  assert.equal(rows.length, 4, 'queued, old settled, waiting on main and running Sonic each have one row');
  assert.equal(new Set(rows.map(row => row.item)).size, rows.length);
  assert.doesNotMatch(plain(list), /Keep the original parser|Synthetic preliminary report/);
  assert.equal(press(list, 'X').state.overlay, undefined);
  const item = targetKey({ kind: 'worker', laneId: worker.laneId, workerId: worker.id });
  const pane = list.panes[0];
  const hit = { type: 'mouse', button: 'left', x: 3, y: pane.y + rows.findIndex(row => row.item === item) - pane.offset };
  const clicked = handleMonitorInput(list.state, hit, { frame: list }).state;
  assert.equal(clicked.subpage.target.workerId, worker.id);
  list = draw({ ...list.state, subpage: { ...list.state.subpage, cursor: item } });
  const inspector = draw(key(list, 'enter').state);
  assert.equal(inspector.state.subpage.kind, 'inspector');
  assert.match(plain(inspector), /Keep the original parser\?/);
  assert.match(plain(inspector), /Sonic children/);
  assert.doesNotMatch(plain(inspector), /Synthetic translation/);
  assert.deepEqual(key(inspector, 'enter').action, { type: 'open-files', files: [join(dir, 'report.md')] });
  assert.equal(press(inspector, '1').action?.answer, 'Keep it');
  const asked = draw(press(inspector, 'X').state);
  assert.match(plain(asked), /y confirm/);
  assert.deepEqual(press(asked, 'y').action, { type: 'stop-job', dir });
  assert.equal(key(inspector, 'escape').state.subpage.cursor, item);
  for (const lang of ['en', 'zh']) {
    const previous = setLanguage(lang);
    try {
      for (const width of [24, 40, 80]) for (const state of [home.state, list.state, inspector.state, asked.state])
        assert.ok(draw(state, width).lines.every(line => visualLength(line) === width));
    } finally { setLanguage(previous); }
  }
});
