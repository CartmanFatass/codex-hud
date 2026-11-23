import { splitOf, withState, sliceState } from '../fixtures/state-helpers.mjs';
/** What the owner tries is never cut (spec §2.2, PANEL-REDESIGN 04): a to-try slice and a waiting item wrap whole at 40 columns in Classic and
 *  Split; with the model on a slice's brief and acceptance steps sit above its text, with it off nothing is asked and the text stands alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { SmallModel } from '../../dist/collectors/small-model.js';
import { parseBrief, TryBriefs } from '../../dist/collectors/try-brief.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';

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
const asSplit = (state) => withState(state, { prefs: { panelLayout: 'split' } });
const progress = (extra) => (withState(sliceState(), { activeTab: 'project', project: { folded: new Set(['agents', 'healthy', 'files']), view: { kind: 'progress' } } }, extra));
const text = (frame) => plain(frame).join('\n');
/** The words wrapped across rows, read back as one line. */
const flat = (frame) => text(frame).replace(/\s+/g, ' ');
const whole = (frame, word) => assert.ok(flat(frame).includes(word) && !/…/.test(text(frame).split('\n').filter((l) => /watcher|link loop|folder|every open job/.test(l)).join('')), `${word} must be there, uncut`);
const fits = (frame) => frame.lines.forEach((l) => assert.equal(visualLength(l), 40));

test('Classic at 40 columns: a long to-try slice and a long waiting item wrap whole instead of being cut', async (t) => {
  const { f, data } = await fixture(t);
  const tryView = f.render(40, 'en', 40, progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), data);
  fits(tryView);
  whole(tryView, 'ENDOFLEDGER');
  assert.ok(text(tryView).split('\n').filter((l) => /watcher|loop|folder|every open|ENDOFLEDGER/.test(l)).length >= 3, 'the text is on several rows under the id');
  const hub = f.render(40, 'en', 40, withState(sliceState(), { activeTab: 'project', project: { nav: { cursor: 'project:wait:0' } } }), data);
  fits(hub);
  assert.ok(flat(hub).includes('ENDOFWAITING'), 'the selected waiting item in Classic shows its whole text');
});

test('Classic short of room: the row the cursor is on keeps its whole text, the others keep two rows', async (t) => {
  const { f, data } = await fixture(t);
  const rows = (cursor, height) => f.render(40, 'en', height, progress({ project: { nav: { cursor }, view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), data).panes[0].rows.map((r) => r.text).join('\n').replace(/\s+/g, ' ');
  const tall = rows('project:fold:hist:DATA-ONE', 60);
  assert.ok(tall.includes('ENDOFLEDGER') && tall.includes('ENDOFOTHER'), 'with the rows, every slice is whole');
  const short = rows('project:fold:hist:DATA-ONE', 16);
  assert.ok(short.includes('ENDOFLEDGER'), 'the cursor slice stays whole');
  assert.ok(!short.includes('ENDOFOTHER') && short.includes('…'), 'the other long slice gave way to two rows');
});

test('Split at 40 columns: the hub and Progress preview wrap a long to-try slice and a long waiting item whole', async (t) => {
  const { f, data } = await fixture(t);
  const hub = f.render(40, 'en', 60, split({ activeTab: 'project', project: { nav: { cursor: 'project:page:progress' } } }), data);
  fits(hub);
  whole(hub, 'ENDOFLEDGER');
  const waiting = f.render(40, 'en', 60, split({ activeTab: 'project', project: { nav: { cursor: 'project:wait:0' } } }), data);
  fits(waiting);
  assert.ok(flat(waiting).includes('ENDOFWAITING'));
  const page = f.render(40, 'en', 60, asSplit(withState(progress(), { project: { nav: { cursor: 'project:slice:DATA-ONE' } } })), data);
  fits(page);
  // The Progress list row is cut at a word (UX-PASS D2); the preview below it keeps the whole text.
  assert.ok(flat(page).includes('ENDOFLEDGER'), 'the preview keeps the whole slice text');
});

const TWO = { brief: 'Job rows no longer vanish when a session file loops back. Nothing else changes.', steps: BRIEF.steps };
const TWO_ZH = { brief: '会话文件回环时，任务行不再消失。其余保持不变。', steps: ['打开面板。', '任务行仍在。'] };
const briefed = (data, brief) => ({ ...data, ledger: data.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, brief } : r)) });
const FOLDED = ['agents', 'healthy', 'files'];

