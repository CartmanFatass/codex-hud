import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../src/core/canonical.js';
import {
  observeWindowsPolicy,
  sameWindowsPolicy,
  type WindowsPolicyPorts,
  type WindowsPolicySystem,
} from '../../src/cli/claude-windows-policy.js';

function fixture() {
  const system: WindowsPolicySystem = {
    observerExe: '/synthetic/windows/Windows/System32/reg.exe',
    managedRoot: '/synthetic/windows/Program Files/ClaudeCode',
    executableIdentity: 'synthetic-native-system-executable-and-acl',
    interopIdentity: 'synthetic-interop-and-mount',
  };
  const registry: Record<string, Record<string, unknown> | null> = { HKLM: null, HKCU: null };
  const files = new Map<string, Record<string, unknown> | string[]>();
  const queries: string[] = [];
  const reads: string[] = [];
  const ports: WindowsPolicyPorts = {
    system: () => structuredClone(system),
    registry: (hive) => {
      queries.push(hive);
      const value = registry[hive];
      return value === null
        ? { state: 'missing', code: 2 }
        : { state: 'value', code: 0, kind: 1, data: JSON.stringify(value) };
    },
    read: (path) => {
      reads.push(path);
      const value = files.get(path);
      return {
        receipt: {
          state: value === undefined ? 'missing' : Array.isArray(value) ? 'directory' : 'file',
          fingerprint: value === undefined ? null : digest(value),
        },
        value: value === undefined || Array.isArray(value) ? null : value,
        entries: Array.isArray(value) ? value : null,
      };
    },
  };
  return { ports, system, registry, files, queries, reads };
}

test('Claude Windows policy captures explicit absence and bounded read-only queries without guessed system paths', () => {
  assert.equal(observeWindowsPolicy('2.1.305').reason, 'configuration_windows_host_not_wsl');
  const f = fixture();
  const before = observeWindowsPolicy('2.1.305', f.ports);
  assert.equal(before.reason, null);
  assert.ok(before.observation);
  assert.equal(before.observation.inheritance, false);
  assert.equal(before.observation.localChain, 'linux');
  assert.equal(before.observation.hkcuEligible, false);
  assert.deepEqual(
    before.observation.registry.map((entry) => entry.state),
    ['missing', 'missing']
  );
  assert.equal(f.queries.length, 2);
  assert.equal(f.reads.length, 3);
  assert.equal(sameWindowsPolicy(before.observation, observeWindowsPolicy('2.1.305', f.ports).observation), true);
  f.registry.HKLM = { wslInheritsWindowsSettings: true, hooks: { Stop: [] } };
  const changed = observeWindowsPolicy('2.1.305', f.ports).observation;
  assert.equal(changed?.localChain, 'windows-admin');
  assert.equal(sameWindowsPolicy(before.observation, changed), false);
  assert.equal(sameWindowsPolicy(before.observation, null), false);
});

test('Claude Windows inheritance accounts for controls, admin documents, drop-ins and conditional HKCU', () => {
  const f = fixture();
  f.registry.HKCU = { wslInheritsWindowsSettings: true, hooks: {} };
  assert.equal(observeWindowsPolicy('2.1.305', f.ports).observation?.inheritance, false);
  f.registry.HKLM = { wslInheritsWindowsSettings: 'true' };
  let result = observeWindowsPolicy('2.1.305', f.ports).observation!;
  assert.equal(result.inheritance, true);
  assert.equal(result.localChain, 'linux');
  assert.equal(result.hkcuEligible, true);
  const directory = f.system.managedRoot + '/managed-settings.d';
  f.files.set(directory, ['10-control.json', '20-policy.json', '.ignored.json', 'README']);
  f.files.set(directory + '/10-control.json', { wslInheritsWindowsSettings: true });
  f.files.set(directory + '/20-policy.json', { permissions: { deny: ['Bash(synthetic)'] } });
  result = observeWindowsPolicy('2.1.305', f.ports).observation!;
  assert.equal(result.localChain, 'windows-admin');
  assert.equal(result.hkcuEligible, false);
  assert.equal(result.files.length, 5);
  f.files.set(directory + '/20-policy.json', { permissions: { deny: ['Bash(changed)'] } });
  assert.equal(sameWindowsPolicy(result, observeWindowsPolicy('2.1.305', f.ports).observation), false);
  f.registry.HKLM = { wslInheritsWindowsSettings: false };
  assert.equal(observeWindowsPolicy('2.1.305', f.ports).reason, 'configuration_windows_inheritance_conflict');
});

test('Claude Windows access, interop, expansion, limits, identity races and uncovered selection remain unknown', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.ports.system = () => null;
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.registry = () => ({ state: 'denied', code: 5 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.registry = () => ({ state: 'error', code: 1 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.registry = () => {
        throw new Error('synthetic timeout with private data');
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.registry = () => ({ state: 'value', code: 0, kind: 1, data: 'x'.repeat(262145) });
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.registry = () => ({ state: 'value', code: 0, kind: 2, data: '{"env":{"VALUE":"%SECRET%"}}' });
    },
    (f: ReturnType<typeof fixture>) => {
      f.registry.HKLM = { wslInheritsWindowsSettings: 'invalid' };
    },
    (f: ReturnType<typeof fixture>) => {
      f.files.set(
        f.system.managedRoot + '/managed-settings.d',
        Array.from({ length: 17 }, (_, n) => `${n}.json`)
      );
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.read = () => {
        throw new Error('configuration_unreadable');
      };
    },
    (f: ReturnType<typeof fixture>) => {
      const query = f.ports.registry;
      f.ports.registry = (...args) => {
        const result = query(...args);
        f.system.executableIdentity = 'replaced';
        return result;
      };
    },
  ]) {
    const f = fixture();
    change(f);
    const result = observeWindowsPolicy('2.1.305', f.ports);
    assert.equal(result.observation, null);
    assert.match(result.reason!, /^configuration_windows_|^configuration_unreadable$/);
    assert.equal(JSON.stringify(result).includes('private data'), false);
  }
  const f = fixture();
  assert.equal(observeWindowsPolicy('2.1.306', f.ports).reason, 'configuration_windows_version_uncovered');
  assert.equal(f.queries.length, 0);
  assert.equal(f.reads.length, 0);
});
