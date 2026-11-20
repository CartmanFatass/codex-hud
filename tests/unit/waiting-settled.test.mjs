import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector, waitSettled } from '../../dist/collectors/project-board.js';

const ledger = new Map([['DONE-ONE', { state: 'accepted' }], ['GONE', { state: 'dropped' }], ['OPEN', { state: 'try' }]]);
const tickets = [{ slug: 'demo-feature', at: 0, tickets: [
  { number: '01', state: 'done' }, { number: '02', state: 'ready' }, { number: '03', state: 'dropped' },
] }];

test('a waiting item settles only when every named slice and ticket is finished', () => {
  const settled = (text) => waitSettled(text, ledger, tickets);
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
});

test('the collector drops settled waiting items from every count', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'waiting-settled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); };
  put(join(cwd, 'docs/handoff/STATE.md'), [
    '# State', '', 'Milestone: M1', '', '## Waiting for the owner', '',
    '- Settled by a slice (waits on DONE-ONE)',
    '- Settled by a ticket (waits on demo-feature/01)',
    '- Still open (waits on OPEN)',
    '- A plain decision', '',
    '## Slices', '',
    '- accepted · M1 · DONE-ONE · landed (abc1234)',
    '- try · M1 · OPEN · landed (def5678)', '',
  ].join('\n'));
  put(join(cwd, '.scratch/demo-feature/issues/01-first.md'), '# 01: First\n\n**Status:** resolved · **Blocked by:** none\n');
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const data = await new ProjectCollector(cwd, hud, { HOME: home }, home).collect('home', { lanes: [], workers: [] }, Date.now());
  assert.deepEqual(data.waiting.map((w) => w.value), ['Still open (waits on OPEN)', 'A plain decision']);
});