test('a to-try row with a brief: its id and age on one row, the first sentence beside them when it fits whole, else under them in full; the rest of the brief is for the preview', async (t) => {
  const { f, data } = await fixture(t), withBrief = briefed(data, TWO), zh = briefed(data, TWO_ZH);
  const SENTENCE = 'Job rows no longer vanish when a session file loops back.';
  // The id row, then the rows under it up to the next row that starts at the margin (the next slice).
  const under = (lines) => { const at = lines.findIndex((l) => /^\s*[◇✓] DATA-ONE/.test(l)); return { id: lines[at], text: lines.slice(at + 1).slice(0, 3).filter((l) => /^ {2,}[^\s◇◆◐○✓▸]/.test(l)).map((l) => l.trim()).join(' ') }; };
  for (const [view, state] of [['Classic to-try view', progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } })], ['Classic Progress', progress()], ['Split Progress list', asSplit(withState(progress(), { project: { nav: { cursor: 'project:slice:DATA-ONE' } } }))]]) {
    const frame = f.render(40, 'en', 60, state, withBrief);
    fits(frame);
    const lines = view.startsWith('Split') ? frame.panes.find((p) => p.id === 'agents').rows.map((r) => stripAnsi(r.text).trimEnd()) : plain(frame);
    assert.equal(lines.filter((l) => /^\s*[◇✓] DATA-ONE/.test(l)).length, 1, `${view}: the slice has one id row`);
    const own = under(lines);
    assert.doesNotMatch(own.id, /Job rows/, `${view}: the id row keeps its room`);
    assert.equal(own.text, SENTENCE, `${view}: the whole first sentence under the id, nothing cut`);
    assert.doesNotMatch(lines.join(' '), /Nothing else changes|ENDOFLEDGER/, `${view}: neither the second sentence nor the ledger text on a list row`);
  }
  // Wide enough, the sentence is whole beside the id, and still only the first.
  const wide = plain(f.render(100, 'en', 60, progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), withBrief)).filter((l) => /DATA-ONE/.test(l));
  assert.match(wide[0], /DATA-ONE {2}Job rows no longer vanish when a session file loops back\.(?! Nothing)/);
  // A long id does not take the sentence's room: it goes under the id, whole.
  const long = { ...withBrief, ledger: withBrief.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, id: 'SUPERVISOR-MCP-LONG-ID' } : r)) };
  const longRows = plain(f.render(40, 'en', 60, progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), long)), at = longRows.findIndex((l) => /SUPERVISOR-MCP-LONG-ID/.test(l));
  assert.ok(at >= 0 && !/Job rows/.test(longRows[at]) && /^ {2,}Job rows no longer vanish/.test(longRows[at + 1]), 'the sentence is under the long id');
  // Chinese ends a sentence with 。 and wraps no word; the rows still fit 40 columns.
  const frame = f.render(40, 'zh', 60, progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), zh);
  fits(frame);
  assert.ok(under(plain(frame)).text.startsWith('会话文件回环时，任务行不再消失。'), 'the sentence under the id');
  assert.doesNotMatch(flat(frame), /其余保持不变/);
});

