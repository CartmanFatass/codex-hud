import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { validateDelegateConfig, loadDelegateConfig, type DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import {
  MemoryCallerRegistry,
  FileCallerRegistry,
  registerCaller,
  type Registration,
} from '../../packages/hud-mcp/src/registry.js';
import { LinuxProcessReader, type ProcessInfo, type ProcessReaderPort } from '../../packages/hud-mcp/src/process.js';
import { SessionRefResolver, exactClaudeCallRecords, resolvePiSession } from '../../packages/hud-mcp/src/resolvers.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { TOOLS } from '../../packages/hud-mcp/src/tools.js';
import { makeSourceId } from '../../src/core/identity.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import { Refusal } from '../../packages/hud-mcp/src/errors.js';

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-mcp-test-')));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
function profile(root: string, harness: 'claude' | 'codex' | 'pi' = 'codex'): DelegateProfile {
  return {
    name: 'synthetic',
    harness,
    source: { root, label: 'Synthetic' },
    launch: { argv: ['synthetic', '{{prompt}}'] },
    headless: { argv: ['synthetic', 'exec'] },
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
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
  };
}
class Processes implements ProcessReaderPort {
  readonly rows = new Map<number, ProcessInfo>();
  constructor(root: string, harness = 'codex') {
    this.rows.set(11, {
      pid: 11,
      ppid: 10,
      procStart: '110',
      argv: ['node'],
      env: {},
      pidNamespace: 'pid:[synthetic]',
    });
    this.rows.set(10, {
      pid: 10,
      ppid: 1,
      procStart: '100',
      argv: [harness],
      env: { HOME: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root },
      pidNamespace: 'pid:[synthetic]',
    });
  }
  get(pid: number): ProcessInfo {
    const p = this.rows.get(pid);
    if (!p) throw new Error('missing');
    return structuredClone(p);
  }
  domain() {
    return deriveProcessDomain({
      machineId: 'synthetic-machine',
      bootId: 'synthetic-boot',
      pidNamespace: 'pid:[synthetic]',
    });
  }
}
const id = '01900000-0000-7000-8000-000000000001';
const other = '01900000-0000-7000-8000-000000000002';
const meta = (sessionId = id) => ({
  callId: 'synthetic-call',
  sessionId,
  threadId: sessionId,
  'x-codex-turn-metadata': {
    session_id: sessionId,
    thread_id: sessionId,
    thread_source: 'user',
    codex_version: '0.166.0',
    turn_trigger: 'exec',
  },
});
async function registered(root: string, harness: 'codex' | 'claude' = 'codex') {
  const reader = new Processes(root, harness),
    registry = new MemoryCallerRegistry(),
    p = profile(root, harness);
  const registration = await registerCaller({
    reader,
    registry,
    profile: p,
    pid: 11,
    cwd: () => root,
    envPane: 'synthetic:p1',
    nowMs: 100,
  });
  return { reader, registry, p, registration };
}
function header(root: string, sessionId = id) {
  const file = join(root, sessionId + '.jsonl');
  writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, source: 'exec', cli_version: '0.166.0' } }) + '\n'
  );
  return file;
}
function locator(root: string) {
  const directory = join(root, 'sessions');
  mkdirSync(directory, { recursive: true });
  return { codex: (_root: string, sessionId: string) => header(directory, sessionId) };
}

