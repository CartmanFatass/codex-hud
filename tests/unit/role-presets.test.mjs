import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { currentPreset, roleRegistry } from '../../dist/roles/roster.js';
import { editPlaces, editPreset } from '../../dist/roles/role-control.js';

const bundled = resolve('packages/hud-mcp');
const pi = { harness: 'pi', pi_role: 'implementer', split: false };
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-presets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hud = join(root, 'hud'), cwd = join(root, 'project');
  fs.mkdirSync(cwd);
  const put = (file, value) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const file = join(hud, 'roles/imp.json');
  const own = { role: 'imp', instructions: 'implementer', can_continue: true, run: [pi], note: 'keep', idle_grace_s: 720 };
  const registry = () => roleRegistry(hud, cwd, { PATH: '' }, undefined, undefined, bundled);
  const role = () => registry().roles().get('imp');
  return { hud, cwd, put, file, own, registry, role };
}

test('presets validate names, duplicates and every run like the role run', (t) => {
  const f = fixture(t);
  for (const [presets, reason] of [
    [{}, 'bad presets'],
    [[{ name: 'bad name', run: [pi] }], 'bad preset name'],
    [[{ name: 'x'.repeat(33), run: [pi] }], 'bad preset name'],
    [[{ name: 'x', run: [pi] }, { name: 'x', run: [pi] }], 'duplicate preset x'],
    [[{ name: 'x', run: [] }], 'preset x: bad run places'],
    [[{ name: 'x', run: [{ harness: 'pi', split: 'no' }] }], 'preset x: bad pi fields'],
    [[{ name: 'x', run: [{ harness: 'cli', agent: 'agy', thinking: 1 }] }], 'preset x: bad model/thinking/effort'],
  ]) {
    f.put(f.file, { ...f.own, presets });
    assert.deepEqual(f.registry().invalid(), [{ path: f.file, reason }]);
    assert.equal(f.role().source_file, join(bundled, 'roles/imp.json'), 'invalid owner file leaves the shipped role in force');
  }
});

test('presets merge shipped, owner, registered project by name; omission inherits', (t) => {
  const f = fixture(t);
  f.put(f.file, f.own);
  assert.deepEqual(f.role().presets.map((p) => p.name), ['default', 'hydrogen', 'astra']);
  const override = { name: 'hydrogen', run: [{ ...pi, model: 'owner/model' }] };
  f.put(f.file, { ...f.own, presets: [override, { name: 'mine._-1', run: [pi] }] });
  assert.deepEqual(f.role().presets.map((p) => p.name), ['default', 'hydrogen', 'astra', 'mine._-1']);
  assert.deepEqual(f.role().presets[1], override);
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: fs.realpathSync(f.cwd), registered_at: '2026-11-17T00:00:00Z' }] });
  f.put(join(f.cwd, '.hud/roles/imp.json'), { ...f.own, presets: [{ name: 'hydrogen', run: [{ ...pi, model: 'project/model' }] }] });
  assert.equal(f.role().presets[1].run[0].model, 'project/model');
  assert.equal(f.role().presets.length, 4);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.deepEqual(editPlaces(f.hud, f.cwd, { PATH: '' }, { role: 'imp', index: 0, op: 'preset' }), { ok: false, message: 'the project file is in force: o opens it' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const projectFile = join(f.cwd, '.hud/roles/imp.json');
  const run = [{ harness: 'cli', agent: 'agy', model: 'project-cli', thinking: 'high' }];
  f.put(projectFile, { ...f.own, active_preset: 'cli', presets: [{ name: 'cli', run }] });
  assert.deepEqual(f.registry().invalid(), []);
  assert.deepEqual(f.role().run, run);
  for (const [place, reason] of [
    [{ ...run[0], args: ['--extra'] }, 'project CLI places take agent, model and thinking only'],
    [{ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }, 'project roles are pi or CLI only'],
  ]) {
    f.put(projectFile, { ...f.own, presets: [{ name: 'invalid', run: [place] }] });
    assert.deepEqual(f.registry().invalid(), [{ path: projectFile, reason }]);
  }
});