test('without a brief (model off, pending or failed) a to-try row keeps the whole original text, wrapped, none of it broken inside a word or a path', async (t) => {
  const { f, data } = await fixture(t);
  const path = '.scratch/panel-ux/issues/01-owner-text-counts-keys.md';
  const long = { ...data, ledger: data.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, text: `ticket ${path} and an overlong-hyphenated-compound-name-that-has-no-spaces-at-all-ENDOFPATH (d0e1f2a3)` } : r)) };
  for (const state of [progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), split({ activeTab: 'project', project: { nav: { cursor: 'project:page:progress' } } })]) {
    const frame = f.render(40, 'en', 60, state, long);
    fits(frame);
    const lines = plain(frame).map((l) => l.trimEnd());
    // Every word of the text sits whole on one row: a break falls at a space, or after a `/`, `-`, `_` or `.`, never inside a word.
    const at = lines.findIndex((l) => /ticket \.scratch/.test(l));
    assert.ok(at >= 0);
    const run = lines.slice(at, at + 8);
    for (const word of ('ticket ' + path + ' and an overlong-hyphenated-compound-name-that-has-no-spaces-at-all-ENDOFPATH').match(/[A-Za-z0-9]{3,}/g)) assert.ok(run.some((l) => l.includes(word)), `${word} is split across rows:\n${run.join('\n')}`);
    assert.ok(run.join('').replace(/\s+/g, '').includes(path + 'andan'), 'the path reads on, in order');
    assert.ok(!/…/.test(run.join('')), 'nothing is cut');
  }
});