test('delegate.json valid load, roles, unknown fields, mutually exclusive templates, missing source and bad timeouts', () => {
  const f = fixture();
  try {
    const good = { version: 1, profiles: [profile(f.root)] };
    const file = join(f.root, 'delegate.json');
    writeFileSync(file, JSON.stringify(good));
    assert.deepEqual(loadDelegateConfig(file), good);
    const bad: unknown[] = [
      { ...good, unknown: 1 },
      { version: 2, profiles: [] },
      { version: 1, profiles: [{ ...profile(f.root), extra: true }] },
      { version: 1, profiles: [{ ...profile(f.root), launch: { argv: ['x'], shell: 'x', shellPath: '/bin/sh' } }] },
      { version: 1, profiles: [{ ...profile(f.root), launch: { argv: ['x'], unknown: true } }] },
      { version: 1, profiles: [{ ...profile(f.root), roles: { x: { model: 'x', owner: 'fake' } } }] },
      { version: 1, profiles: [{ ...profile(f.root), source: { root: join(f.root, 'absent'), label: 'Synthetic' } }] },
      { version: 1, profiles: [{ ...profile(f.root), responseMarginMs: 0 }] },
      { version: 1, profiles: [{ ...profile(f.root), clientToolTimeoutMs: 2000, responseMarginMs: 2000 }] },
    ];
    for (const value of bad) assert.throws(() => validateDelegateConfig(value), /configuration_invalid/);
  } finally {
    f.cleanup();
  }
});
test('registration records A4 fields and verified physical start; file fake remains private and refuses overwrite', async () => {
  const f = fixture();
  try {
    const { registration, registry } = await registered(f.root);
    assert.equal(registry.callers.length, 1);
    assert.equal(registration.caller.procStart, '110');
    assert.equal(registration.caller.parentProcStart, '100');
    assert.equal(registration.caller.sourceId, makeSourceId('codex', f.root));
    assert.equal(registration.caller.cwd, f.root);
    assert.equal(registration.caller.envPane, 'synthetic:p1');
    assert.equal(registration.caller.retiredAt, null);
    const dir = join(f.root, 'registry');
    const fake = new FileCallerRegistry(dir);
    await fake.register(registration.caller, registration.source);
    const file = join(dir, registration.caller.callerId + '.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).caller.callerId, registration.caller.callerId);
    await assert.rejects(fake.register(registration.caller, registration.source));
  } finally {
    f.cleanup();
  }
});
test('unknown cwd is a typed refusal before registry write', async () => {
  const f = fixture();
  try {
    const registry = new MemoryCallerRegistry();
    await assert.rejects(
      registerCaller({
        reader: new Processes(f.root),
        registry,
        profile: profile(f.root),
        pid: 11,
        cwd: () => {
          throw new Error('gone');
        },
        envPane: null,
        nowMs: 1,
      }),
      (e) => e instanceof Refusal && e.code === 'cwd_unavailable'
    );
    assert.equal(registry.callers.length, 0);
  } finally {
    f.cleanup();
  }
});
test('real /proc registration stamp and PID domain are read without environment secrets', () => {
  if (process.platform !== 'linux') return;
  const reader = new LinuxProcessReader();
  const self = reader.get(process.pid);
  assert.equal(self.pid, process.pid);
  assert.equal(self.ppid, process.ppid);
  assert.match(self.procStart, /^\d+$/);
  assert.ok(reader.domain().pidDomain.includes(reader.domain().bootId));
  assert.ok(Object.keys(self.env).every((k) => ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(k)));
});
test('Codex root combination resolves, native child refuses without invalidating subsequent root', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root);
    const resolver = new SessionRefResolver(registration, reader, p, locator(f.root));
    assert.equal((await resolver.resolve(meta(), 'delegate_whoami')).ok, true);
    const child = meta();
    child.threadId = other;
    child['x-codex-turn-metadata'].thread_id = other;
    child['x-codex-turn-metadata'].thread_source = 'subagent';
    assert.deepEqual(await resolver.resolve(child, 'delegate_whoami'), { ok: false, code: 'identity_unverified' });
    assert.equal((await resolver.resolve(meta(), 'delegate_whoami')).ok, true);
  } finally {
    f.cleanup();
  }
});
test('missing, conflicting and forged arguments metadata never falls back to remembered root/proc', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root);
    const resolver = new SessionRefResolver(registration, reader, p, locator(f.root));
    assert.equal((await resolver.resolve(meta(), 'delegate_whoami')).ok, true);
    assert.deepEqual(await resolver.resolve(undefined, 'delegate_report'), {
      ok: false,
      code: 'identity_source_missing',
    });
    const conflict = meta();
    conflict['x-codex-turn-metadata'].session_id = other;
    assert.deepEqual(await resolver.resolve(conflict, 'delegate_whoami'), { ok: false, code: 'identity_unverified' });
    const server = new HudMcpServer(resolver);
    const reply = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delegate_whoami', arguments: { claim: 'synthetic-root-claim', _meta: meta() } },
    })) as { error: { code: number } };
    assert.equal(reply.error.code, -32602);
  } finally {
    f.cleanup();
  }
});
test('session switches remain source diagnostics; shared ledger supplies the generation gate', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root);
    const loc = locator(f.root);
    const old = new SessionRefResolver(registration, reader, p, loc);
    assert.equal((await old.resolve(meta(), 'delegate_report')).ok, true);
    assert.equal((await old.resolve(meta(other), 'delegate_whoami')).ok, true);
    assert.equal((await old.resolve(meta(), 'delegate_report')).ok, true);
    const nextRegistration = { ...registration, caller: { ...registration.caller, callerId: 'synthetic-new-mcp' } };
    const next = new SessionRefResolver(nextRegistration, reader, p, loc);
    assert.equal((await next.resolve(meta(other), 'delegate_whoami')).ok, true);
    assert.equal((await old.resolve(meta(), 'delegate_report')).ok, true);
    // These are source diagnostics, not distributed context authorization. B2/B5 supply
    // the atomic generation gate before any future body may execute.
  } finally {
    f.cleanup();
  }
});
test('PID reuse, source mismatch, missing header and unmeasured Codex versions refuse', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root);
    const loc = locator(f.root);
    const resolver = new SessionRefResolver(registration, reader, p, loc);
    const unknown = meta();
    unknown['x-codex-turn-metadata'].codex_version = '999';
    assert.deepEqual(await resolver.resolve(unknown, 'delegate_whoami'), { ok: false, code: 'unsupported' });
    reader.rows.get(10)!.procStart = 'replacement';
    assert.deepEqual(await resolver.resolve(meta(), 'delegate_whoami'), { ok: false, code: 'identity_unverified' });
  } finally {
    f.cleanup();
  }
});
test('Claude exact call parser ignores substring/tool-result/private records and retains duplicates/child agentId', () => {
  const row = (agentId?: string) => ({
    type: 'assistant',
    sessionId: id,
    isSidechain: !!agentId,
    ...(agentId ? { agentId } : {}),
    message: { content: [{ type: 'tool_use', id: 'exact', name: 'mcp__hud__delegate_whoami' }] },
  });
  const root = JSON.stringify(row()) + '\n';
  assert.equal(exactClaudeCallRecords(root, 'exact', 'mcp__hud__delegate_whoami').length, 1);
  assert.equal(exactClaudeCallRecords(root + root, 'exact', 'mcp__hud__delegate_whoami').length, 2);
  assert.equal(
    exactClaudeCallRecords(JSON.stringify(row('synthetic-child')), 'exact', 'mcp__hud__delegate_whoami')[0].agentId,
    'synthetic-child'
  );
  assert.equal(exactClaudeCallRecords(root, 'ex', 'mcp__hud__delegate_whoami').length, 0);
  assert.equal(exactClaudeCallRecords(root, 'exact', 'different').length, 0);
});
test('Claude late/missing public call refuses, observed record still cannot upgrade unverified profile', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root, 'claude');
    const sessions = join(f.root, 'sessions');
    mkdirSync(sessions);
    const cwd = '/synthetic/project';
    writeFileSync(
      join(sessions, '10.json'),
      JSON.stringify({ pid: 10, procStart: '100', sessionId: id, cwd, pidDomain: reader.domain().claudePidDomain })
    );
    const project = join(f.root, 'projects', '-synthetic-project');
    mkdirSync(project, { recursive: true });
    const file = join(project, id + '.jsonl');
    writeFileSync(file, '');
    const resolver = new SessionRefResolver(registration, reader, p);
    const m = { 'claudecode/toolUseId': 'exact' };
    assert.deepEqual(await resolver.resolve(m, 'delegate_whoami'), { ok: false, code: 'identity_source_missing' });
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        isSidechain: false,
        message: { content: [{ type: 'tool_use', id: 'exact', name: 'mcp__hud__delegate_whoami' }] },
      }) + '\n'
    );
    assert.deepEqual(await resolver.resolve(m, 'delegate_whoami'), { ok: false, code: 'unsupported' });
  } finally {
    f.cleanup();
  }
});
test('pi explicit session path resolver checks header and source; directory alone grants nothing', () => {
  const f = fixture();
  try {
    const file = join(f.root, 'session.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'synthetic-pi' }) + '\n');
    const p = new Processes(f.root).get(10);
    p.argv = ['pi', '--session', file];
    assert.equal(resolvePiSession(p, f.root)?.sessionId, 'synthetic-pi');
    p.argv = ['pi', '--session', file, '--fork'];
    assert.equal(resolvePiSession(p, f.root), null);
    p.argv = ['pi', '--session-id', 'synthetic-pi'];
    assert.equal(resolvePiSession(p, f.root, () => file)?.sessionId, 'synthetic-pi');
    p.argv = ['pi', '--session-id', 'different'];
    assert.equal(
      resolvePiSession(p, f.root, () => file),
      null
    );
    p.argv = ['pi', '--session-dir', f.root];
    assert.equal(resolvePiSession(p, f.root), null);
  } finally {
    f.cleanup();
  }
});
test('seven MCP schemas, target XOR, numeric bounds, request keys, unknown identity arguments', async () => {
  const server = new HudMcpServer({ resolve: async () => ({ ok: false, code: 'identity_source_missing' }) });
  assert.equal(TOOLS.length, 7);
  const call = async (name: string, args: unknown) =>
    server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{
      error?: { code: number };
      result?: unknown;
    }>;
  assert.equal((await call('delegate_status', {})).error?.code, -32602);
  assert.equal((await call('delegate_status', { runId: 'r', linkId: 'l' })).error?.code, -32602);
  assert.equal((await call('delegate_wait', { runId: 'r', timeoutMs: 120001 })).error?.code, -32602);
  assert.equal((await call('delegate_whoami', { admin: true })).error?.code, -32602);
  assert.ok((await call('delegate_whoami', {})).result);
  assert.equal((await call('delegate_whoami', null)).error?.code, -32602);
  const accepted = new HudMcpServer({
    resolve: async () => ({
      ok: true,
      callId: 'c',
      sessionRef: { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: id, threadId: null },
      processKey: 'synthetic',
      evidenceDigest: 'synthetic',
    }),
  });
  const reply = (await accepted.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'delegate_whoami', arguments: { claim: 'synthetic' } },
  })) as { result: { structuredContent: { code: string } } };
  assert.equal(reply.result.structuredContent.code, 'not_implemented');
});
test('runtime rejects Node 18, 22.12 and 23 before importing package entry', async () => {
  const bin = fileURLToPath(new URL('../../../bin/hud-mcp.mjs', import.meta.url));
  for (const version of ['18.20.0', '22.12.0', '23.9.0']) {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});await import(${JSON.stringify(bin)});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /requires Node 22.x >=22.13.0 or Node >=24/);
  }
});

