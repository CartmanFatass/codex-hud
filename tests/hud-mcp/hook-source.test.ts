import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ReadOnlyScopeSnapshot, type ScopeSnapshot } from '../../src/core/ledger-scope-read.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { launchProfileDigest } from '../../src/core/capabilities.js';
import { makeRecord } from '../../packages/hud-mcp/src/hook/command.js';
import { bootStartToMonotonic } from '../../packages/hud-mcp/src/hook/process.js';
import { consumeHookRecord } from '../../packages/hud-mcp/src/hook/resolve.js';
import { cleanupHookNamespace } from '../../packages/hud-mcp/src/hook/cleanup.js';
import {
  CLAUDE_VERSION,
  IMPLEMENTATION,
  HUD_TOOLS,
  hash,
  hookProfileFingerprint,
  makeHookSettings,
  publishRecord,
  recordPaths,
  type HookConfig,
  type HookRecord,
} from '../../packages/hud-mcp/src/hook/record.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import type { DelegateProfile } from '../../packages/hud-mcp/src/config.js';
import type { ProcessInfo, ProcessReaderPort } from '../../packages/hud-mcp/src/process.js';
import type { Registration } from '../../packages/hud-mcp/src/registry.js';
const id = '01900000-0000-7000-8000-000000000001';
const runtime = (() => {
  const [a, b] = process.versions.node.split('.').map(Number);
  return (a === 22 && b >= 13) || a >= 24;
})();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-hook-test-')));
  const config: HookConfig = {
    version: 1,
    implementation: IMPLEMENTATION,
    claudeVersion: CLAUDE_VERSION,
    claudeExecutable: realpathSync(process.execPath),
    sourceRoot: root,
    ledgerPath: join(root, 'ledger.sqlite'),
    directory: root,
    serverName: 'hud.special',
    profileFingerprint: 'a'.repeat(64),
    clockTicksPerSecond: 100,
  };
  const sourceId = hash(['claude', root]);
  const domain = deriveProcessDomain({
    machineId: 'synthetic-machine',
    bootId: 'synthetic-boot',
    pidNamespace: 'synthetic-pid-ns',
  });
  const processKey = JSON.stringify(['claude', sourceId, domain.pidDomain, process.pid, '100']);
  let premise: ScopeSnapshot = {
    kind: 'no_current',
    processKey,
    ledgerId: 'synthetic-ledger',
    highWaterGeneration: 0,
    current: null,
  };
  const scopes = { read: () => structuredClone(premise) };
  const launch = {
    processKey,
    sourceId,
    bootId: 'synthetic-boot',
    harnessPid: process.pid,
    harnessStart: '100',
    claudePidDomain: domain.claudePidDomain,
    hookStartMonoMs: Number(process.hrtime.bigint()) / 1e6 - 10,
    hookStartUncertaintyMs: 10,
  };
  const input = {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'synthetic-call',
    tool_name: `mcp__${config.serverName}__delegate_whoami`,
    session_id: id,
    tool_input: { claim: 'PRIVATE-SENTINEL', prompt: 'PRIVATE-SENTINEL' },
    prompt: 'PRIVATE-SENTINEL',
    transcript_path: '/PRIVATE-SENTINEL/root',
  };
  const record = () => makeRecord(config, input, launch, scopes);
  const expected = () => ({
    processKey,
    sourceId,
    bootId: launch.bootId,
    callId: input.tool_use_id,
    toolName: input.tool_name,
    sessionId: id,
  });
  const consume = () => consumeHookRecord({ config, scopes }, expected());
  const paths = () => recordPaths(config, premise, input.tool_use_id);
  return {
    root,
    config,
    sourceId,
    domain,
    processKey,
    scopes,
    launch,
    input,
    record,
    expected,
    consume,
    paths,
    change: (v: ScopeSnapshot) => {
      premise = v;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function rewrite(f: ReturnType<typeof fixture>, record: HookRecord) {
  const { fingerprint: _fp, ...body } = record;
  writeFileSync(f.paths().record, JSON.stringify({ ...body, fingerprint: hash(body) }) + '\n', { mode: 0o600 });
}

test('hook publication is bounded, private, exact and omits tool_input/prompt/transcript sentinel even in temporary files', () => {
  const f = fixture();
  try {
    publishRecord(f.config, f.record());
    assert.equal(statSync(f.paths().record).mode & 0o777, 0o600);
    assert.ok(statSync(f.paths().record).size <= 8192);
    for (const entry of readdirSync(f.paths().directory))
      assert.ok(!readFileSync(join(f.paths().directory, entry), 'utf8').includes('PRIVATE-SENTINEL'));
    assert.equal(f.consume().record.sessionId, id);
    assert.equal(readdirSync(f.paths().directory).filter((n) => n.endsWith('.json')).length, 0);
    assert.throws(f.consume);
    assert.deepEqual(cleanupHookNamespace(f.paths().directory), { removed: 1, complete: true });
    assert.equal(readdirSync(f.paths().directory).length, 0);
  } finally {
    f.cleanup();
  }
});

test('missing then late record never revives a refused call; a new exact call can retry', () => {
  const f = fixture();
  try {
    assert.throws(f.consume);
    assert.throws(() => publishRecord(f.config, f.record()));
    assert.throws(f.consume);
    f.input.tool_use_id = 'new-call';
    publishRecord(f.config, f.record());
    assert.equal(f.consume().record.toolUseId, 'new-call');
  } finally {
    f.cleanup();
  }
});

test('half-written, oversized, symlink and duplicate conflicting publications refuse', () => {
  for (const mode of ['half', 'oversize', 'symlink', 'duplicate']) {
    const f = fixture();
    try {
      const record = f.record();
      if (mode === 'half') writeFileSync(f.paths().record, '{"version":', { mode: 0o600 });
      if (mode === 'oversize') writeFileSync(f.paths().record, ' '.repeat(8193), { mode: 0o600 });
      if (mode === 'symlink') {
        const target = join(f.root, 'target');
        writeFileSync(target, JSON.stringify(record) + '\n', { mode: 0o600 });
        symlinkSync(target, f.paths().record);
      }
      if (mode === 'duplicate') {
        publishRecord(f.config, record);
        assert.throws(() => publishRecord(f.config, record));
      }
      assert.throws(f.consume, mode);
    } finally {
      f.cleanup();
    }
  }
});

for (const field of [
  'version',
  'implementation',
  'claudeVersion',
  'profileFingerprint',
  'sourceId',
  'processKey',
  'bootId',
  'serverName',
  'toolUseId',
  'toolName',
  'sessionId',
  'hookStartMonoMs',
  'hookStartUncertaintyMs',
  'publishedMonoMs',
] as const) {
  test(`wrong hook ${field} refuses even with a matching content fingerprint`, () => {
    const f = fixture();
    try {
      const record = f.record();
      (record as unknown as Record<string, unknown>)[field] =
        field === 'version'
          ? 2
          : field === 'hookStartUncertaintyMs'
            ? -1
            : field === 'hookStartMonoMs'
              ? 0
              : field === 'publishedMonoMs'
                ? 1e30
                : 'wrong';
      rewrite(f, record);
      assert.throws(f.consume);
    } finally {
      f.cleanup();
    }
  });
}

test('native child with root transcript path refuses and leaves subsequent root verifiable', () => {
  const f = fixture();
  try {
    const child = makeRecord(
      f.config,
      { ...f.input, agent_id: 'synthetic-child', agent_type: 'Explore' },
      f.launch,
      f.scopes
    );
    publishRecord(f.config, child);
    assert.throws(f.consume);
    f.input.tool_use_id = 'root-after-child';
    publishRecord(f.config, f.record());
    assert.equal(f.consume().record.agent.kind, 'root');
    for (const fields of [{ agent_id: '' }, { agent_type: 'Explore' }, { agent_id: null, agent_type: null }])
      assert.throws(() => makeRecord(f.config, { ...f.input, ...fields }, f.launch, f.scopes));
  } finally {
    f.cleanup();
  }
});

test('A→B→A old record and closed-scope no-current ABA reject instead of attaching latest generation', () => {
  const f = fixture();
  try {
    const premise = f.scopes.read();
    const ref = { harness: 'claude' as const, sourceId: f.sourceId, sessionId: id, threadId: null };
    const current = (generation: number): ScopeSnapshot => ({
      ...premise,
      kind: 'current',
      highWaterGeneration: generation,
      current: { generation, sessionRef: ref, bindingEvidenceId: 'synthetic-evidence' },
    });
    f.change(current(1));
    publishRecord(f.config, f.record());
    f.change(current(3));
    assert.throws(f.consume);
    f.input.tool_use_id = 'absent-ABA';
    f.change(premise);
    publishRecord(f.config, f.record());
    f.change({ ...premise, highWaterGeneration: 2 });
    assert.throws(f.consume);
  } finally {
    f.cleanup();
  }
});

test('CLI settings preserve existing hooks/config and match only the exact server tools including headless close', () => {
  const f = fixture();
  try {
    const old = {
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }], Stop: ['synthetic'] },
      permissions: { allow: ['Read'] },
    };
    const value = makeHookSettings(f.config, 'node synthetic-hook', old) as typeof old;
    assert.deepEqual(value.hooks.PreToolUse[0], old.hooks.PreToolUse[0]);
    assert.deepEqual(value.permissions, old.permissions);
    assert.equal(old.hooks.PreToolUse.length, 1);
    const regex = new RegExp(value.hooks.PreToolUse[1].matcher);
    assert.ok(HUD_TOOLS.includes('delegate_close'));
    assert.ok(regex.test('mcp__hud.special__delegate_close'));
    assert.ok(!regex.test('mcp__hud.special__delegate_close_suffix'));
    assert.ok(!regex.test('mcp__other__delegate_close'));
    for (const t of HUD_TOOLS) assert.ok(regex.test(`mcp__hud.special__${t}`));
    for (const name of [
      'Read',
      'mcp__hudXspecial__delegate_whoami',
      'mcp__other__delegate_whoami',
      'mcp__hud.special__delegate_new',
      'mcp__hud.special__delegate_whoami_suffix',
    ])
      assert.ok(!regex.test(name));
  } finally {
    f.cleanup();
  }
});

