/** Workflow diagrams, Run Detail and recent outcomes on Execution. Synthetic records only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionJobs, fakeFork, IDS, NOW, PANE } from '../fixtures/execution-page.mjs';
import { putTicketFeature, ticketRecord } from '../fixtures/ticket-store.mjs';
import { viewFor, withState } from '../fixtures/state-helpers.mjs';
import { PanelExecution } from '../../dist/panel/execution.js';
import { countProjectWaitingRuns, executionSnapshot } from '../../dist/collectors/execution.js';
import { collectWorkSummary } from '../../dist/collectors/work-summary-snapshot.js';
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
const LEAD = 'j0b02000000000000';
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

  putJson(join(base.hud, 'jobs', LEAD, 'job.json'), { job: LEAD, role: 'lead', headless: true, cwd: base.project,
    dispatch_exit_code: 0, created_at: ago(4), ticket_queue: FLOWS.working });
  putJson(join(base.hud, 'jobs', LEAD, 'STATUS.json'), { state: 'waiting_orchestrator', started_at: ago(3) });
  fs.writeFileSync(join(base.hud, 'jobs', LEAD, 'brief.md'), '# Check ticket assumptions\n');

  // 1. Working ticket-queue run with all ticket stages.
  putJson(join(flows, `${FLOWS.working}.json`), {
    flow: FLOWS.working, root: base.project, project_root: base.project, feature: 'exec-runs',
    pane: PANE, task: false, max_parallel: 2, created_at: ago(22), updated_at: ago(1),
    state: 'working',
    steps: { tickets: { state: 'running' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    repair_rounds: 1,
    active_lead: { job: LEAD, kind: 'assumption', step: 'tickets', round: 1, ticket: '03' },
    tickets: [
      { ticket: '01', path: join(base.project, '.scratch/exec-runs/01.md'), role: 'imp', job: IDS.settled, landed: true },
      { ticket: '02', path: join(base.project, '.scratch/exec-runs/02.md'), role: 'imp', job: landJobId, land: LAND_FLOW },
      { ticket: '03', path: join(base.project, '.scratch/exec-runs/03.md'), role: 'imp', job: IDS.imp },
      { ticket: '04', path: join(base.project, '.scratch/exec-runs/04.md'), role: 'frontend-imp', job: IDS.settled },
      { ticket: '05', path: join(base.project, '.scratch/exec-runs/05.md'), role: 'imp', held: { reason: 'Unattended landing would change docs/spec.md', at: ago(5), kind: 'escalate', owner_approval: 'spec-change' } },
      { ticket: '06', path: join(base.project, '.scratch/exec-runs/06.md'), role: 'imp', failed: { reason: 'gate failed on synthetic test', at: ago(4), kind: 'land' } },
    ],
    queued: [{ ticket: '07', blockers: ['03'] }],
    blocked: [{ ticket: '08', blockers: ['07', '05'] }, { ticket: '09', blockers: ['08'] }],
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
    ['09', 'blocked'],
  ]);
  assert.equal(working.tickets[4].holdTag, 'spec change');
  assert.deepEqual(working.tickets[6].blockers, ['03']);
  assert.deepEqual(working.tickets[7].blockers, ['07', '05']);
  assert.equal(working.heldCount, 1);
  assert.equal(working.repairRounds, 1);
  assert.equal(working.lead, undefined, 'tickets-step assumption lead must not bind to accept');
  assert.equal(working.metro.stations.find((s) => s.id === 'accept').state, 'waiting');
  assert.equal(working.metro.stations.find((s) => s.id === 'accept').jobId, undefined);
  assert.deepEqual(f.execution.activity(f.project).filter(({ kind }) => kind === 'gate').map(({ ticket, flow }) => [ticket, flow]),
    [['exec-runs/02', LAND_FLOW]], 'an active queue landing is one gate for its linked ticket');

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

test('Execution shows only the current attempt in Workflow and keeps superseded receipts in Recent', (t) => {
  const hud = fs.mkdtempSync(join(tmpdir(), 'exec-queue-restarts-'));
  t.after(() => fs.rmSync(hud, { recursive: true, force: true }));
  const root = join(hud, 'project');
  const run = (n, state, created, fields = {}) => {
    const flow = `q${String(n).padStart(16, '0')}`;
    putJson(join(hud, 'flows', `${flow}.json`), {
      flow, root, feature: 'sample', state, created_at: ago(created), updated_at: ago(1), tickets: [], ...fields,
    });
    return flow;
  };
  const failed = run(1, 'failed', 30);
  const olderPause = run(2, 'paused', 20);
  const legacy = run(3, 'paused', 15, { feature: 'legacy', superseded_by: 'q0000000000000099' });
  const latest = run(4, 'paused', 10);
  const superseded = run(9, 'superseded', 18, { superseded_by: latest });
  const otherProject = join(hud, 'another-project');
  run(5, 'working', 5, { root: otherProject });
  const unrelated = run(6, 'failed', 30, { feature: 'unrelated' });
  run(7, 'completed', 5, { feature: 'unrelated', root: otherProject });
  run(8, 'completed', 5, { feature: 'unrelated', unattended: { objective: 'unrelated' } });

  assert.equal(countProjectWaitingRuns(hud, root), 1);
  assert.equal(collectWorkSummary(hud).global.pausedMain, 1);
  const view = executionSnapshot(hud, { workers: [], lanes: [] }, { root, pane: PANE, complete: true }, NOW);
  assert.deepEqual(view.runs.filter(run => run.endedAt === undefined).map(run => run.flow), [latest]);
  const frame = render(view);
  const shown = text(frame);
  assert.match(shown, /0 running\s+1 waiting\s+0 queued/);
  const [live, recent] = shown.split('Recently ended');
  assert.doesNotMatch(live, /superseded/);
  assert.match(recent, /superseded/);
  const rows = frame.workboard.rows.map(row => row.item);
  assert.ok(rows.includes(`project:exec-run:${latest}`));
  assert.equal(rows.filter(item => item?.startsWith(`project:exec-run:${superseded}`)).length, 1);
  assert.ok(rows.includes(`project:exec-run:${unrelated}`), 'a latest failure remains in Recently ended');
  for (const old of [failed, olderPause, legacy]) {
    assert.ok(!view.runs.some(run => run.flow === old));
    assert.ok(!rows.some(item => item?.startsWith(`project:exec-run:${old}`)));
  }
});

test('queued stations get titles and dependency waves from JSON even without jobs or header blockers', async (t) => {
  const f = await setupWithRuns(t);
  putTicketFeature(f.project, 'exec-runs', [
    ticketRecord(7, { title: 'Replay the synthetic queue', blocked_by: ['exec-runs/03'] }),
    ticketRecord(8, { title: 'Index queued records', blocked_by: ['exec-runs/07'] }),
    ticketRecord(9, { title: 'Show queue counts', blocked_by: ['exec-runs/08'] }),
    ticketRecord(10, { title: 'Store title for the future station', blocked_by: ['exec-runs/09'] }),
  ]);
  const file = join(f.hud, 'flows', `${FLOWS.working}.json`), header = JSON.parse(fs.readFileSync(file, 'utf8'));
  header.queued = [{ ticket: '07' }, { ticket: 'exec-runs/08' }];
  header.blocked = [{ ticket: '09' }];
  header.future = [{ ticket: '10', title: 'Future station', role: 'imp', blockers: ['exec-runs/01'] }];
  putJson(file, header);
  await f.execution.refresh(undefined, NOW + 1);
  const view = f.execution.view(f.project), working = view.runs.find((r) => r.flow === FLOWS.working);
  assert.deepEqual(working.queueWaves.blocked.map((wave) => wave.map(({ ticket }) => ticket)), [['07'], ['exec-runs/08'], ['09']]);
  assert.deepEqual(working.metro.edges.filter(({ to }) => ['07', 'exec-runs/08', '09'].includes(to)), [
    { from: '03', to: '07' }, { from: '07', to: 'exec-runs/08' }, { from: 'exec-runs/08', to: '09' },
  ]);
  assert.ok(working.queueWaves.current.some(({ ticket }) => ticket === '10'), 'omitted waiting_on in a receipt means ready');
  assert.deepEqual(working.metro.edges.filter(({ to }) => to === '10'), [{ from: '01', to: '10' }], 'receipt edges take precedence over store edges');
  const station = working.metro.stations.find(({ id }) => id === '07');
  assert.equal(station.title, 'Replay the synthetic queue');
  assert.equal(station.jobId, undefined);
  const frame = render(view, { state: onExecution({ cursor: `project:exec-run:${FLOWS.working}:07` }) });
  assert.match(text(frame), /07 Replay the synthetic queue/);
});

test('queue waves render EN/ZH, no-colour, coloured, role icons (unicode/nerd/text), and exact widths down to narrow columns', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);

  for (const width of [36, 40, 62, 100, 140]) {
    for (const lang of ['en', 'zh']) {
      const frame = render(view, { width, lang, theme: 'none', icons: 'unicode' });
      const shown = text(frame);
      for (const line of frame.lines) {
        assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
        assert.equal(line, stripAnsi(line), 'none theme must emit no ANSI');
      }
      assert.doesNotMatch(shown, /stale-run|foreign-run|q4d5e6f7|q5e6f7a8/);
      const headings = lang === 'zh' ? ['工作流', '工作者', '刚结束'] : ['Workflow', 'Workers', 'Recently ended'];
      const positions = headings.map((head) => frame.lines.findIndex((line) => line.startsWith(`${head} `)));
      assert.ok(positions.every((at, i) => at > (positions[i - 1] ?? -1)), `${lang} ${width}: ${positions}`);
      // Coloured theme stays width-exact too.
      const coloured = render(view, { width, lang, theme: 'mocha', icons: 'unicode' });
      for (const line of coloured.lines) assert.equal(visualLength(line), width, `mocha ${lang} ${width}`);
    }
  }

  // Verify Hairline metro map content at standard wide width in EN (no flow IDs, no old vertical waves, no ⚖/★ wait glyphs).
  const wideEn = text(render(view, { width: 120, lang: 'en', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    'Workflow', 'Queue exec-runs', 'Queue obj-unattended', 'Queue recent-done · 1 ticket',
    'paused 45m', 'running 22m', 'held for you',
    '◇◈◆ review', '☆✪★ accept',
  ]) {
    assert.ok(wideEn.includes(needle), `EN 120 missing: ${needle}\n${wideEn}`);
  }
  assert.doesNotMatch(wideEn.split('Workers')[0], /⚖|▼|─▶|○ ★|q1a2b3c4|q2b3c4d5|Assumed|blocked by|owner approval|Build passes|Lead acceptance/);
  assert.doesNotMatch(wideEn.split('Recently ended')[1], /q3c4d5e6|Finished earlier|land gate synthetic ticket/, 'ended run members are not repeated');
  assert.equal(wideEn.split('\n').filter((line) => line.includes('recent-done')).length, 1);

  // Verify Hairline metro map content in ZH.
  const wideZh = text(render(view, { width: 120, lang: 'zh', theme: 'none', icons: 'unicode' }));
  for (const needle of [
    '工作流', '队列 exec-runs', '队列 obj-unattended', '已暂停 45分', '运行中 22分',
    '挂起·等你', '◇◈◆ 评审', '☆✪★ 验收', '刚结束',
  ]) {
    assert.ok(wideZh.includes(needle), `ZH 120 missing: ${needle}\n${wideZh}`);
  }
  assert.doesNotMatch(wideZh.split('工作者')[0], /⚖|▼|─▶|○ ★|负责人验收/);

  // Text icon mode emits ASCII only on the Workflow metro map.
  const asciiFrame = render(view, { width: 120, lang: 'en', theme: 'none', icons: 'text' });
  const asciiText = text(asciiFrame);
  for (const line of asciiFrame.lines) assert.equal(visualLength(line), 120);
  assert.doesNotMatch(asciiText, /[⚒✎⚖•✦◈⚡┌┐└┘├┤▸◉○→✓✗╭╮╰╯╌╎◇☆●]/);
  for (const needle of ['r R review', 'a A accept', '= Queue obj-unattended', '@ Queue exec-runs']) {
    assert.ok(asciiText.includes(needle), `ASCII missing: ${needle}\n${asciiText}`);
  }

  // Nerd icon mode keeps Unicode metro marks while honouring ROLE_GLYPHS nerd icons on detail/cards.
  const nerdFrame = render(view, { width: 120, lang: 'en', theme: 'none', icons: 'nerd' });
  const nerdText = text(nerdFrame);
  for (const line of nerdFrame.lines) assert.equal(visualLength(line), 120);
  assert.ok(nerdText.includes(roleIcon('imp', 'nerd')), `nerd missing imp icon\n${nerdText}`);
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

  // A tickets-step assumption lead must NOT become accept's Enter target while accept is still waiting;
  // Enter opens station inspection (not an Inspector for the assumption lead).
  const onAccept = onExecution({ cursor: `project:exec-run:${FLOWS.working}:accept` });
  const acceptDetail = press(onAccept, '\r').state;
  assert.equal(acceptDetail.subpage?.kind, 'station-detail');
  assert.equal(acceptDetail.subpage?.stationId, 'accept');
  // Enter on a landed ticket station opens its retained job Inspector too, and Esc returns to the same station.
  const onLandedTicket = onExecution({ cursor: `project:exec-run:${FLOWS.working}:01` });
  const inspected = press(onLandedTicket, '\r').state;
  assert.deepEqual([inspected.subpage.kind, inspected.subpage.from, inspected.subpage.target.workerId],
    ['inspector', 'execution', `thin-job:${IDS.settled}`]);
  const backFromJob = press(inspected, '\x1b').state;
  assert.equal(backFromJob.subpage, undefined);
  assert.equal(backFromJob.activeTab, 'execution');
  assert.equal(backFromJob.execution.cursor, `project:exec-run:${FLOWS.working}:01`);
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

  const failed = job(1, 'Build broke', 4, { state: 'failed', worktree: true, ticket: 'compile/01' });
  const landed = job(2, 'Committed changes', 12, { worktree: true, package: 'compile', ticket: '02' });
  const retried = land(landed, 'failed');
  // Post-landing failure doesn't reset the landing age on Project or the settlement age on Execution.
  putJson(join(flows, `${retried}-2.json`), { flow: `${retried}-2`, job: landed, state: 'failed', step: 'after[1]', landed_sha: 'a'.repeat(40), landed_at: ago(10), updated_at: ago(1) });
  const queueJob = job(3, 'Run member title', 23);
  const landedRun = run(1, 'ingest', 15, [{ job: queueJob, landed: true }, { landed: true }]);
  job(4, 'Run attempt title', 7, { ticket_queue: landedRun });
  const unlanded = job(5, 'Worktree without land', 29, { worktree: true, ticket: 'compile/03' });
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
  const unknown = job(10, 'Unknown standalone evidence', 40, { worktree: true, ticket: 'compile/04' });
  fs.writeFileSync(join(flows, `f${unknown.slice(1)}.json`), '{broken');
  job(11, 'Stale job title', 1441, { ticket: 'compile/05' });
  job(12, 'Foreign job title', 2, { cwd: join(root, 'foreign'), ticket: 'compile/06' });
  run(5, 'stale queue', 1441, [{ landed: true }]);
  const cancelledRun = run(6, 'archive', 24, [{ landed: true }, { landed: true }], 'cancelled');
  const supersededRun = run(7, 'replace', 26, [
    { landed: true }, { landed: true }, { failed: { at: ago(27), reason: 'failed check before restart' } },
  ], 'superseded');

  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW, true);
  assert.equal(execution.view(project), undefined, 'activity-only collection does not publish a worker view');
  const outcomes = execution.activity(project).filter((entry) => entry.kind === 'ended');
  const actual = Object.fromEntries(outcomes.map(({ ticket, at, result }) => [ticket, [at, result]]));
  assert.deepEqual(actual['compile/01'], [Date.parse(ago(4)), 'failed']);
  assert.deepEqual(actual['compile/02'], [Date.parse(ago(10)), 'landed']);
  assert.deepEqual(actual['compile/03'], [Date.parse(ago(29)), 'not landed']);
  assert.deepEqual(actual['compile/04'], [Date.parse(ago(40)), undefined]);
  assert.equal(actual['compile/05'], undefined);
  assert.equal(actual['compile/06'], undefined);
  assert.deepEqual(actual['ingest/01'], [Date.parse(ago(23)), 'landed']);
  assert.equal(actual['ingest/02'], undefined, 'an undated landing does not inherit the run end');
  assert.deepEqual(actual['broken/02'], [Date.parse(ago(90)), 'failed']);
  assert.equal(execution.activity(join(root, 'foreign')), undefined);
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
    [runItem(cancelledRun), 'cancelled', '已取消', '24m', '24分'],
    [runItem(supersededRun), 'superseded', '已被取代', '26m', '26分'],
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
    for (const [i, [item, en, zh, enAge, zhAge]] of expected.entries()) {
      const line = rows[i].text.trimEnd(), [word, age] = lang === 'zh' ? [zh, zhAge] : [en, enAge];
      const landedCount = lang === 'zh' ? '2 已落地' : '2 landed';
      let outcome = word;
      if (width === 62 && item === runItem(landedRun)) outcome = landedCount;
      if (width === 62 && (item === runItem(cancelledRun) || item === runItem(supersededRun))) outcome = `${word} · ${landedCount}`;
      assert.ok(line.endsWith(outcome ? ` ${outcome} ${age}` : ` ${age}`), `${lang} ${width}: ${line}`);
      if (width === 40 && item === runItem(landedRun)) assert.ok(!line.includes(landedCount), `${lang} ${width}: ${line}`);
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

test('the recent job list includes every settlement within 24 hours even past the family window', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-recent-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project');
  const id = (n) => `j${n.toString(16).padStart(16, '0')}`;
  for (let n = 1; n <= 202; n++) {
    const dir = join(hud, 'jobs', id(n));
    putJson(join(dir, 'job.json'), { job: id(n), role: 'sonic', cwd: project, created_at: ago(240),
      ...(n > 200 && { parent_job: id(200) }) });
    putJson(join(dir, 'STATUS.json'), { state: 'done', settled_at: ago(n === 1 ? 1441 : n === 2 ? 1440 : 203 - n) });
    // The job directory is touched on atomic STATUS replacement; order it differently from the settlements.
    const mtime = new Date(ago(n > 200 ? n - 200 : 240));
    fs.utimesSync(dir, mtime, mtime);
  }
  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);
  assert.equal(view.complete, true);
  assert.deepEqual(view.endedJobs.map((job) => job.jobId), Array.from({ length: 199 }, (_, i) => id(200 - i)));
  assert.deepEqual(view.endedJobs[0].children?.map((child) => child.jobId), [id(202), id(201)]);
});

test('Recent folds settled sonic children into their parent row, keeps failed/asking/orphan children, and strips short leading labels on child titles', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-recent-fold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), hud = join(root, 'hud');
  const id = (n) => `j${n.toString(16).padStart(16, '0')}`;
  const writeJob = (n, brief, minutes, { role = 'sonic', state = 'done', worktree, qa, ...receipt } = {}) => {
    const jobId = id(n), dir = join(hud, 'jobs', jobId);
    putJson(join(dir, 'job.json'), {
      job: jobId, role, cwd: project, project_root: project, created_at: ago(minutes + 5),
      ...(role === 'sonic' && { headless: true }),
      ...(worktree && { worktree: { root: join(root, 'wt'), main_root: project, branch: 'wt/fold' } }),
      ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), { state, settled_at: ago(minutes), ended_at: ago(minutes) });
    fs.writeFileSync(join(dir, 'brief.md'), brief);
    if (qa) {
      fs.mkdirSync(join(dir, 'qa'), { recursive: true });
      fs.writeFileSync(join(dir, 'qa', 'q1.md'), qa);
    }
    return jobId;
  };

  // 1. Settled parent with three settled sonic children (including leading labels and hyphenated asks).
  const parent = writeJob(1, '# 45: Fix recent execution rows\n', 10, { role: 'imp', worktree: true, ticket: 'chores/45' });
  const c1 = writeJob(2, 'Read-only: inspect thin-jobs title derivation\n', 12, { parent_job: parent });
  const c2 = writeJob(3, 'Read-only survey: explain X\n', 13, { parent_job: parent });
  const c3 = writeJob(4, '# Read-only code survey: cross-check execution-view callers\n', 14, { parent_job: parent });

  // 2. Failed child and child with an open question still get their own Recent rows.
  const failedChild = writeJob(5, 'Read-only: inspect failing cache path\n', 8, { parent_job: parent, state: 'failed' });
  const askingChild = writeJob(6, 'Read-only survey: confirm fallback scope\n', 6, {
    parent_job: parent, state: 'done',
    qa: '# Question\n\nKeep the legacy helper?\n\nDefault if unanswered: yes\n',
  });

  // 3. Child whose parent is outside the 24-hour Recent window keeps its own row.
  const oldParent = writeJob(7, '# 44: Earlier settled worker\n', 1500, { role: 'imp' });
  const orphanChild = writeJob(8, 'Read-only survey: check older callers\n', 20, { parent_job: oldParent });

  // 4. Child with 4-word prefix or file path before colon keeps its full line.
  const longPrefix = writeJob(9, 'One two three four: keep full label\n', 25, { parent_job: oldParent });
  const pathPrefix = writeJob(10, 'src/collectors/thin-jobs.ts: check line 854\n', 26, { parent_job: oldParent });

  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);

  // Only top-level rows remain in endedJobs: askingChild, failedChild, parent (+3 sonic), orphanChild, longPrefix, pathPrefix.
  assert.deepEqual(view.endedJobs.map((j) => j.jobId), [askingChild, failedChild, parent, orphanChild, longPrefix, pathPrefix]);
  const parentEntry = view.endedJobs.find((j) => j.jobId === parent);
  assert.deepEqual(parentEntry.children?.map((c) => c.jobId), [c1, c2, c3]);

  // Title derivation: "Read-only survey: explain X" -> "explain X", and no child gets "Read-only" as its displayId/title.
  const byId = new Map(execution.board().workers.map((w) => [w.id.replace(/^thin-job:/, ''), w]));
  assert.equal(byId.get(c1).task, 'inspect thin-jobs title derivation');
  assert.equal(byId.get(c1).displayId, undefined);
  assert.equal(byId.get(c2).task, 'explain X');
  assert.equal(byId.get(c2).briefTitle, 'explain X');
  assert.equal(byId.get(c3).task, 'cross-check execution-view callers');
  assert.equal(byId.get(c3).displayId, undefined);
  assert.equal(byId.get(longPrefix).task, 'One two three four: keep full label');
  assert.equal(byId.get(pathPrefix).task, 'src/collectors/thin-jobs.ts: check line 854');

  // Rendering in EN and ZH across widths: parent carries muted child count, no folded child rows, no "Read-only" title.
  for (const lang of ['en', 'zh']) for (const width of [40, 62, 100]) {
    const frame = render(view, { lang, width, theme: 'none' });
    const shown = text(frame);
    for (const line of frame.lines) {
      assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
      assert.equal(line, stripAnsi(line), 'none theme emits no ANSI');
    }
    const items = frame.workboard.rows.map((r) => r.item).filter(Boolean);
    assert.deepEqual(items, [askingChild, failedChild, parent, orphanChild, longPrefix, pathPrefix].map((j) => `project:exec:${j}`));
    assert.doesNotMatch(shown, /Read-only/);
    const parentRow = frame.workboard.rows.find((r) => r.item === `project:exec:${parent}`);
    if (width >= 62) {
      assert.ok(parentRow.text.includes(lang === 'zh' ? '+3 个 sonic' : '+3 sonic'), `${lang} ${width}: ${parentRow.text}`);
    }
    if (width === 100) {
      assert.match(shown, /inspect failing cache path/);
      assert.match(shown, /confirm fallback scope/);
      assert.match(shown, /check older callers/);
    }
    for (const line of render(view, { lang, width, theme: 'mocha' }).lines) {
      assert.equal(visualLength(line), width, `mocha ${lang} ${width}`);
    }
  }

  // Opening the settled parent's Inspector from Recent lists its sonic helpers with their cleaned asks.
  const parentFrame = render(view, { state: onExecution({ cursor: `project:exec:${parent}` }), width: 100, height: 40 });
  const inspector = handleMonitorInput(parentFrame.state, { type: 'key', key: 'enter' }, { frame: parentFrame, nowMs: NOW }).state;
  assert.equal(inspector.subpage?.kind, 'inspector');
  assert.equal(inspector.subpage?.target.workerId, `thin-job:${parent}`);
  const detail = text(render(view, { state: inspector, width: 100, height: 40, workboard: execution.board() }));
  assert.match(detail, /Sonic children/);
  assert.match(detail, /inspect thin-jobs title derivation/);
  assert.match(detail, /explain X/);
  assert.match(detail, /cross-check execution-view callers/);
  assert.doesNotMatch(detail, /Read-only/);
});

/** Settled synthetic jobs and ended ticket queues for the fold into parent rows. */
function foldFixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-queue-fold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), hud = join(root, 'hud');
  const id = (n) => `j${n.toString(16).padStart(16, '0')}`;
  const writeJob = (n, brief, minutes, { role = 'sonic', state = 'done', questions = [], ...receipt } = {}) => {
    const jobId = id(n), dir = join(hud, 'jobs', jobId);
    putJson(join(dir, 'job.json'), {
      job: jobId, role, cwd: project, project_root: project, created_at: ago(minutes + 5),
      ...(role === 'sonic' && { headless: true }), ...receipt,
    });
    putJson(join(dir, 'STATUS.json'), { state, settled_at: ago(minutes), ended_at: ago(minutes) });
    fs.writeFileSync(join(dir, 'brief.md'), brief);
    for (const qid of questions) {
      fs.mkdirSync(join(dir, 'qa'), { recursive: true });
      fs.writeFileSync(join(dir, 'qa', `${qid}.md`), '# Question\n\nKeep the legacy helper?\n\nDefault if unanswered: yes\n');
    }
    return jobId;
  };
  const queue = (flow, fields) => putJson(join(hud, 'flows', `${flow}.json`), {
    flow, root: project, project_root: project, feature: 'sample', pane: PANE, state: 'completed',
    created_at: ago(90), updated_at: ago(5), ...fields,
  });
  const collect = async () => {
    const execution = new PanelExecution(hud, PANE, {}, () => {});
    t.after(() => execution.dispose());
    execution.sync(project, false);
    await execution.refresh(undefined, NOW);
    return { execution, view: execution.view(project) };
  };
  return { hud, project, writeJob, queue, collect };
}

