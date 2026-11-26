import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectObjectiveEvidence, objectivePath, readObjectives } from '../../dist/collectors/objectives.js';
import { STATE_BYTES } from '../../dist/collectors/state-ledger.js';
import { visualLength } from '../../dist/render/colors.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { onPage, PROJECTS } from '../fixtures/project-page.mjs';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { NOW, plain, projectFixture } from '../fixtures/project-page.mjs';

const sample = `# Objectives
**Stance:** active · **Priority:** high

## finish: Publish the guide
**State:** done
**Result:** Published a synthetic guide.

## hold: Compare an alternative
**State:** paused
**Next:** Wait for sample readings.

## measure: Measure the sample
**State:** active
**Features:** native-tree, missing
**Next:** Repeat the sample.
**Result:** Recorded a baseline.
**Evidence:** docs/notes.md, https://example.org/notes, 123abcd
**Future field:**  keep  these spaces${'  '}

## invalid: Missing a required field
**Next:** Not an Objective.
`;

test('bounded Objective reader skips malformed sections and ignores unknown fields', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = objectivePath(root);
  assert.equal(readObjectives(root), undefined);
  fs.mkdirSync(join(root, '.hud'));
  fs.writeFileSync(path, sample);
  const { stance, priority, objectives, diagnostics } = readObjectives(root);
  assert.deepEqual([stance, priority], ['active', 'high']);
  assert.deepEqual(objectives.map(({ id, state }) => [id, state]), [['finish', 'done'], ['hold', 'paused'], ['measure', 'active']]);
  assert.deepEqual(objectives[2], {
    id: 'measure', title: 'Measure the sample', state: 'active', features: ['native-tree', 'missing'],
    next: 'Repeat the sample.', result: 'Recorded a baseline.', evidence: ['docs/notes.md', 'https://example.org/notes', '123abcd'],
  });
  assert.deepEqual(diagnostics, ['Malformed Objective section 4']);
  fs.writeFileSync(path, '## same: One\n**State:** active\n## same: Two\n**State:** done\n');
  const repeated = readObjectives(root);
  assert.deepEqual([repeated.stance, repeated.priority, repeated.objectives.length, repeated.diagnostics.length], ['unknown', 'normal', 0, 2]);
  fs.writeFileSync(path, sample + ' '.repeat(STATE_BYTES));
  assert.deepEqual(readObjectives(root).objectives, []);
  assert.match(readObjectives(root).diagnostics[0], /exceeds/);
});

