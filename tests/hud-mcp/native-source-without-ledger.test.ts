import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { makeRecord } from '../../packages/hud-mcp/src/hook/command.js';
import { consumeHookRecord } from '../../packages/hud-mcp/src/hook/resolve.js';
import {
  hash,
  hookProfileFingerprint,
  IMPLEMENTATION,
  publishRecord,
  recordPaths,
  type HookConfig,
} from '../../packages/hud-mcp/src/hook/record.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import type { DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import type { ProcessInfo } from '../../packages/hud-mcp/src/process.js';
import type { Registration } from '../../packages/hud-mcp/src/registry.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';

const A = '01900000-0000-7000-8000-000000000001';
const B = '01900000-0000-7000-8000-000000000002';
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-native-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const domain = deriveProcessDomain({
    machineId: 'synthetic-machine',
    bootId: 'synthetic-boot',
    pidNamespace: 'synthetic-ns',
  });
  const sourceId = hash(['claude', root]);
  const processKey = JSON.stringify(['claude', sourceId, domain.pidDomain, process.pid, '100']);
  const profile = {
    name: 'synthetic',
    harness: 'claude',
    source: { root, label: 'Synthetic' },
    env: {},
    mcpServerName: 'hud',
    callSource: { kind: 'claude_pre_tool_use_v1' },
  } as unknown as DelegateProfile;
  const config: HookConfig = {
    version: 1,
    implementation: IMPLEMENTATION,
    claudeExecutable: realpathSync(process.execPath),
    sourceRoot: root,
    directory: root,
    serverName: 'hud',
    profileFingerprint: hookProfileFingerprint(profile),
    clockTicksPerSecond: 100,
  };
  const launch = {
    processKey,
    sourceId,
    bootId: domain.bootId,
    harnessPid: process.pid,
    harnessStart: '100',
    claudePidDomain: domain.claudePidDomain,
    hookStartMonoMs: Number(process.hrtime.bigint()) / 1e6 - 10,
    hookStartUncertaintyMs: 10,
  };
  const input = (sessionId = A, callId = 'same-call') => ({
    hook_event_name: 'PreToolUse',
    tool_use_id: callId,
    tool_name: 'mcp__hud__managed_list',
    session_id: sessionId,
  });
  const record = (sessionId = A, callId = 'same-call') => makeRecord(config, input(sessionId, callId), launch);
  const expected = (sessionId = A, callId = 'same-call') => ({
    processKey,
    sourceId,
    bootId: domain.bootId,
    sessionId,
    callId,
    toolName: 'mcp__hud__managed_list',
  });
  const parent: ProcessInfo = {
    pid: process.pid,
    ppid: 1,
    procStart: '100',
    argv: ['claude'],
    env: { CLAUDE_CONFIG_DIR: root },
    pidNamespace: 'synthetic-ns',
  };
  const self: ProcessInfo = { ...parent, pid: 12, ppid: parent.pid, procStart: '120', argv: ['node'], env: {} };
  const reader = { get: (pid: number) => structuredClone(pid === self.pid ? self : parent), domain: () => domain };
  const registration: Registration = {
    caller: {
      callerId: 'synthetic',
      instanceKind: 'dedicated',
      harness: 'claude',
      sourceId,
      pid: 12,
      ppid: process.pid,
      procStart: '120',
      parentProcStart: '100',
      cwd: root,
      envPane: null,
      startedAt: 1,
      lastSeenAt: 1,
      retiredAt: null,
    },
    source: { harness: 'claude', sourceId, rootPath: root, label: 'Synthetic' },
    harnessPid: process.pid,
    harnessProcStart: '100',
  };
  mkdirSync(join(root, 'sessions'));
  const registry = (sessionId = A) =>
    writeFileSync(
      join(root, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, procStart: '100', pidDomain: domain.claudePidDomain, sessionId, cwd: root }),
      { mode: 0o600 }
    );
  registry();
  const resolver = new SessionRefResolver(
    registration,
    reader,
    profile,
    undefined,
    { config },
    {
      read: () => {
        throw new Error('HUD scopes must not be read');
      },
    }
  );
  const resolve = (callId = 'same-call') => resolver.resolve({ 'claudecode/toolUseId': callId }, 'managed_list');
  return { root, config, launch, input, record, expected, registry, resolve, reader, registration, profile };
}