test(
  'scope snapshot reads the real src/ledger schema, no-current high-water and current ref; never creates a missing file',
  { skip: !runtime && 'Node 22.x >=22.13 or >=24 required' },
  async () => {
    const f = fixture();
    let ledger;
    try {
      const reader = new ReadOnlyScopeSnapshot(f.config.ledgerPath);
      assert.equal(reader.read(f.processKey).kind, 'missing_ledger');
      assert.equal(readdirSync(f.root).length, 0);
      ledger = await openLedger(f.config.ledgerPath);
      assert.deepEqual(reader.read(f.processKey), {
        kind: 'no_current',
        ledgerId: ledger.ledgerId,
        processKey: f.processKey,
        highWaterGeneration: 0,
        current: null,
      });
      await ledger.transaction((tx) => {
        tx.run('INSERT INTO sources VALUES (?,?,?,?)', f.sourceId, 'claude', f.root, 'Synthetic');
        tx.run(
          'INSERT INTO caller_scopes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          f.processKey,
          1,
          'claude',
          f.sourceId,
          f.domain.pidDomain,
          process.pid,
          '100',
          null,
          null,
          null,
          1,
          null
        );
      });
      const current = reader.read(f.processKey);
      assert.equal(current.kind, 'current');
      if (current.kind === 'current') assert.equal(current.current.generation, 1);
      const ref = JSON.stringify(['claude', f.sourceId, id, null]);
      await ledger.transaction((tx) => {
        tx.run('INSERT INTO sessions VALUES (?,?,?,?,?)', ref, 'claude', f.sourceId, id, '');
        tx.run(
          'INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?)',
          'synthetic-evidence',
          null,
          null,
          'trusted_session',
          'reconciler',
          'a'.repeat(64),
          '{}',
          1,
          1,
          'accepted'
        );
        tx.run(
          'UPDATE caller_scopes SET session_ref=?,bound_by=?,binding_evidence_id=? WHERE process_key=?',
          ref,
          'trusted_session',
          'synthetic-evidence',
          f.processKey
        );
      });
      const bound = reader.read(f.processKey);
      assert.equal(bound.kind, 'current');
      if (bound.kind === 'current')
        assert.deepEqual(bound.current.sessionRef, {
          harness: 'claude',
          sourceId: f.sourceId,
          sessionId: id,
          threadId: null,
        });
      await ledger.transaction((tx) =>
        tx.run('UPDATE caller_scopes SET closed_at=2 WHERE process_key=?', f.processKey)
      );
      assert.deepEqual(reader.read(f.processKey), {
        kind: 'no_current',
        ledgerId: ledger.ledgerId,
        processKey: f.processKey,
        highWaterGeneration: 1,
        current: null,
      });
      assert.equal(
        ledger.snapshot((tx) => tx.get('PRAGMA user_version')!.user_version),
        1
      );
    } finally {
      await ledger?.close();
      f.cleanup();
    }
  }
);

