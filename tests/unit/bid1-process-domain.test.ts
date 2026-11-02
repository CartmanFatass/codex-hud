import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ProcessDomainError,
  callerPidDomain,
  claudeRegistryPidDomain,
  deriveProcessDomain,
  readProcessDomain,
  readProcessDomainInputs,
  runPidDomain,
  validateProcessDomainInputs,
  type ProcessDomainInputs,
} from '../../src/core/process-domain.js';
import { currentDomain } from '../../src/core/run/process.js';
import { LinuxProcessReader } from '../../packages/hud-mcp/src/process.js';
import { Refusal } from '../../packages/hud-mcp/src/errors.js';
import { verifiedLaunchDomain } from '../../packages/hud-mcp/src/hook/process.js';

const inputs: ProcessDomainInputs = {
  machineId: 'synthetic-machine-id-0123456789',
  bootId: 'synthetic-boot-id',
  pidNamespace: 'pid:[4026531836]',
};
// Literal bytes, not a re-derivation: existing ledger rows, receipts and ProcessKeys must still match.
const callerBytes = '["linux","synthetic-machine-id-0123456789","synthetic-boot-id","pid:[4026531836]"]';
const runBytes = '8215e956f91dfd6f9f4660d38295ece9e41def019bd3483839e5e4ae480f415b:pid:[4026531836]';
const claudeBytes = 'linux:synthetic-machine-id-0123456789:pid:[4026531836]';

test('BID1 three pid-domain encodings keep their exact bytes', () => {
  assert.equal(callerPidDomain(inputs), callerBytes);
  assert.equal(runPidDomain(inputs), runBytes);
  assert.equal(claudeRegistryPidDomain(inputs), claudeBytes);
  assert.deepEqual(deriveProcessDomain(inputs), {
    bootId: 'synthetic-boot-id',
    pidDomain: callerBytes,
    runPidDomain: runBytes,
    claudePidDomain: claudeBytes,
  });
  // The three forms describe the same facts but are never interchangeable strings.
  assert.notEqual(callerBytes, runBytes);
  assert.notEqual(callerBytes, claudeBytes);
  assert.notEqual(runBytes, claudeBytes);
});

test('BID1 machine and boot whitespace is trimmed exactly as the previous producers did', () => {
  const padded: ProcessDomainInputs = {
    machineId: '  synthetic-machine-id-0123456789\n',
    bootId: '\tsynthetic-boot-id \n',
    pidNamespace: inputs.pidNamespace,
  };
  assert.deepEqual(validateProcessDomainInputs(padded), inputs);
  assert.equal(callerPidDomain(padded), callerBytes);
  assert.equal(runPidDomain(padded), runBytes);
  assert.equal(claudeRegistryPidDomain(padded), claudeBytes);
});

test('BID1 boot changes only the caller form; namespace changes every form', () => {
  const otherBoot = deriveProcessDomain({ ...inputs, bootId: 'synthetic-boot-id-2' });
  assert.notEqual(otherBoot.pidDomain, callerBytes);
  assert.equal(otherBoot.runPidDomain, runBytes);
  assert.equal(otherBoot.claudePidDomain, claudeBytes);

  const otherNamespace = deriveProcessDomain({ ...inputs, pidNamespace: 'pid:[4026531999]' });
  assert.notEqual(otherNamespace.pidDomain, callerBytes);
  assert.notEqual(otherNamespace.runPidDomain, runBytes);
  assert.notEqual(otherNamespace.claudePidDomain, claudeBytes);

  const otherMachine = deriveProcessDomain({ ...inputs, machineId: 'synthetic-machine-id-2' });
  assert.notEqual(otherMachine.pidDomain, callerBytes);
  assert.notEqual(otherMachine.runPidDomain, runBytes);
  assert.notEqual(otherMachine.claudePidDomain, claudeBytes);
});

test('BID1 empty or blank machine, boot or namespace is invalid, never guessed', () => {
  const derive = [callerPidDomain, runPidDomain, claudeRegistryPidDomain, deriveProcessDomain];
  for (const field of ['machineId', 'bootId', 'pidNamespace'] as const)
    for (const value of ['', '   ', '\n\t'])
      for (const fn of derive)
        assert.throws(
          () => fn({ ...inputs, [field]: value }),
          (error) => error instanceof ProcessDomainError && error.reason === 'invalid',
          `${field}=${JSON.stringify(value)} must be refused`
        );
});