test('native hook emits no scope and resolves without a ledger, even with a poisoned legacy scope reader', async (t) => {
  const f = fixture(t);
  const record = f.record();
  assert.equal(Object.hasOwn(record, 'premise'), false);
  assert.equal(Object.hasOwn(f.config, 'ledgerPath'), false);
  publishRecord(f.config, record);
  const result = await f.resolve();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sessionRef.sessionId, A);
    assert.equal(result.scopePremise, undefined);
  }
  assert.equal(existsSync(join(f.root, 'ledger.sqlite')), false);
  writeFileSync(join(f.root, 'ledger.sqlite'), 'not SQLite; do not read or change');
  publishRecord(f.config, f.record(A, 'next'));
  assert.equal((await f.resolve('next')).ok, true);
  assert.equal(readFileSync(join(f.root, 'ledger.sqlite'), 'utf8'), 'not SQLite; do not read or change');
});

test('same-process native A/B calls with identical call IDs have independent one-shot namespaces', (t) => {
  const f = fixture(t);
  const a = f.record(A),
    b = f.record(B);
  assert.notEqual(recordPaths(f.config, a, a.toolUseId).record, recordPaths(f.config, b, b.toolUseId).record);
  publishRecord(f.config, a);
  publishRecord(f.config, b);
  assert.equal(consumeHookRecord({ config: f.config }, f.expected(A)).record.sessionId, A);
  assert.equal(consumeHookRecord({ config: f.config }, f.expected(B)).record.sessionId, B);
  assert.throws(() => consumeHookRecord({ config: f.config }, f.expected(A)));
  assert.throws(() => consumeHookRecord({ config: f.config }, f.expected(B)));
});

test('native A evidence cannot authorize current B; switch during consumption is rejected', async (t) => {
  const f = fixture(t);
  publishRecord(f.config, f.record(A));
  f.registry(B);
  assert.equal((await f.resolve()).ok, false);
  f.registry(A);
  assert.equal((await f.resolve()).ok, true);
  const switching = new SessionRefResolver(f.registration, f.reader, f.profile, undefined, {
    config: f.config,
    observe: () => f.registry(B),
  });
  publishRecord(f.config, f.record(A, 'switch'));
  assert.equal((await switching.resolve({ 'claudecode/toolUseId': 'switch' }, 'managed_list')).ok, false);
});

test('native one-shot evidence still rejects missing-late, duplicates, wrong tool, process, boot and child source', (t) => {
  const f = fixture(t);
  assert.throws(() => consumeHookRecord({ config: f.config }, f.expected(A, 'late')));
  assert.throws(() => publishRecord(f.config, f.record(A, 'late')));
  const duplicate = f.record(A, 'duplicate');
  publishRecord(f.config, duplicate);
  assert.throws(() => publishRecord(f.config, duplicate));
  assert.throws(() => consumeHookRecord({ config: f.config }, f.expected(A, 'duplicate')));
  for (const field of ['toolName', 'processKey', 'bootId'] as const) {
    const record = f.record(A, field);
    publishRecord(f.config, record);
    assert.throws(() => consumeHookRecord({ config: f.config }, { ...f.expected(A, field), [field]: 'forged' }));
  }
  publishRecord(
    f.config,
    makeRecord(f.config, { ...f.input(A, 'child'), agent_id: 'native-child', agent_type: 'Explore' }, f.launch)
  );
  assert.throws(() => consumeHookRecord({ config: f.config }, f.expected(A, 'child')), /Native child/);
});