test('resolver uses genuine metadata and returns the captured premise without poisoning root after native child or /clear', async () => {
  const f = fixture();
  try {
    const p = {
      name: 'synthetic',
      harness: 'claude',
      source: { root: f.root, label: 'Synthetic' },
      env: {},
      mcpServerName: f.config.serverName,
      callSource: { kind: 'claude_pre_tool_use_v1' },
    } as unknown as DelegateProfile;
    f.config.profileFingerprint = hookProfileFingerprint(p);
    const self: ProcessInfo = {
      pid: 12,
      ppid: process.pid,
      procStart: '120',
      argv: ['node'],
      env: {},
      pidNamespace: 'synthetic-ns',
    };
    const parent: ProcessInfo = {
      ...self,
      pid: process.pid,
      ppid: 1,
      procStart: '100',
      argv: ['claude'],
      env: { CLAUDE_CONFIG_DIR: f.root },
    };
    const reader: ProcessReaderPort = {
      get: (pid) => structuredClone(pid === self.pid ? self : parent),
      domain: () => f.domain,
    };
    const registration: Registration = {
      caller: {
        callerId: 'synthetic',
        instanceKind: 'dedicated',
        harness: 'claude',
        sourceId: f.sourceId,
        pid: 12,
        ppid: process.pid,
        procStart: '120',
        parentProcStart: '100',
        cwd: f.root,
        envPane: null,
        startedAt: 1,
        lastSeenAt: 1,
        retiredAt: null,
      },
      source: { harness: 'claude', sourceId: f.sourceId, rootPath: f.root, label: 'Synthetic' },
      harnessPid: process.pid,
      harnessProcStart: '100',
    };
    mkdirSync(join(f.root, 'sessions'));
    const registry = () =>
      writeFileSync(
        join(f.root, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          procStart: '100',
          pidDomain: f.launch.claudePidDomain,
          sessionId: f.input.session_id,
          cwd: f.root,
        }),
        { mode: 0o600 }
      );
    registry();
    const resolver = new SessionRefResolver(registration, reader, p, undefined, { config: f.config, scopes: f.scopes });
    const resolve = () => resolver.resolve({ 'claudecode/toolUseId': f.input.tool_use_id }, 'delegate_whoami');
    publishRecord(f.config, f.record());
    const first = await resolve();
    assert.ok(first.ok);
    if (first.ok) assert.deepEqual(first.scopePremise, f.scopes.read());
    f.input.tool_use_id = 'child';
    publishRecord(
      f.config,
      makeRecord(f.config, { ...f.input, agent_id: 'child', agent_type: 'Explore' }, f.launch, f.scopes)
    );
    assert.equal((await resolve()).ok, false);
    f.input.tool_use_id = 'root-after';
    publishRecord(f.config, f.record());
    assert.ok((await resolve()).ok);
    f.input.tool_use_id = 'after-clear';
    f.input.session_id = '01900000-0000-7000-8000-000000000002';
    registry();
    publishRecord(f.config, f.record());
    assert.ok((await resolve()).ok);
    assert.equal((await resolver.resolve({ 'claudecode/toolUseId': 'forged' }, 'delegate_whoami')).ok, false);
    assert.equal((await resolver.resolve(undefined, 'delegate_whoami')).ok, false);
    f.input.tool_use_id = 'missing-registry';
    publishRecord(f.config, f.record());
    unlinkSync(join(f.root, 'sessions', `${process.pid}.json`));
    assert.equal((await resolve()).ok, false);
    registry();
    assert.equal((await resolve()).ok, false, 'late registry cannot revive the same attempted call');
    p.env.HUD_HOME = '/synthetic/changed-home';
    f.input.tool_use_id = 'changed-profile';
    publishRecord(f.config, f.record());
    assert.deepEqual(
      await resolve(),
      { ok: false, code: 'unsupported' },
      'old-profile evidence must not verify after a nonsecret env value changes'
    );
    assert.equal(readlinkSync(`/proc/${process.pid}/exe`), f.config.claudeExecutable);
  } finally {
    f.cleanup();
  }
});