test('switch writes a selector, not its run; legacy equality ignores key order but not place order', (t) => {
  const f = fixture(t), preset = { name: 'mine', run: [{ ...pi, model: 'owner/model', lens: false, pi_args: ['--verbose'] }, { ...pi, model: 'synthetic/backup' }] };
  f.put(f.file, { ...f.own, presets: [preset] });
  const edit = (step) => editPlaces(f.hud, f.cwd, { PATH: '' }, { role: 'imp', index: 0, op: 'preset', step });
  assert.deepEqual(edit(-1), { ok: true, index: 0, preset: 'mine' }, 'custom goes back to last');
  const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(stored, { ...f.own, presets: [preset], active_preset: 'mine' });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(currentPreset(f.role()), 'mine');
  const { preset: _, ...r } = f.role();
  assert.equal(currentPreset({ ...r, run: r.run.map((p) => Object.fromEntries(Object.entries(p).reverse())) }), 'mine');
  assert.equal(currentPreset({ ...r, run: [...r.run].reverse() }), null);
  assert.deepEqual(edit(1), { ok: true, index: 0, preset: 'default' }, 'last wraps to default');
  assert.equal(currentPreset(f.role()), 'default');
  assert.equal(currentPreset({ ...r, run: [{ ...pi, thinking: 'high' }] }), null);
  assert.equal(currentPreset({ run: [pi] }), null);
});

const stored = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const edit = (f, change) => editPreset(f.hud, f.cwd, { PATH: '' }, { role: 'imp', ...change }, bundled);

test('legacy file chain, explicit Custom, duplicate saved chains and missing selectors keep their own identities', (t) => {
  const f = fixture(t), now = Date.parse('2026-11-20T09:00:00Z');
  const exe = join(f.cwd, 'pi-role');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const run = [{ ...pi, model: 'synthetic/file' }];
  const file = { ...f.own, run, presets: [{ name: 'same-a', run }, { name: 'same-b', run }] };
  f.put(f.file, file);
  const assign = () => {
    const registry = roleRegistry(f.hud, f.cwd, { PATH: f.cwd }, undefined, undefined, bundled);
    return registry.assignment(registry.roles().get('imp'), now);
  };
  assert.deepEqual([assign().preset, assign().runs_on], ['same-a', run[0]]);
  assert.deepEqual(stored(f.file), file, 'read-only legacy evaluation');
  assert.equal(edit(f, { op: 'select', name: 'same-b' }).ok, true);
  assert.deepEqual([assign().preset, assign().runs_on], ['same-b', run[0]]);
  assert.equal(edit(f, { op: 'select', name: null }).ok, true);
  assert.deepEqual([assign().preset, assign().runs_on], [null, run[0]]);
  f.put(f.file, { ...file, active_preset: 'retired' });
  assert.deepEqual([assign().preset, assign().preset_missing, assign().runs_on], [null, 'retired', run[0]]);
  assert.equal(stored(f.file).active_preset, 'retired');
  for (const [values, reason] of [[{ active_preset: {} }, 'bad active_preset'],
    [{ hidden_presets: ['dupe', 'dupe'] }, 'bad hidden_presets'], [{ hidden_presets: ['space here'] }, 'bad hidden_presets']]) {
    f.put(f.file, { ...file, ...values });
    assert.deepEqual(f.registry().invalid(), [{ path: f.file, reason }]);
  }
});