test('an ended queue counts settled sonic helpers on the ticket row, which opens the worker Inspector listing them', async (t) => {
  const f = foldFixture(t), flow = 'q0000000000000050';
  const member = { role: 'imp', ticket_queue: flow };
  const worker = f.writeJob(1, '# 01: Fold queue helpers\n', 10, member);
  const helpers = ['inspect the collector', 'list the render callers', 'check the fixtures'].map((ask, i) =>
    f.writeJob(2 + i, `Read-only: ${ask}\n`, 12 + i, { parent_job: worker }));
  const second = f.writeJob(5, '# 02: Second ticket\n', 20, member);
  f.writeJob(6, 'Read-only survey: find the owners\n', 22, { parent_job: second });
  const plainWorker = f.writeJob(7, '# 03: No helpers\n', 30, member);
  f.queue(flow, { tickets: [worker, second, plainWorker].map((job, i) => ({ ticket: `0${i + 1}`, role: 'imp', job, landed: true })) });

  const { execution, view } = await f.collect();
  assert.deepEqual(view.endedJobs, [], 'neither members nor their helpers take Recent rows');
  assert.deepEqual(view.runs[0].tickets.map((tk) => tk.children?.map((child) => child.jobId)),
    [helpers, [`j${'6'.padStart(16, '0')}`], undefined]);

  const press = (state, key, size = {}) => {
    const frame = render(view, { state, ...size, workboard: state.subpage && execution.board() });
    return handleMonitorInput(frame.state, { type: 'key', key }, { frame, nowMs: NOW }).state;
  };
  const recent = render(view);
  assert.deepEqual(recent.workboard.rows.map((row) => row.item).filter(Boolean), [`project:exec-run:${flow}`]);
  assert.doesNotMatch(text(recent), /Read-only|inspect the collector|find the owners/);
  const detail = press(onExecution({ cursor: `project:exec-run:${flow}` }), 'enter');
  assert.deepEqual(detail.subpage, { kind: 'run-detail', flow, scroll: 0 });

  const rowItem = (ticket) => `project:run-ticket:${ticket}`;
  for (const lang of ['en', 'zh']) for (const width of [40, 62, 100]) {
    const frame = render(view, { state: detail, lang, width, workboard: execution.board() });
    const targets = frame.workboard.rows.filter((row) => row.item);
    assert.deepEqual(targets.map((row) => [row.item, row.execJob.target.workerId]),
      [[rowItem('01'), `thin-job:${worker}`], [rowItem('02'), `thin-job:${second}`]]);
    assert.ok(targets[0].text.includes(lang === 'zh' ? '+3 个 sonic' : '+3 sonic'), `${lang} ${width}: ${targets[0].text}`);
    assert.ok(targets[1].text.includes(lang === 'zh' ? '+1 个 sonic' : '+1 sonic'), `${lang} ${width}: ${targets[1].text}`);
    assert.ok(text(frame).includes(lang === 'zh' ? '⏎ 详情' : '⏎ details'));
    for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
    for (const line of render(view, { state: detail, lang, width, theme: 'mocha' }).lines) assert.equal(visualLength(line), width);
  }

  // Enter with nothing selected opens the first such row; Esc returns to it in Run Detail, then to Recent.
  const inspector = press(detail, 'enter');
  assert.deepEqual([inspector.subpage.kind, inspector.subpage.from, inspector.subpage.target.workerId],
    ['inspector', 'execution', `thin-job:${worker}`]);
  const listed = text(render(view, { state: inspector, height: 40, workboard: execution.board() }));
  assert.match(listed, /Sonic children/);
  for (const ask of ['inspect the collector', 'list the render callers', 'check the fixtures']) assert.ok(listed.includes(ask), listed);
  assert.doesNotMatch(listed, /Read-only|find the owners/);
  const back = press(inspector, 'escape');
  assert.deepEqual([back.subpage.kind, back.subpage.cursor], ['run-detail', rowItem('01')]);
  assert.match(text(render(view, { state: back })), /▸ \S 01 /);
  assert.equal(press(back, 'escape').subpage, undefined);

  // Tab selects the next row, and a click opens one.
  const next = press(press(back, 'tab'), 'enter');
  assert.equal(next.subpage.target.workerId, `thin-job:${second}`);
  const frame = render(view, { state: detail });
  const y = frame.lines.findIndex((line) => line.includes('+1 sonic'));
  const clicked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 4, y }, { frame, nowMs: NOW }).state;
  assert.equal(clicked.subpage.target.workerId, `thin-job:${second}`);
});

