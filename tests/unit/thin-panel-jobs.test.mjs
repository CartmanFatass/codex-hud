import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

test('Work renders scoped thin jobs newest first, including closed jobs with a question', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-thin-panel-'));
  const keys = ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = join(home, key);
  const display = setDisplayConfig({ theme: 'none', icons: 'text' });
  const language = setLanguage('en');
  const project = join(home, 'project');
  const hudHome = process.env.HUD_HOME;
  const now = Date.parse('2026-11-10T12:00:00Z');
  const pipelines = [];
  t.after(() => {
    for (const pipeline of pipelines) pipeline.dispose();
    setDisplayConfig(display);
    setLanguage(language);
    keys.forEach((key, i) => (previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i])));
    rmSync(home, { recursive: true, force: true });
  });
  const put = (file, value) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const jobs = [
    {
      job: 'j0000000000000001',
      role: 'imp',
      cwd: join(project, 'child'),
      created_at: '2026-11-10T11:58:00Z',
      herdr_pane: 'main-pane',
    },
    {
      job: 'j0000000000000002',
      role: 'reviewer',
      cwd: project + '-other',
      created_at: '2026-11-10T11:50:00Z',
      herdr_pane: 'main-pane',
    },
  ];
  jobs.forEach((job, i) => {
    const dir = join(hudHome, 'jobs', job.job);
    put(join(dir, 'job.json'), job);
    put(join(dir, 'STATUS.json'), { state: i ? 'closed' : 'working' });
    put(join(dir, 'qa/q1.md'), 'Synthetic question');
    if (!i) put(join(dir, 'qa/q1.answer.md'), 'Synthetic answer');
  });
  const pipeline = (pane) => {
    const result = new PanelJobPipeline(hudHome, null, { live: false }, null, { project, pane });
    pipelines.push(result);
    return result;
  };
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) };
  const beside = pipeline('main-pane');
  await beside.refresh();
  const board = beside.workboard(tree);
  assert.deepEqual(
    board.workers.map((worker) => worker.role),
    ['imp', 'reviewer']
  );
  const frame = renderMonitor({
    tree,
    workboard: board,
    state: { ...initialMonitorState(), mainTab: 'work' },
    width: 80,
    height: 12,
    nowMs: now,
  });
  const lines = frame.lines.map(stripAnsi);
  lines.forEach((line) => assert.equal(visualLength(line), 80));
  const text = lines.join('\n');
  assert.match(text, /imp\s+000001 working\s+2m/);
  assert.match(text, /reviewer\s+000002 closed question\s+10m/);
  assert.equal((text.match(/question/g) ?? []).length, 1);
  assert.doesNotMatch(text, /stalled|Observation unavailable/);
  console.log('Synthetic Work view:\n' + lines.map((line) => line.trimEnd()).join('\n'));
  const fallback = pipeline(null);
  await fallback.refresh();
  assert.deepEqual(
    fallback.workboard(tree).workers.map((worker) => worker.role),
    ['imp']
  );
  const other = pipeline('another-pane');
  await other.refresh();
  assert.equal(other.workboard(tree).workers.length, 0);
});