test('Project overview: activity tiers, first-met priority, subtitles, folds and header keys at 40 and 62 in EN/ZH', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  const at = (min) => NOW - min * 60_000, old = at(6 * 1440);
  const feature = (slug, states) => ({ slug, at: old, tickets: states.map((state, i) => ({ number: `0${i + 1}`,
    title: 'Synthetic ticket, not a hub job row', path: `/synthetic/${slug}/${i}.md`, state, at: old,
    checked: 0, total: 1, blockers: [], status: state, items: [] })) });
  const specs = [
    ['quiet', 'active', ['ready']], ['pi-worker', 'done', ['done']], ['recent', 'active', ['done', 'ready']],
    ['needs-try', 'active', ['try']], ['waiting', 'paused', ['done']], ['hot', 'done', ['working', 'working']],
    ['failed', 'active', ['ready']], ['unlanded', 'active', ['ready']], ['parked', 'paused', ['ready']],
    ['last-land', 'active', ['done', 'dropped']], ['study', 'active', []], ['partial', 'active', ['done']],
  ];
  const objectives = specs.map(([id, state, tickets]) => ({ id, state, title: `Title of ${id}`, features: tickets.length ? [id] : [], evidence: [],
    ...(id === 'recent' ? { result: 'New result from the ledger' } : id === 'failed' ? { result: 'Undated result' } : {}) }));
  const tickets = specs.filter((spec) => spec[2].length).map(([id, , states]) => ({ ...feature(id, states), ...(id === 'partial' ? { partial: true } : {}) }));
  tickets.find((f) => f.slug === 'hot').tickets[0].job = { id: 'job-one', state: 'working', role: 'imp', at: at(10) };
  const data = { ...f.data, updatedAt: at(3), objectivesAt: old, ledger: [], tickets, objectiveTickets: tickets,
    objectives: { path: objectivePath(f.cwd), stance: 'active', priority: 'high', objectives, diagnostics: ['bad section'], resultDates: { recent: at(3) }, acceptance: {} },
    waiting: [{ label: '', objective: 'waiting', request: 'r1', value: 'Choose a synthetic option' }],
    unlinked: [feature('spare', ['ready']), feature('other', ['done', 'ready'])],
    editing: [{ label: 'editing', value: 'Job edit must not appear', path: '/synthetic/job.md' }] };
  const projectActivity = [
    { ticket: 'hot/01', kind: 'live', jobId: 'job-one', at: at(8) },
    { ticket: 'HOT-02', kind: 'live', jobId: 'job-two', at: at(4) },
    { ticket: 'hot/02', kind: 'gate', flow: 'gate-one', at: at(2) },
    { ticket: 'recent/01', kind: 'ended', result: 'landed', at: at(3) },
    { ticket: 'failed/01', kind: 'ended', result: 'failed', at: at(20) },
    { ticket: 'unlanded/01', kind: 'ended', result: 'not landed', at: at(40) },
    { ticket: 'last-land/01', kind: 'ended', result: 'landed', at: at(1) },
    { ticket: 'quiet/01', kind: 'ended', result: 'failed', at: old },
  ];
  const decoder = new WorkbenchInputDecoder('workboard');
  const act = (frame, input) => handleMonitorInput(frame.state, input, { frame });
  const press = (frame, raw) => {
    const [input] = decoder.push(Buffer.from(raw));
    assert.ok(acceptsMonitorInput(frame.state, input), raw);
    return act(frame, input);
  };
  const esc = (frame) => act(frame, { type: 'key', key: 'escape' }).state;
  for (const lang of ['en', 'zh']) for (const width of [40, 62]) {
    const zh = lang === 'zh';
    const draw = (state, height = 35, project = data) => f.render(width, lang, state, height, project, true, 'unicode', 'none', { projectActivity, projects: PROJECTS });
    const hub = draw(), rows = hub.workboard.rows, text = plain(hub).join('\n');
    const ids = (frame) => frame.workboard.rows.flatMap((r) => r.objectiveTarget ? [r.objectiveTarget.objective.id] : []);
    assert.deepEqual(ids(hub), ['hot', 'recent', 'failed', 'unlanded', 'waiting', 'needs-try', 'quiet', 'study', 'partial']);
    assert.equal(hub.state.project.nav.cursor, 'project:wait:0');
    assert.match(draw(undefined, 35, { ...data, waiting: [] }).state.project.nav.cursor, /:hot$/);
    assert.ok([...hub.lines, ...rows.map((r) => r.text)].every((line) => visualLength(line) === width && !line.includes('\x1b')));
    assert.match(text, zh ? /工单 +工作区 +文档/ : /Tickets +Worktree +Docs/);
    assert.match(text, zh ? /进行中.*3分前/ : /active.*3m ago/);
    if (width === 62) assert.match(text, zh ? /高优先级/ : /high priority/);
    assert.match(text, zh ? /^目标 ─+ 完成\/工单$/m : /^Objectives ─+ done\/tickets$/m);
    assert.match(text, zh ? /● 2 在跑 · 1 门禁/ : /● 2 live · 1 (?:at )?gate/);
    assert.match(text, zh ? /✓ 刚落地/ : /✓ Just landed/);
    if (width === 62) assert.match(text, zh ? /刚落地 recent/ : /Just landed recent/);
    assert.match(text, zh ? /✗ 20分前失败/ : /✗ 20m ago: failed/);
    assert.match(text, zh ? /◒ 40分前(?:结束·)?未落地/ : /◒ 40m (?:unlanded|ago: ended · not landed)/);
    assert.match(text, zh ? /\? 在等你[ \n]/ : /\? Waiting on you[ \n]/);
    assert.match(text, zh ? /◇ 等你试用/ : /◇ Your try/);
    assert.match(text, zh ? /空闲 6天/ : /Idle 6d/);
    assert.match(text, /study +╌+/);
    assert.match(text, /partial +—/);
    assert.match(text, zh ? /▸ 已完成\/搁置 3/ : /▸ Done\/paused 3/);
    assert.doesNotMatch(text, /Details ─|详情 ─|Progress|进度|pi-worker|parked|last-land|Job edit|Undated result|not a hub job row/);
    assert.match(text, /◌ (?:Unlinked|未归入目标): spare 0\/1 · other 1\/2/);
    assert.equal(rows.filter((r) => r.objectiveSubtitle).length, ids(hub).length);
    assert.match(text, /✓ New result from the ledger/);
    assert.match(text, /Title of failed/);
    assert.ok(!draw(undefined, 12).workboard.rows.some((r) => r.objectiveSubtitle), 'subtitles drop before objective rows');
    assert.deepEqual(ids(draw(undefined, 12)), ids(hub));
    const beforeLanding = { ...data, objectiveTickets: tickets.map((f) => f.slug === 'last-land' ? feature(f.slug, ['ready', 'dropped']) : f) };
    assert.ok(ids(draw(undefined, 35, beforeLanding)).includes('last-land'), 'an unfinished ticket keeps the Objective out of the fold');
    assert.ok(!ids(hub).includes('last-land'), 'the same Objective folds on the first frame with all tickets resolved');

    hub.state.project.nav.cursor = rows.find((r) => r.item === 'project:fold:objectives:closed').item;
    const expanded = draw(press(hub, '\r').state);
    assert.deepEqual(ids(expanded).slice(-3), ['last-land', 'pi-worker', 'parked'], 'last landing folded immediately, newest in fold');
    assert.equal(expanded.state.project.nav.cursor, hub.state.project.nav.cursor);
    assert.deepEqual(ids(draw(press(expanded, '\r').state)), ids(hub));
    const ticketLinks = hub.controls.filter((c) => c.kind === 'project-page');
    assert.deepEqual(ticketLinks.map((c) => c.item), ['tickets', 'tree', 'docs']);
    for (const [i, [raw, page]] of [['t', 'tickets'], ['b', 'tree'], ['d', 'docs']].entries()) {
      const hot = rows.find((r) => r.objectiveTarget?.objective.id === 'hot');
      hub.state.project.nav.cursor = hot.item;
      const next = draw(press(hub, raw).state);
      assert.equal(next.state.project.view.kind, page);
      assert.match(plain(next)[0], /^‹ /);
      assert.doesNotMatch(plain(next).join('\n'), /Job edit|project:job:/);
      assert.equal(draw(esc(next)).state.project.nav.cursor, hot.item);
      const { x, y } = ticketLinks[i];
      assert.equal(act(hub, { type: 'mouse', button: 'left', x, y }).state.project.view.kind, page);
      if (page === 'docs') assert.deepEqual(press(next, 'o').action, { type: 'open-files', files: [data.statePath] });
    }
    assert.equal(press(hub, 'p').state.project.view.kind, 'hub');
    const noGit = draw(undefined, 35, { ...data, git: undefined });
    assert.ok(!noGit.controls.some((c) => c.kind === 'project-page' && c.item === 'tree'));
    assert.equal(press(noGit, 'b').state.project.view.kind, 'hub');
    const unlinked = draw(onPage(undefined, { project: { nav: { cursor: 'project:page:unlinked' } } }));
    const detail = draw(press(unlinked, '\r').state);
    assert.equal(detail.state.project.view.kind, 'unlinked');
    assert.deepEqual(detail.workboard.rows.flatMap((r) => r.files ?? []), ['/synthetic/spare/0.md', '/synthetic/other/1.md']);
  }
});

