import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import {
  actualSourceRoot,
  inferHarness,
  LinuxProcessReader,
  type ProcessInfo,
  type ProcessReaderPort,
} from '../../packages/hud-mcp/src/process.js';
import { MemoryCallerRegistry, registerCaller } from '../../packages/hud-mcp/src/registry.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';

function fixture(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-pi-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function pi(argv: string[], env: Record<string, string> = {}): ProcessInfo {
  return { pid: 10, ppid: 1, procStart: '100', argv: ['pi', ...argv], env, pidNamespace: 'pid:[synthetic]' };
}

test('Pi source diagnosis accepts a first split selector after the executable or direct Node entrypoint', (t) => {
  const root = fixture(t);
  for (const prefix of [['pi'], ['/synthetic/bin/pi'], ['node', '/synthetic/pi-coding-agent/dist/cli.js']]) {
    const process = { ...pi([]), argv: [...prefix, '--session-dir', root, '--mode', 'rpc'] };
    assert.equal(inferHarness(process), 'pi');
    assert.equal(actualSourceRoot(process, 'pi'), root);
  }
  const withSpace = join(root, 'synthetic directory=one');
  mkdirSync(withSpace);
  assert.equal(actualSourceRoot(pi(['--session-dir', withSpace]), 'pi'), withSpace);
});

test('Pi source diagnosis rejects equals selectors and ambiguous placement after earlier options or prompt text', (t) => {
  const root = fixture(t);
  for (const argv of [
    ['pi', `--session-dir=${root}`],
    ['node', '/synthetic/pi-coding-agent/dist/cli.js', `--session-dir=${root}`],
    ['pi', '--system-prompt', '--session-dir', root],
    ['pi', '--mode', 'rpc', '--session-dir', root],
    ['pi', 'synthetic prompt', '--session-dir', root],
    ['node', '/synthetic/pi-coding-agent/dist/cli.js', '--system-prompt', '--session-dir', root],
    ['node', '--require', '/synthetic/pi-coding-agent/dist/cli.js', '--session-dir', root],
    ['node', '--eval=/synthetic/pi-coding-agent/dist/cli.js', '--session-dir', root],
  ]) {
    assert.equal(actualSourceRoot({ ...pi([]), argv }, 'pi'), null, JSON.stringify(argv));
  }
});

test('Pi source diagnosis never guesses from environment, cwd, session files or similarly named options', (t) => {
  const root = fixture(t);
  const env = { HOME: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root };
  mkdirSync(join(root, '.pi', 'agent', 'sessions'), { recursive: true });
  const file = join(root, 'synthetic-session.jsonl');
  writeFileSync(file, '{"type":"session","id":"synthetic"}\n');
  for (const argv of [
    [],
    [root],
    ['--session', file],
    ['--session-id', 'synthetic'],
    ['--session-directory', root],
    [`--session-directory=${root}`],
    ['--role', 'synthetic', '--orchestrator'],
  ]) {
    assert.equal(actualSourceRoot(pi(argv, env), 'pi'), null, JSON.stringify(argv));
  }
});

test('Pi source diagnosis rejects duplicate and missing selectors, including mixed argument forms', (t) => {
  const root = fixture(t);
  const other = join(root, 'other');
  mkdirSync(other);
  for (const argv of [
    ['--session-dir'],
    ['--session-dir='],
    ['--session-dir', '', root],
    ['--session-dir', '--session', root],
    ['--session-dir', root, '--session-dir', root],
    [`--session-dir=${root}`, `--session-dir=${root}`],
    ['--session-dir', root, `--session-dir=${other}`],
    [`--session-dir=${root}`, '--session-dir', other],
    ['--session-dir', root, '--session-dir'],
    ['--', '--session-dir', root],
    ['--session-dir', root, '--', 'synthetic prompt'],
  ]) {
    assert.equal(actualSourceRoot(pi(argv), 'pi'), null, JSON.stringify(argv));
  }
});

test('Pi source diagnosis rejects relative, noncanonical, missing and nondirectory roots', (t) => {
  const root = fixture(t);
  const child = join(root, 'child');
  mkdirSync(child);
  const file = join(root, 'file');
  writeFileSync(file, 'synthetic');
  for (const value of [
    '.',
    relative(process.cwd(), root),
    '~/sessions',
    '$HOME/sessions',
    `${root}/`,
    `${root}/.`,
    `${root}//child`,
    `${child}/..`,
    join(root, 'missing'),
    file,
    `${root}\0ignored`,
  ]) {
    for (const argv of [['--session-dir', value], [`--session-dir=${value}`]]) {
      assert.equal(actualSourceRoot(pi(argv), 'pi'), null, JSON.stringify(argv));
    }
  }
});

test('Pi source diagnosis rejects symlinks at the root and in ancestor components', (t) => {
  const root = fixture(t);
  const target = join(root, 'target');
  mkdirSync(join(target, 'child'), { recursive: true });
  const alias = join(root, 'alias');
  symlinkSync(target, alias, 'dir');
  for (const value of [alias, join(alias, 'child')]) {
    assert.equal(actualSourceRoot(pi(['--session-dir', value]), 'pi'), null);
  }
  assert.equal(actualSourceRoot(pi(['--session-dir', target]), 'pi'), target);
});

test('Codex and Claude source diagnosis retains explicit, HOME fallback and canonicalization behavior', (t) => {
  const root = fixture(t);
  for (const harness of ['codex', 'claude'] as const) {
    const homeRoot = join(root, harness === 'codex' ? '.codex' : '.claude');
    mkdirSync(homeRoot);
    const explicitRoot = join(root, `${harness}-explicit`);
    mkdirSync(explicitRoot);
    const alias = join(root, `${harness}-alias`);
    symlinkSync(explicitRoot, alias, 'dir');
    const key = harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const process = { ...pi(['--session-dir', 'irrelevant']), argv: [harness] };
    assert.equal(actualSourceRoot({ ...process, env: {} }, harness), null);
    assert.equal(actualSourceRoot({ ...process, env: { HOME: root } }, harness), homeRoot);
    assert.equal(actualSourceRoot({ ...process, env: { HOME: root, [key]: alias } }, harness), explicitRoot);
    assert.equal(actualSourceRoot({ ...process, env: { HOME: root, [key]: `${root}/missing` } }, harness), null);
  }
});

test('Linux process reader preserves empty argv values and removes only the procfs terminator', async (t) => {
  const root = fixture(t);
  const argv = ['--eval', 'setTimeout(() => {}, 60_000)', '--', '--session-dir', '', root, ''];
  const child = spawn(process.execPath, argv, {
    env: { HOME: root, HUD_HOME: join(root, 'hud') },
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  try {
    await once(child, 'spawn');
    const info = new LinuxProcessReader().get(child.pid!);
    assert.deepEqual(info.argv, [process.execPath, ...argv]);
    assert.equal(info.ppid, process.pid);
    assert.equal(info.env.HOME, root);
    assert.equal(actualSourceRoot({ ...info, argv: ['pi', ...info.argv.slice(4)] }, 'pi'), null);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
});

test('Pi source registration stays diagnostic and the default per-call resolver stays unsupported', async (t) => {
  const root = fixture(t);
  const harness = pi(['--session-dir', root]);
  const caller = { ...pi([]), pid: 11, ppid: 10, procStart: '110', argv: ['node', 'synthetic-mcp'] };
  const reader: ProcessReaderPort = {
    get: (pid) => structuredClone(pid === caller.pid ? caller : harness),
    domain: () =>
      deriveProcessDomain({
        machineId: 'synthetic-machine',
        bootId: 'synthetic-boot',
        pidNamespace: harness.pidNamespace,
      }),
  };
  const profile: DelegateProfile = {
    name: 'synthetic-pi',
    harness: 'pi',
    source: { root, label: 'Synthetic Pi' },
    launch: { argv: ['pi', '--session-dir', root, '{{prompt}}'] },
    headless: null,
    resume: null,
    resumeHeadless: null,
    host: { kind: 'none', layout: 'none' },
    env: {},
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
  };
  const registry = new MemoryCallerRegistry();
  const registration = await registerCaller({
    reader,
    registry,
    profile,
    pid: caller.pid,
    cwd: () => root,
    envPane: null,
    nowMs: 1000,
  });
  assert.equal(registration.source?.rootPath, root);
  assert.equal(registration.source?.harness, 'pi');
  assert.equal(registry.sources.length, 1);
  const resolver = new SessionRefResolver(registration, reader, profile);
  assert.deepEqual(await resolver.resolve({ callId: 'synthetic-call' }, 'delegate_whoami'), {
    ok: false,
    code: 'unsupported',
  });
});
