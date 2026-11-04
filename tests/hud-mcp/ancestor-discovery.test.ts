import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import type { DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import { Refusal } from '../../packages/hud-mcp/src/errors.js';
import { findHarness, type ProcessInfo, type ProcessReaderPort } from '../../packages/hud-mcp/src/process.js';
import { MemoryCallerRegistry, registerCaller } from '../../packages/hud-mcp/src/registry.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';

// These readers simulate errno faults. They are not evidence of a real root-owned ancestor.
const row = (pid: number, ppid: number, argv = ['synthetic-shell']): ProcessInfo => ({
  pid,
  ppid,
  procStart: `synthetic-start-${pid}`,
  argv,
  env: {},
  pidNamespace: 'pid:[synthetic]',
});
class Processes implements ProcessReaderPort {
  readonly rows = new Map([
    [41, row(41, 40, ['node'])],
    [40, row(40, 30)],
    [30, row(30, 20)],
    [20, row(20, 1, ['codex'])],
  ]);
  readonly reads: number[] = [];
  readonly counts = new Map<number, number>();
  intercept?: (pid: number, count: number) => ProcessInfo | void;
  get(pid: number): ProcessInfo {
    this.reads.push(pid);
    const count = (this.counts.get(pid) ?? 0) + 1;
    this.counts.set(pid, count);
    const replacement = this.intercept?.(pid, count);
    const value = replacement ?? this.rows.get(pid);
    assert.ok(value, `unexpected synthetic PID ${pid}`);
    return structuredClone(value);
  }
  domain() {
    return deriveProcessDomain({
      machineId: 'synthetic-machine',
      bootId: 'synthetic-boot',
      pidNamespace: 'pid:[synthetic]',
    });
  }
}
const permission = (code: 'EACCES' | 'EPERM') => Object.assign(new Error('simulated access denial'), { code });
const profile: DelegateProfile = {
  name: 'synthetic',
  harness: 'codex',
  source: { root: '/synthetic/configured-source', label: 'Synthetic' },
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
};
const input = (reader: Processes, registry = new MemoryCallerRegistry()) => ({
  reader,
  registry,
  profile: null as DelegateProfile | null,
  pid: 41,
  cwd: () => '/synthetic/work',
  envPane: null,
  nowMs: 123,
});

for (const code of ['EACCES', 'EPERM'] as const) {
  for (const configured of [false, true]) {
    test(`simulated ${code} optional ancestor: physical registration survives, no farther harness or authority (profile=${configured})`, async () => {
      const reader = new Processes();
      const registry = new MemoryCallerRegistry();
      // Even a candidate harness and matching configured/MCP roots cannot rescue a denied read.
      if (configured) reader.rows.get(30)!.argv = ['codex'];
      for (const process of reader.rows.values())
        process.env = { HOME: '/synthetic/home', CODEX_HOME: profile.source.root };
      reader.intercept = (pid) => {
        if (pid === 30) throw permission(code);
      };
      const registration = await registerCaller({ ...input(reader, registry), profile: configured ? profile : null });
      assert.deepEqual(reader.reads, [41, 40, 40, 30, 41, 40]);
      assert.equal(reader.counts.has(20), false, 'readable farther harness must never be inspected');
      assert.deepEqual(registry.callers, [registration.caller]);
      assert.deepEqual(registry.sources, []);
      assert.deepEqual(registration.caller, {
        callerId: registration.caller.callerId,
        instanceKind: 'dedicated',
        harness: null,
        sourceId: null,
        pid: 41,
        procStart: 'synthetic-start-41',
        ppid: 40,
        parentProcStart: 'synthetic-start-40',
        cwd: '/synthetic/work',
        envPane: null,
        startedAt: 123,
        lastSeenAt: 123,
        retiredAt: null,
      });
      assert.equal(registration.source, null);
      assert.equal(registration.harnessPid, null);
      assert.equal(registration.harnessProcStart, null);
      let scopes = 0;
      let dispatches = 0;
      const resolver = new SessionRefResolver(registration, reader, configured ? profile : null, undefined, undefined, {
        read: () => {
          scopes++;
          throw new Error('source-less caller must not read scopes');
        },
      });
      const server = new HudMcpServer(resolver, {
        invoke: async () => {
          dispatches++;
          throw new Error('source-less caller must not dispatch');
        },
      });
      const reply = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delegate_whoami', arguments: { claim: 'synthetic-untrusted-claim' }, _meta: {} },
      })) as { result: { structuredContent: unknown } };
      assert.deepEqual(reply.result.structuredContent, { ok: false, code: 'identity_source_missing' });
      assert.equal(scopes, 0);
      assert.equal(dispatches, 0);
      assert.deepEqual(reader.reads, [41, 40, 40, 30, 41, 40], 'no identity retry or remembered harness');
    });
  }
  for (const [name, target, occurrence] of [
    ['self initial', 41, 1],
    ['actual parent initial', 40, 1],
    ['self final', 41, 2],
    ['actual parent final', 40, 3],
  ] as const) {
    test(`simulated ${code} mandatory ${name} still rejects before any registry write`, async () => {
      const reader = new Processes();
      reader.rows.get(40)!.argv = ['codex'];
      const registry = new MemoryCallerRegistry();
      const denied = permission(code);
      reader.intercept = (pid, count) => {
        if (pid === target && count === occurrence) throw denied;
      };
      await assert.rejects(
        registerCaller({ ...input(reader, registry), profile: target === 40 && occurrence === 1 ? profile : null }),
        (error) => error === denied
      );
      assert.equal(reader.counts.get(target), occurrence);
      assert.deepEqual(registry.callers, []);
      assert.deepEqual(registry.sources, []);
    });
  }
}

