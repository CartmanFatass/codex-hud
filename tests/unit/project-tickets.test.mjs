import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ticketFixture, ticketFrames, ticketVocabulary } from '../fixtures/project-tickets.mjs';
import { plain, NOW, TREE } from '../fixtures/project-page.mjs';
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
for (const [number, word, expectedState] of ticketVocabulary) test(`local tracker vocabulary: ${word}`, async (t) => {
  const f = await fixture(t), ticket = tickets(f.data).find((r) => r.number === number);
  assert.equal(ticket.state, expectedState);
  assert.equal(ticket.job, undefined, 'file vocabulary works without a linked job');
  assert.deepEqual(ticket.blockers, [], 'resolved and wontfix dependencies do not block');
  for (const lang of ['en', 'zh']) {
    const frame = f.render(120, lang, undefined, f.data, 'mocha');
    const row = frame.workboard.rows.find((r) => r.files?.[0] === ticket.path), text = stripAnsi(row.text);
    const glyph = expectedState === 'done' ? '✓' : expectedState === 'dropped' ? '–' : expectedState === 'working' ? '◐' : '●';
    assert.ok(text.includes(`${glyph} ${number} Vocabulary ${word}`), text);
    const status = ['needs-triage', 'needs-info', 'ready-for-human'].includes(word) ? word
      : lang === 'en' ? expectedState : ({ done: '完成', dropped: '已放弃', working: '工作中', ready: '就绪' })[expectedState];
    assert.match(row.text, new RegExp(`\\x1b\\[[0-9;]+m${status}\\x1b\\[0m`));
    if (word === 'wontfix') assert.match(row.text, /\x1b\[[0-9;]+m08 Vocabulary wontfix\x1b\[0m/);
    const feature = frame.workboard.rows.find((r) => r.item === 'project:fold:tickets:native-tree');
    assert.match(stripAnsi(feature.text), /1\/12/, 'wontfix is not counted as done even with all boxes checked');
  }
});
test('Project ticket frames are cell-exact at 80/120 EN/ZH; unknown words dim and no empty section', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(ticketFrames(f), expected);
  for (const width of [32, 56, 80, 120]) for (const lang of ['en', 'zh']) {
    const frame = f.render(width, lang), text = plain(frame).join('\n');
    for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
    if (width >= 80) {
      assert.match(text, lang === 'en' ? /2 features · 14 tickets/ : /2 个功能 · 14 个工单/);
      assert.match(text, lang === 'en' ? /imp working 12m/ : /imp 工作中 12分钟/);
      assert.match(text, lang === 'en' ? /blocked by 02, 03/ : /受阻于 02, 03/);
      assert.match(text, /triaging/);
      assert.match(text, /▸ retired-tools.*2\/2/);
      assert.doesNotMatch(text, /Claude collector|Legacy cleanup|Not a ticket/);
      assert.ok(text.indexOf(lang === 'en' ? 'Progress' : '进度') < text.indexOf(lang === 'en' ? 'Tickets' : '工单'));
      assert.ok(text.indexOf(lang === 'en' ? 'Tickets' : '工单') < text.indexOf(lang === 'en' ? 'Working tree' : '工作区'));
    }
  }
  const coloured = f.render(120, 'en', undefined, f.data, 'mocha');
  const row = coloured.workboard.rows.find((r) => stripAnsi(r.text).includes('triaging'));
  assert.match(row.text, /\x1b\[[0-9;]+mready · triaging\x1b\[0m/);
  fs.rmSync(join(f.cwd, '.scratch'), { recursive: true });
  const data = await f.collector.collect(true, f.board, NOW + 3);
  assert.deepEqual(data.tickets, []);
  assert.doesNotMatch(plain(f.render(80, 'en', undefined, data)).join('\n'), /Tickets|native-tree|retired-tools/);
});
test('completed feature starts folded; Enter/o toggle it using existing Project input without mutating state on render', async (t) => {
  const f = await fixture(t), state = { ...initialMonitorState(), mainTab: 'project' };
  let frame = f.render(120, 'en', state);
  assert.equal(state.projectFolded, undefined);
  frame.state.projectCursor = 'project:fold:tickets:retired-tools';
  frame = f.render(120, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /✓ 01 Claude collector.*done.*0\/2/);
  assert.match(plain(frame).join('\n'), /✓ 02 Legacy cleanup.*done.*2\/2/);
  frame = f.render(120, 'en', press(frame, 'open-session').state);
  assert.doesNotMatch(plain(frame).join('\n'), /Claude collector/);
  frame.state.projectCursor = 'project:fold:tickets:native-tree';
  frame = f.render(120, 'en', press(frame, 'enter').state);
  assert.doesNotMatch(plain(frame).join('\n'), /Home lanes/);
  frame.state.projectCursor = 'project:fold:tickets';
  frame = f.render(120, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /▸ Tickets/);
  assert.doesNotMatch(plain(frame).join('\n'), /retired-tools/);
});
test('Enter and raw o open the exact ticket file via the existing action and a fake herdr tab', async (t) => {
  const f = await fixture(t), log = join(f.root, 'open.jsonl'), bin = join(f.root, 'bin');
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OPEN_LOG, JSON.stringify(args) + '\\n');
const operation = args.slice(0, 2).join(' ');
console.log(JSON.stringify({result: operation === 'pane get' ? {pane: {workspace_id: 'w4E'}} : {root_pane: {pane_id: 'w4E:p3'}}}));
`, { mode: 0o700 });
  const frame = f.render(120), decoder = new WorkbenchInputDecoder('workboard');
  frame.state.projectCursor = frame.workboard.rows.find((r) => r.files?.[0] === f.paths.working).item;
  for (const raw of ['\r', 'o']) {
    const input = decoder.push(Buffer.from(raw))[0];
    const result = handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW, standalone: true });
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