test('BID1 MCP domain read maps invalid evidence to registration_unverified', () => {
  const reader = new LinuxProcessReader(() =>
    deriveProcessDomain({ machineId: '', bootId: inputs.bootId, pidNamespace: inputs.pidNamespace })
  );
  assert.throws(
    () => reader.domain(),
    (error) => error instanceof Refusal && error.code === 'registration_unverified'
  );
});

test(
  'BID1 MCP and run producers agree with the shared module on this host',
  { skip: process.platform === 'linux' ? false : 'Linux procfs required' },
  () => {
    const hostInputs = readProcessDomainInputs();
    const view = deriveProcessDomain(hostInputs);
    assert.deepEqual(readProcessDomain(), view);
    assert.deepEqual(new LinuxProcessReader().domain(), view);
    assert.deepEqual(currentDomain(), { boot_id: view.bootId, pid_domain: view.runPidDomain });
    assert.equal(new LinuxProcessReader().domain().runPidDomain, currentDomain().pid_domain);
  }
);

test(
  'BID1 run machine-id policy follows a readable symlink; blank or unreadable inputs still refuse',
  { skip: process.platform === 'linux' ? false : 'Linux procfs required' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'hud-bid1-domain-'));
    try {
      const target = join(root, 'machine-id');
      const link = join(root, 'machine-id-link');
      const blank = join(root, 'blank');
      const missing = join(root, 'missing');
      writeFileSync(target, 'synthetic-machine-id-0123456789\n', { mode: 0o600 });
      symlinkSync(target, link);
      writeFileSync(blank, ' \n', { mode: 0o600 });

      const targetRun = currentDomain({ machineIdPath: target });
      const linkRun = currentDomain({ machineIdPath: link });
      assert.deepEqual(linkRun, targetRun);
      assert.equal(linkRun.pid_domain, runPidDomain(readProcessDomainInputs({ machineIdPath: target })));

      // MCP and the hook keep their existing no-follow policy.
      assert.throws(
        () => readProcessDomain({ machineIdPath: link }),
        (error) => error instanceof ProcessDomainError && error.reason === 'unreadable'
      );
      assert.throws(
        () => new LinuxProcessReader(() => readProcessDomain({ machineIdPath: link })).domain(),
        (error) => error instanceof Refusal && error.code === 'registration_unverified'
      );
      assert.throws(
        () => readProcessDomainInputs({ machineIdPath: link }),
        (error) => error instanceof ProcessDomainError && error.reason === 'unreadable'
      );

      // The run path still refuses blank or unreadable resolved content.
      assert.throws(
        () => currentDomain({ machineIdPath: blank }),
        (error) => error instanceof ProcessDomainError && error.reason === 'invalid'
      );
      assert.throws(
        () => currentDomain({ machineIdPath: missing }),
        (error) => error instanceof ProcessDomainError && error.reason === 'unreadable'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test('BID1 hook launch derivation agrees with the shared module and refuses a foreign namespace', () => {
  const view = deriveProcessDomain(inputs);
  assert.deepEqual(verifiedLaunchDomain(inputs, inputs.pidNamespace), {
    pidDomain: view.pidDomain,
    claudePidDomain: view.claudePidDomain,
  });
  assert.throws(() => verifiedLaunchDomain(inputs, 'pid:[4026531999]'), /Wrong Claude source\/domain/);
});

test('BID1 process-domain adds one node-only module to the hook graph', () => {
  const source = readFileSync(new URL('../../../src/core/process-domain.ts', import.meta.url), 'utf8');
  const runtimeImports = source
    .split('\n')
    .filter((line) => line.startsWith('import ') && !line.startsWith('import type '))
    .map((line) => /from '([^']+)'/.exec(line)?.[1]);
  assert.deepEqual(runtimeImports, ['node:crypto', 'node:fs']);
  const hook = readFileSync(new URL('../../../packages/hud-mcp/src/hook/process.ts', import.meta.url), 'utf8');
  assert.match(hook, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/core\/process-domain\.js'/);
  assert.doesNotMatch(hook, /src\/core\/run\//);
});
