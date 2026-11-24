import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from '../helpers/thin-mcp-harness.mjs';

const now = '2024-02-06T02:00:00.000Z'; // Still February 5 in Los Angeles.
const clock = `process.env.TZ = 'America/Los_Angeles'; Date.now = () => ${Date.parse(now)};`;

async function scheduleFixture(t) {
  const f = await fixture(t, { inHerdr: false, probe: clock });
  const home = f.env.HUD_HOME, path = join(home, 'schedule.json');
  return {
    ...f, home, path,
    call: (op, args) => f.call('hud_schedule', { op, ...args }),
    refused: async (op, args, code, message) => {
      const { result } = await f.rpc('tools/call', { name: 'hud_schedule', arguments: { op, ...args } });
      assert.equal(result.isError, true);
      const error = JSON.parse(result.content[0].text);
      assert.equal(error.code, code);
      assert.match(error.error, message);
    },
    read: () => JSON.parse(fs.readFileSync(path, 'utf8')),
  };
}

test('hud_schedule writes private day and month dates and lists open items in local due order', async (t) => {
  const f = await scheduleFixture(t);
  assert.deepEqual(await f.call('list'), { items: [] });
  assert.equal(fs.existsSync(f.path), false);
  const add = (date, text) => f.call('add', { date, text });
  const { item: month } = await add('2024-02', 'Review sample');
  assert.deepEqual(month, { id: 's1', date: '2024-02', text: 'Review sample', created_at: now, stage: 'soon', due: false, days_until_due: 24 });
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  const { item: today } = await add('2024-02-05', '检查样本');
  const { item: overdue } = await add('2024-02-04', 'Renew sample');
  const { item: far } = await add('2024-03', 'Back up sample');
  assert.deepEqual([today.stage, overdue.stage, far.stage], ['today', 'overdue', 'far']);
  assert.deepEqual((await f.call('list')).items, [overdue, today, month, far]);
  assert.deepEqual((await f.call('list', { due: true })).items, [overdue, today]);

  const inode = fs.statSync(f.path).ino;
  const { item: moved } = await f.call('move', { id: overdue.id, date: '2024-02-12' });
  assert.equal(moved.days_until_due, 7);
  assert.equal(moved.stage, 'soon');
  assert.equal(moved.id, overdue.id);
  assert.notEqual(fs.statSync(f.path).ino, inode, 'writes replace the file atomically');
  assert.deepEqual((await f.call('list')).items, [today, moved, month, far]);
  assert.deepEqual(await f.call('done', { id: today.id, note: 'Checked' }), { id: today.id, done_at: now });
  assert.deepEqual(await f.call('list', { due: true }), { items: [] });
  assert.deepEqual((await f.call('list')).items, [moved, month, far]);
  const state = f.read();
  assert.deepEqual({ version: state.version, seq: state.seq }, { version: 1, seq: 4 });
  assert.deepEqual(state.items.find(({ id }) => id === today.id),
    { id: today.id, text: today.text, date: today.date, created_at: now, done_at: now });
  assert.equal(fs.existsSync(join(f.home, 'events')), false);
});

test('hud_schedule refuses invalid dates, text and project or Objective links at add', async (t) => {
  const f = await scheduleFixture(t), project = fs.realpathSync(f.root);
  const add = { date: '2024-02-29', text: 'Review sample' };
  const invalid = (fields, message) => f.refused('add', { ...add, ...fields }, 'invalid_arguments', message);
  await invalid({ date: '2024-02-30' }, /date/);
  await invalid({ text: 'line one\nline two' }, /text/);
  await invalid({ text: '界'.repeat(161) }, /160 characters/);
  await invalid({ project }, /not registered/);
  await invalid({ objective: 'review' }, /requires a project/);
  const projects = join(f.home, 'projects.json');
  fs.writeFileSync(projects, JSON.stringify({ version: 1, projects: [{ root: project }] }));
  fs.mkdirSync(join(project, '.hud'));
  fs.writeFileSync(join(project, '.hud', 'objectives.md'), '## review: Review the sample\n**State:** active\n');
  await invalid({ project, objective: 'missing' }, /unknown Objective/);
  assert.equal(fs.existsSync(f.path), false);
  const { item } = await f.call('add', { ...add, project, objective: 'review' });
  assert.equal(item.project, project);
  assert.equal(item.objective, 'review');
  fs.writeFileSync(projects, JSON.stringify({ version: 1, projects: [] }));
  const { project: _project, objective: _objective, ...unlinked } = item;
  assert.deepEqual((await f.call('list')).items, [unlinked]);
  assert.equal(f.read().items[0].project, project, 'unregistering does not change the private record');
});

test('hud_schedule refuses the 201st open item and prunes expired completions only on write', async (t) => {
  const f = await scheduleFixture(t);
  const add = { date: '2024-02-06', text: 'Sample' };
  const created_at = '2023-12-01T00:00:00.000Z';
  const seed = (n, done_at) => ({ id: `s${n}`, ...add, created_at, done_at });
  const expired = seed(201, '2024-01-06T02:00:00.000Z');
  const recent = seed(202, '2024-01-07T02:00:00.001Z');
  const initial = { version: 1, seq: 202, items: [...Array.from({ length: 200 }, (_, i) => seed(i + 1)), expired, recent] };
  fs.writeFileSync(f.path, JSON.stringify(initial));
  assert.equal((await f.call('list')).items.length, 200);
  assert.equal(f.read().items.length, 202, 'list does not prune');
  await f.refused('add', add, 'tool_error', /200 open items/);
  await f.call('done', { id: 's1' });
  assert.equal(f.read().items.some(({ id }) => id === 's201'), false);
  assert.deepEqual(f.read().items.find(({ id }) => id === 's202'), recent);
  assert.equal((await f.call('add', add)).item.id, 's203', 'pruned IDs are not reused');
  assert.equal((await f.call('list')).items.length, 200);
});

test('hud_schedule refuses to read or replace oversized state', async (t) => {
  const f = await scheduleFixture(t);
  const json = JSON.stringify({ version: 1, seq: 0, items: [] });
  const atLimit = json.padEnd(64 * 1024);
  fs.writeFileSync(f.path, atLimit);
  assert.deepEqual(await f.call('list'), { items: [] });
  fs.appendFileSync(f.path, ' ');
  await f.refused('list', {}, 'tool_error', /file_too_large/);
  await f.refused('add', { date: '2024-02', text: 'Review' }, 'tool_error', /file_too_large/);
  assert.equal(fs.readFileSync(f.path, 'utf8'), atLimit + ' ');
});
