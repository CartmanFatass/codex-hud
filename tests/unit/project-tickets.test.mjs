import { withState, sliceState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ticketFixture, ticketFrames, ticketVocabulary } from '../fixtures/project-tickets.mjs';
import { plain, onPage, NOW, TREE } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { projectShown } from '../../dist/collectors/project-board.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { openEditorPane } from '../../dist/cli/panel-pane.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/ticket-frames.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-tickets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await ticketFixture(root) };
}
const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW, standalone: true });
const tickets = (data, slug = 'native-tree') => data.tickets.find((f) => f.slug === slug).tickets;
const featurePage = (...folds) => onPage('tickets', { project: { folded: new Set(['feature:native-tree', ...folds]) } });
function observe(t) {
  const originals = Object.fromEntries(['readSync', 'lstatSync', 'opendirSync', 'openSync'].map((k) => [k, fs[k]]));
  const calls = { readSync: [], lstatSync: [], opendirSync: [], openSync: [] };
  for (const key of Object.keys(calls)) fs[key] = (...args) => { calls[key].push(args); return originals[key](...args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, originals); syncBuiltinESMExports(); });
  return calls;
}
test('local to-tickets derives done by status/boxes, ready, number/title blockers, unknown words; malformed skipped', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.data.tickets.map((x) => x.slug), ['native-tree', 'retired-tools']);
  assert.deepEqual(tickets(f.data).map((r) => [r.number, r.state, r.checked, r.total, r.blockers]), [
    ['02', 'working', 1, 4, []], ['03', 'ready', 0, 3, []], ['04', 'queued', 0, 2, ['02', '03']],
    ['05', 'queued', 0, 1, ['03']], ['06', 'ready', 0, 0, []],
    ...ticketVocabulary.map(([number, , state, boxes]) => [number, state, boxes.filter((x) => x === 'x').length, boxes.length, []]),
  ]);
  assert.equal(tickets(f.data)[4].status, 'triaging');
  assert.deepEqual(tickets(f.data, 'retired-tools').map((r) => [r.state, r.checked, r.total]), [['done', 0, 2], ['done', 2, 2]]);
  assert.equal(tickets(f.data)[0].job.role, 'imp');
  assert.equal(tickets(f.data)[0].job.state, 'working');
  assert.equal(tickets(f.data)[0].job.at, NOW - 12 * 60000);
  assert.ok(tickets(f.data).slice(1).every((r) => !r.job));
  for (const status of ['cLoSeD', 'COMPLETE']) {
    f.issue('retired-tools', '01', 'collector', 'Claude collector', status, 'None', [' '], 30);
    const data = await f.collector.collect(true, f.board, NOW + 2);
    assert.equal(tickets(data, 'retired-tools')[0].state, 'done');
  }
});
test('fields on one shared line and a status with a note still parse (the supervisor and role-bind tickets)', async (t) => {
  const f = await fixture(t), dir = join(f.cwd, '.scratch', 'inline', 'issues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, '01-shared.md'), '# 01: Shared line\n\n**Who:** imp · **Size:** small · **Blocked by:** none · **Status:** resolved\n\n- [ ] box\n');
  fs.writeFileSync(join(dir, '02-note.md'), '# 02: Note after status\n\n**Blocked by:** 01 (landed)\n\n**Status:** resolved (follow-up in phase 2)\n\n- [ ] box\n');
  fs.writeFileSync(join(dir, '03-open.md'), '# 03: Open on a shared line\n\n**Who:** imp · **Blocked by:** 02 · **Status:** ready-for-agent\n');
  fs.writeFileSync(join(dir, '04-dropped.md'), '# 04: Dropped with a note\n\n**Who:** imp · **Blocked by:** 03 · **Status:** wontfix (superseded by 08)\n');
  const data = await f.collector.collect(true, f.board, NOW + 5);
  assert.deepEqual(tickets(data, 'inline').map((r) => [r.number, r.state, r.status]), [
    ['01', 'done', 'resolved'], ['02', 'done', 'resolved (follow-up in phase 2)'],
    ['03', 'ready', 'ready-for-agent'], ['04', 'dropped', 'wontfix (superseded by 08)'],
  ]);
});
test('local tracker vocabulary renders every state word in EN and ZH', async (t) => {
  const f = await fixture(t);
  const frames = {
    en: f.render(120, 'en', featurePage('agents'), f.data, 'mocha'),
    zh: f.render(120, 'zh', featurePage('agents'), f.data, 'mocha'),
  };
  for (const [number, word, expectedState] of ticketVocabulary) {
    const ticket = tickets(f.data).find((r) => r.number === number);
    assert.equal(ticket.state, expectedState, word);
    assert.equal(ticket.job, undefined, 'file vocabulary works without a linked job');
    assert.deepEqual(ticket.blockers, [], 'resolved and wontfix dependencies do not block');
    for (const lang of ['en', 'zh']) {
      // The Done lane is folded by default; its rows are open here.
      const frame = frames[lang];
      const row = frame.workboard.rows.find((r) => r.files?.[0] === ticket.path), text = stripAnsi(row.text);
      // A ticket that waits on a person is a `?` in For you, whatever else holds it; the rest keep their state's mark.
      const asks = ['needs-triage', 'needs-info', 'ready-for-human'].includes(word);
      const glyph = asks ? '?' : expectedState === 'done' ? '✓' : expectedState === 'dropped' ? '–' : expectedState === 'working' ? '◐' : '●';
      assert.ok(text.includes(`${glyph} nt ${number} Vocabulary ${word}`), text);
      const status = asks ? word : expectedState === 'working' ? (lang === 'en' ? 'working' : '工作中')
        : expectedState === 'dropped' ? (lang === 'en' ? 'dropped' : '已放弃') : undefined;
      if (status) assert.match(row.text, new RegExp(`\\x1b\\[[0-9;]+m${status}\\x1b\\[0m`));
      if (word === 'wontfix') assert.match(row.text, /\x1b\[[0-9;]+m08 Vocabulary wontfix\x1b\[0m/);
      assert.match(plain(frame).join('\n'), /native-tree +2\/12/, 'dropped work is resolved in feature ratios');
    }
  }
});
test('Project ticket frames are cell-exact at 40/80/120 EN/ZH; unknown words dim and no empty section', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(ticketFrames(f), expected);
  for (const width of [32, 56, 80, 120]) for (const lang of ['en', 'zh']) {
    const frame = f.render(width, lang, featurePage()), hub = f.render(width, lang), text = plain(frame).join('\n');
    for (const line of [...frame.lines, ...hub.lines]) assert.equal(visualLength(line), width, stripAnsi(line));
    assert.match(plain(hub).join('\n'), lang === 'en' ? /Tickets +3\/13 done/ : /工单 +3\/13 完成/);
    if (width >= 80) {
      assert.match(text, lang === 'en' ? /2 features/ : /2 个功能/);
      assert.match(text, lang === 'en' ? /imp 12m/ : /imp 12分/);
      assert.match(text, lang === 'en' ? /▸ Queued ─+ 2/ : /▸ 待前序 ─+ 2/);
      assert.doesNotMatch(text, /04 Settings cleanup/);
      assert.match(text, /triaging/);
      assert.match(text, lang === 'en' ? /^Done ─+ 2$/m : /^已完成 ─+ 2$/m);
      assert.match(text, /retired-tools +2\/2/);
      assert.doesNotMatch(text, /Claude collector|Legacy cleanup|Not a ticket/);
      const entries = plain(hub).join('\n'), at = (word) => entries.indexOf(word);
      const [tickets, progress, tree, docs] = (lang === 'en' ? ['Tickets', 'Progress', 'Worktree', 'Docs'] : ['工单', '进度', '工作区', '文档']).map(at);
      assert.ok(tickets >= 0 && tickets < progress && progress < tree && tree < docs, 'Details lists Tickets, Progress, Worktree, Docs');
      assert.equal(at(lang === 'en' ? 'Control plane' : '控制面'), -1);
    }
  }
  const coloured = f.render(120, 'en', featurePage(), f.data, 'mocha');
  const row = coloured.workboard.rows.find((r) => stripAnsi(r.text).includes('triaging'));
  assert.match(row.text, /\x1b\[[0-9;]+mtriaging\x1b\[0m/);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  const data = await f.collector.collect(true, f.board, NOW + 3);
  assert.deepEqual(data.tickets, []);
  assert.doesNotMatch(plain(f.render(80, 'en', undefined, data)).join('\n'), /Tickets|native-tree|retired-tools/, 'no Tickets entry on the hub');
  assert.match(plain(f.render(80, 'en', 'tickets', data)).join('\n'), /Project › Tickets\n\n  none/);
});
test('open features list tickets by state and keep queued tickets folded', async (t) => {
  const f = await fixture(t), state = featurePage();
  let frame = f.render(120, 'en', state);
  assert.deepEqual(state.project.folded, new Set(['feature:native-tree']));
  const lines = plain(frame), at = (re) => lines.findIndex((l) => re.test(l));
  const order = [/^For you ─+ 3$/, /^Working ─+ 2$/, /^Ready ─+ 3$/, /^▸ Queued ─+ 2$/, /^Done ─+ 2$/].map(at);
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])));
  assert.match(lines.join('\n'), /native-tree +2\/12/);
  // For you holds what waits on a person, ahead of anything its blockers say; a blocked ticket names its blockers.
  const lane = (name) => lines.slice(at(new RegExp(`^${name} ─`)) + 1).slice(0, 6).filter((l) => /^ {2}\S/.test(l)).join('\n');
  assert.match(lane('For you'), /\? nt 10 Vocabulary needs-triage +needs-triage +0\/1/);
  assert.match(lane('For you'), /\? nt 12 Vocabulary ready-for-human +ready-for-human +0\/1/);
  assert.match(lane('Working'), /◐ nt 02 Home lanes +imp 12m +1\/4/);
  assert.doesNotMatch(lines.join('\n'), /05 Shortcuts/);
  frame.state.project.nav.cursor = 'project:fold:lane:queued:native-tree';
  frame = f.render(120, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /· nt 05 Shortcuts +← 03 ● +0\/1/);
  assert.doesNotMatch(lines.join('\n'), /Claude collector/);
  frame = f.render(120, 'en', press(frame, 'open-session').state);
  assert.doesNotMatch(plain(frame).join('\n'), /05 Shortcuts/);
});
test('unknown blockers stay Stalled while known cross-feature waits use the folded Queued lane', async (t) => {
  const f = await fixture(t);
  f.issue('native-tree', '14', 'needs-upstream', 'Missing upstream', 'ready-for-agent', 'unknown/01');
  f.issue('native-tree', '15', 'wait-upstream', 'Known upstream', 'ready-for-agent', 'upstream/01');
  f.issue('upstream', '01', 'waiting', 'Upstream needs input', 'needs-info');
  const data = await f.collector.collect(true, f.board, NOW + 2);
  for (const lang of ['en', 'zh']) {
    const frame = f.render(80, lang, featurePage(), data), lines = plain(frame).join('\n');
    assert.match(lines, lang === 'en' ? /^▸ Queued ─+ 3$/m : /^▸ 待前序 ─+ 3$/m);
    assert.match(lines, lang === 'en' ? /^Stalled ─+ 1$/m : /^受阻 ─+ 1$/m);
    assert.match(lines, /◆ nt 14 Missing upstream +← unknown\/01/);
    assert.doesNotMatch(lines, /05 Shortcuts|15 Known upstream/);
    frame.state.project.nav.cursor = 'project:fold:lane:queued:native-tree';
    const expanded = f.render(80, lang, press(frame, 'enter').state, data);
    assert.match(plain(expanded).join('\n'), /· nt 15 Known upstream +← upstream\/01/);
  }
});
test('Enter on a ticket shows its checklist and latest comment in the panel, a second Enter folds it; raw o opens the file in a fake herdr tab', async (t) => {
  const f = await fixture(t), log = join(f.root, 'open.jsonl'), bin = join(f.root, 'bin');
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OPEN_LOG, JSON.stringify(args) + '\\n');
const operation = args.slice(0, 2).join(' ');
console.log(JSON.stringify({result: operation === 'pane get' ? {pane: {workspace_id: 'w4E'}} : {root_pane: {pane_id: 'w4E:p3'}}}));
`, { mode: 0o700 });
  const decoder = new WorkbenchInputDecoder('workboard'), input = (raw) => decoder.push(Buffer.from(raw))[0];
  const send = (frame, raw) => handleMonitorInput(frame.state, input(raw), { tree: TREE, frame, nowMs: NOW, standalone: true });
  const ticketRow = (frame) => frame.workboard.rows.find((r) => r.files?.[0] === f.paths.working);
  let frame = f.render(80, 'en', featurePage());
  assert.doesNotMatch(plain(frame).join('\n'), /Criterion|first criterion landed/, 'a ticket starts closed');
  frame.state.project.nav.cursor = ticketRow(frame).item;
  const before = plain(frame);
  const opened = send(frame, '\r');
  assert.equal(opened.action, undefined, 'Enter shows the ticket here; it does not open an editor');
  frame = f.render(80, 'en', opened.state);
  const text = plain(frame).join('\n');
  assert.match(text, /02 Home lanes.*1\/4\n +✓ Criterion 1\n +○ Criterion 2\n +○ Criterion 3\n +○ Criterion 4\n +comment +The first criterion landed; the others wait for a synthetic/);
  assert.match(text, /decision that has not come yet\./, 'the latest comment, not the first');
  assert.doesNotMatch(text, /An earlier note/);
  assert.equal(frame.state.project.nav.cursor, ticketRow(frame).item, 'the cursor stays on the ticket');
  // Every row of the open ticket belongs to it: a click on its checklist folds it again, as the next Enter does.
  assert.ok(frame.workboard.rows.filter((r) => r.item === frame.state.project.nav.cursor).length >= 7);
  frame = f.render(80, 'en', send(frame, '\r').state);
  assert.deepEqual(plain(frame), before);
  // o opens the exact file, closed or open, through the existing action and the herdr tab.
  for (const shown of [frame, f.render(80, 'en', opened.state)]) {
    const result = send(shown, 'o');
    assert.deepEqual(result.action, { type: 'open-files', files: [f.paths.working] });
    await openEditorPane(result.action.files, { ...f.env, PATH: `${bin}:${dirname(process.execPath)}`, HERDR_PANE_ID: 'w4E:p2', OPEN_LOG: log });
  }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.slice(0, 3), [
    ['pane', 'get', 'w4E:p2'],
    ['tab', 'create', '--workspace', 'w4E', '--cwd', process.cwd(), '--label', '02-home-lanes.md', '--focus'],
    ['pane', 'run', 'w4E:p3', `vim '${f.paths.working}'; exit`],
  ]);
  assert.deepEqual(calls.slice(3), calls.slice(0, 3));
  // A ticket with no checklist says so; a long title keeps its row and the status moves under it at 40 columns.
  const bare = f.render(40, 'en', featurePage('lane:queued:native-tree', 'ticket:native-tree:06-polish.md'));
  assert.match(plain(bare).join('\n'), /● nt 06 Polish +triaging +0\/0\n +no checklist/);
  assert.match(plain(bare).join('\n'), /· nt 04 Settings cleanup +← 02, 03 +0\/2\n/, 'the blockers share the row at 40 columns');
});
test('Home collects no tickets; warm signatures read/parse nothing, changes unblock and reorder without cached overlays', async (t) => {
  const f = await fixture(t), calls = observe(t);
  assert.equal(await f.collector.collect(projectShown(sliceState()), f.board, NOW + 2), undefined);
  assert.ok(Object.values(calls).every((c) => c.length === 0));
  const warm = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(calls.readSync.length, 0);
  assert.equal(calls.opendirSync.length, 0);
  assert.equal(tickets(warm)[0].job.role, 'imp');
  f.issue('native-tree', '02', 'home-lanes', 'Home lanes', 'done');
  f.issue('native-tree', '03', 'inspector', 'Inspector', 'done');
  let data = await f.collector.collect(true, f.board, NOW + 3);
  assert.equal(tickets(data).find((r) => r.number === '04').state, 'ready');
  assert.equal(tickets(data).find((r) => r.number === '05').state, 'ready');
  f.issue('native-tree', '03', 'inspector', 'Inspector');
  f.issue('retired-tools', '01', 'collector', 'Claude collector', 'done', 'None', [], 0);
  data = await f.collector.collect(true, f.board, NOW + 4);
  assert.equal(tickets(data).find((r) => r.number === '04').state, 'queued');
  assert.equal(tickets(data).find((r) => r.number === '05').state, 'queued');
  assert.equal(data.tickets[0].slug, 'retired-tools');
  f.put(join(f.ticketJob, 'job.json'), { cwd: f.cwd, role: 'imp', package: 'other-feature', created_at: new Date(NOW).toISOString() });
  data = await f.collector.collect(true, f.board, NOW + 4);
  assert.equal(tickets(data)[0].job, undefined, 'a removed match cannot persist in cached ticket data');
});
test('job matching uses package plus filename or bounded number in task/brief path, never an unrelated number', async (t) => {
  const f = await fixture(t), jobPath = join(f.ticketJob, 'job.json'), brief = join(f.ticketJob, 'brief.md');
  f.put(brief, '# Unrelated task 102 and 020');
  const job = { cwd: f.cwd, role: 'imp', package: 'native-tree', created_at: new Date(NOW).toISOString() };
  f.put(jobPath, job);
  let data = await f.collector.collect(true, f.board, NOW + 2);
  assert.ok(tickets(data).every((r) => !r.job));
  for (const extra of [{ task: 'Implement ticket 02' }, { brief_path: '.scratch/native-tree/issues/02-home-lanes.md' }]) {
    f.put(jobPath, { ...job, ...extra });
    data = await f.collector.collect(true, f.board, NOW + 3);
    assert.equal(tickets(data)[0].job.role, 'imp');
    assert.ok(tickets(data).slice(1).every((r) => !r.job));
  }
  f.put(jobPath, { ...job, package: 'native-tree-extra', task: 'Implement ticket 02' });
  data = await f.collector.collect(true, f.board, NOW + 4);
  assert.ok(tickets(data).every((r) => !r.job));
});
test('ticket reads cap at 64 KiB and discovery at 512 files, last-changed features first; oversized/malformed files skip', async (t) => {
  const f = await fixture(t);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  for (let feature = 0; feature < 17; feature++) for (let n = 1; n <= 65; n++)
    f.issue(`feature-${String(feature).padStart(2, '0')}`, String(n).padStart(2, '0'), 'ticket', `Synthetic ${n}`);
  // The feature changed longest ago drops out, not the one last by name.
  for (let feature = 0; feature < 17; feature++) {
    const at = new Date(NOW - (feature === 5 ? 86400000 : feature * 1000));
    fs.utimesSync(join(f.cwd, `.scratch/feature-${String(feature).padStart(2, '0')}/issues`), at, at);
  }
  const oversized = join(f.cwd, '.scratch/feature-00/issues/01-ticket.md');
  fs.appendFileSync(oversized, 'x'.repeat(65536));
  const calls = observe(t), data = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(data.tickets.length, 8);
  assert.ok(data.tickets.some((f) => f.slug === 'feature-08') && !data.tickets.some((f) => f.slug === 'feature-05'));
  assert.ok(data.tickets.every((f) => f.tickets.length <= 64));
  assert.equal(data.tickets.find((f) => f.slug === 'feature-00').tickets.length, 63);
  assert.equal(data.ticketTotals.partial, true);
  const opened = calls.openSync.map((args) => String(args[0])).filter((p) => p.includes('/.scratch/'));
  assert.equal(opened.length, 512);
  assert.ok(opened.every((p) => !p.includes('/feature-05/') && !p.endsWith('/65-ticket.md')));
  assert.ok(calls.readSync.every((args) => args[3] <= 65536));
});
test('the 64-feature scan marks partial meters without opening omitted tickets', async (t) => {
  const f = await fixture(t), scratch = join(f.cwd, '.scratch');
  fs.rmSync(scratch, { recursive: true });
  const slug = (n) => `feature-${String(n).padStart(2, '0')}`;
  for (let n = 0; n < 81; n++) {
    f.issue(slug(n), '01', 'ticket', `Synthetic ${n}`, n % 2 ? 'ready-for-agent' : 'resolved');
    const at = new Date(NOW - n * 1000);
    fs.utimesSync(join(scratch, slug(n), 'issues'), at, at);
  }
  const calls = observe(t), data = await f.collector.collect(true, f.board, NOW + 2);
  assert.deepEqual(data.ticketTotals, { doneTickets: 32, totalTickets: 64, doneFeatures: 32, totalFeatures: 64, partial: true });
  const opened = calls.openSync.map(([path]) => String(path)).filter((path) => path.startsWith(scratch));
  assert.equal(opened.length, 64);
  assert.ok(opened.every((path) => Number(path.match(/feature-(\d+)/)[1]) < 64));
  for (const [lang, word] of [['en', 'Partial'], ['zh', '不完整']]) {
    for (const panelLayout of ['classic']) for (const page of [undefined, 'tickets']) {
      const frame = f.render(40, lang, onPage(page, { prefs: { panelLayout } }), data);
      const text = plain(frame).join('\n');
      if (page) assert.match(text, new RegExp(word));
      else {
        assert.doesNotMatch(text, /Partial|不完整/);
        assert.match(text, lang === 'en' ? /^Details ─+ 64 features sampled$/m : /^详情 ─+ 从 64 个功能抽样$/m);
      }
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    }
  }
  const home = await f.collector.collect('home', f.board, NOW + 3);
  for (let n = 64; n < 81; n++) fs.rmSync(join(scratch, slug(n)), { recursive: true });
  const complete = await f.collector.collect('home', f.board, NOW + 4);
  assert.equal(complete.ticketTotals.totalFeatures, 64);
  assert.equal(complete.ticketTotals.partial, undefined, 'an exact cap is not a partial scan');
});
test('features with open tickets always show; finished ones fill the rest of sixteen, newest first', async (t) => {
  const f = await fixture(t);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  const slug = (n) => `feature-${String(n).padStart(2, '0')}`;
  for (let n = 0; n < 20; n++) {
    f.issue(slug(n), '01', 'ticket', `Synthetic ${n}`, n < 2 ? 'ready-for-agent' : 'resolved');
    const file = join(f.cwd, `.scratch/${slug(n)}/issues/01-ticket.md`);
    // The two open features are the oldest; the finished ones are newer.
    const at = new Date(NOW - (n < 2 ? 86400000 + n : (20 - n) * 1000));
    fs.utimesSync(file, at, at);
    fs.utimesSync(join(f.cwd, `.scratch/${slug(n)}/issues`), at, at);
  }
  const data = await f.collector.collect(true, f.board, NOW + 2);
  const shown = data.tickets.map((x) => x.slug);
  assert.deepEqual(data.ticketTotals, { doneTickets: 18, totalTickets: 20, doneFeatures: 18, totalFeatures: 20 });
  assert.equal(shown.length, 16);
  assert.ok(shown.includes(slug(0)) && shown.includes(slug(1)), shown.join(' '));
  for (const n of [2, 3, 4, 5]) assert.ok(!shown.includes(slug(n)), `oldest finished ${slug(n)} drops out`);
});
test('tickets reuse only the newest 64 job directories, even when an older matching job exists', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 66; i++) {
    const dir = join(f.hud, 'jobs', `j${(256 + i).toString(16).padStart(16, '0')}`);
    f.put(join(dir, 'job.json'), { cwd: f.cwd, role: 'imp', package: i >= 64 ? 'native-tree' : 'other-feature', task: 'Implement ticket 02',
      created_at: new Date(NOW - i * 1000).toISOString() });
    f.put(join(dir, 'STATUS.json'), { state: 'working' });
    fs.utimesSync(dir, new Date(NOW - i * 1000), new Date(NOW - i * 1000));
  }
  for (const id of ['j0000000000000001', 'j0000000000000002', 'j0000000000000010'])
    fs.utimesSync(join(f.hud, 'jobs', id), new Date(NOW - 86400000), new Date(NOW - 86400000));
  const calls = observe(t), data = await f.collector.collect(true, { ...f.board, workers: [] }, NOW + 2);
  assert.ok(tickets(data).every((r) => !r.job));
  const opened = calls.openSync.map((a) => String(a[0])).filter((p) => p.includes('/jobs/'));
  assert.equal(new Set(opened.map((p) => p.match(/\/jobs\/(j[0-9a-f]+)\//)[1])).size, 64);
  assert.ok(opened.every((p) => /\/(job|STATUS)\.json$/.test(p)));
});
test('40-column Tickets frame (EN and ZH) cuts titles at whole words or CJK characters, falling back to cell cut only when the first word cannot fit', async (t) => {
  const f = await fixture(t), wide = /[\u2e80-\u9fff\uff00-\uffef]/;
  // Build tickets whose first word fits at 40 columns (English), Chinese titles, and a long first word that must fall back to cell cut.
  f.issue('native-tree', '20', 'words-triage', 'Panel layout needs triage soon', 'needs-triage');
  f.issue('native-tree', '21', 'words-human', 'Brief ready for human review', 'ready-for-human');
  f.issue('native-tree', '22', 'cjk-info', '工单标题中文截断验证需要更多信息', 'needs-info');
  f.issue('native-tree', '23', 'long-word', 'Supercalifragilisticexpialidocious', 'needs-info');
  const data = await f.collector.collect(true, f.board, NOW + 6);
  const byNumber = new Map(data.tickets.flatMap((feat) => feat.tickets).map((tk) => [tk.number, tk.title]));
  const checkCut = (line, num, title) => {
    const match = new RegExp(`\\b${num} ([^\\n]*?)…`).exec(line);
    if (!match) return;
    const prefix = match[1];
    assert.ok(prefix.length > 0, `non-empty title for ${num}: ${line}`);
    const first = title.split(' ')[0];
    // Whole word (next char in full title is a space) or CJK character before `…`, unless even the first word does not fit.
    const wholeWord = title.startsWith(prefix) && title[prefix.length] === ' ';
    const cjk = wide.test(prefix.at(-1) ?? '') || wide.test(title[prefix.length] ?? '');
    if (visualLength(first) < visualLength(prefix) + 1) assert.ok(wholeWord || cjk, `title cut inside a word for ${num}: ${line}`);
  };
  for (const lang of ['en', 'zh']) {
    for (const layout of ['classic']) {
      const state = withState(featurePage(), { prefs: { panelLayout: layout }, project: { nav: { cursor: 'project:fold:feature:native-tree' } } });
      const frame = f.render(40, lang, state, data);
      const lines = frame.workboard.rows.map(row => stripAnsi(row.text));
      for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
      for (const line of lines) {
        const num = /^  \S \S+ (\d+) /.exec(line)?.[1];
        if (num && byNumber.has(num)) checkCut(line, num, byNumber.get(num));
      }
      const joined = lines.join('\n');
      assert.match(joined, /\? nt 10 Vocabulary…  needs-triage  0\/1/);
      assert.match(joined, /\? nt 11 Vocabulary…    needs-info  0\/1/);
      assert.match(joined, /\? nt 12 Vocabula… ready-for-human  0\/1/, 'first word longer than 9-cell room falls back to cell cut');
      assert.match(joined, /\? nt 20 Panel…       needs-triage  0\/1/);
      assert.match(joined, /\? nt 21 Brief…    ready-for-human  0\/1/);
      assert.match(joined, /\? nt 22 工单标题中文…  needs-info  0\/1/);
      assert.match(joined, /\? nt 23 Supercalifrag… needs-info  0\/1/);
      if (lang === 'en') assert.match(joined, /◐ nt 09 Vocabulary…       working  0\/1/);
    }
  }
});
