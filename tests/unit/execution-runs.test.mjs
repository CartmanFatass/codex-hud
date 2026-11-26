/** Ticket-queue Runs section and Run Detail on the Project Execution page. Synthetic records only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionJobs, fakeFork, IDS, NOW, PANE } from '../fixtures/execution-page.mjs';
import { viewFor, withState } from '../fixtures/state-helpers.mjs';
import { PanelExecution } from '../../dist/panel/execution.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { roleIcon } from '../../dist/render/model-glyphs.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const FLOWS = {
  working: 'q1a2b3c4000000001',
  paused: 'q2b3c4d5000000002',
  ended: 'q3c4d5e6000000003',
  old: 'q4d5e6f7000000004',
  foreign: 'q5e6f7a8000000005',
};
const LAND_FLOW = 'f0a01000000000000';
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const onExecution = (nav) => withState(initialMonitorState(), {
  activeTab: 'execution',
  ...(nav && { execution: nav }),
});

function render(view, { state = onExecution(), width = 100, height = 80, lang = 'en', theme = 'none', icons = 'unicode', workboard, homePortfolio } = {}) {
  const display = setDisplayConfig({ theme, icons }), language = setLanguage(lang);
  try {
    return renderMonitor({ state, width, height, nowMs: NOW, execution: view, workboard, homePortfolio, projectName: 'demo-project' });
  } finally {
    setDisplayConfig(display);
    setLanguage(language);
  }
}

const text = (frame) => frame.lines.map(stripAnsi).join('\n');

function putJson(file, value) {
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function setupWithRuns(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = join(root, 'h.sock');
  const fork = await fakeFork(t, socket);
  const base = executionJobs(root, socket);
  const flows = join(base.hud, 'flows');

  // Extra synthetic job for land-gate stage.
  const landJobId = 'j0b01000000000000';
  putJson(join(base.hud, 'jobs', landJobId, 'job.json'), {
    job: landJobId, role: 'imp', cwd: base.project, project_root: base.project, herdr_pane: PANE,
    dispatch_exit_code: 0, created_at: ago(25),
  });
  putJson(join(base.hud, 'jobs', landJobId, 'STATUS.json'), {
    state: 'done', started_at: ago(24), settled_at: ago(18),
  });
  fs.writeFileSync(join(base.hud, 'jobs', landJobId, 'brief.md'), '# 02: land gate synthetic ticket\n');
  putJson(join(flows, `${LAND_FLOW}.json`), {
    flow: LAND_FLOW, job: landJobId, pane: PANE, task: false,
    wt: { root: join(root, 'wt-imp'), main_root: base.project, branch: 'wt/land' },
    config: { base: 'main', gate: ['npm test'], after: [], push: false },
    state: 'running', step: 'gate[1]: npm test',
    pid: process.pid, start: '1', created_at: ago(18), updated_at: ago(1), source_sha: 'a'.repeat(40),
  });

  // 1. Working ticket-queue run with all ticket stages.
  putJson(join(flows, `${FLOWS.working}.json`), {
    flow: FLOWS.working, root: base.project, project_root: base.project, feature: 'exec-runs',
    pane: PANE, task: false, max_parallel: 2, created_at: ago(22), updated_at: ago(1),
    state: 'working',
    steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    repair_rounds: 1,
    tickets: [
      { ticket: '01', path: join(base.project, '.scratch/exec-runs/01.md'), role: 'imp', job: IDS.settled, landed: true },
      { ticket: '02', path: join(base.project, '.scratch/exec-runs/02.md'), role: 'imp', job: landJobId, land: LAND_FLOW },
      { ticket: '03', path: join(base.project, '.scratch/exec-runs/03.md'), role: 'imp', job: IDS.imp },
      { ticket: '04', path: join(base.project, '.scratch/exec-runs/04.md'), role: 'frontend-imp', job: IDS.settled },
      { ticket: '05', path: join(base.project, '.scratch/exec-runs/05.md'), role: 'imp', held: { reason: 'Unattended landing would change docs/spec.md', at: ago(5), kind: 'escalate', owner_approval: 'spec-change' } },
      { ticket: '06', path: join(base.project, '.scratch/exec-runs/06.md'), role: 'imp', failed: { reason: 'gate failed on synthetic test', at: ago(4), kind: 'land' } },
    ],
    queued: [{ ticket: '07', blockers: ['03'] }],
    blocked: [{ ticket: '08', blockers: ['05'] }],
    todo: [
      { source: '01 (j0a07000)', kind: 'assumed', text: 'Keep compact summary ordering across narrow columns' },
      { source: 'lead (jlead001)', kind: 'lead', text: 'Verify ZH strings after milestone translation' },
    ],
    decisions: [
      { step: 'tickets', kind: 'question', job: 'jlead001000000000', decision: 'answer', ticket: '03', question: 'q1', reason: 'Use the existing headerScanner helper off the paint path', at: ago(6) },
    ],
    reviews: [
      { round: 0, job: 'jrev0001000000000', summary: 'Two-axis synthetic review: clean scope, one minor layout follow-up.', findings: { blocker: 0, major: 1, minor: 2 } },
    ],
  });

  // 2. Paused pane-less (unattended) run belonging to this project.
  putJson(join(flows, `${FLOWS.paused}.json`), {
    flow: FLOWS.paused, root: base.project, project_root: base.project, feature: 'obj-unattended',
    pane: '', task: false, max_parallel: 1, created_at: ago(45), updated_at: ago(3),
    unattended: { objective: 'obj-unattended' },
    state: 'paused', reason: 'owner approval needed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'asking' } },
    tickets: [
      { ticket: '01', path: join(base.project, '.scratch/u/01.md'), role: 'imp', held: { reason: 'Unapproved removal declared: legacy toggle', at: ago(3), kind: 'escalate', owner_approval: 'feature-deletion' } },
      { ticket: '02', path: join(base.project, '.scratch/u/02.md'), role: 'imp', held: { reason: 'scope assumption in report: widened retention', at: ago(2), kind: 'assumption' } },
    ],
    todo: [],
    decisions: [],
    reviews: [],
  });

  // 3. Recently ended (< 1h) run with accept verdict.
  putJson(join(flows, `${FLOWS.ended}.json`), {
    flow: FLOWS.ended, root: base.project, project_root: base.project, feature: 'recent-done',
    pane: PANE, task: false, max_parallel: 2, created_at: ago(55), updated_at: ago(20),
    state: 'completed', verdict: 'finish: all synthetic checks passed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    tickets: [
      { ticket: '01', path: join(base.project, '.scratch/done/01.md'), role: 'imp', job: IDS.settled, landed: true },
    ],
    todo: [{ source: '01', kind: 'assumed', text: 'Default synthetic label retained' }],
    decisions: [{ step: 'accept', kind: 'accept', job: 'jlead002000000000', decision: 'finish', reason: 'All tickets landed and review passed', at: ago(20) }],
    reviews: [{ round: 0, job: 'jrev0002000000000', summary: 'All checks green.' }],
  });

  // 4. Ended > 1h ago: must be excluded.
  const oldFile = join(flows, `${FLOWS.old}.json`);
  putJson(oldFile, {
    flow: FLOWS.old, root: base.project, project_root: base.project, feature: 'stale-run',
    pane: PANE, task: false, max_parallel: 1, created_at: ago(180), updated_at: ago(95),
    state: 'completed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    tickets: [],
  });
  const oldTime = new Date(NOW - 95 * 60_000);
  fs.utimesSync(oldFile, oldTime, oldTime);

  // 5. Foreign project run with same pane: must be excluded from this project's Execution page.
  putJson(join(flows, `${FLOWS.foreign}.json`), {
    flow: FLOWS.foreign, root: join(root, 'elsewhere'), project_root: join(root, 'elsewhere'), feature: 'foreign-run',
    pane: PANE, task: false, max_parallel: 1, created_at: ago(10), updated_at: ago(1),
    state: 'working',
    steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [],
  });

  const execution = new PanelExecution(base.hud, PANE, base.env, () => {});
  t.after(() => execution.dispose());
  execution.sync(base.project, false);
  await execution.refresh(undefined, NOW);
  return { ...base, fork, execution, landJobId };
}

test('Execution collects paused, working, and recently ended runs (including pane-less unattended), excludes old and foreign runs, and reads zero herdr during paint', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);
  assert.deepEqual(view.runs.map((r) => r.flow), [FLOWS.paused, FLOWS.working, FLOWS.ended]);

  const working = view.runs.find((r) => r.flow === FLOWS.working);
  assert.deepEqual(working.steps, [
    { key: 'tickets', state: 'running' },
    { key: 'review', state: 'waiting' },
    { key: 'accept', state: 'waiting' },
  ]);
  assert.deepEqual(working.tickets.map((tk) => [tk.ticket, tk.stage]), [
    ['01', 'landed'],
    ['02', 'land-gate'],
    ['03', 'worker'],
    ['04', 'settled'],
    ['05', 'held'],
    ['06', 'failed'],
    ['07', 'queued'],
    ['08', 'blocked'],
  ]);
  assert.equal(working.tickets[4].holdTag, 'spec change');
  assert.deepEqual(working.tickets[6].blockers, ['03']);
  assert.deepEqual(working.tickets[7].blockers, ['05']);
  assert.equal(working.heldCount, 1);
  assert.equal(working.repairRounds, 1);

  const paused = view.runs.find((r) => r.flow === FLOWS.paused);
  assert.equal(paused.unattended, true);
  assert.equal(paused.label, 'obj-unattended');
  assert.deepEqual(paused.tickets.map((tk) => tk.holdTag), ['feature deletion', 'assumption']);

  const ended = view.runs.find((r) => r.flow === FLOWS.ended);
  assert.equal(ended.steps[2].verdict, 'finish');

  // Painting never calls herdr.
  for (const width of [36, 40, 56, 60, 100, 140]) render(view, { width });
  assert.equal(f.fork.requests.length, 0);
});

test('Runs section renders EN/ZH, no-colour, coloured, role icons (unicode/nerd/text), and exact widths down to narrow columns', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);

  for (const width of [36, 40, 56, 60, 100, 140]) {
    for (const lang of ['en', 'zh']) {
      const frame = render(view, { width, lang, theme: 'none', icons: 'unicode' });
      const shown = text(frame);
      for (const line of frame.lines) {
        assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
        assert.equal(line, stripAnsi(line), 'none theme must emit no ANSI');
      }
      assert.doesNotMatch(shown, /stale-run|foreign-run|q4d5e6f7|q5e6f7a8/);
      // Runs section comes before Workers.
      const runsPos = shown.indexOf(lang === 'zh' ? '运行' : 'Runs');
      const workersPos = shown.indexOf(lang === 'zh' ? '工作者' : 'Workers');
      assert.ok(runsPos >= 0 && workersPos > runsPos, `${lang} ${width}: Runs before Workers`);
      // Coloured theme stays width-exact too.
      const coloured = render(view, { width, lang, theme: 'mocha', icons: 'unicode' });
      for (const line of coloured.lines) assert.equal(visualLength(line), width, `mocha ${lang} ${width}`);
    }
  }

  // Verify full content at standard wide width in EN.
  const wideEn = text(render(view, { width: 120, lang: 'en', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    'Runs', 'exec-runs', 'q1a2b3c4', 'obj-unattended', 'q2b3c4d5', 'recent-done', 'q3c4d5e6',
    roleIcon('imp', 'unicode'), roleIcon('frontend-imp', 'unicode'), roleIcon('reviewer', 'unicode'), roleIcon('lead', 'unicode'),
    'tickets', 'review', 'accept', 'finish',
    'landed', 'land gate', 'working', 'settled', 'held (spec change)', 'held (feature deletion)', 'held (assumption)', 'failed', 'queued · blocked by 03', 'blocked by 05',
    'todo 2 · decisions 1 · held 1 · repairs 1',
    'todo 1 · decisions 1 · held 0',
  ]) {
    assert.ok(wideEn.includes(needle), `EN 120 missing: ${needle}\n${wideEn}`);
  }
  // Repairs omitted when zero on recent-done.
  assert.doesNotMatch(wideEn, /todo 1 · decisions 1 · held 0 · repairs/);

  // Verify full content in ZH.
  const wideZh = text(render(view, { width: 120, lang: 'zh', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    '运行', '工单', '评审', '通过', '完成',
    '已落地', '落地门禁', '工作中', '已结束', '挂起 (规范变更)', '挂起 (功能删除)', '挂起 (假设)', '失败', '受 03 阻塞', '受 05 阻塞',
    '待办 2 · 决定 1 · 挂起 1 · 修复 1',
  ]) {
    assert.ok(wideZh.includes(needle), `ZH 120 missing: ${needle}\n${wideZh}`);
  }

  // Text icon mode emits ASCII only and honours ROLE_GLYPHS ASCII icons.
  const asciiFrame = render(view, { width: 120, lang: 'en', theme: 'none', icons: 'text' });
  const asciiText = text(asciiFrame);
  for (const line of asciiFrame.lines) assert.equal(visualLength(line), 120);
  assert.doesNotMatch(asciiText, /[⚒✎⚖•✦◈⚡┌┐└┘├┤▸◉○→✓✗]/);
  for (const needle of [`${roleIcon('imp', 'text')} tickets`, `${roleIcon('reviewer', 'text')} review`, `${roleIcon('lead', 'text')} accept`]) {
    assert.ok(asciiText.includes(needle), `ASCII missing: ${needle}\n${asciiText}`);
  }

  // Nerd icon mode honours ROLE_GLYPHS nerd icons.
  const nerdFrame = render(view, { width: 120, lang: 'en', theme: 'none', icons: 'nerd' });
  const nerdText = text(nerdFrame);
  for (const line of nerdFrame.lines) assert.equal(visualLength(line), 120);
  for (const needle of [roleIcon('imp', 'nerd'), roleIcon('frontend-imp', 'nerd'), roleIcon('reviewer', 'nerd'), roleIcon('lead', 'nerd')]) {
    assert.ok(nerdText.includes(needle), `nerd missing: ${needle}\n${nerdText}`);
  }
});

test('Enter on a ticket opens its job Inspector and Enter on a run opens Run Detail with decisions, todo, and review summary', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);
  const decoder = new WorkbenchInputDecoder('workboard');
  const press = (state, bytes, width = 100, height = 30) => {
    const frame = render(view, { state, width, height, workboard: state.subpage && f.execution.board() });
    const input = bytes === '\x1b' ? { type: 'key', key: 'escape' } : decoder.push(Buffer.from(bytes))[0];
    assert.ok(acceptsMonitorInput(frame.state, input));
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };

  // Initial cursor starts on the first run (paused). Move to working run and open Run Detail.
  const onWorkingRun = onExecution({ cursor: `project:exec-run:${FLOWS.working}` });
  const detailState = press(onWorkingRun, '\r').state;
  assert.deepEqual(detailState.subpage, { kind: 'run-detail', flow: FLOWS.working, scroll: 0 });

  for (const width of [40, 60, 100]) {
    for (const lang of ['en', 'zh']) {
      const detailFrame = render(view, { state: detailState, width, height: 60, lang, theme: 'none' });
      const shown = text(detailFrame);
      for (const line of detailFrame.lines) {
        assert.equal(visualLength(line), width, `detail ${lang} ${width}`);
        assert.equal(line, stripAnsi(line));
      }
      const joined = detailFrame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n').replace(/\n\s*┃\s*/g, ' ');
      assert.ok(joined.includes('Use the existing headerScanner helper'), `${lang} ${width} decision reason`);
      assert.ok(joined.includes('Keep compact summary ordering'), `${lang} ${width} todo text`);
      assert.ok(joined.includes('Two-axis synthetic review'), `${lang} ${width} review summary`);
      assert.ok(joined.includes('Unattended landing would change docs/spec.md'), `${lang} ${width} held reason`);
      if (width === 100) {
        for (const role of ['imp', 'frontend-imp', 'reviewer', 'lead']) {
          assert.ok(shown.includes(roleIcon(role, 'unicode')), `detail ${lang} missing ${role} icon`);
        }
      }
      assert.ok(shown.includes(lang === 'zh' ? 'Esc 返回' : 'Esc back'));
    }
  }

  // Scrolling inside Run Detail moves offset; Esc returns to Execution.
  const scrolled = press(detailState, 'j', 60, 12).state;
  assert.equal(scrolled.subpage.kind, 'run-detail');
  assert.ok(scrolled.subpage.scroll > 0);
  const backFromRun = press(scrolled, '\x1b').state;
  assert.equal(backFromRun.subpage, undefined);
  assert.equal(backFromRun.activeTab, 'execution');
  assert.equal(backFromRun.execution.cursor, `project:exec-run:${FLOWS.working}`);

  // Enter on a ticket line opens that job's Inspector, and Esc returns to Execution.
  const onTicket = onExecution({ cursor: `project:exec-run:${FLOWS.working}:ticket:03` });
  const inspected = press(onTicket, '\r').state;
  assert.deepEqual([inspected.subpage.kind, inspected.subpage.from, inspected.subpage.target.workerId],
    ['inspector', 'execution', `thin-job:${IDS.imp}`]);
  const inspText = text(render(view, { state: inspected, workboard: f.execution.board() }));
  assert.match(inspText, /EXEC-01|synthetic page/);
  const backFromJob = press(inspected, '\x1b').state;
  assert.equal(backFromJob.subpage, undefined);
  assert.equal(backFromJob.activeTab, 'execution');
  assert.equal(backFromJob.execution.cursor, `project:exec-run:${FLOWS.working}:ticket:03`);
});

test('Runs section still renders when there are no live workers, while Home stays unchanged', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);
  const runsOnly = { ...view, jobs: [], sessions: [] };
  const shown = text(render(runsOnly, { width: 100, height: 40 }));
  assert.match(shown, /Runs/);
  assert.match(shown, /exec-runs/);
  assert.match(shown, /No running or waiting jobs/);

  // Home and multi-project views do not render ticket-queue run rows.
  const homeFrame = render(undefined, { state: initialMonitorState(), width: 100, height: 30, workboard: f.execution.board() });
  assert.doesNotMatch(text(homeFrame), /q1a2b3c4|q2b3c4d5|land gate/);
  const listState = withState(initialMonitorState(), { activeTab: 'project', project: { view: viewFor('projects-list') } });
  const listFrame = renderMonitor({
    state: listState, width: 100, height: 30, nowMs: NOW, workboard: f.execution.board(),
    projects: [{ root: f.project, name: 'demo-project' }, { root: '/synthetic/other', name: 'other-project' }],
  });
  assert.doesNotMatch(text(listFrame), /q1a2b3c4|q2b3c4d5|land gate/);
});
