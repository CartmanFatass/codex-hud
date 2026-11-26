import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executionSnapshot } from '../../dist/collectors/execution.js';
import { objectivePath } from '../../dist/collectors/objectives.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { PanelExecution } from '../../dist/panel/execution.js';
import { visualLength } from '../../dist/render/colors.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { NOW, onPage, plain, projectFixture } from '../fixtures/project-page.mjs';

function makeWorker(base, id, role, overrides = {}) {
  return {
    ...base,
    id: `thin-job:${id}`,
    role,
    displayId: id.slice(0, 8),
    task: overrides.ticketTitle ?? id,
    briefTitle: undefined,
    homeNeedsHuman: false,
    ask: undefined,
    work: undefined,
    ...overrides,
  };
}

test('Feature page: ticket states, completion order, status fitting, Inspector/inline/o/g/P/H, and Esc at 40/62/120 EN/ZH no-colour', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'feature-page-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const at = (min) => NOW - min * 60_000;
  const old = at(6 * 1440);
  const ticketPath = (slug, num) => `/synthetic/${slug}/${num}-item.md`;

  // Synthetic feature covering EVERY ticket state:
  // try (04), working (03 live tab, 09 gate), blocked (08 with blocker), ready (06 with unlanded job, 10 plain),
  // queued (05 <- 03, 07 <- 03, 05), done (01 older, 02 landed 30m ago, 11 newer plain), dropped (12).
  const feature = {
    slug: 'nav-redesign',
    at: at(5),
    tickets: [
      {
        number: '01', title: 'Queue schema and migration', path: ticketPath('nav-redesign', '01'),
        state: 'done', at: NOW, status: 'done', checked: 2, total: 2, blockers: [],
        items: [{ done: true, text: 'Create migration script' }, { done: true, text: 'Verify schema rollback' }],
        comment: 'Landed in abc1234',
      },
      {
        number: '02', title: 'Persist the retry queue', path: ticketPath('nav-redesign', '02'),
        state: 'done', at: at(30), status: 'done', checked: 1, total: 1, blockers: [],
        items: [{ done: true, text: 'Persist retry queue on disk' }],
        comment: 'Landed in def5678',
      },
      {
        number: '03', title: 'Retry queue survives restarts', path: ticketPath('nav-redesign', '03'),
        state: 'working', at: at(14), status: 'claimed', checked: 1, total: 3, blockers: [],
        items: [{ done: true, text: 'Save checkpoint' }, { done: false, text: 'Restore on boot' }],
      },
      {
        number: '04', title: 'Dead-letter view', path: ticketPath('nav-redesign', '04'),
        state: 'try', at: at(25), status: 'ready-for-human', checked: 2, total: 2, blockers: [],
        items: [{ done: true, text: 'Render dead-letter list' }, { done: true, text: 'Export synthetic trace' }],
        landedComment: 'Landed in 9988776',
        comment: 'Ready for owner walkthrough',
      },
      {
        number: '05', title: 'Backoff limits per source', path: ticketPath('nav-redesign', '05'),
        state: 'queued', at: old, status: 'ready-for-agent', checked: 0, total: 1, blockers: ['03'],
        items: [{ done: false, text: 'Cap retry backoff per source' }],
      },
      {
        number: '06', title: 'Queue depth metric', path: ticketPath('nav-redesign', '06'),
        state: 'ready', at: at(40), status: 'ready-for-agent', checked: 0, total: 2, blockers: [],
        items: [{ done: false, text: 'Expose queue depth counter' }],
      },
      {
        number: '07', title: 'Throttle burst drains', path: ticketPath('nav-redesign', '07'),
        state: 'queued', at: old, status: 'ready-for-agent', checked: 0, total: 1, blockers: ['03', '05'],
        items: [{ done: false, text: 'Rate-limit burst drain' }],
      },
      {
        number: '08', title: 'External webhook contract', path: ticketPath('nav-redesign', '08'),
        state: 'blocked', at: old, status: 'needs-info', checked: 0, total: 1, blockers: ['03', '13', '14', '15'],
        items: [{ done: false, text: 'Confirm synthetic payload' }],
        comment: 'Waiting on payload shape',
      },
      {
        number: '09', title: 'Gate runner verification', path: ticketPath('nav-redesign', '09'),
        state: 'working', at: at(3), status: 'claimed', checked: 1, total: 1, blockers: [],
        items: [{ done: true, text: 'Pass gate steps' }],
      },
      {
        number: '10', title: 'Ready ticket with no checklist', path: ticketPath('nav-redesign', '10'),
        state: 'ready', at: old, status: 'ready-for-agent', checked: 0, total: 0, blockers: [],
        items: [],
      },
      {
        number: '11', title: 'Earlier landed note without job', path: ticketPath('nav-redesign', '11'),
        state: 'done', at: old, status: 'done', checked: 1, total: 1, blockers: [],
        items: [{ done: true, text: 'Document feature flag' }],
        job: { role: 'imp', state: 'done', created: at(180), completedAt: at(120) },
        comment: 'Landed in 4455667',
      },
      {
        number: '12', title: 'Legacy polling loop', path: ticketPath('nav-redesign', '12'),
        state: 'dropped', at: old, status: 'wontfix', checked: 0, total: 1, blockers: [],
        items: [{ done: false, text: 'Superseded by watch loop' }],
      },
    ],
  };

  const unlinkedFeature = {
    slug: 'spare-cli',
    at: at(10),
    tickets: [
      {
        number: '01', title: 'Add dry-run flag', path: ticketPath('spare-cli', '01'),
        state: 'ready', at: at(10), status: 'ready-for-agent', checked: 0, total: 1, blockers: [],
        items: [{ done: false, text: 'Print dry-run plan' }],
      },
    ],
  };

  const baseWorker = f.board.workers[0];
  const liveJobId = 'j0000000000000103';
  const gateJobId = 'j0000000000000109';
  const unlandedJobId = 'j0000000000000106';
  const landedJobId = 'j0000000000000102';
  const workers = [
    makeWorker(baseWorker, liveJobId, 'imp', { ticketTitle: '03 Retry queue survives restarts', settledAt: null, headless: false, startedAt: at(14) }),
    makeWorker(baseWorker, gateJobId, 'imp', { ticketTitle: '09 Gate runner verification', settledAt: at(4), headless: true, startedAt: at(18) }),
    makeWorker(baseWorker, unlandedJobId, 'imp', { ticketTitle: '06 Queue depth metric', settledAt: at(40), headless: false, startedAt: at(65) }),
    makeWorker(baseWorker, landedJobId, 'imp', { ticketTitle: '02 Persist the retry queue', settledAt: at(30), headless: false, startedAt: at(55) }),
  ];
  const board = {
    ...f.board,
    lanes: [{ ...f.board.lanes[0], workers }],
    workers,
  };
  const targetFor = (id, tab) => ({
    target: { kind: 'worker', laneId: baseWorker.laneId, workerId: `thin-job:${id}` },
    dir: join(f.hud, 'jobs', id),
    tab,
  });

  const projectActivity = [
    { ticket: 'nav-redesign/03', kind: 'live', jobId: liveJobId, at: at(2), startedAt: at(14), state: 'working', execJob: targetFor(liveJobId, true) },
    { ticket: 'nav-redesign/09', kind: 'gate', flow: 'f0000000000000109', jobId: gateJobId, at: at(3), progress: { kind: 'gate', index: 2, total: 3 }, execJob: targetFor(gateJobId, false) },
    { ticket: 'nav-redesign/06', kind: 'ended', jobId: unlandedJobId, at: at(40), result: 'not landed', execJob: targetFor(unlandedJobId, false) },
    { ticket: 'nav-redesign/08', kind: 'ended', at: at(30), result: 'failed' },
    { ticket: 'nav-redesign/02', kind: 'ended', jobId: landedJobId, at: at(30), result: 'landed', execJob: targetFor(landedJobId, false) },
  ];

  const mainObjective = {
    id: 'interaction',
    state: 'active',
    title: 'Project and Feature drill-down navigation',
    features: ['pad-a', 'pad-b', 'pad-c', 'pad-d', 'pad-e', 'nav-redesign'],
    evidence: [],
  };
  const data = {
    ...f.data,
    updatedAt: at(3),
    objectivesAt: old,
    // The older landing was edited most recently; the ledger date comes from its Landed commit.
    ledger: [{ id: 'NAV-REDESIGN-01', state: 'accepted', at: at(3 * 1440), landed: true }],
    tickets: [feature, unlinkedFeature],
    objectiveTickets: [feature],
    unlinked: [unlinkedFeature],
    objectives: {
      path: objectivePath(f.cwd),
      stance: 'active',
      priority: 'high',
      objectives: [mainObjective],
      diagnostics: [],
      acceptance: {},
    },
    waiting: [
      { label: '', objective: 'interaction', request: 'r1', value: 'Confirm nav-redesign scope', sentence: 'Confirm nav-redesign scope', at: at(120), waitedOn: true },
    ],
  };
  const choices = [
    { root: f.cwd, name: 'orchard' },
    { root: '/synthetic/tide-lab', name: 'tide-lab' },
  ];

  const decoder = new WorkbenchInputDecoder('workboard');
  const send = (frame, raw) => {
    const [input] = decoder.push(Buffer.from(raw));
    assert.ok(acceptsMonitorInput(frame.state, input), `accepts ${JSON.stringify(raw)} on ${frame.state.subpage?.kind}`);
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };
  const key = (frame, k) => handleMonitorInput(frame.state, { type: 'key', key: k }, { frame, nowMs: NOW });

  for (const lang of ['en', 'zh']) for (const width of [40, 62, 120]) {
    const zh = lang === 'zh';
    const draw = (state, height = 36, themeName = 'none') => f.render(width, lang, state, height, data, true, 'unicode', themeName, {
      workboard: board,
      projectDisplayRoot: f.cwd,
      projectName: 'orchard',
      projects: choices,
      projectActivity,
    });

    // 1. Entry from Objective page -> Feature page (with non-zero scroll preserved on Esc)
    const objState = {
      ...onPage(),
      subpage: { kind: 'objective', target: { root: f.cwd, objective: mainObjective, blocked: true }, cursor: 'objective:feature:nav-redesign', scroll: 2, revealed: 'objective:feature:nav-redesign' },
    };
    const objFrame = draw(objState, 10);
    assert.equal(objFrame.state.subpage.scroll, 2);
    const opened = key(objFrame, 'enter');
    assert.equal(opened.state.subpage?.kind, 'feature');
    assert.equal(opened.state.subpage?.target.slug, 'nav-redesign');
    assert.equal(opened.state.subpage?.target.objectiveId, 'interaction');

    const featFrame = draw(opened.state, 36, 'none');
    assert.ok([...featFrame.lines, ...featFrame.workboard.rows.map((r) => r.text)]
      .every((line) => visualLength(line) === width && !line.includes('\x1b')), 'cell-exact and no ANSI in none theme');
    const lines = plain(featFrame);
    const text = lines.join('\n');

    // Crumb ends in slug; project name shown at 62/120 and omitted below 56 (40).
    if (width >= 56) {
      assert.match(lines[0], zh ? /^‹ orchard › interaction › nav-redesign\s+3\/11 工单$/ : /^‹ orchard › interaction › nav-redesign\s+3\/11 tickets$/);
    } else {
      assert.match(lines[0], /^‹ interaction › nav-redesign\s+3\/11$/);
      assert.doesNotMatch(lines[0], /orchard/);
    }

    // Pinned project request stays on top without project name; [ ] project switch is off.
    assert.match(lines[1], /^\? interaction\b/);
    assert.doesNotMatch(lines[1], /orchard/);
    assert.equal(send(featFrame, ']').state.selectedProject, undefined);

    // Stacked bar and legend with counts (all 6 buckets present, wrapping cleanly at 40 and 62).
    assert.match(text, /[█▒░]{10,}/);
    for (const part of zh
      ? ['完成 3', '待试用 1', '工作中 2', '受阻 1', '待办 4', '已放弃 1']
      : ['done 3', 'to try 1', 'working 2', 'blocked 1', 'todo 4', 'dropped 1']) {
      assert.ok(text.includes(part), `legend includes ${part}`);
    }

    // Tickets section exists; NO separate Running/Recently ended job sections.
    assert.match(text, zh ? /^工单 ─+ 12$/m : /^Tickets ─+ 12$/m);
    assert.doesNotMatch(text, /^运行中 ─|^刚结束 ─|^Running ─|^Recently ended ─/m);

    // Exact ticket ordering:
    // to-try (04) -> working (03, 09) -> blocked (08) -> ready (06, 10) -> queued (05, 07) -> done newest first (02 [30m], 11 [2h], 01 [3d]) -> dropped (12).
    const ticketRows = featFrame.workboard.rows.filter((r) => r.item?.startsWith('feature:ticket:'));
    const numbers = ticketRows.map((r) => /^feature:ticket:nav-redesign:(\d+)-/.exec(r.item)[1]);
    assert.deepEqual(numbers, ['04', '03', '09', '08', '06', '10', '05', '07', '02', '11', '01', '12']);

    // State marks, blockers, and observed job status on the SAME ticket row.
    const rowOf = (num) => ticketRows.find((r) => r.item.includes(`:${num}-`)).text;
    assert.match(rowOf('04'), zh ? /^  ◇ 04 .*待试用/ : /^  ◇ 04 .*to try/);
    assert.match(rowOf('03'), zh ? /^  ◐ 03 .*◐ 工作中 14分/ : /^  ◐ 03 .*◐ working 14m/);
    assert.match(rowOf('09'), zh ? /^  ◐ 09 .*门禁 2\/3/ : /^  ◐ 09 .*Gate 2\/3/);
    assert.match(rowOf('08'), zh ? /^  ◆ 08 External.*受阻 .*✗ 失败 30分/ : /^  ◆ 08 External.*blocked .*✗ failed 30m/);
    assert.match(rowOf('06'), zh ? /^  ● 06 Queue depth.*◒ 未落地 40分/ : /^  ● 06 Queue depth.*◒ not landed 40m/);
    if (width === 120) {
      assert.match(rowOf('08'), zh ? /受阻 ← 03, 13, 14, 15  ✗ 失败 30分/ : /blocked ← 03, 13, 14, 15  ✗ failed 30m/);
      assert.match(rowOf('06'), zh ? /就绪  ◒ 未落地 40分/ : /ready  ◒ not landed 40m/);
    } else if (width === 40) {
      assert.doesNotMatch(rowOf('08'), /←/); // Keep the state word and full job status, cut the blockers first.
    }
    assert.match(rowOf('10'), zh ? /^  ● 10 .*就绪/ : /^  ● 10 .*ready/);
    assert.match(rowOf('05'), zh ? /^  · 05 .*待前序 ← 03/ : /^  · 05 .*Queued ← 03/);
    assert.match(rowOf('07'), /^  · 07 .*← 03, 05/);
    assert.match(rowOf('02'), zh ? /^  ✓ 02 .*✓ 已落地 30分/ : /^  ✓ 02 .*✓ landed 30m/);
    assert.match(rowOf('11'), zh ? /^  ✓ 11 .*完成/ : /^  ✓ 11 .*done/);
    assert.match(rowOf('01'), zh ? /^  ✓ 01 .*完成/ : /^  ✓ 01 .*done/);
    assert.match(rowOf('12'), zh ? /^  – 12 .*已放弃/ : /^  – 12 .*dropped/);

    // Colour theme still maintains exact visual width on every line.
    const coloured = draw(opened.state, 36, 'mocha');
    assert.ok(coloured.lines.every((line) => visualLength(line) === width));
    assert.ok(coloured.lines.some((line) => line.includes('\x1b')));

    // 2. Enter on ticket WITH live job (03) opens Inspector; Esc returns to Feature page at ticket 03.
    const selectTicket = (frame, num) => draw({ ...frame.state, subpage: { ...frame.state.subpage, cursor: `feature:ticket:nav-redesign:${num}-item.md` } }, 36);
    const onLive = selectTicket(featFrame, '03');
    assert.match(plain(onLive).at(-1), zh ? /g 任务页/ : /g job tab/);
    // g / P / H act on live tab job's ticket row.
    assert.deepEqual(send(onLive, 'g').action, { type: 'focus-job-tab', dir: join(f.hud, 'jobs', liveJobId) });
    assert.deepEqual(send(onLive, 'P').action, { type: 'pin-job-tab', dir: join(f.hud, 'jobs', liveJobId) });
    assert.deepEqual(send(onLive, 'H').action, { type: 'hide-job-tab', dir: join(f.hud, 'jobs', liveJobId) });
    // o always opens the ticket file even when a live job exists.
    assert.deepEqual(send(onLive, 'o').action, { type: 'open-files', files: [ticketPath('nav-redesign', '03')] });
    // Enter opens Inspector for that job.
    const liveInsp = key(onLive, 'enter');
    assert.equal(liveInsp.state.subpage?.kind, 'inspector');
    assert.equal(liveInsp.state.subpage?.target.workerId, `thin-job:${liveJobId}`);
    assert.equal(liveInsp.state.subpage?.from, 'feature');
    const liveInspFrame = draw(liveInsp.state, 36);
    assert.match(plain(liveInspFrame).join('\n'), /Retry queue/);
    // Esc returns to Feature page at ticket 03.
    const backFromLive = key(liveInspFrame, 'escape');
    assert.equal(backFromLive.state.subpage?.kind, 'feature');
    assert.equal(backFromLive.state.subpage?.cursor, 'feature:ticket:nav-redesign:03-item.md');

    // 3. Enter on ticket WITH retained <=24h job (02 landed) opens Inspector; g P H are no-ops (tab=false); o opens file.
    const onLanded = selectTicket(featFrame, '02');
    assert.equal(send(onLanded, 'g').action, undefined);
    assert.equal(send(onLanded, 'P').action, undefined);
    assert.equal(send(onLanded, 'H').action, undefined);
    assert.deepEqual(send(onLanded, 'o').action, { type: 'open-files', files: [ticketPath('nav-redesign', '02')] });
    const landedInsp = key(onLanded, 'enter');
    assert.equal(landedInsp.state.subpage?.kind, 'inspector');
    assert.equal(landedInsp.state.subpage?.target.workerId, `thin-job:${landedJobId}`);
    assert.equal(key(draw(landedInsp.state, 36), 'escape').state.subpage?.kind, 'feature');

    // 4. Enter on ticket WITHOUT live/retained job (04 with both landedComment & comment, and 01 with Landed comment, and 10 with no checklist) expands inline; second Enter folds; o opens file.
    const onTry = selectTicket(featFrame, '04');
    assert.equal(send(onTry, 'g').action, undefined);
    const expandedTry = draw(key(onTry, 'enter').state, 36);
    assert.equal(expandedTry.state.subpage?.kind, 'feature');
    const tryText = plain(expandedTry).join('\n');
    assert.match(tryText, /✓ Render dead-letter list/);
    assert.match(tryText, /✓ Export synthetic trace/);
    assert.match(tryText, /Landed in 9988776/);
    assert.match(tryText, /Ready for owner walkthrough/);
    assert.deepEqual(send(expandedTry, 'o').action, { type: 'open-files', files: [ticketPath('nav-redesign', '04')] });
    // Second Enter folds it back.
    const foldedTry = draw(key(expandedTry, 'enter').state, 36);
    assert.doesNotMatch(plain(foldedTry).join('\n'), /Render dead-letter list/);

    // Ticket 10 with empty checklist shows "no checklist" when expanded.
    const onBare = selectTicket(featFrame, '10');
    const expandedBare = draw(key(onBare, 'enter').state, 36);
    assert.match(plain(expandedBare).join('\n'), zh ? /没有检查项/ : /no checklist/);

    // 5. Esc from Feature page returns to Objective page at the exact feature row and scroll.
    const backObj = key(featFrame, 'escape');
    assert.equal(backObj.state.subpage?.kind, 'objective');
    assert.equal(backObj.state.subpage?.cursor, 'objective:feature:nav-redesign');
    assert.equal(backObj.state.subpage?.scroll, 2);

    // 6. Entry from Unlinked list -> Feature page, and Esc returns to Unlinked list at exact feature row.
    const unlinkedFrame = draw(onPage('unlinked', { project: { nav: { cursor: `project:file:${ticketPath('spare-cli', '01')}:unlinked` } } }), 24);
    const fromUnlinked = key(unlinkedFrame, 'enter');
    assert.equal(fromUnlinked.state.subpage?.kind, 'feature');
    assert.equal(fromUnlinked.state.subpage?.target.slug, 'spare-cli');
    const unlinkedFeatFrame = draw(fromUnlinked.state, 24);
    assert.match(plain(unlinkedFeatFrame)[0], width >= 56 ? /^‹ orchard › spare-cli\s+0\/1/ : /^‹ spare-cli\s+0\/1/);
    assert.match(plain(unlinkedFeatFrame).join('\n'), /● 01 Add dry-run flag/);
    const backUnlinked = key(unlinkedFeatFrame, 'escape');
    assert.equal(backUnlinked.state.subpage, undefined);
    assert.equal(backUnlinked.state.project.view.kind, 'unlinked');
    assert.equal(backUnlinked.state.project.nav.cursor, `project:file:${ticketPath('spare-cli', '01')}:unlinked`);

    // 7. Entry from Tickets page (`t`) -> Feature page, and Esc returns to Tickets page at exact feature row.
    const ticketsFrame = draw(onPage('tickets', { project: { nav: { cursor: 'project:fold:feature:nav-redesign' } } }), 24);
    const fromTickets = key(ticketsFrame, 'enter');
    assert.equal(fromTickets.state.subpage?.kind, 'feature');
    assert.equal(fromTickets.state.subpage?.target.slug, 'nav-redesign');
    const ticketsFeatFrame = draw(fromTickets.state, 24);
    assert.match(plain(ticketsFeatFrame)[0], width >= 56 ? /^‹ orchard › nav-redesign\s+3\/11/ : /^‹ nav-redesign\s+3\/11/);
    const backTickets = key(ticketsFeatFrame, 'escape');
    assert.equal(backTickets.state.subpage, undefined);
    assert.equal(backTickets.state.project.view.kind, 'tickets');
    assert.equal(backTickets.state.project.nav.cursor, 'project:fold:feature:nav-redesign');
  }
});

