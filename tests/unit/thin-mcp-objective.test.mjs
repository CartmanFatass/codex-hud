import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readObjectives } from '../../dist/collectors/objectives.js';
import { fixture } from '../helpers/thin-mcp-harness.mjs';

test('hud_objective edits only supplied fields and appends one private receipt per material change', async (t) => {
  const f = await fixture(t, false), cwd = fs.realpathSync(f.root), home = f.env.HUD_HOME;
  const path = join(cwd, '.hud/objectives.md'), events = join(home, 'events');
  fs.writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: cwd }] }));
  const { tools } = (await f.rpc('tools/list')).result;
  assert.ok(tools.some(({ name }) => name === 'hud_objective'));
  const set = (args) => f.call('hud_objective', { op: 'set', cwd, id: 'measure', ...args });
  const project = (args) => f.call('hud_objective', { op: 'project', cwd, ...args });
  assert.equal(fs.existsSync(path), false);
  assert.equal((await set({ title: 'Measure sample', state: 'active', next: 'Observe' })).change, 'created');
  const read = () => fs.readFileSync(path, 'utf8');
  assert.equal(read(), '## measure: Measure sample\n**State:** active\n**Next:** Observe\n');
  const original = '\uFEFF# Objectives\r\n**Stance:** active  ·  **Priority:** high \r\n\r\n'
    + '## measure: Measure sample\r\n**State:** active\r\n**Next:**  Observe  \r\n**Note:**  样本  \r\n\r\n'
    + '## other: Separate goal\r\n**State:** done\r\n**Next:** Observe';
  fs.writeFileSync(path, original);
  const receipts = () => fs.readdirSync(events).sort().flatMap((file) => {
    const full = join(events, file);
    assert.match(file, /^\d{4}-\d{2}\.jsonl$/);
    assert.equal(fs.statSync(full).mode & 0o777, 0o600);
    return fs.readFileSync(full, 'utf8').trimEnd().split('\n').map((line) => {
      const { at, ...row } = JSON.parse(line);
      assert.equal(new Date(at).toISOString(), at);
      assert.equal(at.slice(0, 7) + '.jsonl', file);
      return row;
    });
  });
  assert.equal((await set({ next: 'Observe again' })).changed, true);
  const edited = original.replace('**Next:**  Observe  ', '**Next:**  Observe again  ');
  assert.equal(read(), edited);
  await project({ priority: 'low' });
  assert.equal(read(), edited.replace('**Priority:** high', '**Priority:** low'));
  assert.equal(receipts().length, 1);
  for (const args of [{ state: 'blocked' }, { next: 'one\ntwo' }, { features: ['../other'] }, { evidence: ['/outside'] }]) {
    const before = read();
    const { result } = await f.rpc('tools/call', { name: 'hud_objective', arguments: { op: 'set', cwd, id: 'measure', ...args } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid_arguments/);
    assert.equal(read(), before);
  }
  await set({ state: 'paused' });
  await set({ title: 'Repeat sample' });
  await set({ result: 'The reading held.' });
  assert.equal(readObjectives(cwd).objectives[0].result, 'The reading held.');
  assert.equal((await set({ result: 'The reading held.' })).changed, false);
  await set({ result: '', features: ['sample'], evidence: ['docs/report.md', '123abcd'] });
  const record = readObjectives(cwd);
  assert.deepEqual(record.diagnostics, []);
  assert.equal(record.priority, 'low');
  assert.equal(record.objectives[0].result, undefined);
  assert.deepEqual(record.objectives[0].features, ['sample']);
  assert.deepEqual(receipts(), [
    ['Measure sample', 'created', 'active'], ['Measure sample', 'state', 'paused'],
    ['Repeat sample', 'title', 'paused'], ['Repeat sample', 'result', 'paused'],
  ].map(([title, change, state]) => ({ v: 1, kind: 'objective', project: cwd, id: 'measure', title, change, state })));
  assert.equal(fs.existsSync(join(home, 'archive')), false);
});

test('hud_objective project can start the header with either field', async (t) => {
  const f = await fixture(t, false), cwd = fs.realpathSync(f.root), home = f.env.HUD_HOME;
  const set = (args) => f.call('hud_objective', { op: 'project', cwd, ...args });
  fs.writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: cwd }] }));
  await set({ priority: 'low' });
  assert.deepEqual(readObjectives(cwd), { stance: 'unknown', priority: 'low', objectives: [], diagnostics: [] });
  await set({ stance: 'maintenance' });
  assert.equal(readObjectives(cwd).stance, 'maintenance');
  await set({ stance: 'paused', priority: 'normal' });
  assert.deepEqual(readObjectives(cwd), { stance: 'paused', priority: 'normal', objectives: [], diagnostics: [] });
  assert.equal(fs.existsSync(join(home, 'events')), false);
});
