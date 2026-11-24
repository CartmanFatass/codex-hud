import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { projectList } from '../../dist/roles/projects.js';
import { PanelJobPipeline } from '../../dist/panel/job-pipeline.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { cachedReportSignature, writeReportMeta } from '../../dist/roles/report-meta.js';

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
  const finished = job(3, 'done');
  job(2, 'queued'); job(4, 'working', 'w4E:p2'); job(5, 'working', 'w4E:p1', working.id);
  put(join(finished.dir, 'report.md'), '# Findings\n\nThe synthetic parser kept its old rules.');
  writeReportMeta(finished.dir, cachedReportSignature(finished.dir), { summary: 'Kept «original rules».' });
  put(join(finished.dir, 'review-1.md'), 'Verdict: accept');
  put(join(working.dir, 'qa/q1.md'), '# Question\n\nKeep the original parser?\n\nOptions:\n- Keep it\n- Replace it\n\nDefault if unanswered: Keep it\n');
  put(join(working.dir, 'report.md'), '# Report\n\nSynthetic preliminary report.');
  put(join(cwd, 'STATE.md'), '# State\n\n## Waiting for the owner\n- Approve the sample fixture\n- Pick the source for the synthetic run from the examples in the project\n  - Use the synthetic index\n\n## Now\n- Validating the example set\n\n## Next\n- Publish the sample run\n');
  const pipeline = new PanelJobPipeline(home, { pane: 'w4E:p1', project: cwd });
  t.after(() => { pipeline.dispose(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(pipeline.jobsObserved, false, 'before collection a zero is not known');
  await pipeline.refresh();
  const workboard = pipeline.workboard(tree);
  const worker = workboard.workers.find(w => w.id.endsWith(working.id));
  const project = await new ProjectCollector(cwd, home).collect('home', workboard, nowMs);
  put(join(home, 'projects.json'), { version: 1, projects: [{ root: cwd }] });
  const projects = projectList(home, cwd), homePortfolio = await new HomePortfolioCollector(home).read(projects, workboard, nowMs);
  const draw = (state, width = 80) => renderMonitor({ state, width, height: 27, nowMs, workboard: pipeline.workboard(tree),
    project, projects, homePortfolio, jobsObserved: pipeline.jobsObserved });
  return { draw, worker, dir: working.dir, pipeline, finished };
}

test('Home shows explicit STATE requests, a Now note and project-wide job counts without workers', async (t) => {
  const { draw } = await fixture(t);
  const previous = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  t.after(() => setDisplayConfig(previous));
  const frame = draw(initialMonitorState());
  assert.match(plain(frame), /Waiting[\s\S]*Approve the sample fixture[\s\S]*⚒2 ⚡1 ◷⚒1[\s\S]*¶ Validating the example set/);
  assert.doesNotMatch(plain(frame), /Publish the sample run|This pane|Synthetic worker|Keep the original parser|done today|Latest|Stalled/);
  assert.equal(frame.workboard.targets.size, 0);
  assert.equal(acceptsMonitorInput(frame.state, { type: 'key', text: '/', key: '' }), false);
  assert.equal(press(frame, 'X').state.overlay, undefined);
});

test('Home Waiting opens the calling project request by keyboard and click', async (t) => {
  const { draw } = await fixture(t);
  const home = draw({ ...initialMonitorState(), selectedProject: '/another/sample-project' }, 40);
  const selected = draw(key(home, 'down').state, 40);
  const pane = selected.panes[0];
  const continuation = pane.rows.findLastIndex((r) => r.item && r.item === selected.state.home.cursor);
  assert.ok(continuation > 0, 'the request wraps');
  const clicked = handleMonitorInput(selected.state, { type: 'mouse', button: 'left', x: 3,
    y: pane.y + continuation - pane.offset }, { frame: selected });
  for (const outcome of [key(selected, 'enter'), clicked]) {
    assert.equal(outcome.state.activeTab, 'project');
    assert.equal(outcome.state.selectedProject, undefined);
    const detail = draw(outcome.state);
    assert.match(plain(detail), /Pick the source for the synthetic run/);
    assert.match(plain(detail), /Use the synthetic index/);
    assert.doesNotMatch(plain(detail), /Approve the sample fixture/);
    assert.match(key(detail, 'open-session').action?.files[0], /STATE\.md$/);
  }
  assert.equal(press(selected, 'v').state.subpage.kind, 'jobs');
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

test('Chinese Inspector shows the original English question and report with the signed worker summary and declared verdict', async (t) => {
  const { draw, worker, pipeline, finished } = await fixture(t);
  const previous = setLanguage('zh');
  t.after(() => setLanguage(previous));
  const inspect = (w) => draw({ ...initialMonitorState(), subpage: { kind: 'inspector', scroll: 0,
    target: { kind: 'worker', laneId: w.laneId, workerId: w.id } } });
  await pipeline.refresh(worker.id);
  const asking = plain(inspect(worker));
  assert.match(asking, /Keep the original parser\?/);
  assert.match(asking, /\[1\] Keep it/);
  assert.match(asking, /Synthetic preliminary report\./);
  const done = pipeline.workboard(tree).workers.find(w => w.id.endsWith(finished.id));
  await pipeline.refresh(done.id);
  const reported = plain(inspect(done));
  assert.match(reported, /Kept «original rules»\./);
  assert.match(reported, /The synthetic parser kept its old rules\./);
  assert.match(reported, /review-1\.md\s+accept/);
});