test('executionSnapshot populates live, gate, unlanded and landed TicketActivity with execJob and LandProgress', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'feature-page-exec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const hud = join(root, 'hud');
  fs.mkdirSync(cwd, { recursive: true });
  const put = (p, body) => {
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const iso = (min) => new Date(NOW - min * 60_000).toISOString();

  // Live tab job on feat/03
  const liveId = 'j0000000000000203';
  put(join(hud, 'jobs', liveId, 'job.json'), {
    job: liveId, role: 'imp', cwd, ticket: 'feat/03', herdr_pane: 'w1:p1', created_at: iso(15),
  });
  put(join(hud, 'jobs', liveId, 'STATUS.json'), { state: 'working', started_at: iso(14) });

  // Settled worktree job with no landing (unlanded) on feat/06
  const unlandedId = 'j0000000000000206';
  put(join(hud, 'jobs', unlandedId, 'job.json'), {
    job: unlandedId, role: 'imp', cwd, ticket: 'feat/06', headless: true,
    worktree: { root: join(root, 'wt6'), main_root: cwd, branch: 'wt/feat-06' },
    created_at: iso(60),
  });
  put(join(hud, 'jobs', unlandedId, 'STATUS.json'), { state: 'done', started_at: iso(55), settled_at: iso(40) });

  // Settled worktree job with active standalone land gate 2/3 on feat/09
  const gateId = 'j0000000000000209';
  const flowId = 'f0000000000000209';
  put(join(hud, 'jobs', gateId, 'job.json'), {
    job: gateId, role: 'imp', cwd, ticket: 'feat/09', headless: true,
    worktree: { root: join(root, 'wt9'), main_root: cwd, branch: 'wt/feat-09' },
    created_at: iso(25),
  });
  put(join(hud, 'jobs', gateId, 'STATUS.json'), { state: 'done', started_at: iso(20), settled_at: iso(5) });
  put(join(hud, 'flows', `${flowId}.json`), {
    flow: flowId, kind: 'land', state: 'running', job: gateId,
    step: 'gate[2]: npm test',
    config: { base: 'main', gate: ['npm run build', 'npm test', 'npm run lint'], after: [], push: false },
    wt: { root: join(root, 'wt9'), main_root: cwd, branch: 'wt/feat-09' },
    created_at: iso(4), updated_at: iso(2), step_started_at: iso(2),
  });

  const lanes = readThinJobs(hud, { project: cwd, pane: 'w1:p1', within: cwd });
  const board = {
    revision: 'synthetic',
    lanes,
    workers: lanes.flatMap((l) => l.workers),
    decisions: [],
    coverage: { incomplete: false, diagnostics: [], workspace: cwd },
  };
  const snap = executionSnapshot(hud, board, { root: cwd, pane: 'w1:p1', complete: true, activityOnly: true }, NOW);
  const byTicket = (tk) => snap.ticketActivity.filter((e) => e.ticket === tk);

  const liveEntry = byTicket('feat/03').find((e) => e.kind === 'live');
  assert.ok(liveEntry);
  assert.equal(liveEntry.jobId, liveId);
  assert.equal(liveEntry.state, 'working');
  assert.equal(liveEntry.execJob?.tab, true);
  assert.equal(liveEntry.execJob?.target.workerId, `thin-job:${liveId}`);

  const unlandedEntry = byTicket('feat/06').find((e) => e.kind === 'ended');
  assert.ok(unlandedEntry);
  assert.equal(unlandedEntry.result, 'not landed');
  assert.equal(unlandedEntry.execJob?.tab, false);
  assert.equal(unlandedEntry.execJob?.target.workerId, `thin-job:${unlandedId}`);

  const gateEntry = byTicket('feat/09').find((e) => e.kind === 'gate');
  assert.ok(gateEntry);
  assert.deepEqual(gateEntry.progress, { kind: 'gate', index: 2, total: 3, passed: 1, since: NOW - 2 * 60_000 });
  assert.equal(gateEntry.execJob?.target.workerId, `thin-job:${gateId}`);
});