test('the preview of a briefed slice: whole brief, numbered steps, then the original ledger text folded (Enter unfolds it); expanded Classic rows say the same', async (t) => {
  const { f, data } = await fixture(t), withBrief = briefed(data, TWO);
  const order = (frame, open) => {
    const s = flat(frame), at = (w) => s.indexOf(w);
    assert.ok(at('Job rows no longer vanish when a session file loops back. Nothing else changes.') >= 0, 'the whole brief, not only its first sentence');
    assert.ok(at('How to try') > at('Nothing else changes') && at('1. Open the panel') > at('How to try') && at('3. The job row stays.') > at('2. Make a session'), 'then the numbered steps');
    assert.ok(at('Ledger line') > at('3. The job row stays.'), 'the fold row comes after the steps');
    assert.equal(at('ENDOFLEDGER') >= 0, open, open ? 'unfolded: the original text follows the fold row' : 'folded: the original text is not there');
    if (open) assert.ok(at('ENDOFLEDGER') > at('Ledger line'));
  };
  const cursor = { project: { nav: { cursor: 'project:slice:DATA-ONE' } } };
  const preview = f.render(40, 'en', 60, asSplit(withState(progress(), cursor)), withBrief);
  fits(preview);
  order(preview, false);
  assert.match(text(preview), /▸ Ledger line/);
  const unfolded = f.render(40, 'en', 60, asSplit(withState(progress(), cursor, { project: { folded: new Set([...FOLDED, 'ledger:DATA-ONE']) } })), withBrief);
  fits(unfolded);
  order(unfolded, true);
  assert.match(text(unfolded), /▾ Ledger line/);
  // Classic: the row that is not expanded shows the sentence only; expanded, the brief and steps with the original text folded; one more Enter unfolds it.
  const row = f.render(40, 'en', 60, progress({ project: { view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), withBrief);
  assert.doesNotMatch(flat(row), /How to try|Ledger line/);
  const open = f.render(40, 'en', 60, progress({ project: { folded: new Set([...FOLDED, 'hist:DATA-ONE']), view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), withBrief);
  fits(open);
  order(open, false);
  const both = f.render(40, 'en', 60, progress({ project: { folded: new Set([...FOLDED, 'hist:DATA-ONE', 'ledger:DATA-ONE']), view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), withBrief);
  fits(both);
  order(both, true);
  const press = (frame, key, extra = {}) => handleMonitorInput({ ...frame.state, ...extra }, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW });
  const onFold = f.render(40, 'en', 60, progress({ project: { nav: { cursor: 'project:fold:ledger:DATA-ONE' }, folded: new Set([...FOLDED, 'hist:DATA-ONE']), view: { kind: 'progress', onlyTry: { scroll: 0 } } } }), withBrief);
  assert.ok(press(onFold, 'enter').state.project.folded.has('ledger:DATA-ONE'), 'Classic: Enter on the fold row unfolds the original text');
  // Split: Enter on the slice's row goes into the preview, onto the fold row; Enter there unfolds, again folds.
  const inside = press(preview, 'enter');
  assert.equal(splitOf(inside.state).focus, 'preview');
  assert.equal(splitOf(inside.state).previewCursor, 'project:fold:ledger:DATA-ONE');
  const afterInside = f.render(40, 'en', 60, inside.state, withBrief);
  const unfoldedByKey = press(afterInside, 'enter');
  assert.ok(unfoldedByKey.state.project.folded.has('ledger:DATA-ONE'));
  assert.match(text(f.render(40, 'en', 60, unfoldedByKey.state, withBrief)), /ENDOFLEDGER/);
  // Without a brief the slice's preview is the whole text as before: nothing to fold, so Enter still opens the file.
  const plainPreview = f.render(40, 'en', 60, asSplit(withState(progress(), cursor)), data);
  assert.doesNotMatch(text(plainPreview), /Ledger line|How to try/);
  assert.equal(press(plainPreview, 'enter').action?.type, 'open-files');
});

test('Waiting and the hub report all pending trials; Home Progress counts only its milestone in both languages', async (t) => {
  const { f, data } = await fixture(t);
  const tries = data.ledger.filter((r) => r.state === 'try').length;
  assert.ok(tries >= 3, 'the fixture has slices to try in more than one milestone');
  for (const lang of ['en', 'zh']) {
    const word = lang === 'en' ? 'to try' : '待试用', numbers = (frame) => [...text(frame).matchAll(new RegExp(`(\\d+) ${word}`, 'g'))].map((m) => Number(m[1]));
    const frames = {
      hub: f.render(60, lang, 40, withState(sliceState(), { activeTab: 'project', project: { folded: new Set(FOLDED) } }), data),
      split: f.render(60, lang, 40, split({ activeTab: 'project' }), data),
      home: f.render(60, lang, 40, split(), data),
    };
    for (const [name, frame] of Object.entries({ hub: frames.hub, split: frames.split })) {
      const found = numbers(frame).filter((n) => n !== 0);
      assert.ok(found.length > 0, `${lang} ${name}: says a number to try`);
      assert.deepEqual([...new Set(found)], [tries], `${lang} ${name}: ${found}`);
    }
    // The Progress row has one form: milestone and words, never a bare meter fraction.
    const homeRow = plain(frames.home).find((l) => /^[◐@] (Progress|进度)/.test(l));
    assert.ok(homeRow, `${lang}: Home's Progress row`);
    assert.doesNotMatch(homeRow, /\d+\/\d+|[█▒░]/, `${lang}: ${homeRow}`);
    const current = data.ledger.filter(r => r.state === 'try' && (r.release ?? r.milestone) === data.ladder.current).length;
    assert.match(homeRow, new RegExp(`${current} ${word}`));
    assert.match(plain(frames.home).find(l => /^\? (Waiting for you|等你处理)/.test(l)), new RegExp(`${tries} ${word}`));
  }
  // A bar's fraction says what it counts.
  assert.match(text(f.render(60, 'en', 40, progress(), data)), /\d+\/\d+ accepted/);
  assert.match(text(f.render(60, 'zh', 40, progress(), data)), /\d+\/\d+ 已验收/);
});

/** A real repository with one commit and a ticket, so the collector has something to read; the model is a fake that counts its calls. */
function service(t, mode, reply = () => BRIEF) {
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
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(await reply(calls.length)) } }] }), { status: 200 });
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