test('scope reader refuses unsupported runtimes before touching a missing path', () => {
  const f = fixture();
  try {
    const moduleUrl = new URL('../../src/core/ledger-scope-read.js', import.meta.url).href;
    for (const version of ['18.20.0', '22.12.0', '23.9.0']) {
      const code = `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}}); const {ReadOnlyScopeSnapshot}=await import(${JSON.stringify(moduleUrl)}); try {new ReadOnlyScopeSnapshot(${JSON.stringify(f.config.ledgerPath)}).read('unused');process.exit(2);} catch(e) {if(!e.message.includes('require Node'))process.exit(3);}`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code]);
      assert.equal(child.status, 0, String(child.stderr));
      assert.equal(readdirSync(f.root).length, 0);
    }
  } finally {
    f.cleanup();
  }
});

test('hook fingerprint binds nonsecret env values, matches core digest and excludes per-run credential values', () => {
  const p = {
    name: 'synthetic',
    env: {
      HUD_HOME: '/synthetic/a',
      MODE: 'direct',
      HUD_CLAIM: 'PRIVATE-SENTINEL',
      HUD_RUN: 'run-a',
      HUD_LINK: 'link-a',
    },
  } as unknown as DelegateProfile;
  const fingerprint = hookProfileFingerprint(p);
  assert.equal(fingerprint, launchProfileDigest(p));
  assert.notEqual(fingerprint, hookProfileFingerprint({ ...p, env: { ...p.env, HUD_HOME: '/synthetic/b' } }));
  assert.notEqual(fingerprint, hookProfileFingerprint({ ...p, env: { ...p.env, MODE: 'other' } }));
  assert.equal(
    fingerprint,
    hookProfileFingerprint({
      ...p,
      env: { ...p.env, HUD_CLAIM: 'different-private-claim', HUD_RUN: 'run-b', HUD_LINK: 'link-b' },
    })
  );
});