test('helpers keep their own Recent rows when no retained recent row leads to the run member that started them', async (t) => {
  const f = foldFixture(t), flow = 'q0000000000000051';
  const stale = f.writeJob(1, '# 01: Settled yesterday\n', 1500, { role: 'imp', ticket_queue: flow });
  const late = f.writeJob(2, 'Read-only: check older callers\n', 20, { parent_job: stale });
  const unretainedReviewer = 'j0000000000000099';
  const orphanHelper = f.writeJob(4, 'Read-only: check pruned reviewer range\n', 16, { parent_job: unretainedReviewer });
  f.queue(flow, { tickets: [{ ticket: '01', role: 'imp', job: stale, landed: true }], review_job: unretainedReviewer });

  const { view } = await f.collect();
  assert.ok(view.runs[0].tickets[0].execJob, 'the old member is still retained');
  assert.equal(view.runs[0].tickets[0].children, undefined);
  assert.deepEqual(view.endedJobs.map((job) => job.jobId), [orphanHelper, late]);
});

test('helpers of a settled queue reviewer, acceptance lead, land repair and earlier attempt fold into Run Detail step rows while failed helpers keep Recent rows', async (t) => {
  const f = foldFixture(t), flow = 'q0000000000000052', landFlow = 'f0000000000000052';
  const member = { ticket_queue: flow };
  const ticketWorker = f.writeJob(1, '# 01: Implement feature\n', 30, { role: 'imp', ...member });
  const repairWorker = f.writeJob(2, '# 01: Repair failing gate\n', 25, { role: 'imp', ...member });
  const repairHelper = f.writeJob(3, 'Read-only: inspect gate flake\n', 26, { parent_job: repairWorker });
  const earlierAttempt = f.writeJob(4, '# 01: Earlier attempt\n', 40, { role: 'imp', ...member });
  const earlierHelper = f.writeJob(5, 'Read-only: check previous diff\n', 41, { parent_job: earlierAttempt });
  const reviewer = f.writeJob(6, '# Review milestone\n', 15, { role: 'reviewer', ...member });
  const revHelper1 = f.writeJob(7, 'Read-only: audit collector fold\n', 17, { parent_job: reviewer });
  const revHelper2 = f.writeJob(8, 'Read-only survey: check render widths\n', 16, { parent_job: reviewer });
  const failedRevHelper = f.writeJob(9, 'Read-only: failed reviewer probe\n', 14, { parent_job: reviewer, state: 'failed' });
  const acceptLead = f.writeJob(10, '# Accept milestone\n', 10, { role: 'lead', ...member });
  const leadHelper1 = f.writeJob(11, 'Read-only: verify acceptance checklist\n', 12, { parent_job: acceptLead });
  const leadHelper2 = f.writeJob(12, 'Read-only: verify reference docs\n', 11, { parent_job: acceptLead });

  putJson(join(f.hud, 'flows', `${landFlow}.json`), {
    flow: landFlow, job: ticketWorker, pane: PANE, task: false, ticket_queue: flow,
    wt: { root: join(f.hud, 'wt'), main_root: f.project, branch: 'wt/52' },
    config: { base: 'main', gate: ['npm test'], after: [], push: false },
    state: 'completed', step: 'done', landed_sha: 'b'.repeat(40), landed_at: ago(24),
    created_at: ago(29), updated_at: ago(24), source_sha: 'a'.repeat(40),
    repairs: [{ step: 'gate[1]: npm test', outcome: 'gate passed', job: repairWorker, started_at: ago(27), changed_at: ago(25) }],
  });
  f.queue(flow, {
    steps: { tickets: { state: 'done' }, review: { state: 'done' }, accept: { state: 'done', answer: 'finish' } },
    verdict: 'finish: all checks passed',
    review_job: reviewer,
    tickets: [{ ticket: '01', role: 'imp', job: ticketWorker, land: landFlow, landed: true }],
    reviews: [{ round: 0, job: reviewer, summary: 'Clean milestone diff.', findings: { blocker: 0, major: 0, minor: 1 } }],
    decisions: [{ step: 'accept', kind: 'accept', job: acceptLead, decision: 'finish', reason: 'Verified checks', at: ago(10) }],
  });

  const { execution, view } = await f.collect();
  assert.deepEqual(view.endedJobs.map((job) => job.jobId), [failedRevHelper], 'only the failed helper keeps a Recent row');
  const run = view.runs[0];
  assert.deepEqual(run.tickets[0].landRepairs[0].children?.map((c) => c.jobId), [repairHelper]);
  assert.deepEqual(run.reviews[0].children?.map((c) => c.jobId), [revHelper2, revHelper1]);
  assert.deepEqual(run.decisions[0].children?.map((c) => c.jobId), [leadHelper2, leadHelper1]);
  assert.deepEqual(run.otherSteps?.map((s) => [s.jobId, s.children.map((c) => c.jobId)]), [[earlierAttempt, [earlierHelper]]]);

  const press = (state, key, size = {}) => {
    const frame = render(view, { state, ...size, workboard: state.subpage && execution.board() });
    return handleMonitorInput(frame.state, { type: 'key', key }, { frame, nowMs: NOW }).state;
  };
  const recent = render(view);
  assert.deepEqual(recent.workboard.rows.map((row) => row.item).filter(Boolean),
    [`project:exec-run:${flow}`, `project:exec:${failedRevHelper}`]);
  assert.doesNotMatch(text(recent), /audit collector fold|verify acceptance checklist|inspect gate flake|check previous diff/);

  const detail = press(onExecution({ cursor: `project:exec-run:${flow}` }), 'enter');
  assert.deepEqual(detail.subpage, { kind: 'run-detail', flow, scroll: 0 });
  const expectedTargets = [
    ['project:run-ticket-repair:01:1', `thin-job:${repairWorker}`, 1],
    ['project:run-review:0', `thin-job:${reviewer}`, 2],
    ['project:run-decision:0', `thin-job:${acceptLead}`, 2],
    [`project:run-step:${earlierAttempt}`, `thin-job:${earlierAttempt}`, 1],
  ];
  for (const lang of ['en', 'zh']) for (const width of [40, 62, 100]) {
    const frame = render(view, { state: detail, lang, width, workboard: execution.board() });
    const targets = frame.workboard.rows.filter((row) => row.item);
    assert.deepEqual(targets.map((row) => [row.item, row.execJob.target.workerId]),
      expectedTargets.map(([item, workerId]) => [item, workerId]));
    for (const [i, [, , count]] of expectedTargets.entries()) {
      const needle = lang === 'zh' ? `+${count} 个 sonic` : `+${count} sonic`;
      assert.ok(targets[i].text.includes(needle), `${lang} ${width} row ${i}: ${targets[i].text}`);
    }
    for (const line of frame.lines) {
      assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
      assert.equal(line, stripAnsi(line));
    }
    for (const line of render(view, { state: detail, lang, width, theme: 'mocha' }).lines) {
      assert.equal(visualLength(line), width, `mocha ${lang} ${width}`);
    }
  }

  // Tab to the review row, Enter opens reviewer Inspector with its helpers' asks, Esc returns to the review row.
  const onReview = press(press(detail, 'tab'), 'tab');
  const revInspector = press(onReview, 'enter');
  assert.deepEqual([revInspector.subpage.kind, revInspector.subpage.target.workerId], ['inspector', `thin-job:${reviewer}`]);
  const revListed = text(render(view, { state: revInspector, height: 40, workboard: execution.board() }));
  assert.match(revListed, /Sonic children/);
  assert.ok(revListed.includes('audit collector fold'), revListed);
  assert.ok(revListed.includes('check render widths'), revListed);
  assert.doesNotMatch(revListed, /verify acceptance checklist|Read-only/);
  const backReview = press(revInspector, 'escape');
  assert.deepEqual([backReview.subpage.kind, backReview.subpage.cursor], ['run-detail', 'project:run-review:0']);

  // Tab to the acceptance lead row, Enter opens lead Inspector listing its helpers' asks, Esc returns to it then Recent.
  const leadInspector = press(press(backReview, 'tab'), 'enter');
  assert.equal(leadInspector.subpage.target.workerId, `thin-job:${acceptLead}`);
  const leadListed = text(render(view, { state: leadInspector, height: 40, workboard: execution.board() }));
  assert.ok(leadListed.includes('verify acceptance checklist'), leadListed);
  assert.ok(leadListed.includes('verify reference docs'), leadListed);
  assert.doesNotMatch(leadListed, /audit collector fold|Read-only/);
  const backLead = press(leadInspector, 'escape');
  assert.deepEqual([backLead.subpage.kind, backLead.subpage.cursor], ['run-detail', 'project:run-decision:0']);
  assert.equal(press(backLead, 'escape').subpage, undefined);
});