test('Feature and Objective use individual queue landing times, not the queue end', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'feature-page-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const slug = 'nav-redesign', flow = 'q0000000000000010', job = 'j0000000000000013';
  const at = (min) => NOW - min * 60_000, iso = (min) => new Date(at(min)).toISOString();
  const path = (no) => join(f.cwd, '.scratch', slug, 'issues', `${no}-sample.md`);
  for (const n of ['01', '02', '03', '04']) f.issue(slug, n, `Queue ticket ${n}`, 'done', undefined, 'none', n === '04' ? 720 : 0);
  // An old landing must not come back as a recent job outcome when the source worker settles later.
  f.put(join(f.hud, 'jobs', job, 'job.json'), { job, role: 'imp', cwd: f.cwd, ticket: `${slug}/03`, created_at: iso(1800) });
  f.put(join(f.hud, 'jobs', job, 'STATUS.json'), { state: 'done', settled_at: iso(10) });
  f.put(join(f.hud, 'flows', `${flow}.json`), {
    flow, root: f.cwd, feature: slug, state: 'completed', created_at: iso(1800), updated_at: iso(5),
    tickets: [
      { ticket: '01', path: path('01'), role: 'imp', landed: true, landed_at: iso(480), changed_at: iso(7) },
      { ticket: '02', path: path('02'), role: 'imp', landed: true, changed_at: iso(120) },
      { ticket: '03', path: path('03'), role: 'imp', landed: true, landed_at: iso(1500), job },
      { ticket: '04', path: path('04'), role: 'imp', landed: true }, // Undated legacy item: no fabricated age.
    ],
  }, 5);
  const execution = new PanelExecution(f.hud, null);
  t.after(() => execution.dispose());
  execution.sync(f.cwd);
  const project = await f.collector.collect(true, f.board, NOW);
  await execution.refresh(undefined, NOW, false, project);
  assert.equal(execution.view(f.cwd).runs.find((run) => run.flow === flow).endedAt, at(5));
  const projectActivity = execution.activity(f.cwd);
  assert.deepEqual(projectActivity.map(({ ticket, kind, result, at }) => [ticket, kind, result, at]), [
    [`${slug}/01`, 'ended', 'landed', at(480)], [`${slug}/02`, 'ended', 'landed', at(120)],
  ]);
  const draw = (subpage) => f.render(120, 'en', { ...onPage(), subpage }, 24, project, true, 'unicode', 'none', {
    projectActivity, projectLandings: execution.landings(f.cwd),
  });
  const feature = draw({ kind: 'feature', target: { root: f.cwd, slug } });
  const lines = plain(feature).join('\n');
  assert.match(lines, /Queue ticket 01.*✓ landed 8h/);
  assert.match(lines, /Queue ticket 02.*✓ landed 2h/);
  assert.match(lines, /Queue ticket 03\s+done\s*$/m);
  assert.deepEqual([...lines.matchAll(/Queue ticket (\d+)/g)].map((m) => m[1]), ['02', '01', '04', '03']);
  const objective = { id: 'interaction', state: 'active', title: 'Synthetic project navigation', features: [slug], evidence: [] };
  const detail = draw({ kind: 'objective', target: { root: f.cwd, objective, blocked: false } });
  assert.match(detail.workboard.rows.find((row) => row.item === `objective:feature:${slug}`).text, /✓ landed 2h ago/);
});

