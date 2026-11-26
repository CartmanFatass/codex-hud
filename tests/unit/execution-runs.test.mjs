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
const LAND_FLOW = 'f0b01000000000000';
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

  // 3. Recently ended (> 1h, < 24h) run with accept verdict.
  putJson(join(flows, `${FLOWS.ended}.json`), {
    flow: FLOWS.ended, root: base.project, project_root: base.project, feature: 'recent-done',
    pane: PANE, task: false, max_parallel: 2, created_at: ago(164), updated_at: ago(124),
    state: 'completed', verdict: 'finish: all synthetic checks passed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    tickets: [
      { ticket: '01', path: join(base.project, '.scratch/done/01.md'), role: 'imp', job: IDS.settled, landed: true },
    ],
    todo: [{ source: '01', kind: 'assumed', text: 'Default synthetic label retained' }],
    decisions: [{ step: 'accept', kind: 'accept', job: 'jlead002000000000', decision: 'finish', reason: 'All tickets landed and review passed', at: ago(20) }],
    reviews: [{ round: 0, job: 'jrev0002000000000', summary: 'All checks green.' }],
  });

  // 4. Ended > 24h ago: must be excluded.
  const oldFile = join(flows, `${FLOWS.old}.json`);
  putJson(oldFile, {
    flow: FLOWS.old, root: base.project, project_root: base.project, feature: 'stale-run',
    pane: PANE, task: false, max_parallel: 1, created_at: ago(1500), updated_at: ago(1441),
    state: 'completed',
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    tickets: [],
  });
  const oldTime = new Date(ago(1441));
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
      const headings = lang === 'zh' ? ['工作者', '运行', '刚结束', '派工关系'] : ['Workers', 'Runs', 'Recently ended', 'Delegation'];
      const positions = headings.map((head) => frame.lines.findIndex((line) => line.startsWith(`${head} `)));
      assert.ok(positions.every((at, i) => at > (positions[i - 1] ?? -1)), `${lang} ${width}: ${positions}`);
      // Coloured theme stays width-exact too.
      const coloured = render(view, { width, lang, theme: 'mocha', icons: 'unicode' });
      for (const line of coloured.lines) assert.equal(visualLength(line), width, `mocha ${lang} ${width}`);
    }
  }

  // Verify full content at standard wide width in EN.
  const wideEn = text(render(view, { width: 120, lang: 'en', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    'Runs', 'exec-runs', 'q1a2b3c4', 'obj-unattended', 'q2b3c4d5', 'Queue recent-done · 1 ticket',
    roleIcon('imp', 'unicode'), roleIcon('frontend-imp', 'unicode'), roleIcon('reviewer', 'unicode'), roleIcon('lead', 'unicode'),
    'tickets', 'review', 'accept',
    'landed', 'land gate', 'working', 'settled', 'held (spec change)', 'held (feature deletion)', 'held (assumption)', 'failed', 'queued · blocked by 03', 'blocked by 05',
    'todo 2 · decisions 1 · held 1 · repairs 1',
  ]) {
    assert.ok(wideEn.includes(needle), `EN 120 missing: ${needle}\n${wideEn}`);
  }
  assert.doesNotMatch(wideEn, /q3c4d5e6|Finished earlier|land gate synthetic ticket/, 'ended run and members are not repeated');
  assert.equal(wideEn.split('\n').filter((line) => line.includes('recent-done')).length, 1);

  // Verify full content in ZH.
  const wideZh = text(render(view, { width: 120, lang: 'zh', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    '运行', '工单', '评审', '通过', '刚结束',
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

  // Move to the working run and open Run Detail.
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

test('idle Execution shows only recent project rows, ordered together by end time with observed results', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-recent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), hud = join(root, 'hud'), flows = join(hud, 'flows');
  const job = (n, title, minutes, { state = 'done', worktree, ...receipt } = {}) => {
    const id = `j${n.toString(16).padStart(16, '0')}`, dir = join(hud, 'jobs', id);
    putJson(join(dir, 'job.json'), {
      job: id, role: worktree ? 'imp' : 'sonic', cwd: project, created_at: ago(minutes + 8),
      ...(worktree && { worktree: { root: join(root, 'wt'), main_root: project, branch: 'wt/demo' } }), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), { state, settled_at: ago(minutes), ended_at: ago(1) });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${title}\n`);
    return id;
  };
  const run = (n, feature, minutes, tickets, state = 'completed') => {
    const flow = `q${n.toString(16).padStart(16, '0')}`;
    putJson(join(flows, `${flow}.json`), {
      flow, root: project, feature, pane: PANE, created_at: ago(minutes + 80), updated_at: ago(minutes), state,
      tickets: tickets.map((ticket, i) => ({ ticket: `0${i + 1}`, role: 'imp', ...ticket })),
    });
    return flow;
  };
  const land = (id, state, extra) => {
    const flow = `f${id.slice(1)}`;
    putJson(join(flows, `${flow}.json`), { flow, job: id, state, step: 'done', updated_at: ago(1), ...extra });
    return flow;
  };

  const failed = job(1, 'Build broke', 4, { state: 'failed', worktree: true });
  const landed = job(2, 'Committed changes', 12, { worktree: true });
  const retried = land(landed, 'failed');
  // A later attempt landed even though its post-landing step failed; neither flow resets the job age.
  putJson(join(flows, `${retried}-2.json`), { flow: `${retried}-2`, job: landed, state: 'failed', step: 'after[1]', landed_sha: 'a'.repeat(40), updated_at: ago(1) });
  const queueJob = job(3, 'Run member title', 13);
  const landedRun = run(1, 'ingest', 15, [{ job: queueJob, landed: true }, { landed: true }]);
  job(4, 'Run attempt title', 7, { ticket_queue: landedRun });
  const unlanded = job(5, 'Worktree without land', 29, { worktree: true });
  const unreadable = job(6, 'Unknown evidence', 40, { worktree: true });
  const badLand = land(unreadable, 'completed');
  fs.writeFileSync(join(flows, `${badLand}.json`), '{broken');
  const complete = job(7, 'Read-only study', 58);
  const stopped = job(8, 'Stopped before report', 78, { state: 'stopped' });
  const failedRun = run(2, 'broken', 90, [{ landed: true }, { failed: { at: ago(90), reason: 'failed check' } }], 'failed');
  const noCommit = job(9, 'Run member no commit', 124, { worktree: true });
  const unlandedRun = run(3, 'unfinished', 120, [{ job: noCommit, land: land(noCommit, 'completed') }], 'stopped');
  const unknownRun = run(4, 'record unavailable', 125, [{ job: unreadable, land: badLand }]);
  // Use a different job for the unreadable standalone row so it is not hidden as a run member.
  const unknown = job(10, 'Unknown standalone evidence', 40, { worktree: true });
  fs.writeFileSync(join(flows, `f${unknown.slice(1)}.json`), '{broken');
  job(11, 'Stale job title', 1441);
  job(12, 'Foreign job title', 2, { cwd: join(root, 'foreign') });
  run(5, 'stale queue', 1441, [{ landed: true }]);

  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, true);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);
  assert.equal(view.jobs.length, 0);
  assert.equal(view.complete, false, 'unreadable job landing leaves coverage partial');
  const jobItem = (id) => `project:exec:${id}`, runItem = (id) => `project:exec-run:${id}`;
  const expected = [
    [jobItem(failed), 'failed', '失败', '4m', '4分'],
    [jobItem(landed), 'landed', '已落地', '12m', '12分'],
    [runItem(landedRun), 'landed', '已落地', '15m', '15分'],
    [jobItem(unlanded), 'not landed', '未落地', '29m', '29分'],
    [jobItem(unknown), '', '', '40m', '40分'],
    [jobItem(complete), 'done', '完成', '58m', '58分'],
    [jobItem(stopped), 'stopped', '已停止', '1h', '1时'],
    [runItem(failedRun), 'failed', '失败', '1h', '1时'],
    [runItem(unlandedRun), 'not landed', '未落地', '2h', '2时'],
    [runItem(unknownRun), '', '', '2h', '2时'],
  ];
  for (const lang of ['en', 'zh']) for (const width of [40, 62]) {
    const frame = render(view, { lang, width }), headings = frame.workboard.rows.filter((row) => !row.item);
    assert.equal(headings.length, 1, 'no idle readout or empty sections');
    assert.match(headings[0].text, lang === 'zh' ? /^刚结束 .*不完整/ : /^Recently ended .*Partial/);
    assert.equal(frame.state.execution.cursor, jobItem(failed));
    const rows = frame.workboard.rows.filter((row) => row.item);
    assert.deepEqual(rows.map((row) => row.item), expected.map(([item]) => item));
    for (const [i, [, en, zh, enAge, zhAge]] of expected.entries()) {
      const line = rows[i].text.trimEnd(), [word, age] = lang === 'zh' ? [zh, zhAge] : [en, enAge];
      assert.ok(line.endsWith(word ? ` ${word} ${age}` : ` ${age}`), `${lang} ${width}: ${line}`);
      if (!word) assert.doesNotMatch(line, /\b(?:failed|stopped|landed|done)\b|失败|已停止|落地|完成/);
    }
    for (const line of frame.lines) {
      assert.equal(visualLength(line), width);
      assert.equal(line, stripAnsi(line));
    }
    assert.match(text(frame), lang === 'zh' ? /队列 ingest · 2 张工单/ : width === 62 ? /Queue ingest · 2 tickets/ : /Queue ingest · 2/);
    assert.doesNotMatch(text(frame), /Run member|Run attempt|Stale job|Foreign job|stale queue|No running or waiting jobs/);
  }

  // Enter uses the existing subpages, retaining the Execution cursor and scroll on Esc.
  const press = (state, key) => {
    const frame = render(view, { state, width: 40, height: 8, workboard: state.subpage && execution.board() });
    return handleMonitorInput(frame.state, { type: 'key', key }, { frame, nowMs: NOW }).state;
  };
  const onJob = onExecution({ cursor: jobItem(stopped), scroll: 4 });
  const inspector = press(onJob, 'enter');
  assert.equal(inspector.subpage.target.workerId, `thin-job:${stopped}`);
  assert.match(text(render(view, { state: inspector, workboard: execution.board() })), /Stopped before report/);
  const backFromJob = press(inspector, 'escape');
  assert.equal(backFromJob.subpage, undefined);
  assert.deepEqual(backFromJob.execution, inspector.execution);
  const onRun = onExecution({ cursor: runItem(unlandedRun), scroll: 5 });
  const detail = press(onRun, 'enter');
  assert.deepEqual(detail.subpage, { kind: 'run-detail', flow: unlandedRun, scroll: 0 });
  const backFromRun = press(detail, 'escape');
  assert.equal(backFromRun.subpage, undefined);
  assert.deepEqual(backFromRun.execution, detail.execution);

  await execution.refresh(undefined, NOW + 24 * 60 * 60_000);
  const empty = render(execution.view(project));
  assert.match(text(empty), /No running or waiting jobs/);
  assert.doesNotMatch(text(empty), /Recently ended/);
});

test('the recent job list caps an observed family window at the 200 newest settlements', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-recent-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project');
  const id = (n) => `j${n.toString(16).padStart(16, '0')}`;
  for (let n = 1; n <= 202; n++) {
    const dir = join(hud, 'jobs', id(n));
    putJson(join(dir, 'job.json'), { job: id(n), role: 'sonic', cwd: project, created_at: ago(240),
      ...(n > 200 && { parent_job: id(200) }) });
    putJson(join(dir, 'STATUS.json'), { state: 'done', settled_at: ago(203 - n) });
    // Keep both children inside the bounded family scan without letting directory mtimes stand for end times.
    const mtime = new Date(ago(n > 200 ? n - 200 : 240));
    fs.utimesSync(dir, mtime, mtime);
  }
  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);
  assert.equal(view.complete, false);
  assert.deepEqual(view.endedJobs.map((job) => job.jobId), Array.from({ length: 200 }, (_, i) => id(202 - i)));
});

test('Runs section still renders when there are no live workers, while Home stays unchanged', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);
  const runsOnly = { ...view, jobs: [], sessions: [] };
  const shown = text(render(runsOnly, { width: 100, height: 40 }));
  assert.match(shown, /Runs/);
  assert.match(shown, /exec-runs/);
  assert.match(shown, /Recently ended/);
  assert.doesNotMatch(shown, /Workers|No running or waiting jobs/);

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
