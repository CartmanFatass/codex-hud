import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector, waitSettled } from '../../dist/collectors/project-board.js';
import { appendTry } from '../../dist/collectors/try-records.js';

const finished = new Set(['done-one', 'gone', 'demo-feature/1', 'demo-feature/3']);

test('a waiting item settles only when every named slice and ticket is finished', () => {
  const settled = (text) => waitSettled(text, finished);
  assert.equal(settled('Decide the export format (waits on DONE-ONE)'), true);
  assert.equal(settled('Two refs (waits on DONE-ONE, demo-feature/01)'), true);
  assert.equal(settled('Dropped counts (waits on GONE and demo-feature/03)'), true);
  assert.equal(settled('Ticket by hash (waits on demo-feature#1)'), true);
  assert.equal(settled('One still to try (waits on DONE-ONE, OPEN)'), false);
  assert.equal(settled('Ticket open (waits on demo-feature/02)'), false);
  assert.equal(settled('Unknown ref stays (waits on NOPE)'), false);
  assert.equal(settled('Unknown feature stays (waits on other/01)'), false);
  // Mentioning an accepted slice in prose is not a dependency.
  assert.equal(settled('Compare with DONE-ONE before deciding'), false);
  assert.equal(settled('No refs at all'), false);
  assert.equal(waitSettled('Archived ref without a resolver (waits on sample/01)', new Set(['sample-done/1'])), false);
});

test('an owner request waits on sample/01 stays settled after sample/01 moves to sample-done/01 without rewriting prose', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'waiting-archived-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); };
  const at = '2026-01-01T00:00:00.000Z';
  const ticket = (number, status) => ({
    number, title: `Ticket ${number}`, status, owner_try: false, live_try: 'none', approved_removals: [],
    blocked_by: [], what: 'Synthetic slice.', acceptance: [{ id: 1, text: 'Check', done: status === 'done' }],
    comments: [], created_at: at, updated_at: at,
  });
  const statePath = join(cwd, 'docs/handoff/STATE.md');
  const stateText = [
    '# State', '', '## Waiting for the owner', '',
    '- Settled archived ticket (waits on sample/01)',
    '- Still open direct ticket (waits on sample/02)',
    '- Ambiguous archived ticket (waits on sample/03)', '',
  ].join('\n');
  put(statePath, stateText);
  put(join(cwd, '.hud/tickets/sample.json'), JSON.stringify({
    version: 1, feature: 'sample', tickets: [ticket(2, 'ready-for-agent')],
  }, null, 2) + '\n');
  put(join(cwd, '.hud/tickets/sample-done.json'), JSON.stringify({
    version: 1, feature: 'sample-done', tickets: [ticket(1, 'done'), ticket(2, 'done'), ticket(3, 'done')],
  }, null, 2) + '\n');
  put(join(cwd, '.hud/tickets/sample-done-2.json'), JSON.stringify({
    version: 1, feature: 'sample-done-2', tickets: [ticket(3, 'done')],
  }, null, 2) + '\n');
  fs.mkdirSync(home, { recursive: true });
  const data = await new ProjectCollector(cwd, hud, { HOME: home }, home).collect('home', { lanes: [], workers: [] }, Date.now());
  assert.deepEqual(data.waiting.map((w) => w.value), [
    'Still open direct ticket (waits on sample/02)',
    'Ambiguous archived ticket (waits on sample/03)',
  ]);
  assert.equal(fs.readFileSync(statePath, 'utf8'), stateText, 'owner prose must not be rewritten');
});

test('the collector drops settled waiting items from every count', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'waiting-settled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); };
  put(join(cwd, 'docs/handoff/STATE.md'), [
    '# State', '', 'Milestone: M1', '', '## Waiting for the owner', '',
    '- Settled by a legacy accept (waits on OLD-ACCEPT)',
    '- Not settled by STATE (waits on DONE-ONE)',
    '- Settled by a ticket (waits on demo-feature/01)',
    '- Still open (waits on OPEN)',
    '- A plain decision', '',
    '## Slices', '',
    '- accepted · M1 · DONE-ONE · landed (abc1234)',
    '- try · M1 · OPEN · landed (def5678)', '',
  ].join('\n'));
  put(join(cwd, '.scratch/demo-feature/issues/01-first.md'), '# 01: First\n\n**Status:** resolved · **Blocked by:** none\n');
  appendTry(hud, cwd, 'accept', { milestone: 'M1', slices: [{ id: 'OLD-ACCEPT', text: '' }] });
  fs.mkdirSync(home, { recursive: true });
  const data = await new ProjectCollector(cwd, hud, { HOME: home }, home).collect('home', { lanes: [], workers: [] }, Date.now());
  assert.deepEqual(data.waiting.map((w) => w.value), ['Not settled by STATE (waits on DONE-ONE)', 'Still open (waits on OPEN)', 'A plain decision']);
});

test('a placeholder bullet in an empty Waiting section is not a request', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'waiting-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  fs.mkdirSync(join(cwd, 'docs/handoff'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const line of ['- Nothing open.', '- None', '- 无']) {
    fs.writeFileSync(join(cwd, 'docs/handoff/STATE.md'), ['# State', '', '## Waiting for the owner', '', line, '', '## Next', ''].join('\n'));
    const data = await new ProjectCollector(cwd, hud, { HOME: home }, home).collect('home', { lanes: [], workers: [] }, Date.now());
    assert.deepEqual(data.waiting, [], line);
  }
});