test('helpers of council, batch and unrecorded reviewer steps fold into their Run Detail step rows', async (t) => {
  const f = foldFixture(t);
  // 1. Ended queue with review_job not yet appended to reviews[].
  const qFlow = 'q0000000000000053';
  const unrecordedRev = f.writeJob(1, '# Review before record\n', 15, { role: 'reviewer', ticket_queue: qFlow });
  const unrecordedRevHelper = f.writeJob(2, 'Read-only: inspect unrecorded review\n', 16, { parent_job: unrecordedRev });
  f.queue(qFlow, { tickets: [], review_job: unrecordedRev });

  // 2. Ended council whose member started two settled sonic helpers.
  const seat = f.writeJob(3, '# Council seat\n', 20, { role: 'oracle' });
  const seatHelper1 = f.writeJob(4, 'Read-only: council fact one\n', 22, { parent_job: seat });
  const seatHelper2 = f.writeJob(5, 'Read-only: council fact two\n', 21, { parent_job: seat });
  const council = f.writeJob(6, '# Architecture council\n', 18, {
    role: 'council', synthesizer: 'main', council_members: [{ preset: 'fable', job: seat }],
  });
  putJson(join(f.hud, 'flows', `${council}.json`), {
    flow: council, cwd: f.project, project_root: f.project, pane: PANE,
    template: 'council', state: 'completed', steps: { council: { state: 'done' } },
    created_at: ago(30), updated_at: ago(18),
  });

  // 3. Ended batch whose item started a settled sonic helper.
  const batch = 'b0000000000000053';
  const batchItem = f.writeJob(7, '# Batch item one\n', 25, { role: 'imp', batch_flow: batch });
  const batchHelper = f.writeJob(8, 'Read-only: inspect batch target\n', 26, { parent_job: batchItem });
  const batchFile = join(f.hud, 'flows', `${batch}.json`);
  putJson(batchFile, {
    flow: batch, cwd: f.project, project_root: f.project, pane: PANE,
    state: 'completed', created_at: Date.parse(ago(35)), updated_at: Date.parse(ago(24)),
    scale: { role: 'imp', count: 1, max_parallel: 1 },
    totals: { done: 1, failed: 0, running: 0, waiting: 0 },
  });
  const batchTime = new Date(ago(24));
  fs.utimesSync(batchFile, batchTime, batchTime);
  putJson(join(f.hud, 'flows', batch, 'index.json'), { items: [{ item: 1, pilot: true, state: 'done', job: batchItem }] });

  const { execution, view } = await f.collect();
  assert.deepEqual(view.endedJobs, [], 'all settled step helpers fold into their workflow runs');
  const press = (state, key) => {
    const frame = render(view, { state, width: 80, height: 40, workboard: state.subpage && execution.board() });
    return handleMonitorInput(frame.state, { type: 'key', key }, { frame, nowMs: NOW }).state;
  };

  for (const [flow, expectedItem, expectedWorker, expectedCount, expectedAsk] of [
    [qFlow, 'project:run-reviewer', unrecordedRev, '+1 sonic', 'inspect unrecorded review'],
    [council, 'project:run-node:member-0', seat, '+2 sonic', 'council fact one'],
    [batch, `project:run-step:${batchItem}`, batchItem, '+1 sonic', 'inspect batch target'],
  ]) {
    const detail = press(onExecution({ cursor: `project:exec-run:${flow}` }), 'enter');
    const detailFrame = render(view, { state: detail, width: 80, height: 40, workboard: execution.board() });
    const row = detailFrame.workboard.rows.find((r) => r.item === expectedItem);
    assert.ok(row, `${flow} missing selectable row ${expectedItem}`);
    assert.ok(row.text.includes(expectedCount), `${flow}: ${row.text}`);
    const insp = press(detail, 'enter');
    assert.equal(insp.subpage.target.workerId, `thin-job:${expectedWorker}`);
    const inspText = text(render(view, { state: insp, width: 80, height: 40, workboard: execution.board() }));
    assert.ok(inspText.includes(expectedAsk), `${flow}: ${inspText}`);
    const back = press(insp, 'escape');
    assert.deepEqual([back.subpage.kind, back.subpage.cursor], ['run-detail', expectedItem]);
  }
  assert.ok([unrecordedRevHelper, seatHelper1, seatHelper2, batchHelper].length === 4);
});