test('fresh post-suspend hook maps BOOTTIME start to monotonic, retains bounded uncertainty and verifies', () => {
  const f = fixture();
  try {
    const now = Number(process.hrtime.bigint()) / 1e6;
    const suspend = 60000;
    const before = now - 1;
    const bootNow = Math.floor((before + suspend) / 10) * 10;
    const bootStart = bootNow - 50;
    const mapped = bootStartToMonotonic(bootStart, bootNow, before, now);
    assert.ok(mapped.hookStartMonoMs <= now - 50);
    assert.equal(mapped.hookStartUncertaintyMs, 21);
    const record = makeRecord(f.config, f.input, { ...f.launch, ...mapped }, f.scopes);
    publishRecord(f.config, record);
    assert.equal(f.consume().record.hookStartUncertaintyMs, 21);
    assert.throws(() => bootStartToMonotonic(1, 0, 1, 2));
    assert.throws(() => bootStartToMonotonic(0, 0, 2, 1));
    assert.throws(() => bootStartToMonotonic(NaN, 0, 1, 2));
  } finally {
    f.cleanup();
  }
});

test('E4 Claude close source record uses the exact tool and rejects suffix/server forgery', () => {
  const f = fixture();
  try {
    f.input.tool_name = 'mcp__hud.special__delegate_close';
    publishRecord(f.config, f.record());
    assert.equal(f.consume().record.toolName, 'mcp__hud.special__delegate_close');
    for (const name of ['mcp__hud.special__delegate_close_suffix', 'mcp__other__delegate_close']) {
      f.input.tool_name = name;
      assert.throws(f.record);
    }
  } finally { f.cleanup(); }
});