test('a changed ticket hides the old brief during a replacement and after refusal; moving milestones also invalidates it', async (t) => {
  const { f, data } = await fixture(t);
  const replacement = Promise.withResolvers();
  const s = service(t, 'on', (n) => n === 1 ? BRIEF : n === 2 ? replacement.promise : { brief: 'Use the revised procedure.', steps: [] });
  const row = { ...s.row('the watcher now survives a link loop (.scratch/demo/issues/01-thing.md)'), milestone: '0.1.3' };
  const snapshot = { ...data, ledger: data.ledger.map((r) => r.id === row.id ? row : r) };
  const current = (snap = snapshot) => s.briefs.apply(s.root, snap);
  const frame = (snap = snapshot) => f.render(40, 'en', 24, asSplit(progress({ project: { nav: { cursor: 'project:slice:DATA-ONE' } } })), current(snap));
  s.briefs.update(s.root, [row]);
  await until(() => current() !== snapshot);
  assert.match(flat(frame()), /Job rows no longer vanish/);
  const moved = { ...row, milestone: 'M4' }, movedSnapshot = { ...snapshot, ledger: snapshot.ledger.map((r) => r === row ? moved : r) };
  assert.doesNotMatch(flat(frame(movedSnapshot)), /Job rows no longer vanish/, 'an existing brief belongs only to its ledger milestone');

  fs.writeFileSync(join(s.root, '.scratch/demo/issues/01-thing.md'), '# 01\nREVISEDTICKET: use a different procedure\n');
  s.clock.now += 6 * 60_000;
  s.briefs.update(s.root, [row]);
  await until(() => s.calls.length === 2);
  assert.match(JSON.stringify(s.calls[1]), /REVISEDTICKET/);
  const originalOnly = () => {
    const visible = flat(frame());
    assert.match(visible, /the watcher now survives a link loop/);
    assert.doesNotMatch(visible, /Job rows no longer vanish|Use the revised procedure/);
  };
  originalOnly();
  replacement.resolve({ brief: 'Use the revised procedure.', steps: 'not an array' });
  await until(() => s.model.diagnostics().lastFailure);
  assert.ok(s.model.diagnostics().lastFailure, 'the replacement was refused');
  originalOnly();
  assert.equal(parseBrief('{"brief":"missing steps"}'), undefined);

  s.briefs.update(s.root, [moved]); // The milestone change bypasses the retry delay for the old line.
  await until(() => current(movedSnapshot) !== movedSnapshot);
  assert.equal(s.calls.length, 3);
  assert.match(JSON.stringify(s.calls[2]), /M4 · the watcher/);
  assert.match(flat(frame(movedSnapshot)), /Use the revised procedure\./, 'an explicit empty steps array is valid');
});

test('model off: no call, and the snapshot is the very one it was given', async (t) => {
  const s = service(t, 'off'), snap = s.snapshot(s.row(LONG));
  s.briefs.update(s.root, snap.ledger);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.calls.length, 0);
  assert.equal(s.briefs.apply(s.root, snap), snap);
});

test('a clamped brief sentence ends at a word, never inside one (EN at 40 columns)', async () => {
  const { clampClean } = await import('../../dist/render/project-view.js');
  const { lines, more } = clampClean('Ledger history, live jobs and ticket detail now show on the Progress page.', 34, 2);
  assert.equal(more, true);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\b(?:the|Progress)…$/, lines[1]);
  assert.doesNotMatch(lines[1], /pag…$/);
  const zh = clampClean('台账历史、进行中的任务和工单详情现在都能在进度页直接看到。其余页面不变。', 20, 2).lines;
  assert.match(zh[1], /…$/);
});

test('TryBriefs reads commit and ticket file from ticketPath and commit fields on ticket-derived slices', async (t) => {
  const s = service(t, 'on');
  const row = { id: 'DEMO-01', state: 'try', milestone: 'demo', text: 'Synthetic ticket title (00000000)', commit: s.hash, ticketPath: '.scratch/demo/issues/01-thing.md' };
  s.briefs.update(s.root, [row]);
  await until(() => s.briefs.apply(s.root, s.snapshot(row)).ledger[0].brief);
  assert.equal(s.calls.length, 1);
  const sent = JSON.stringify(s.calls[0]);
  for (const word of ['Synthetic ticket title', 'synthetic subject', 'SYNTHBODY', 'TICKETWORD'])
    assert.ok(sent.includes(word), `${word} reaches the model for ticket-derived slice`);
});
