import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

test('Home shows thin jobs as workers, one question that needs the owner and the answers decided for them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-thin-panel-'));
  const keys = ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = join(home, key);
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  const language = setLanguage('en');
  const project = join(home, 'project');
  const hudHome = process.env.HUD_HOME;
  // Local noon: every minute offset below stays inside the same local day.
  const now = new Date().setHours(12, 0, 0, 0);
  const pipelines = [];
  t.after(() => {
    for (const pipeline of pipelines) pipeline.dispose();
    setDisplayConfig(display);
    setLanguage(language);
    keys.forEach((key, i) => (previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i])));
    rmSync(home, { recursive: true, force: true });
  });
  const ago = (minutes) => new Date(now - minutes * 60000);
  const put = (file, value, minutes) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    utimesSync(file, ago(minutes), ago(minutes));
  };
  const question = (n, ask, options, fallback) =>
    `# Question q${n} from imp@project\n\n${ask}\n\nOptions:\n${options.map((o) => `- ${o}`).join('\n')}\n\n` +
    `Default if unanswered: ${fallback}\n\nContext: synthetic\n`;
  const job = (n, role, cwd, age, status, brief, qa = {}, pane = 'main-pane') => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(hudHome, 'jobs', id);
    put(join(dir, 'job.json'), { job: id, role, cwd, created_at: ago(age).toISOString(), herdr_pane: pane }, age);
    if (status) put(join(dir, 'STATUS.json'), status, 1);
    put(join(dir, 'brief.md'), brief, age);
    for (const [name, [text, minutes]] of Object.entries(qa)) put(join(dir, 'qa', name), text, minutes);
  };
  // Working, with one answer that differs from the worker's default and one that matches it.
  job(
    1,
    'imp',
    join(project, 'child'),
    12,
    { state: 'working', model: 'gpt-6.1-sol', thinking: 'high', started_at: ago(12).toISOString() },
    '# Fix the retry cap in the sync client\n\nDetails follow.\n',
    {
      'q1.md': [question(1, 'Keep the v1 shim or remove it?', ['keep', 'remove'], 'keep'), 20],
      'q1.answer.md': ['remove', 9],
      'q2.md': [question(2, 'Use jitter on retries?', ['yes', 'no'], 'yes'), 8],
      'q2.answer.md': ['yes', 4],
    }
  );
  // Blocked on a question nobody has answered.
  job(
    2,
    'reviewer',
    project,
    7,
    { state: 'waiting_orchestrator', model: 'gpt-6.1-sol', thinking: 'xhigh', started_at: ago(7).toISOString() },
    'Review the sync client diff for races',
    { 'q1.md': [question(1, 'Is the lock held across the await in flush()?', ['yes', 'no'], 'yes'), 5] }
  );
  // Finished 15 minutes ago: out of the list, still in the day's count.
  const closed = { state: 'closed', started_at: ago(40).toISOString(), settled_at: ago(16).toISOString() };
  job(3, 'sonic', project, 40, { ...closed, ended_at: ago(15).toISOString() }, 'Rename the helper across the package');
  // Failed two minutes ago: still listed.
  job(
    4,
    'sonic',
    project,
    30,
    { state: 'failed', model: 'deepseek-v4.1-flash', thinking: 'low', ended_at: ago(2).toISOString() },
    'Regenerate the lockfile'
  );
  // Another pane in another project: not this panel's.
  job(5, 'imp', project + '-other', 11, { state: 'working' }, 'Belongs elsewhere', {}, 'other-pane');
  const pipeline = (pane) => {
    const result = new PanelJobPipeline(hudHome, null, { live: false }, null, { project, pane });
    pipelines.push(result);
    return result;
  };
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) };
  const beside = pipeline('main-pane');
  await beside.refresh();
  const board = beside.workboard(tree);
  const frameOf = (width, tab = 'home') =>
    renderMonitor({
      tree,
      workboard: board,
      state: { ...initialMonitorState(), mainTab: tab },
      width,
      height: 24,
      nowMs: now,
    }).lines.map(stripAnsi);
  const wide = frameOf(110);
  wide.forEach((line) => assert.equal(visualLength(line), 110));
  const text = wide.join('\n');
  console.log('Synthetic Home, 110 columns:\n' + wide.map((line) => line.trimEnd()).join('\n'));
  console.log(
    'Synthetic Home, 56 columns:\n' +
      frameOf(56)
        .map((line) => line.trimEnd())
        .join('\n')
  );
  // Needs you: the unanswered question, its first line and the minutes it has waited.
  assert.match(text, /need you 1/);
  assert.match(text, /\? reviewer Is the lock held across the await in flush\(\)\?\s+5m/);
  // Decided for you: the departure ranks first and names the worker's default; the matching answer is routine.
  assert.match(text, /worth a look 1[\s\S]*≠ imp q1 Keep the v1 shim or remove it\? → remove\s+9m[\s\S]*instead: keep/);
  assert.match(text, /decided for you 1[\s\S]*· imp q2 Use jitter on retries\? → yes\s+4m/);
  // Workers: owner's words and the brief's heading; the model only at wide widths.
  assert.match(text, /▸ pi\s+imp\s+Fix the retry cap in the sync client\s+gpt-6\.1-sol·high\s+working 12m/);
  assert.match(text, /pi\s+sonic\s+Regenerate the lockfile\s+deepseek-v4\.1-flash·low\s+failed 2m/);
  assert.match(text, /today 2 calls · 1 done · 1 failed/);
  assert.doesNotMatch(text, /Rename the helper|Belongs elsewhere|idle_grace|closed|phase unknown|observed start order/);
  assert.doesNotMatch(frameOf(56).join('\n'), /gpt-6\.1|deepseek/);
  // Work keeps the whole recent history, finished jobs included.
  const work = frameOf(110, 'work').join('\n');
  assert.match(work, /✓ pi\s+sonic\s+Rename the helper across the package.*done 15m/);
  // A panel bound to a pane sees that pane's jobs; with no pane, the project's.
  assert.deepEqual(
    board.workers.map((worker) => worker.role),
    ['reviewer', 'imp', 'sonic', 'sonic']
  );
  const fallback = pipeline(null);
  await fallback.refresh();
  assert.deepEqual(
    fallback.workboard(tree).workers.map((worker) => worker.role),
    ['reviewer', 'imp', 'sonic', 'sonic']
  );
  const other = pipeline('another-pane');
  await other.refresh();
  assert.equal(other.workboard(tree).workers.length, 0);
});