for (const corrupt of [false, true]) {
  test(`default main neither imports SQLite nor creates/reads ledger (existing corrupt ledger=${corrupt})`, (t) => {
    const f = fixture(t);
    if (corrupt) writeFileSync(join(f.root, 'ledger.sqlite'), 'synthetic corrupt ledger');
    const guard = join(f.root, 'guard.mjs');
    writeFileSync(
      guard,
      `export function resolve(s,c,next){if(s==='node:sqlite'||/ledger-scope-read|ledger-registry|\\/ledger\\/|\\/ledger\\.js$/.test(s))throw Error('forbidden ledger dependency '+s);return next(s,c);}`
    );
    const main = fileURLToPath(new URL('../../packages/hud-mcp/src/main.js', import.meta.url));
    const result = spawnSync(process.execPath, ['--loader', guard, main], {
      env: { HOME: f.root, HUD_HOME: f.root },
      input: [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'managed_list', arguments: {} } },
      ]
        .map((message) => JSON.stringify(message) + '\n')
        .join(''),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const replies = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reply = replies.find((reply) => reply.id === 1);
    assert.equal(replies.find((reply) => reply.id === 2).result.structuredContent.code, 'identity_source_missing');
    assert.ok(reply.result.tools.some((tool: { name: string }) => tool.name === 'managed_create'));
    assert.equal(existsSync(join(f.root, 'ledger.sqlite')), corrupt);
    if (corrupt) assert.equal(readFileSync(join(f.root, 'ledger.sqlite'), 'utf8'), 'synthetic corrupt ledger');
  });
}

test('native hook publisher runs under a real synthetic parent without loading or touching a ledger', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'ledger.sqlite'), 'untouched corrupt database');
  const configPath = join(f.root, 'hook.json');
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const guard = join(f.root, 'hook-guard.mjs');
  writeFileSync(
    guard,
    `export function resolve(s,c,next){if(s==='node:sqlite'||/ledger-scope-read|ledger-registry|\\/ledger\\/|\\/ledger\\.js$/.test(s))throw Error('forbidden database dependency');return next(s,c);}`
  );
  const driver = join(f.root, 'native-parent.mjs');
  const processModule = new URL('../../packages/hud-mcp/src/hook/process.js', import.meta.url).href;
  const domainModule = new URL('../../src/core/process-domain.js', import.meta.url).href;
  const commandModule = new URL('../../packages/hud-mcp/src/hook/command.js', import.meta.url).href;
  const childCode = `const {runHook}=await import(${JSON.stringify(commandModule)}); await runHook(${JSON.stringify(configPath)});`;
  writeFileSync(
    driver,
    `
    import {spawnSync} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    import {proc} from ${JSON.stringify(processModule)};
    import {readProcessDomain} from ${JSON.stringify(domainModule)};
    const stamp=proc(process.pid), domain=readProcessDomain();
    writeFileSync(${JSON.stringify(join(f.root, 'sessions'))}+'/'+process.pid+'.json',JSON.stringify({pid:process.pid,procStart:stamp.start,pidDomain:domain.claudePidDomain,sessionId:${JSON.stringify(A)},cwd:${JSON.stringify(f.root)}}),{mode:0o600});
    const result=spawnSync(process.execPath,['--loader',${JSON.stringify(guard)},'--input-type=module','-e',${JSON.stringify(childCode)}],{env:process.env,input:${JSON.stringify(JSON.stringify(f.input(A, 'native-publish')))},encoding:'utf8'});
    if(result.status!==0) process.stderr.write(result.stderr); process.exitCode=result.status??1;
  `
  );
  const result = spawnSync(process.execPath, [driver], {
    argv0: 'claude',
    env: { HOME: f.root, HUD_HOME: f.root, CLAUDE_CONFIG_DIR: f.root },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const namespace = readdirSync(f.root).find((name) => /^[a-f0-9]{64}$/.test(name));
  assert.ok(namespace);
  const files = readdirSync(join(f.root, namespace)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(f.root, namespace, files[0]), 'utf8'));
  assert.equal(record.sessionId, A);
  assert.equal(record.toolUseId, 'native-publish');
  assert.equal(Object.hasOwn(record, 'premise'), false);
  assert.equal(readFileSync(join(f.root, 'ledger.sqlite'), 'utf8'), 'untouched corrupt database');
});
