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
      assert.match(text, lang === 'en' ? /Evidence[\s\S]*missing · docs\/missing\.md/ : /依据[\s\S]*缺 · docs\/missing\.md/);
      assert.match(text, lang === 'en' ? /State\s+active · blocked/ : /状态\s+进行中 · 受阻/);
      assert.match(text, /https:\/\/example\.org\/notes\n\s+123abcd/);
    }
    for (const expected of [{ type: 'open-files', files: [path] }, undefined,
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
