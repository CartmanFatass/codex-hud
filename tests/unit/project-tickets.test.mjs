import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ticketFixture, ticketFrames, ticketVocabulary } from '../fixtures/project-tickets.mjs';
import { plain, onPage, NOW, TREE } from '../fixtures/project-page.mjs';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
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
    ['02', 'ready', 1, 4, []], ['03', 'ready', 0, 3, []], ['04', 'blocked', 0, 2, ['02', '03']],
    ['05', 'blocked', 0, 1, ['03']], ['06', 'ready', 0, 0, []],
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
for (const [number, word, expectedState] of ticketVocabulary) test(`local tracker vocabulary: ${word}`, async (t) => {
  const f = await fixture(t), ticket = tickets(f.data).find((r) => r.number === number);
  assert.equal(ticket.state, expectedState);
  assert.equal(ticket.job, undefined, 'file vocabulary works without a linked job');
  assert.deepEqual(ticket.blockers, [], 'resolved and wontfix dependencies do not block');
  for (const lang of ['en', 'zh']) {
    // The Done lane is folded by default; its rows are open here.
    const frame = f.render(120, lang, onPage('tickets', { projectFolded: new Set(['agents', 'lane:done']) }), f.data, 'mocha');
    const row = frame.workboard.rows.find((r) => r.files?.[0] === ticket.path), text = stripAnsi(row.text);
    // A ticket that waits on a person is a `?` in For you, whatever else holds it; the rest keep their state's mark.
    const asks = ['needs-triage', 'needs-info', 'ready-for-human'].includes(word);
    const glyph = asks ? '?' : expectedState === 'done' ? '✓' : expectedState === 'dropped' ? '–' : expectedState === 'working' ? '◐' : '●';
    assert.ok(text.includes(`${glyph} nt ${number} Vocabulary ${word}`), text);
    const status = asks ? word : expectedState === 'working' ? (lang === 'en' ? 'working' : '工作中')
      : expectedState === 'dropped' ? (lang === 'en' ? 'dropped' : '已放弃') : undefined;
    if (status) assert.match(row.text, new RegExp(`\\x1b\\[[0-9;]+m${status}\\x1b\\[0m`));
    if (word === 'wontfix') assert.match(row.text, /\x1b\[[0-9;]+m08 Vocabulary wontfix\x1b\[0m/);
    assert.match(plain(frame).join('\n'), /nt native-tree 1\/12/, 'wontfix is not counted as done even with all boxes checked');
  }
});
test('Project ticket frames are cell-exact at 40/80/120 EN/ZH; unknown words dim and no empty section', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(ticketFrames(f), expected);
  for (const width of [32, 56, 80, 120]) for (const lang of ['en', 'zh']) {
    const frame = f.render(width, lang, 'tickets'), hub = f.render(width, lang), text = plain(frame).join('\n');
    for (const line of [...frame.lines, ...hub.lines]) assert.equal(visualLength(line), width, stripAnsi(line));
    assert.match(plain(hub).join('\n'), lang === 'en' ? /Tickets +\d+\/14 done/ : /工单 +\d+\/14 完成/, 'the done count is the last fact to go');
    if (width >= 56) assert.match(plain(hub).join('\n'), lang === 'en' ? /Tickets +3\/14 done · 2 working · 2 blocked/ : /工单 +3\/14 完成 · 2 工作中 · 2 受阻/);
    if (width >= 80) {
      assert.match(text, lang === 'en' ? /2 features · 14 tickets/ : /2 个功能 · 14 个工单/);
      assert.match(text, lang === 'en' ? /imp 12m/ : /imp 12分钟/);
      assert.match(text, /◆ nt 04 Settings cleanup +← 02, 03/);
      assert.match(text, /triaging/);
      assert.match(text, lang === 'en' ? /^▸ Done ─+ 4$/m : /^▸ 已完成 ─+ 4$/m);
      assert.match(text, /rt retired-tools 2\/2/);
      assert.doesNotMatch(text, /Claude collector|Legacy cleanup|Not a ticket/);
      const entries = plain(hub).join('\n'), at = (word) => entries.indexOf(word);
      const [progress, tickets, tree, docs, control] = (lang === 'en' ? ['Progress', 'Tickets', 'Working tree', 'Docs', 'Control plane'] : ['进度', '工单', '工作区', '文档', '控制面']).map(at);
      assert.ok(progress >= 0 && progress < tickets && tickets < tree && tree < docs && docs < control, 'the hub lists Progress, Tickets, Working tree, Docs, Control plane');
    }
  }
  const coloured = f.render(120, 'en', 'tickets', f.data, 'mocha');
  const row = coloured.workboard.rows.find((r) => stripAnsi(r.text).includes('triaging'));
  assert.match(row.text, /\x1b\[[0-9;]+mtriaging\x1b\[0m/);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  const data = await f.collector.collect(true, f.board, NOW + 3);
  assert.deepEqual(data.tickets, []);
  assert.doesNotMatch(plain(f.render(80, 'en', undefined, data)).join('\n'), /Tickets|native-tree|retired-tools/, 'no Tickets entry on the hub');
  assert.match(plain(f.render(80, 'en', 'tickets', data)).join('\n'), /Project › Tickets\n\n  none/);
});
test('tickets are lanes by state: For you first, then Working, Ready, Blocked; Done starts folded and Enter/o toggle it without mutating state on render', async (t) => {
  const f = await fixture(t), state = { ...initialMonitorState(), mainTab: 'project', projectPage: 'tickets' };
  let frame = f.render(120, 'en', state);
  assert.equal(state.projectFolded, undefined);
  const lines = plain(frame), at = (re) => lines.findIndex((l) => re.test(l));
  // The lanes in order, each with its count; the meter counts the done tickets of every feature, the codes name the features.
  assert.ok(at(/^For you ─+ 3$/) < at(/^Working ─+ 2$/) && at(/^Working ─+ 2$/) < at(/^Ready ─+ 3$/) && at(/^Ready ─+ 3$/) < at(/^Blocked ─+ 2$/) && at(/^Blocked ─+ 2$/) < at(/^▸ Done ─+ 4$/));
  assert.match(lines.join('\n'), /^ {2}━{3}─{13} 3\/14$/m);
  assert.match(lines.join('\n'), /^ {2}nt native-tree 1\/12 {2}rt retired-tools 2\/2$/m);
  // For you holds what waits on a person, ahead of anything its blockers say; a blocked ticket names its blockers.
  const lane = (name) => lines.slice(at(new RegExp(`^${name} ─`)) + 1).slice(0, 6).filter((l) => /^ {2}\S/.test(l)).join('\n');
  assert.match(lane('For you'), /\? nt 10 Vocabulary needs-triage +needs-triage +0\/1/);
  assert.match(lane('For you'), /\? nt 12 Vocabulary ready-for-human +ready-for-human +0\/1/);
  assert.match(lane('Working'), /◐ nt 02 Home lanes +imp 12m +1\/4/);
  assert.match(lane('Blocked'), /◆ nt 05 Shortcuts +← 03 ● +0\/1/);
  assert.doesNotMatch(lines.join('\n'), /Claude collector/);
  frame.state.projectCursor = 'project:fold:lane:done';
  frame = f.render(120, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /^Done ─+ 4$/m);
  assert.match(plain(frame).join('\n'), /✓ rt 01 Claude collector +0\/2/);
  assert.match(plain(frame).join('\n'), /✓ rt 02 Legacy cleanup +2\/2/);
  frame = f.render(120, 'en', press(frame, 'open-session').state);
  assert.doesNotMatch(plain(frame).join('\n'), /Claude collector/);
  assert.match(plain(frame).join('\n'), /^▸ Done ─+ 4$/m);
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
  let frame = f.render(80, 'en', 'tickets');
  assert.doesNotMatch(plain(frame).join('\n'), /Criterion|first criterion landed/, 'a ticket starts closed');
  frame.state.projectCursor = ticketRow(frame).item;
  const before = plain(frame);
  const opened = send(frame, '\r');
  assert.equal(opened.action, undefined, 'Enter shows the ticket here; it does not open an editor');
  frame = f.render(80, 'en', opened.state);
  const text = plain(frame).join('\n');
  assert.match(text, /02 Home lanes.*1\/4\n +✓ Criterion 1\n +○ Criterion 2\n +○ Criterion 3\n +○ Criterion 4\n +comment +The first criterion landed; the others wait for a synthetic/);
  assert.match(text, /decision that has not come yet\./, 'the latest comment, not the first');
  assert.doesNotMatch(text, /An earlier note/);
  assert.equal(frame.state.projectCursor, ticketRow(frame).item, 'the cursor stays on the ticket');
  // Every row of the open ticket belongs to it: a click on its checklist folds it again, as the next Enter does.
  assert.ok(frame.workboard.rows.filter((r) => r.item === frame.state.projectCursor).length >= 7);
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
  const bare = f.render(40, 'en', onPage('tickets', { projectFolded: new Set(['agents', 'ticket:native-tree:06-polish.md']) }));
  assert.match(plain(bare).join('\n'), /● nt 06 Polish +triaging +0\/0\n +no checklist/);
  assert.match(plain(bare).join('\n'), /◆ nt 04 Settings cleanup +← 02, 03 +0\/2\n/, 'the blockers share the row at 40 columns');
  // One meter for every ticket: thin, as full as the done share (a started one never empty, an unfinished one never full).
  assert.match(plain(f.render(120, 'en', 'tickets')).join('\n'), /^ {2}━{3}─{13} 3\/14$/m);
  assert.match(plain(f.render(40, 'en', 'tickets')).join('\n'), /^ {2}━{3}─{13} 3\/14$/m, 'the same at 40 columns');
});
test('Home collects no tickets; warm signatures read/parse nothing, changes unblock and reorder without cached overlays', async (t) => {
  const f = await fixture(t), calls = observe(t);
  assert.equal(await f.collector.collect(projectShown(initialMonitorState()), f.board, NOW + 2), undefined);
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
  assert.equal(tickets(data).find((r) => r.number === '04').state, 'blocked');
  assert.equal(tickets(data).find((r) => r.number === '05').state, 'blocked');
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
test('ticket reads cap at 64 KiB and discovery at 16 features × 64 files; oversized/malformed files skip', async (t) => {
  const f = await fixture(t);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  for (let feature = 0; feature < 17; feature++) for (let n = 1; n <= 65; n++)
    f.issue(`feature-${String(feature).padStart(2, '0')}`, String(n).padStart(2, '0'), 'ticket', `Synthetic ${n}`);
  const oversized = join(f.cwd, '.scratch/feature-00/issues/01-ticket.md');
  fs.appendFileSync(oversized, 'x'.repeat(65536));
  const calls = observe(t), data = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(data.tickets.length, 16);
  assert.ok(data.tickets.every((f) => f.tickets.length <= 64));
  assert.equal(data.tickets.find((f) => f.slug === 'feature-00').tickets.length, 63);
  const opened = calls.openSync.map((args) => String(args[0])).filter((p) => p.includes('/.scratch/'));
  assert.equal(opened.length, 16 * 64);
  assert.ok(opened.every((p) => !p.includes('/feature-16/') && !p.endsWith('/65-ticket.md')));
  assert.ok(calls.readSync.every((args) => args[3] <= 65536));
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
