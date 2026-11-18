/** What the owner tries is never cut (spec §2.2, PANEL-REDESIGN 04): a to-try slice and a waiting item wrap whole at 40 columns in Classic and
 *  Split; with the model on a slice's brief and acceptance steps sit above its text, with it off nothing is asked and the text stands alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { plain } from '../fixtures/project-page.mjs';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { SmallModel } from '../../dist/collectors/small-model.js';
import { TryBriefs } from '../../dist/collectors/try-brief.js';
import { visualLength } from '../../dist/render/colors.js';

const LONG = 'the watcher now survives a link loop and keeps every open job on its row, even when a session file points back at its own folder, ENDOFLEDGER';
const WAIT = 'Try 2026-11-17 batch: Home counts what waits for you, the hub wraps waiting items, Skills moved into Help and the tabs are two, '
  + 'and what a try finds goes into Next first, ENDOFWAITING';
const BRIEF = { brief: 'Job rows no longer vanish when a session file loops back.', steps: ['Open the panel on a project with open jobs.', 'Make a session file point at its own folder.', 'The job row stays.'] };
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'try-brief-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await splitFixture(root);
  const data = { ...f.rich, waiting: [{ label: '', value: WAIT, path: f.rich.statePath }],
    // DATA-ONE is in the current milestone, so Classic's to-try view opens it and Split's Progress lists it; NO-HASH joins it for the give-way test.
    ledger: f.rich.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, text: `${LONG} (d0e1f2a3)` } : r.id === 'NO-HASH' ? { ...r, milestone: '0.1.3', text: LONG.replace('ENDOFLEDGER', 'ENDOFOTHER') } : r)) };
  return { f, data, root };
}
const progress = (extra) => ({ ...initialMonitorState(), mainTab: 'project', projectPage: 'progress', projectFolded: new Set(['agents', 'healthy', 'files']), ...extra });
const text = (frame) => plain(frame).join('\n');
/** The words wrapped across rows, read back as one line. */
const flat = (frame) => text(frame).replace(/\s+/g, ' ');
const whole = (frame, word) => assert.ok(flat(frame).includes(word) && !/…/.test(text(frame).split('\n').filter((l) => /watcher|link loop|folder|every open job/.test(l)).join('')), `${word} must be there, uncut`);
const fits = (frame) => frame.lines.forEach((l) => assert.equal(visualLength(l), 40));

test('Classic at 40 columns: a long to-try slice and a long waiting item wrap whole instead of being cut', async (t) => {
  const { f, data } = await fixture(t);
  const tryView = f.render(40, 'en', 40, progress({ projectTry: { scroll: 0 } }), data);
  fits(tryView);
  whole(tryView, 'ENDOFLEDGER');
  assert.ok(text(tryView).split('\n').filter((l) => /watcher|loop|folder|every open|ENDOFLEDGER/.test(l)).length >= 3, 'the text is on several rows under the id');
  const hub = f.render(40, 'en', 40, { ...initialMonitorState(), mainTab: 'project', projectFolded: new Set(['agents', 'healthy', 'files']) }, data);
  fits(hub);
  assert.ok(flat(hub).includes('ENDOFWAITING'), 'the hub flows the waiting item whole into its spare rows');
});

test('Classic short of room: the row the cursor is on keeps its whole text, the others keep two rows', async (t) => {
  const { f, data } = await fixture(t);
  const rows = (cursor, height) => f.render(40, 'en', height, progress({ projectTry: { scroll: 0 }, projectCursor: cursor }), data).panes[0].rows.map((r) => r.text).join('\n').replace(/\s+/g, ' ');
  const tall = rows('project:fold:hist:DATA-ONE', 60);
  assert.ok(tall.includes('ENDOFLEDGER') && tall.includes('ENDOFOTHER'), 'with the rows, every slice is whole');
  const short = rows('project:fold:hist:DATA-ONE', 16);
  assert.ok(short.includes('ENDOFLEDGER'), 'the cursor slice stays whole');
  assert.ok(!short.includes('ENDOFOTHER') && short.includes('…'), 'the other long slice gave way to two rows');
});

test('Split at 40 columns: the hub and Progress preview wrap a long to-try slice and a long waiting item whole', async (t) => {
  const { f, data } = await fixture(t);
  const hub = f.render(40, 'en', 60, split({ mainTab: 'project' }), data);
  fits(hub);
  whole(hub, 'ENDOFLEDGER');
  const waiting = f.render(40, 'en', 60, split({ mainTab: 'project', projectCursor: 'project:fold:waiting' }), data);
  fits(waiting);
  assert.ok(flat(waiting).includes('ENDOFWAITING'));
  const page = f.render(40, 'en', 60, split({ ...progress(), projectCursor: 'project:slice:DATA-ONE' }), data);
  fits(page);
  whole(page, 'ENDOFLEDGER');
});