test('Project-resolved target hints and filenames supply the live Feature Inspector and tab actions', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'feature-page-linked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const slug = 'nav-redesign', pane = 'w4E:p2'; // Different pane from the calling Project board.
  const jobs = [
    ['01', 'j0000000000000301', { target_hint: `${slug}/01` }],
    ['02', 'j0000000000000302', { package: slug, task: 'Implement the checklist in 02-sample.md' }],
  ];
  for (const [number, job, hint] of jobs) {
    f.issue(slug, number, `Synthetic task ${number}`, 'ready-for-agent');
    const dir = join(f.hud, 'jobs', job);
    f.put(join(dir, 'job.json'), { job, role: 'imp', cwd: f.cwd, herdr_pane: pane, created_at: new Date(NOW - 60000).toISOString(), ...hint });
    f.put(join(dir, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 60000).toISOString() });
  }
  const project = await f.collector.collect(true, f.board, NOW);
  const execution = new PanelExecution(f.hud, 'w4E:p1');
  t.after(() => execution.dispose());
  execution.sync(f.cwd);
  await execution.refresh(undefined, NOW, true, project);
  for (const [number, job] of jobs) {
    const ticket = project.tickets.find((feature) => feature.slug === slug).tickets.find((ticket) => ticket.number === number);
    assert.equal(ticket.job.id, job);
    assert.equal(ticket.state, 'working');
    const item = `feature:ticket:${slug}:${number}-sample.md`;
    const state = { ...onPage(), subpage: { kind: 'feature', target: { root: f.cwd, slug }, cursor: item } };
    const frame = f.render(80, 'en', state, 20, project, true, 'unicode', 'none', {
      projectActivity: execution.activity(f.cwd),
    });
    const row = frame.workboard.rows.find((r) => r.item === item);
    const dir = join(f.hud, 'jobs', job), worker = execution.board().workers.find((w) => w.id === `thin-job:${job}`);
    assert.deepEqual(row.execJob, { target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id }, dir, tab: true });
    const send = (input) => handleMonitorInput(frame.state, { type: 'key', ...input }, { frame, nowMs: NOW });
    const entered = send({ key: 'enter' }).state.subpage;
    assert.equal(entered.kind, 'inspector');
    assert.equal(entered.from, 'feature');
    assert.equal(entered.target.workerId, worker.id);
    for (const [text, type] of [['g', 'focus-job-tab'], ['P', 'pin-job-tab'], ['H', 'hide-job-tab']]) {
      assert.deepEqual(send({ text }).action, { type, dir });
    }
  }
});