test('runtime accepts declared 22.13 and 24 entry boundaries', async () => {
  const f = fixture();
  const bin = fileURLToPath(new URL('../../../bin/hud-mcp.mjs', import.meta.url));
  try {
    for (const version of ['22.13.0', '24.0.0']) {
      // Exercise bootstrap version routing on the actual Node host, not SQLite compatibility.
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});await import(${JSON.stringify(bin)});`,
        ],
        {
          env: { ...process.env, HUD_HOME: f.root, HUD_MCP_PROFILE: '', HUD_MCP_REGISTRY_DIR: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const ended = once(child, 'exit');
      child.stdin.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) +
          '\n'
      );
      const [code] = await ended;
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(stdout).result.serverInfo.name, 'hud-mcp');
    }
  } finally {
    f.cleanup();
  }
});

test('bounded Codex locator covers harness-local previous day and refuses duplicate exact session paths', async () => {
  const { BoundedSessionLocator } = await import('../../packages/hud-mcp/src/resolvers.js');
  const f = fixture();
  try {
    const epoch = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    const directory = (offset: number) => {
      const d = new Date(epoch + offset * 86400000);
      const dir = join(
        f.root,
        'sessions',
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0')
      );
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const file = join(directory(-1), `rollout-synthetic-${id}.jsonl`);
    writeFileSync(file, '{}\n');
    const locator = new BoundedSessionLocator();
    assert.equal(locator.codex(f.root, id), file);
    writeFileSync(join(directory(0), `rollout-synthetic-${id}.jsonl`), '{}\n');
    assert.equal(locator.codex(f.root, id), null);
    assert.equal(locator.codex(f.root, '../../outside'), null);
  } finally {
    f.cleanup();
  }
});

test('source/header mismatch, missing header and daemon topology cannot resolve identity', async () => {
  const f = fixture();
  try {
    const { registration, reader, p } = await registered(f.root);
    const missing = new SessionRefResolver(registration, reader, p, { codex: () => null });
    assert.deepEqual(await missing.resolve(meta(), 'delegate_whoami'), { ok: false, code: 'identity_source_missing' });
    const dir = join(f.root, 'sessions');
    mkdirSync(dir);
    const file = header(dir, other);
    const wrong = new SessionRefResolver(registration, reader, p, { codex: () => file });
    assert.deepEqual(await wrong.resolve(meta(), 'delegate_whoami'), { ok: false, code: 'identity_unverified' });
    reader.rows.get(10)!.argv.push('app-server');
    assert.deepEqual(await wrong.resolve(meta(), 'delegate_whoami'), { ok: false, code: 'unsupported' });
    reader.rows.get(10)!.argv = ['codex'];
    reader.rows.get(10)!.env.CODEX_HOME = join(f.root, 'unavailable');
    assert.deepEqual(await wrong.resolve(meta(), 'delegate_whoami'), { ok: false, code: 'identity_unverified' });
  } finally {
    f.cleanup();
  }
});

test('stdio framing rejects malformed JSON, ignores notifications and serializes stub replies', async () => {
  const { PassThrough } = await import('node:stream');
  const { serveStdio } = await import('../../packages/hud-mcp/src/server.js');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => (text += chunk.toString()));
  const server = new HudMcpServer({ resolve: async () => ({ ok: false, code: 'identity_source_missing' }) });
  const done = serveStdio(server, input, output);
  input.end(
    'invalid\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
      '\n'
  );
  await done;
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: number | null; error?: { code: number }; result?: { tools: unknown[] } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].error?.code, -32700);
  assert.equal(rows[1].result?.tools.length, 7);
});