test('Home and Project open an Objective detail and route only its openable evidence', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const path = join(f.cwd, 'docs/notes.md'), report = join(f.sliceJob, 'report.md');
  f.put(path, '# Synthetic notes');
  f.put(objectivePath(f.cwd), sample.replace('123abcd',
    `123abcd, docs/missing.md, $HUD_HOME/jobs/j0000000000000002/report.md, ${report}`));
  const statePath = join(f.cwd, 'docs/handoff/STATE.md');
  const remaining = '## Waiting for the owner\n- [r2] Review alternative (objective hold)\n- [r3] Choose a chart (work waits)\n';
  f.put(statePath, remaining + '- [r1] Pick a method (objective measure) (work waits)\n');
  const data = await f.collector.collect(true, f.board, NOW);
  assert.equal(data.waiting.find(({ request }) => request === 'r1').objective, 'measure');
  assert.equal(data.objectives.objectives.find(({ id }) => id === 'measure').state, 'active');
  const homePortfolio = await new HomePortfolioCollector(f.hud).read([{ root: f.cwd, name: 'Study' }], f.board, NOW);
  const [openKey] = new WorkbenchInputDecoder('workboard').push(Buffer.from('o'));
  const key = (frame, input) => handleMonitorInput(frame.state, { type: 'key', key: input }, { frame });
  for (const activeTab of ['project', 'home']) {
    const draw = (state, lang = 'en') => f.render(120, lang, state, 24, data, true, 'unicode', 'none', { homePortfolio });
    const list = draw({ ...draw().state, activeTab });
    const entry = list.workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'measure');
    assert.equal(entry.objectiveTarget.blocked, true);
    assert.ok(!list.workboard.rows.some((r) => r.objectiveTarget?.objective.id === 'hold' && r.objectiveTarget.blocked));
    if (activeTab === 'home') {
      assert.ok(!list.workboard.rows.some((r) => r.item?.startsWith('home:result:')), 'undated results stay off Home');
      list.state.home.cursor = entry.item;
    } else {
      assert.match(entry.text, /Waiting on you/);
      assert.ok(!list.workboard.rows.some((r) => r.objectiveEvidence), 'the overview links to evidence through the Objective detail');
      list.state.project.nav.cursor = entry.item;
    }
    const { state, action } = key(list, 'enter');
    assert.equal(action, undefined);
    assert.equal(state.subpage.kind, 'objective');
    const { objective } = state.subpage.target;
    state.subpage.evidence = collectObjectiveEvidence(objective, state.subpage.target.root, f.hud);
    let detail = draw(state);
    for (const lang of ['en', 'zh']) {
      const frame = draw(state, lang);
      assert.ok(frame.lines.every((line) => visualLength(line) === 120));
      const text = plain(frame).join('\n');
      assert.match(plain(frame)[0], lang === 'en' ? /^‹ Study › measure\s+active · blocked$/ : /^‹ Study › measure\s+进行中 · 受阻$/);
      assert.match(text, lang === 'en' ? /Evidence ─+ 6[\s\S]*missing · docs\/missing\.md/ : /依据 ─+ 6[\s\S]*缺 · docs\/missing\.md/);
      assert.match(text, /› Repeat the sample\./);
      assert.match(text, /✓ Recorded a baseline\./);
      assert.match(text, /https:\/\/example\.org\/notes\n\s+· 123abcd/);
    }
    for (const expected of [undefined, undefined, { type: 'open-files', files: [path] }, undefined,
      { type: 'git-show', cwd: f.cwd, hash: '123abcd' }, undefined,
      { type: 'open-files', files: [report] }, { type: 'open-files', files: [report] }]) {
      assert.deepEqual(handleMonitorInput(detail.state, openKey, { frame: detail }).action, expected);
      detail = draw(key(detail, 'down').state);
    }
    const back = key(detail, 'escape').state;
    assert.equal(back.subpage, undefined);
    assert.equal(back.activeTab, activeTab);
    assert.equal((activeTab === 'home' ? back.home : back.project.nav).cursor, entry.item);
  }
  f.put(statePath, remaining);
  const refreshed = await f.collector.collect(true, f.board, NOW);
  const fresh = f.render(120, 'en', undefined, 24, refreshed);
  assert.equal(fresh.workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'measure').objectiveTarget.blocked, false);
});

