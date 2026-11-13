import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roleRegistry } from '../../dist/roles/roster.js';

function layout(root) {
  const bundled = join(root, 'bundled');
  const hud = join(root, 'hud');
  fs.mkdirSync(join(bundled, 'roles'), { recursive: true });
  fs.mkdirSync(join(hud, 'roles'), { recursive: true });
  return { bundled, hud };
}
const pi = (role, model) => ({
  role,
  harness: 'pi',
  pi_role: 'implementer',
  split: false,
  can_continue: true,
  ...(model ? { model } : {}),
});

test('a later valid role file overrides; a later invalid file does not remove it', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'roster-invalid-'));
  const { bundled, hud } = layout(root);
  const early = join(bundled, 'roles', 'early.json');
  const bad = join(hud, 'roles', 'bad.json');
  const late = join(hud, 'roles', 'late.json');
  fs.writeFileSync(early, JSON.stringify(pi('writer', 'early')));
  fs.writeFileSync(bad, JSON.stringify({ role: 'writer', harness: 'nope', note: 'SECRET_ROLE_FILE_BODY' }));
  fs.writeFileSync(late, JSON.stringify(pi('writer', 'late')));
  const order = {
    [join(bundled, 'roles')]: ['early.json'],
    [join(hud, 'roles')]: ['bad.json', 'late.json'],
  };
  const registry = roleRegistry(hud, root, {}, undefined, (dir) => order[dir] ?? [], bundled);
  assert.equal(registry.roles().get('writer').model, 'late');
  assert.equal(registry.roles().get('writer').source_file, late);
  assert.deepEqual(registry.invalid(), [{ path: bad, reason: 'unknown harness nope' }]);
  assert.equal(JSON.stringify(registry.invalid()).includes('SECRET_ROLE_FILE_BODY'), false);
  assert.equal(registry.invalidPath('writer'), null);

  const reversed = { [join(bundled, 'roles')]: ['early.json'], [join(hud, 'roles')]: ['late.json', 'bad.json'] };
  const after = roleRegistry(hud, root, {}, undefined, (dir) => reversed[dir] ?? [], bundled);
  assert.equal(after.roles().get('writer').model, 'late');
  assert.equal(after.roles().get('writer').source_file, late);
  assert.deepEqual(after.invalid(), [{ path: bad, reason: 'unknown harness nope' }]);
  assert.equal(after.invalidPath('writer'), null);

  const namedOnly = roleRegistry(
    hud,
    root,
    {},
    undefined,
    (dir) => (dir === join(hud, 'roles') ? ['bad.json', 'also-missing.json'] : []),
    bundled
  );
  assert.equal(namedOnly.roles().has('writer'), false);
  assert.equal(namedOnly.invalidPath('writer'), bad);
  fs.writeFileSync(join(hud, 'roles', 'also.json'), JSON.stringify({ role: 'writer', harness: 'cli' }));
  const both = roleRegistry(
    hud,
    root,
    {},
    undefined,
    (dir) => (dir === join(hud, 'roles') ? ['bad.json', 'also.json'] : []),
    bundled
  );
  assert.equal(both.invalidPath('writer'), join(hud, 'roles', 'also.json'));
  assert.equal(both.invalid()[1].reason, 'bad cli fields');
  fs.rmSync(root, { recursive: true, force: true });
});

test('JSON null is invalid and a file that vanishes between list and read is skipped', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'roster-null-'));
  const { bundled, hud } = layout(root);
  const gone = join(hud, 'roles', 'gone.json');
  const empty = join(hud, 'roles', 'empty.json');
  fs.writeFileSync(empty, 'null');
  fs.writeFileSync(join(bundled, 'roles', 'keep.json'), JSON.stringify(pi('keep')));
  const registry = roleRegistry(
    hud,
    root,
    {},
    undefined,
    (dir) => (dir === join(hud, 'roles') ? ['gone.json', 'empty.json'] : ['keep.json']),
    bundled
  );
  assert.equal(registry.roles().has('keep'), true);
  assert.deepEqual(registry.invalid(), [{ path: empty, reason: 'unparseable JSON' }]);
  assert.equal(
    registry.invalid().some((item) => item.path === gone),
    false
  );
  fs.rmSync(root, { recursive: true, force: true });
});