test('a helper folds only when its questions are known to be closed', async (t) => {
  const f = foldFixture(t);
  const parent = f.writeJob(1, '# 01: Parent worker\n', 10, { role: 'imp' });
  const unreadable = f.writeJob(2, 'Read-only: inspect the unreadable one\n', 11, { parent_job: parent });
  fs.writeFileSync(join(f.hud, 'jobs', unreadable, 'qa'), 'not a directory');
  const timedOut = f.writeJob(3, 'Read-only: inspect the expired question\n', 12,
    { parent_job: parent, questions: ['q1'], timed_out_questions: ['q1'] });
  const asking = f.writeJob(4, 'Read-only: inspect the open question\n', 13,
    { parent_job: parent, questions: ['q1', 'q2'], timed_out_questions: ['q1'] });

  const { view } = await f.collect();
  assert.deepEqual(view.endedJobs.map((job) => job.jobId), [parent, unreadable, asking]);
  assert.deepEqual(view.endedJobs[0].children.map((child) => child.jobId), [timedOut]);
});

test('fixed and graph workflows render from cached records; Enter and batch control use the selected row', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-fixed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), project = join(root, 'project'), flows = join(hud, 'flows');
  const id = (prefix, n) => `${prefix}${n.toString(16).padStart(16, '0')}`;
  const job = (n, title, state, receipt = {}) => {
    const job = id('j', n), dir = join(hud, 'jobs', job);
    putJson(join(dir, 'job.json'), { job, cwd: project, project_root: project, role: 'sonic', headless: true, dispatch_exit_code: 0, created_at: ago(30 - n), ...receipt });
    putJson(join(dir, 'STATUS.json'), { state, started_at: ago(29 - n), ...(state === 'closed' && { settled_at: ago(1300) }) });
    fs.writeFileSync(join(dir, 'brief.md'), `# ${title}\n`);
    return job;
  };
  const save = (flow, data, mtime = 1, cwd = project) => {
    const file = join(flows, `${flow}.json`);
    putJson(file, { flow, cwd, project_root: cwd, pane: PANE, ...data });
    const time = new Date(ago(mtime));
    fs.utimesSync(file, time, time);
  };
  const member = job(1, 'Read the interface', 'working', { council: { id: id('j', 2), part: 'member' } });
  const council = job(2, 'Console contract', 'working', { role: 'council', synthesizer: 'main', council_members: [
    { preset: 'fable', failure: 'synthetic failure' }, { preset: 'astra', job: member }, { preset: 'carbon' },
  ] });
  save(council, { template: 'council', state: 'working', steps: { council: { state: 'running' } } });
  const prewalk = job(3, 'Reserve target', 'queued', { role: 'imp' });
  const scout = job(4, 'Find the callers', 'working', { parent_job: prewalk, prewalk_kind: 'code' });
  save(prewalk, { template: 'prewalk', state: 'working', steps: { scouts: { state: 'running' }, target: { state: 'waiting' } } });
  putJson(join(flows, prewalk, 'manifest.json'), { scouts: [{ kind: 'code' }, { kind: 'docs' }] });
  const repair = job(5, 'Repair the synthetic gate', 'working', { role: 'imp' });
  const land = id('f', 5), leased = id('f', 6);
  const gate = { gate: ['unit', 'lint'] };
  save(land, { job: repair, wt: { main_root: project }, state: 'running', step: 'repair 1', config: gate,
    created_at: ago(25), repairs: [{ step: 'gate[2]: lint', outcome: 'waiting for worker', job: repair }],
    timings: [{ step: 'cherry-pick', ok: true }, { step: 'gate[2]: lint', ok: false }] });
  const leaseJob = job(6, 'Land after the lease', 'closed', { role: 'imp' });
  save(leased, { job: leaseJob, wt: { main_root: project }, state: 'queued', step: 'main-checkout lease', config: gate,
    created_at: ago(22), step_started_at: ago(9) });
  const batch = id('b', 9), paused = id('b', 10);
  const scale = { role: 'sonic', count: 40, max_parallel: 7 };
  const totals = { done: 22, failed: 1, running: 7, waiting: 10 };
  save(batch, { state: 'working', created_at: NOW - 8 * 60_000, scale, totals });
  save(paused, { state: 'paused', created_at: NOW - 4 * 60_000, scale, totals });
  putJson(join(flows, batch, 'index.json'), { items: [{ item: 1, pilot: true, state: 'done' }] });
  const graph = id('g', 11), graphJob = job(9, 'Run the graph step', 'working');
  save(graph, { state: 'working', created_at: ago(16), steps: { first: { state: 'done' }, proceed: { state: 'running', job: graphJob },
    alternate: { state: 'running', job: member }, check: { state: 'waiting' } } });
  putJson(join(flows, graph, 'graph.json'), { version: 1, name: 'console-graph', steps: {
    first: { kind: 'check', needs: [] }, proceed: { kind: 'job', role: 'sonic', needs: ['first'] },
    alternate: { kind: 'job', role: 'sonic', needs: ['first'] }, check: { kind: 'check', needs: ['proceed', 'alternate'] },
  } });
  const recentBatch = id('b', 12), recentCouncil = id('j', 13);
  const endedMember = job(12, 'Hidden member row', 'closed', { batch_flow: recentBatch });
  const councilSeat = job(14, 'Hidden council seat', 'closed', { council: { id: recentCouncil, part: 'member' } });
  job(13, 'Finished console review', 'closed', { role: 'council', synthesizer: 'main', council_members: [{ preset: 'fable', job: councilSeat }] });
  save(recentBatch, { state: 'completed', created_at: Date.parse(ago(1400)), scale, totals: { done: 40, failed: 0, running: 0, waiting: 0 } }, 1320);
  putJson(join(flows, recentBatch, 'index.json'), { items: [{ item: 1, pilot: true, state: 'done', job: endedMember }] });
  save(recentCouncil, { template: 'council', state: 'completed', steps: { council: { state: 'done' } } }, 1300);
  save(id('b', 15), { state: 'completed', scale, totals: { done: 40, failed: 0, running: 0, waiting: 0 } }, 1441);
  save(id('b', 16), { state: 'working', scale, totals }, 1, join(root, 'foreign'));

  const execution = new PanelExecution(hud, PANE, {}, () => {});
  t.after(() => execution.dispose());
  execution.sync(project, false);
  await execution.refresh(undefined, NOW);
  const view = execution.view(project);
  assert.deepEqual(view.runs.map(({ flow }) => flow), [paused, council, prewalk, land, leased, graph, batch, recentCouncil, recentBatch]);
  assert.deepEqual(view.endedJobs, []);
  const rendered = render(view, { width: 62, lang: 'zh' });
  const shown = rendered.workboard.rows.map((row) => row.text).join('\n');
  for (const fragment of ['工作流', '评议 Console contract', '◉ 成员 astra', '探路 Reserve target', '◉ code 探路',
    '落地 Repair the synthetic gate', '●─────┬─‹▮✗›╌┬╌╌╌╌╌○', '╰─↻◉╌╌╌╯', '修复 1/2 24分',
    '落地 Land after the lease', '◷ 等锁', '等锁 9分', '流程图 console-graph', '◉ proceed',
    '槽位 7/7', '(●×22 ◉×7 ✗×1 ○×10)', '◉ 并发池 40 项', '✗ 失败  ↻ 修复  ‹▮◉▯› 门禁  ◷ 等锁  ☆✪★ 综合', '刚结束']) {
    assert.ok(shown.includes(fragment), fragment + '\n' + shown);
  }
  assert.doesNotMatch(shown.split('工作者')[0], /⚖|▼|─▶|○ ★/);
  for (const flow of [recentCouncil, recentBatch]) assert.equal(rendered.workboard.rows.filter((row) => row.execRun === flow).length, 1);
  assert.doesNotMatch(shown, /Hidden member row|Hidden council seat/);
  for (const width of [40, 62]) for (const lang of ['en', 'zh']) for (const line of render(view, { width, lang }).lines) {
    assert.equal(visualLength(line), width);
    assert.equal(line, stripAnsi(line));
  }
  // A retained job referenced by both council and graph stays targetable in every flow.
  const memberStations = rendered.workboard.rows.flatMap((row) => row.metroStations ?? []).filter((s) => s.execJob?.target.workerId === `thin-job:${member}`);
  assert.equal(memberStations.length, 2);
  const item = (flow, node = '') => `project:exec-run:${flow}${node ? `:${node}` : ''}`;
  const decoder = new WorkbenchInputDecoder('workboard');
  const press = (state, bytes) => {
    const frame = render(view, { state, width: 62, height: 24 });
    const input = decoder.push(Buffer.from(bytes))[0];
    assert.equal(acceptsMonitorInput(frame.state, input), true);
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };
  for (const [flow, node, jobId] of [[council, 'member-1', member], [prewalk, 'code', scout], [land, 'gate↻', repair], [leased, 'lease', leaseJob], [graph, 'proceed', graphJob], [graph, 'alternate', member]]) {
    assert.equal(press(onExecution({ cursor: item(flow, node) }), '\r').state.subpage.target.workerId, `thin-job:${jobId}`);
  }
  for (const flow of [batch, council, prewalk, land, graph, recentBatch, recentCouncil]) {
    const detail = press(onExecution({ cursor: item(flow) }), '\r').state;
    assert.equal(detail.subpage.flow, flow);
    assert.match(text(render(view, { state: detail })), /Steps/);
  }
  for (const [flow, key, control] of [[batch, 'p', 'pause'], [paused, 'r', 'resume'], [paused, 's', 'stop']]) {
    const state = onExecution({ cursor: item(flow) });
    assert.match(text(render(view, { state })), /X (pause|resume)\/stop/);
    const prompt = press(state, 'X').state;
    assert.match(text(render(view, { state: prompt })), /stop cancels 10 waiting/);
    assert.deepEqual(press(prompt, key).action, { type: 'batch-control', flow, control });
  }
  assert.equal(press(onExecution({ cursor: item(recentBatch) }), 'X').state.overlay, undefined);

  // Atomic replacement invalidates the cache on refresh, not during paint.
  const graphFile = join(flows, graph, 'graph.json');
  const changed = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  putJson(`${graphFile}.new`, { ...changed, name: 'revised-graph' });
  fs.renameSync(`${graphFile}.new`, graphFile);
  assert.match(text(render(view)), /console-graph/);
  await execution.refresh(undefined, NOW);
  assert.match(text(render(execution.view(project))), /revised-graph/);
});

test('Workflow still renders when there are no live workers, while Home stays unchanged', async (t) => {
  const f = await setupWithRuns(t);
  const view = f.execution.view(f.project);
  const runsOnly = { ...view, jobs: [] };
  const shown = text(render(runsOnly, { width: 100, height: 40 }));
  assert.match(shown, /Workflow/);
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