test('Objective page: crumb, prose with result age, features in every activity state, Enter/Esc with scroll, and Inspector link at 40/62 EN/ZH', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-objective-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root, { progressTickets: false });
  const at = (min) => NOW - min * 60_000, old = at(6 * 1440);
  const docFile = join(f.cwd, 'docs/ingest/runbook.md');
  f.put(docFile, '# Synthetic runbook\n');
  const feature = (slug, states) => ({
    slug,
    at: old,
    tickets: states.map((state, i) => ({
      number: String(i + 1).padStart(2, '0'),
      title: `Synthetic ticket ${slug}/${i + 1}`,
      path: `/synthetic/${slug}/${String(i + 1).padStart(2, '0')}.md`,
      state,
      at: old,
      checked: state === 'done' ? 1 : 0,
      total: 1,
      blockers: [],
      status: state,
      items: [],
    })),
  });
  const linkedFeatures = [
    feature('retry-queue', ['done', 'done', 'working', 'ready', 'ready', 'ready']),
    feature('land-fast', ['done', 'done', 'ready']),
    feature('land-older', ['done', 'done', 'ready']),
    feature('unlanded-q', ['done', 'ready', 'ready']),
    feature('fail-q', ['ready', 'ready']),
    feature('try-ui', ['done', 'try', 'ready']),
    feature('gate-q', ['done', 'working']),
    feature('quiet-docs', ['done', 'done']),
  ];
  const longTitle = 'Keep nightly batch imports running end to end without manual restarts across every synthetic shard, checkpoint boundary, retry backoff window, dead-letter queue and recovery path in this test fixture';
  const mainObjective = {
    id: 'ingest',
    state: 'active',
    title: longTitle,
    next: 'Run a full synthetic batch after retry-queue lands.',
    result: 'Checkpoint reader resumes mid-batch without re-reading earlier segments.',
    features: [...linkedFeatures.map((x) => x.slug), 'missing-feat'],
    evidence: ['docs/ingest/runbook.md', '4f2c9a1', 'https://example.org/ingest', 'docs/absent.md'],
  };
  const padFeatures = Array.from({ length: 6 }, (_, i) => feature(`pad-${i + 1}`, ['working']));
  const padObjectives = Array.from({ length: 8 }, (_, i) => ({
    id: `pad-${i + 1}`,
    state: 'active',
    title: `Padding objective ${i + 1} for scroll preservation`,
    features: i < 6 ? [`pad-${i + 1}`] : [],
    evidence: [],
  }));
  const allTickets = [...padFeatures, ...linkedFeatures];
  const data = {
    ...f.data,
    updatedAt: at(3),
    objectivesAt: old,
    ledger: [],
    tickets: allTickets,
    objectiveTickets: allTickets,
    objectives: {
      path: objectivePath(f.cwd),
      stance: 'active',
      priority: 'high',
      objectives: [...padObjectives, mainObjective],
      diagnostics: [],
      resultDates: { ingest: at(5 * 60) },
      acceptance: {},
    },
    waiting: [
      { label: '', objective: 'ingest', request: 'r1', value: 'Confirm retry cap', sentence: 'Confirm retry cap', at: at(180), waitedOn: true },
    ],
  };
  const projectActivity = [
    ...Array.from({ length: 6 }, (_, i) => ({ ticket: `pad-${i + 1}/01`, kind: 'live', jobId: `job-pad-${i + 1}`, at: at(1 + i) })),
    { ticket: 'retry-queue/03', kind: 'live', jobId: 'job-live-1', at: at(14) },
    { ticket: 'land-fast/02', kind: 'ended', result: 'landed', at: at(25) },
    { ticket: 'land-older/01', kind: 'ended', result: 'landed', at: at(5 * 60) },
    { ticket: 'unlanded-q/02', kind: 'ended', result: 'not landed', at: at(40) },
    { ticket: 'fail-q/01', kind: 'ended', result: 'failed', at: at(20) },
    { ticket: 'gate-q/02', kind: 'gate', flow: 'f-gate-1', at: at(2) },
  ];
  const otherRoot = '/synthetic/other-project';
  const choices = [
    { root: f.cwd, name: 'orchard' },
    { root: otherRoot, name: 'tide-lab' },
  ];
  const homePortfolio = {
    projects: [
      ...Array.from({ length: 2 }, (_, i) => ({
        root: `/synthetic/pad-proj-${i}`,
        name: `pad-proj-${i}`,
        registrationIndex: i,
        activeToday: true,
        snapshot: {
          ...f.data,
          waiting: [],
          active: [],
          tickets: [],
          ledger: [],
          objectives: {
            path: `/synthetic/pad-proj-${i}/.hud/objectives.md`,
            stance: 'active',
            priority: 'normal',
            objectives: [{ id: `goal-${i}`, state: 'active', title: `Goal ${i}`, features: [], evidence: [] }],
            diagnostics: [],
            acceptance: {},
          },
        },
      })),
      { root: f.cwd, name: 'orchard', registrationIndex: 2, activeToday: true, snapshot: data, resultDates: new Map([['ingest', at(5 * 60)]]) },
    ],
    requests: [
      { project: { root: f.cwd, name: 'orchard', registrationIndex: 2 }, item: data.waiting[0], index: 0 },
      { project: { root: otherRoot, name: 'tide-lab', registrationIndex: 9 }, item: { label: '', objective: 'other', request: 'r9', value: 'Other project request', sentence: 'Other project request', at: at(60), waitedOn: true }, index: 0 },
    ],
  };
  const openSchedule = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i + 1}`,
    date: `2026-11-${13 + i}`,
    text: `Synthetic schedule item ${i + 1}`,
    project: f.cwd,
    created_at: '2026-11-12T00:00:00Z',
  }));
  const decoder = new WorkbenchInputDecoder('workboard');
  const sendKey = (frame, raw) => {
    const [input] = decoder.push(Buffer.from(raw));
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };
  const key = (frame, k) => handleMonitorInput(frame.state, { type: 'key', key: k }, { frame, nowMs: NOW });

  for (const lang of ['en', 'zh']) for (const width of [40, 62]) {
    const zh = lang === 'zh';
    const draw = (state, height = 34, extra = {}) => f.render(width, lang, state, height, data, true, 'unicode', 'none', {
      projectDisplayRoot: f.cwd,
      projectName: 'orchard',
      projects: choices,
      projectActivity,
      homePortfolio,
      ...extra,
    });

    // 1. Open from Project overview with non-zero scroll; check layout, every feature state, evidence, [ ] off, and Esc return.
    const objItem = `project:objective:${f.cwd}:ingest`;
    const scrolledHub = draw(onPage(undefined, { project: { nav: { cursor: objItem, scroll: 3, revealed: objItem } } }), 12);
    assert.equal(scrolledHub.state.project.nav.scroll, 3);
    const openedFromProject = key(scrolledHub, 'enter');
    assert.equal(openedFromProject.state.subpage?.kind, 'objective');
    openedFromProject.state.subpage.evidence = collectObjectiveEvidence(mainObjective, f.cwd, f.hud);
    const objFrame = draw(openedFromProject.state, 34);
    assert.ok([...objFrame.lines, ...objFrame.workboard.rows.map((r) => r.text)]
      .every((line) => visualLength(line) === width && !line.includes('\x1b')));
    const lines = plain(objFrame);
    const body = lines.join('\n');

    // Crumb replaces tabs and strip; right side shows state and done/total tickets (9/22 across the 8 scanned features, missing-feat omits ratio).
    assert.match(lines[0], zh ? /^‹ orchard › ingest\s+进行中 · 受阻$/ : /^‹ orchard › ingest\s+active · blocked$/);
    // Request row stays pinned on top without project name; other project's request stays absent.
    assert.match(lines[1], /^\? ingest\b/);
    assert.doesNotMatch(lines[1], /orchard/);
    assert.doesNotMatch(body, /Other project request|tide-lab/);
    // `[ ]` project switch is off on the Objective page.
    assert.equal(sendKey(objFrame, ']').state.selectedProject, undefined);
    assert.equal(sendKey(objFrame, '[').state.selectedProject, undefined);

    // Title <= 3 rows (clamped with ellipsis), Next with ›, Result with ✓ and age.
    const nextIdx = objFrame.workboard.rows.findIndex((r) => r.text.includes('›'));
    assert.ok(nextIdx >= 1 && nextIdx <= 3, `title clamped to <= 3 rows (got ${nextIdx})`);
    assert.match(body, /…/);
    assert.match(body, /› Run a full synthetic batch/);
    assert.match(body, zh ? /✓ Checkpoint reader[\s\S]*5时/ : /✓ Checkpoint reader[\s\S]*5h/);

    // Features section: one row per linked feature, bars <= 24, every activity state, NO nested job rows.
    assert.match(body, zh ? /^功能 ─+ 完成\/工单$/m : /^Features ─+ done\/tickets$/m);
    assert.match(body, zh ? /retry-queue.*2\/6\s+● 1 在跑/ : /retry-queue.*2\/6\s+● 1 live/);
    assert.match(body, zh ? /land-fast.*2\/3\s+✓ 刚落地 02/ : /land-fast.*2\/3\s+✓ Just landed 02/);
    assert.match(body, zh ? /land-older.*2\/3\s+✓ 5时前落地/ : /land-older.*2\/3\s+✓ landed 5h ago/);
    assert.match(body, zh ? /unlanded-q.*1\/3\s+◒ 1 未落地/ : /unlanded-q.*1\/3\s+◒ 1 unlanded/);
    assert.match(body, zh ? /fail-q.*0\/2\s+✗ 1 失败/ : /fail-q.*0\/2\s+✗ 1 failed/);
    assert.match(body, zh ? /try-ui.*1\/3\s+◇ 1 待试用/ : /try-ui.*1\/3\s+◇ 1 to try/);
    assert.match(body, zh ? /gate-q.*1\/2\s+● 1 门禁/ : /gate-q.*1\/2\s+● 1 at gate/);
    assert.match(body, /quiet-docs.*2\/2\s*$/m);
    assert.match(body, /missing-fe.*—/);
    assert.doesNotMatch(body, /◉|Synthetic ticket/);
    for (const row of objFrame.workboard.rows.filter((r) => r.item?.startsWith('objective:feature:'))) {
      const bars = row.text.match(/[█▒░╌]+/g) ?? [];
      assert.ok(bars.every((seg) => visualLength(seg) <= 24), `bar <= 24: ${row.text}`);
    }

    // Evidence section: every entry shown.
    assert.match(body, zh ? /^依据 ─+ 4$/m : /^Evidence ─+ 4$/m);
    assert.match(body, /docs\/ingest\/runbook\.md/);
    assert.match(body, /4f2c9a1/);
    assert.match(body, /https:\/\/example\.org\/ingest/);
    assert.match(body, zh ? /缺 · docs\/absent\.md/ : /missing · docs\/absent\.md/);

    // Enter on retry-queue opens its Feature page (o opens its first unfinished ticket 03.md); on quiet-docs opens its Feature page (o opens 02.md); on missing-feat is a no-op.
    assert.equal(objFrame.state.subpage.cursor, 'objective:feature:retry-queue');
    assert.equal(key(objFrame, 'enter').state.subpage?.kind, 'feature');
    assert.equal(key(objFrame, 'enter').state.subpage?.target?.slug, 'retry-queue');
    assert.deepEqual(sendKey(objFrame, 'o').action, { type: 'open-files', files: ['/synthetic/retry-queue/03.md'] });
    const quietSelected = draw({ ...objFrame.state, subpage: { ...objFrame.state.subpage, cursor: 'objective:feature:quiet-docs' } }, 34);
    assert.equal(key(quietSelected, 'enter').state.subpage?.kind, 'feature');
    assert.equal(key(quietSelected, 'enter').state.subpage?.target?.slug, 'quiet-docs');
    assert.deepEqual(sendKey(quietSelected, 'o').action, { type: 'open-files', files: ['/synthetic/quiet-docs/02.md'] });
    const missingSelected = draw({ ...objFrame.state, subpage: { ...objFrame.state.subpage, cursor: 'objective:feature:missing-feat' } }, 34);
    assert.equal(key(missingSelected, 'enter').action, undefined);
    assert.equal(key(missingSelected, 'enter').state.subpage?.kind, 'objective');

    // Enter on file and commit evidence opens them.
    const fileEv = draw({ ...objFrame.state, subpage: { ...objFrame.state.subpage, cursor: 'objective:evidence:0' } }, 34);
    assert.deepEqual(key(fileEv, 'enter').action, { type: 'open-files', files: [docFile] });
    const commitEv = draw({ ...objFrame.state, subpage: { ...objFrame.state.subpage, cursor: 'objective:evidence:1' } }, 34);
    assert.deepEqual(key(commitEv, 'enter').action, { type: 'git-show', cwd: f.cwd, hash: '4f2c9a1' });

    // Esc returns to the exact Project overview row AND scroll.
    const returnedProject = draw(key(objFrame, 'escape').state, 12);
    assert.equal(returnedProject.state.subpage, undefined);
    assert.equal(returnedProject.state.project.nav.cursor, objItem);
    assert.equal(returnedProject.state.project.nav.scroll, 3);

    // Crumb with all linked features present shows state + done/total tickets (11/24 tickets at 62, 11/24 at 40).
    const allScannedObj = { ...mainObjective, features: linkedFeatures.map((x) => x.slug) };
    const allScannedData = { ...data, waiting: [], objectives: { ...data.objectives, objectives: [allScannedObj] } };
    const allScannedFrame = f.render(width, lang, {
      ...openedFromProject.state,
      subpage: { kind: 'objective', scroll: 0, target: { root: f.cwd, objective: allScannedObj, blocked: false } },
    }, 24, allScannedData, true, 'unicode', 'none', {
      projectDisplayRoot: f.cwd, projectName: 'orchard', projects: choices, projectActivity,
    });
    assert.match(
      plain(allScannedFrame)[0],
      width === 62
        ? (zh ? /^‹ orchard › ingest\s+进行中 · 11\/24 工单$/ : /^‹ orchard › ingest\s+active · 11\/24 tickets$/)
        : (zh ? /^‹ orchard › ingest\s+进行中 · 11\/24$/ : /^‹ orchard › ingest\s+active · 11\/24$/),
    );
    if (width === 62) {
      const blockedWithRatio = f.render(width, lang, {
        ...openedFromProject.state,
        subpage: { kind: 'objective', scroll: 0, target: { root: f.cwd, objective: allScannedObj, blocked: true } },
      }, 24, { ...allScannedData, waiting: data.waiting }, true, 'unicode', 'none', {
        projectDisplayRoot: f.cwd, projectName: 'orchard', projects: choices, projectActivity,
      });
      assert.match(
        plain(blockedWithRatio)[0],
        zh ? /^‹ orchard › ingest\s+进行中 · 受阻 · 11\/24 工单$/ : /^‹ orchard › ingest\s+active · blocked · 11\/24 tickets$/,
      );
    }
  }

  // 2. Open from Home goal row AND Home result row; Esc returns to the exact row and scroll.
  for (const kind of ['objective', 'result']) {
    const homeItem = `home:${kind}:${f.cwd}:ingest`;
    const homeState = {
      ...onPage(),
      activeTab: 'home',
      home: { cursor: homeItem, scroll: 0, revealed: homeItem },
    };
    const homeFrame = f.render(62, 'en', homeState, 16, data, true, 'unicode', 'none', {
      projectDisplayRoot: f.cwd, projectName: 'orchard', projects: choices, homePortfolio, openSchedule,
    });
    assert.ok(homeFrame.workboard.rows.some((r) => r.item === homeItem), `${homeItem} present on Home`);
    const opened = key(homeFrame, 'enter');
    assert.equal(opened.state.subpage?.kind, 'objective');
    assert.equal(opened.state.subpage.target.objective.id, 'ingest');
    const objFrame = f.render(62, 'en', opened.state, 34, data, true, 'unicode', 'none', {
      projectDisplayRoot: f.cwd, projectName: 'orchard', projects: choices, projectActivity, homePortfolio,
    });
    assert.match(plain(objFrame)[0], /^‹ orchard › ingest\s+active · blocked$/);
    assert.match(plain(objFrame).join('\n'), /✓ Checkpoint reader[\s\S]*5h/);
    const back = f.render(62, 'en', key(objFrame, 'escape').state, 16, data, true, 'unicode', 'none', {
      projectDisplayRoot: f.cwd, projectName: 'orchard', projects: choices, homePortfolio, openSchedule,
    });
    assert.equal(back.state.subpage, undefined);
    assert.equal(back.state.activeTab, 'home');
    assert.equal(back.state.home.cursor, homeItem);
    assert.equal(back.state.home.scroll, homeFrame.state.home.scroll);
  }

  // 3. Inspector's Objective fact row is selectable and Enter opens the Objective page; Esc returns to Inspector at the same row and scroll.
  const baseWorker = f.board.workers[0];
  const workerWithObj = {
    ...baseWorker,
    projectRoot: f.cwd,
    objective: { id: 'ingest', title: mainObjective.title },
  };
  const boardWithObj = {
    ...f.board,
    lanes: f.board.lanes.map((l) => l.id === baseWorker.laneId ? { ...l, workers: l.workers.map((w) => w.id === baseWorker.id ? workerWithObj : w) } : l),
    workers: f.board.workers.map((w) => w.id === baseWorker.id ? workerWithObj : w),
  };
  const inspectorState = {
    ...onPage(),
    activeTab: 'execution',
    subpage: {
      kind: 'inspector',
      target: { kind: 'worker', laneId: baseWorker.laneId, workerId: baseWorker.id },
      from: 'execution',
      cursor: 'inspector:objective',
      scroll: 3,
      revealed: 'inspector:objective',
    },
  };
  for (const width of [40, 62, 100]) {
    const drawInspect = (state) => f.render(width, 'en', state, 14, data, true, 'unicode', 'none', {
      workboard: boardWithObj,
      projectDisplayRoot: f.cwd,
      projectName: 'orchard',
      projects: choices,
      projectActivity,
    });
    const inspFrame = drawInspect(inspectorState);
    assert.ok(inspFrame.lines.every((line) => visualLength(line) === width && !line.includes('\x1b')));
    const objFact = inspFrame.workboard.rows.find((r) => r.item === 'inspector:objective');
    assert.ok(objFact?.objectiveTarget, 'Inspector Objective row is selectable with objectiveTarget');
    assert.equal(objFact.objectiveTarget.objective.id, 'ingest');
    assert.equal(objFact.objectiveTarget.objective.features.length, mainObjective.features.length);

    // Tab in Inspector reaches inspector:objective (even when starting with cursor undefined).
    const tabStart = drawInspect({ ...inspectorState, subpage: { ...inspectorState.subpage, cursor: undefined, revealed: undefined, scroll: 0 } });
    const tabbed = key(tabStart, 'tab');
    assert.equal(tabbed.state.subpage.cursor, 'inspector:objective');

    // Pressing Enter on Inspector's Objective row opens the Objective page.
    const openedObj = key(inspFrame, 'enter');
    assert.equal(openedObj.state.subpage?.kind, 'objective');
    assert.equal(openedObj.state.subpage.back?.kind, 'inspector');
    const objFrame = drawInspect(openedObj.state);
    assert.match(plain(objFrame)[0], /^‹ orchard › ingest\b/);
    assert.match(plain(objFrame).join('\n'), /retry-queue/);

    // Esc returns to Inspector at inspector:objective with the exact same scroll; second Esc returns to Execution.
    const backToInsp = drawInspect(key(objFrame, 'escape').state);
    assert.equal(backToInsp.state.subpage?.kind, 'inspector');
    assert.equal(backToInsp.state.subpage.cursor, 'inspector:objective');
    assert.equal(backToInsp.state.subpage.scroll, 3);
    assert.equal(backToInsp.state.subpage.from, 'execution');
    const backToExec = key(backToInsp, 'escape').state;
    assert.equal(backToExec.subpage, undefined);
    assert.equal(backToExec.activeTab, 'execution');
  }

  // 4. Inspector Objective whose current record is missing shows id/title and unavailable note (not active or empty Features/Evidence), in EN and ZH.
  const workerMissingObj = {
    ...baseWorker,
    projectRoot: f.cwd,
    objective: { id: 'retired-goal', title: 'Retired synthetic objective from receipt' },
  };
  const boardMissingObj = {
    ...f.board,
    lanes: f.board.lanes.map((l) => l.id === baseWorker.laneId ? { ...l, workers: l.workers.map((w) => w.id === baseWorker.id ? workerMissingObj : w) } : l),
    workers: f.board.workers.map((w) => w.id === baseWorker.id ? workerMissingObj : w),
  };
  for (const lang of ['en', 'zh']) for (const width of [40, 62]) {
    const drawMissing = (state, themeName = 'none') => f.render(width, lang, state, 14, data, true, 'unicode', themeName, {
      workboard: boardMissingObj,
      projectDisplayRoot: f.cwd,
      projectName: 'orchard',
      projects: choices,
      projectActivity,
    });
    const inspMissing = drawMissing(inspectorState);
    const fact = inspMissing.workboard.rows.find((r) => r.item === 'inspector:objective');
    assert.equal(fact?.objectiveTarget?.unavailable, true);
    assert.equal(fact?.objectiveTarget?.objective.id, 'retired-goal');
    assert.equal(fact?.objectiveTarget?.objective.title, 'Retired synthetic objective from receipt');
    assert.equal('state' in fact.objectiveTarget.objective, false);

    const openedMissing = key(inspMissing, 'enter');
    assert.equal(openedMissing.state.subpage?.kind, 'objective');
    const missingFrame = drawMissing(openedMissing.state);
    assert.ok(missingFrame.lines.every((line) => visualLength(line) === width && !line.includes('\x1b')));
    const lines = plain(missingFrame);
    const text = lines.join('\n');
    assert.match(lines[0], /^‹ orchard › retired-goal\s*$/);
    assert.match(text, /Retired synthetic objective/);
    assert.match(text, lang === 'zh' ? /当前目标记录不可用/ : /Current record unavailable/);
    assert.doesNotMatch(text, lang === 'zh' ? /进行中|功能 ─|依据 ─/ : /\bactive\b|Features ─|Evidence ─/);
  }
});