test('optional discovery propagates the exact non-permission error or identity refusal; message text is not errno', async () => {
  for (const error of [
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
    Object.assign(new Error('I/O failure'), { code: 'EIO' }),
    new Error('EACCES: permission denied'),
    new Refusal('registration_unverified'),
    new Refusal('identity_unverified'),
  ]) {
    const reader = new Processes();
    reader.intercept = (pid) => {
      if (pid === 30) throw error;
    };
    assert.throws(
      () => findHarness(reader, 40),
      (caught) => caught === error
    );
    assert.deepEqual(reader.reads, [40, 30]);
    const registry = new MemoryCallerRegistry();
    await assert.rejects(registerCaller(input(reader, registry)), (caught) => caught === error);
    assert.deepEqual(registry.callers, []);
    assert.deepEqual(registry.sources, []);
    assert.equal(reader.counts.has(20), false);
  }
});

test('normal no-harness, nearest genuine harness, eight reads, PID 1 and self-parent bounds remain unchanged', () => {
  const reader = new Processes();
  reader.rows.get(30)!.ppid = 1;
  assert.equal(findHarness(reader, 40), null);
  assert.deepEqual(reader.reads, [40, 30]);
  reader.reads.length = 0;
  reader.rows.get(30)!.argv = ['codex'];
  assert.deepEqual(findHarness(reader, 40), { process: reader.rows.get(30), harness: 'codex' });
  assert.deepEqual(reader.reads, [40, 30]);
  reader.reads.length = 0;
  reader.rows.get(40)!.argv = ['claude'];
  assert.deepEqual(findHarness(reader, 40), { process: reader.rows.get(40), harness: 'claude' });
  assert.deepEqual(reader.reads, [40]);
  reader.reads.length = 0;
  assert.equal(findHarness(reader, 1), null);
  assert.equal(findHarness(reader, 0), null);
  assert.deepEqual(reader.reads, []);
  reader.rows.set(40, row(40, 40));
  assert.equal(findHarness(reader, 40), null);
  assert.deepEqual(reader.reads, [40]);
  reader.reads.length = 0;
  for (let pid = 40; pid >= 32; pid--) reader.rows.set(pid, row(pid, pid - 1));
  reader.rows.get(32)!.argv = ['codex'];
  assert.equal(findHarness(reader, 40), null);
  assert.deepEqual(reader.reads, [40, 39, 38, 37, 36, 35, 34, 33]);
  reader.reads.length = 0;
  reader.rows.get(33)!.argv = ['codex'];
  assert.equal(findHarness(reader, 40)?.process.pid, 33);
  assert.deepEqual(reader.reads, [40, 39, 38, 37, 36, 35, 34, 33]);
});

test('changed physical stamps, inconsistent namespace, unavailable domain and cwd retain zero-write guards', async () => {
  for (const defect of ['self stamp', 'parent stamp', 'namespace', 'domain', 'empty domain', 'cwd'] as const) {
    const reader = new Processes();
    reader.rows.get(30)!.ppid = 1;
    const registry = new MemoryCallerRegistry();
    if (defect === 'namespace') reader.rows.get(40)!.pidNamespace = 'pid:[other]';
    if (defect === 'domain')
      reader.domain = () => {
        throw new Refusal('registration_unverified');
      };
    if (defect === 'empty domain') {
      const domain = reader.domain();
      reader.domain = () => ({ ...domain, pidDomain: '' as typeof domain.pidDomain });
    }
    reader.intercept = (pid, count) => {
      if (
        (defect === 'self stamp' && pid === 41 && count === 2) ||
        (defect === 'parent stamp' && pid === 40 && count === 3)
      )
        return { ...reader.rows.get(pid)!, procStart: 'replacement' };
    };
    await assert.rejects(
      registerCaller({ ...input(reader, registry), cwd: () => (defect === 'cwd' ? '' : '/synthetic/work') }),
      (error) =>
        error instanceof Refusal && error.code === (defect === 'cwd' ? 'cwd_unavailable' : 'registration_unverified')
    );
    assert.deepEqual(registry.callers, []);
    assert.deepEqual(registry.sources, []);
  }
});

test('malformed optional process evidence is not converted into unavailable harness evidence', () => {
  const reader = new Processes();
  reader.rows.get(40)!.argv = undefined as unknown as string[];
  assert.throws(() => findHarness(reader, 40), TypeError);
  assert.deepEqual(reader.reads, [40]);
});