test('rename and delete inherited presets persist on the actual owner path; project can reintroduce a hidden name', (t) => {
  const f = fixture(t), owner = join(f.hud, 'roles/renamed-filename.json');
  const shipped = join(bundled, 'roles/imp.json'), shippedBefore = fs.readFileSync(shipped, 'utf8');
  const local = { name: 'local', run: [{ ...pi, pi_args: ['--verbose'], advanced: { keep: true } }] };
  f.put(owner, { ...f.own, presets: [local], active_preset: 'hydrogen' });
  const registry = f.registry(), imported = registry.roles().get('imp');
  assert.equal(imported.run[0].model, 'gemini-4-hydrogen-high');
  assert.equal(registry.assignment(imported).model_source, shipped);
  assert.equal(edit(f, { op: 'rename', name: 'local' }).message, 'preset name already exists');
  assert.equal(edit(f, { op: 'rename', name: 'night._-1' }).ok, true);
  assert.equal(f.role().preset, 'night._-1');
  assert.deepEqual(f.role().presets.map((p) => p.name), ['default', 'astra', 'local', 'night._-1']);
  assert.deepEqual(stored(owner).presets[0], local);
  assert.deepEqual(stored(owner).hidden_presets, ['hydrogen']);
  assert.deepEqual(stored(owner).run, f.own.run);
  assert.equal(fs.statSync(owner).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(edit(f, { op: 'select', name: 'default' }).ok, true);
  assert.equal(edit(f, { op: 'delete' }).ok, true);
  const after = f.role();
  assert.deepEqual([after.preset, after.run, after.presets.map((p) => p.name)], [null, f.own.run, ['astra', 'local', 'night._-1']]);
  assert.deepEqual(stored(owner).hidden_presets, ['hydrogen', 'default']);
  assert.equal(fs.readFileSync(shipped, 'utf8'), shippedBefore);
  assert.equal(edit(f, { op: 'select', name: 'night._-1' }).ok, true);
  assert.equal(edit(f, { op: 'delete' }).ok, true);
  assert.deepEqual(stored(owner).hidden_presets, ['hydrogen', 'default'], 'a local-only name needs no hide');

  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: fs.realpathSync(f.cwd) }] });
  const project = join(f.cwd, '.hud/roles/imp.json'), run = [{ ...pi, model: 'synthetic/project' }];
  f.put(project, { ...f.own, run, presets: [{ name: 'hydrogen', run }] });
  assert.deepEqual(f.role().presets.map((p) => p.name), ['astra', 'local', 'hydrogen']);
  assert.deepEqual([f.role().preset, f.role().run], ['hydrogen', run], 'the project infers its own selector, not the owner null');
  assert.equal(edit(f, { op: 'select', name: null }).message, 'the project file is in force: o opens it');
});

test('cycling one already active preset does not rewrite the role file', (t) => {
  const f = fixture(t), chain = [{ ...pi, model: 'synthetic/one' }];
  const hidden_presets = f.role().presets.map((p) => p.name);
  f.put(f.file, { ...f.own, run: chain, hidden_presets, presets: [{ name: 'one', run: chain }] });
  const text = fs.readFileSync(f.file, 'utf8'), inode = fs.statSync(f.file).ino;
  for (const step of [1, -1]) assert.deepEqual(editPlaces(f.hud, f.cwd, { PATH: '' }, { role: 'imp', index: 0, op: 'preset', step }), { ok: true, index: 0 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  assert.equal(fs.statSync(f.file).ino, inode);
});

test('create and whole-chain saves only materialize the changed named chain and preserve raw options', (t) => {
  const f = fixture(t), { presets: _, ...shipped } = stored(join(bundled, 'roles/imp.json'));
  assert.equal(edit(f, { op: 'select', name: 'hydrogen' }).ok, true);
  assert.deepEqual(stored(f.file), { ...shipped, active_preset: 'hydrogen' });
  const authored = { name: 'own', run: [{ harness: 'pi', pi_args: ['--verbose'], extra: { nested: true } }] };
  f.put(f.file, { ...f.own, presets: [authored], active_preset: 'own' });
  const old = f.registry(), original = old.roles().get('imp'), revision = old.revision(original);
  assert.equal(edit(f, { op: 'create', name: 'copy', revision, run: old.editableRun(original) }).ok, true);
  assert.deepEqual(stored(f.file).presets, [authored, { ...authored, name: 'copy' }]);
  assert.equal(edit(f, { op: 'delete', revision }).message, 'Role changed on disk; reopen the action');
  const current = f.registry(), role = current.roles().get('imp');
  const run = current.editableRun(role).map((place) => ({ ...place, model: 'synthetic/new' }));
  assert.equal(edit(f, { op: 'run', run, revision: current.revision(role) }).ok, true);
  assert.deepEqual(stored(f.file), { ...f.own, active_preset: 'copy',
    presets: [authored, { name: 'copy', run: [{ ...authored.run[0], model: 'synthetic/new' }] }] });
});