test('a stored brief and steps show above the text: in Split’s preview of the slice and in Classic’s expanded row, not in a folded one', async (t) => {
  const { f, data } = await fixture(t);
  const briefed = { ...data, ledger: data.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, brief: BRIEF } : r)) };
  const above = (frame) => {
    const s = flat(frame), at = (w) => s.indexOf(w);
    assert.ok(at('Job rows no longer vanish') >= 0 && at('1. Open the panel') > at('Job rows no longer vanish') && at('3. The job row stays.') > at('2. Make a session'), 'the brief, then the numbered steps');
    assert.ok(at('the watcher now survives') > at('3. The job row stays.'), 'the original text comes after them');
  };
  const preview = f.render(40, 'en', 60, split({ ...progress(), projectCursor: 'project:slice:DATA-ONE' }), briefed);
  fits(preview);
  above(preview);
  const open = f.render(40, 'en', 60, progress({ projectTry: { scroll: 0 }, projectFolded: new Set(['agents', 'healthy', 'files', 'hist:DATA-ONE']) }), briefed);
  fits(open);
  above(open);
  const folded = f.render(40, 'en', 60, progress({ projectTry: { scroll: 0 } }), briefed);
  assert.ok(!flat(folded).includes('Job rows no longer vanish'), 'a row that is not expanded shows the text only');
  const plainRows = f.render(40, 'en', 60, split({ ...progress(), projectCursor: 'project:slice:DATA-ONE' }), data);
  assert.ok(!flat(plainRows).includes('1. '), 'a pending or failed call leaves the original text alone');
});

/** A real repository with one commit and a ticket, so the collector has something to read; the model is a fake that counts its calls. */
function service(t, mode) {
  const root = fs.mkdtempSync(join(tmpdir(), 'try-brief-svc-')), calls = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  git('init', '-q');
  fs.mkdirSync(join(root, '.scratch/demo/issues'), { recursive: true });
  fs.writeFileSync(join(root, '.scratch/demo/issues/01-thing.md'), '# 01\nTICKETWORD: the thing is built\n');
  fs.writeFileSync(join(root, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'synthetic subject', '-m', 'SYNTHBODY line');
  const hash = git('rev-parse', 'HEAD').trim();
  const env = { HUD_HOME: root, MISTRAL_API_KEY: 'synthetic-key' };
  const model = new SmallModel({ env, fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(BRIEF) } }] }), { status: 200 });
  } });
  model.configure({ backend: mode === 'off' ? 'off' : 'api' });
  const briefs = new TryBriefs(model, join(root, 'display/model-cache/try-briefs.json'), () => {}, () => clock.now);
  const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
  briefs.configure(mode !== 'off', 'en');
  const row = (text) => ({ id: 'DATA-ONE', state: 'try', milestone: 'M4', text });
  const snapshot = (...rows) => ({ ledger: rows });
  return { root, calls, model, briefs, clock, hash, row, snapshot };
}
const until = async (ok, ms = 4000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); };

test('model on: one call per to-try slice from its ledger line, commit and ticket; an unchanged slice costs no second call; a changed line shows its text alone until the new brief', async (t) => {
  const s = service(t, 'on'), line = `${LONG} (${s.hash}; .scratch/demo/)`;
  s.briefs.update(s.root, [s.row(line), { ...s.row('x'), id: 'DONE', state: 'accepted' }]);
  await until(() => s.briefs.apply(s.root, s.snapshot(s.row(line))).ledger[0].brief);
  assert.equal(s.calls.length, 1, 'one call; an accepted slice asks for none');
  const sent = JSON.stringify(s.calls[0]);
  for (const word of ['ENDOFLEDGER', 'synthetic subject', 'SYNTHBODY', 'TICKETWORD']) assert.ok(sent.includes(word), `${word} reaches the model`);
  assert.deepEqual(s.briefs.apply(s.root, s.snapshot(s.row(line))).ledger[0].brief, BRIEF);
  s.clock.now += 6 * 60_000;
  s.briefs.update(s.root, [s.row(line)]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.calls.length, 1, 'the same inputs are not asked twice');
  assert.equal(s.briefs.apply(s.root, s.snapshot(s.row(line + ' changed'))).ledger[0].brief, undefined, 'a brief written for another line is not shown');
  const again = new TryBriefs(s.model, join(s.root, 'display/model-cache/try-briefs.json'), () => {}, () => s.clock.now);
  again.configure(true, 'en');
  assert.deepEqual(again.apply(s.root, s.snapshot(s.row(line))).ledger[0].brief, BRIEF, 'the cache survives a restart');
});

test('model off: no call, and the snapshot is the very one it was given', async (t) => {
  const s = service(t, 'off'), snap = s.snapshot(s.row(LONG));
  s.briefs.update(s.root, snap.ledger);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.calls.length, 0);
  assert.equal(s.briefs.apply(s.root, snap), snap);
});
