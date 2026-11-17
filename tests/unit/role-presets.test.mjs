import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { currentPreset, roleRegistry } from '../../dist/roles/roster.js';
import { editPlaces } from '../../dist/roles/role-control.js';

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
  assert.deepEqual(f.role().presets.map((p) => p.name), ['default', 'grok', 'hydrogen']);
  const override = { name: 'grok', run: [{ ...pi, model: 'owner/model' }] };
  f.put(f.file, { ...f.own, presets: [override, { name: 'mine._-1', run: [pi] }] });
  assert.deepEqual(f.role().presets.map((p) => p.name), ['default', 'grok', 'hydrogen', 'mine._-1']);
  assert.deepEqual(f.role().presets[1], override);
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: fs.realpathSync(f.cwd), registered_at: '2026-11-17T00:00:00Z' }] });
  f.put(join(f.cwd, '.hud/roles/imp.json'), { ...f.own, presets: [{ name: 'grok', run: [{ ...pi, model: 'project/model' }] }] });
  assert.equal(f.role().presets[1].run[0].model, 'project/model');
  assert.equal(f.role().presets.length, 4);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.deepEqual(editPlaces(f.hud, f.cwd, { PATH: '' }, { role: 'imp', index: 0, op: 'preset' }), { ok: false, message: 'the project file is in force: o opens it' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const projectFile = join(f.cwd, '.hud/roles/imp.json');
  f.put(projectFile, { ...f.own, presets: [{ name: 'cli', run: [{ harness: 'cli', agent: 'agy' }] }] });
  assert.deepEqual(f.registry().invalid(), [{ path: projectFile, reason: 'project roles are pi only' }]);
});

test('applying a preset replaces the whole run, preserves owner fields, and equality ignores key order but not place order', (t) => {
  const f = fixture(t), preset = { name: 'mine', run: [{ ...pi, model: 'owner/model', lens: false, pi_args: ['--verbose'] }] };
  f.put(f.file, { ...f.own, presets: [preset] });
  const edit = (step) => editPlaces(f.hud, f.cwd, { PATH: '' }, { role: 'imp', index: 0, op: 'preset', step });
  assert.deepEqual(edit(-1), { ok: true, index: 0 }, 'custom goes back to last');
  const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(stored, { ...f.own, presets: [preset], run: preset.run });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(currentPreset(f.role()), 'mine');
  assert.deepEqual(edit(1), { ok: true, index: 0 }, 'last wraps to default');
  assert.equal(currentPreset(f.role()), 'default');
  const r = f.role();
  assert.equal(currentPreset({ ...r, run: r.run.map((p) => Object.fromEntries(Object.entries(p).reverse())) }), 'default');
  assert.equal(currentPreset({ ...r, run: [...r.run].reverse() }), null);
  assert.equal(currentPreset({ ...r, run: [{ ...pi, thinking: 'high' }] }), null);
  assert.equal(currentPreset({ run: [pi] }), null);
});
