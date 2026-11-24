import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readObjectives } from '../../dist/collectors/objectives.js';
import { PiRoleClient } from '../../dist/harness/pi/role-client.js';
import { fixture, resultValue } from '../helpers/thin-mcp-harness.mjs';

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

test('hud_objective opens and resolves one owner request without editing other STATE bytes or tickets', async (t) => {
  const f = await fixture(t, false), cwd = fs.realpathSync(f.root), home = f.env.HUD_HOME;
  const state = join(cwd, 'docs/handoff/STATE.md'), events = join(home, 'events'), old = '2020-01.jsonl';
  const original = '\uFEFF# State\r\n\r\n## Waiting for the owner \r\n\r\n- Legacy item  \r\n  Keep detail\r\n'
    + '- 2020-01-02 [r8] Manual request\r\n  \r\n\r\n## Next\r\n- Keep this 中文';
  const ticket = join(cwd, '.scratch/sample/issues/01-demo.md'), ticketText = '# 01: Sample\n**Status:** try\n- [ ] Keep open';
  for (const [path, text] of [[state, original], [ticket, ticketText], [join(cwd, '.hud/objectives.md'), '## measure: Measure sample\n**State:** active\n']]) {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, text);
  }
  fs.writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: cwd }] }));
  fs.mkdirSync(events);
  fs.writeFileSync(join(events, old), [[cwd, 'r7'], ['/other-project', 'r99']].map(([project, request]) =>
    JSON.stringify({ v: 1, kind: 'request', project, request, waits: false, change: 'opened', at: '2020-01-01T00:00:00.000Z', by: {} })).join('\n') + '\n');
  const rpc = async (args, id) => (await f.rpc('tools/call', { name: 'hud_objective', arguments: { cwd, ...args },
    _meta: { 'x-codex-turn-metadata': { thread_id: id } } })).result;
  const read = () => fs.readFileSync(state, 'utf8');
  const archive = () => fs.readdirSync(events).sort().map((name) => fs.readFileSync(join(events, name), 'utf8'));
  const before = archive();
  for (const args of [{ op: 'request', text: 'Choose', objective: 'missing' }, { op: 'resolve', request: 'r7' }]) {
    const result = await rpc(args, 'synthetic-opener');
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'invalid_arguments');
    assert.equal(read(), original);
    assert.deepEqual(archive(), before);
  }
  const opened = resultValue(await rpc({ op: 'request', text: 'Choose', objective: 'measure', waits: true }, 'synthetic-opener'));
  assert.equal(opened.request, 'r9');
  const day = read().match(/^- (\d{4}-\d{2}-\d{2}) \[r9\]/m)?.[1];
  assert.ok(day);
  assert.equal(read(), original.replace('  \r\n\r\n## Next', `- ${day} [r9] Choose (objective measure) (work waits)\r\n  \r\n\r\n## Next`));
  const resolved = resultValue(await rpc({ op: 'resolve', request: 'r9', note: 'Chose rows' }, 'synthetic-resolver'));
  assert.equal(resolved.change, 'resolved');
  assert.equal(read(), original);
  assert.equal(fs.readFileSync(ticket, 'utf8'), ticketText);

  const eof = '## Waiting for the owner\n- Legacy at EOF';
  fs.writeFileSync(state, eof);
  assert.equal(resultValue(await rpc({ op: 'request', text: 'Try rows' }, 'synthetic-opener')).request, 'r10');
  const pi = new PiRoleClient({ release: resolve('.'), node: process.execPath, hudHome: home }, f.env, cwd, 'synthetic-pi');
  try {
    assert.equal(resultValue(await pi.call('hud_objective', { cwd, op: 'resolve', request: 'r10', resolution: 'withdrawn' })).change, 'withdrawn');
  } finally { await pi.stop(); }
  assert.equal(read(), eof);
  const rows = fs.readdirSync(events).sort().filter((name) => name !== old).flatMap((name) =>
    fs.readFileSync(join(events, name), 'utf8').trimEnd().split('\n').map((row) => {
      const { at, ...facts } = JSON.parse(row);
      assert.equal(new Date(at).toISOString(), at);
      assert.equal(`${at.slice(0, 7)}.jsonl`, name);
      return facts;
    }));
  const receipt = (request, change, session, fields) => ({ v: 1, kind: 'request', project: cwd, request, change,
    waits: false, by: { harness: 'codex', session }, ...fields });
  assert.deepEqual(rows, [
    receipt('r9', 'opened', 'synthetic-opener', { objective: 'measure', waits: true }),
    receipt('r9', 'resolved', 'synthetic-resolver', { objective: 'measure', waits: true, note: 'Chose rows' }),
    receipt('r10', 'opened', 'synthetic-opener'),
    receipt('r10', 'withdrawn', 'synthetic-pi', { by: { harness: 'pi', session: 'synthetic-pi' } }),
  ]);
});
