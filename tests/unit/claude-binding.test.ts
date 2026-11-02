import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ClaudeAdapter, type ClaudeBindContext } from '../../src/harness/claude/index.js';
import { ClaudeTranscriptFiles } from '../../src/harness/claude/binding.js';
import type { RegistryRecord } from '../../src/core/interfaces/registry-provider.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';

const TIME = Date.parse('2026-03-01T12:00:00Z');
const stamp: ProcessStamp = {
  pid: 32101,
  proc_start: 'synthetic-start',
  boot_id: 'synthetic-boot',
  pid_domain: 'synthetic-machine:synthetic-boot:pid:[321]',
};
const profile = (root: string): LaunchProfile => ({
  name: 'synthetic-claude',
  harness: 'claude',
  source: { root, label: 'Synthetic Claude' },
  launch: { argv: ['claude'] },
  headless: null,
  resume: null,
  resumeHeadless: null,
  host: { kind: 'none', layout: 'none' },
  env: {},
  mcpServerName: 'hud',
  claimTransport: 'config_env',
  clientToolTimeoutMs: null,
  responseMarginMs: 1000,
  orphan_policy: 'continue',
  managedShellVerified: false,
});

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'projects', 'synthetic-project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'));
  const adapter = new ClaudeAdapter();
  const sourceId = await adapter.resolveSource(profile(root), {});
  const ref: SessionRef = { harness: 'claude', sourceId, sessionId: 'synthetic-root', threadId: null };
  const fileFor = (id = ref.sessionId, project = 'synthetic-project') =>
    path.join(root, 'projects', project, `${id}.jsonl`);
  const write = (id = ref.sessionId, cwd = '/synthetic/workspace', project = 'synthetic-project') => {
    const file = fileFor(id, project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd,
        timestamp: new Date(TIME).toISOString(),
        message: { role: 'user', content: 'Synthetic prompt' },
      }) + '\n'
    );
    return file;
  };
  const file = write();
  const context: ClaudeBindContext = {
    sourceId,
    explicitSession: null,
    registry: [],
    locator: null,
    processes: [],
    cwd: '/synthetic/workspace',
    startedAt: Date.now(),
  };
  const sessionFile = (sessionId = ref.sessionId, fields: Record<string, unknown> = {}, process = stamp) => {
    fs.writeFileSync(
      path.join(root, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        procStart: process.proc_start,
        pidDomain: process.pid_domain,
        sessionId,
        ...fields,
      })
    );
  };
  const registry = (target = ref): RegistryRecord => ({
    locator: null,
    binding: null,
    evidence: {
      origin: 'registry',
      ref: target,
      sourceGeneration: 1,
      validity: 'current',
      eventAt: TIME,
      observedAt: TIME,
      lastSuccessfulReadAt: TIME,
      value: {
        server: 'synthetic-server',
        occupant: target,
        completionSeq: null,
        sourceClockAt: TIME,
        activity: 'working',
        pendingReason: 'none',
      },
    },
  });
  return { root, adapter, ref, context, file, fileFor, write, sessionFile, registry };
}

test('Claude source roots are explicit, realpath-scoped and checked against effective CLAUDE_CONFIG_DIR', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.adapter.resolveSource(profile(f.root), { CLAUDE_CONFIG_DIR: f.root }), f.ref.sourceId);
  await assert.rejects(f.adapter.resolveSource(profile('relative'), {}), /invalid_claude_source/);
  await assert.rejects(
    f.adapter.resolveSource(profile(f.root), { CLAUDE_CONFIG_DIR: path.dirname(f.root) }),
    /source_mismatch/
  );
  await assert.rejects(f.adapter.resolveSource(profile(path.join(f.root, 'missing')), {}));
  await assert.rejects(f.adapter.resolveSource({ ...profile(f.root), harness: 'codex' }, {}), /invalid_claude_source/);
  assert.equal(
    await f.adapter.resolveSource(
      { ...profile(f.root), env: { CLAUDE_CONFIG_DIR: f.root } },
      { CLAUDE_CONFIG_DIR: '/synthetic/unused-ambient' }
    ),
    f.ref.sourceId
  );
});

test('stdin wins lower binding tiers and explicit/stdin contradictions fail closed', async (t) => {
  const f = await fixture(t);
  const other = { ...f.ref, sessionId: 'synthetic-other' };
  f.write(other.sessionId);
  f.sessionFile(other.sessionId);
  const statusline = { session_id: f.ref.sessionId, transcript_path: f.file };
  const result = await f.adapter.bind({ ...f.context, statusline, registry: [f.registry(other)], processes: [stamp] });
  assert.deepEqual(result, { sessionRef: f.ref, harness: null, occupantGeneration: null, managed: null });
  assert.equal(await f.adapter.bind({ ...f.context, statusline, explicitSession: other }), null);
  assert.equal(
    await f.adapter.bind({ ...f.context, statusline: { ...statusline, session_id: other.sessionId } }),
    null
  );
  assert.equal(await f.adapter.bind({ ...f.context, explicitSession: { ...f.ref, sourceId: 'f'.repeat(64) } }), null);
});

test('current registry references outrank sessions; ambiguous references never use a newest candidate', async (t) => {
  const f = await fixture(t);
  const other = { ...f.ref, sessionId: 'synthetic-other' };
  f.sessionFile(other.sessionId);
  assert.deepEqual(
    (await f.adapter.bind({ ...f.context, registry: [f.registry()], processes: [stamp] }))?.sessionRef,
    f.ref
  );
  assert.equal(await f.adapter.bind({ ...f.context, registry: [f.registry(), f.registry(other)] }), null);
  assert.equal(
    await f.adapter.bind({
      ...f.context,
      cwd: null,
      registry: [{ ...f.registry(), evidence: { ...f.registry().evidence, validity: 'stale' } }],
    }),
    null
  );
  assert.equal(
    await f.adapter.bind({
      ...f.context,
      cwd: null,
      registry: [
        {
          ...f.registry(),
          evidence: { ...f.registry().evidence, value: { ...f.registry().evidence.value, occupant: other } },
        },
      ],
    }),
    null
  );
});

test('sessions files require the supplied complete process instance, including PID domain', async (t) => {
  const f = await fixture(t);
  const context = { ...f.context, cwd: null, processes: [stamp] };
  f.sessionFile();
  assert.deepEqual(await f.adapter.bind(context), {
    sessionRef: f.ref,
    harness: stamp,
    occupantGeneration: null,
    managed: null,
  });
  assert.equal(await f.adapter.bind({ ...context, processes: [] }), null);
  for (const mismatch of [
    { procStart: 'stale' },
    { pidDomain: 'unobservable-domain' },
    { pid: stamp.pid + 1 },
    { bootId: 'different-boot' },
    { procStart: null },
    { pidDomain: null },
  ]) {
    f.sessionFile(f.ref.sessionId, mismatch);
    assert.equal(await f.adapter.bind(context), null);
  }
  const second = { ...stamp, pid: stamp.pid + 1 };
  f.sessionFile();
  f.sessionFile('synthetic-other', {}, second);
  assert.equal(await f.adapter.bind({ ...context, processes: [stamp, second] }), null);
});

test('registry surface matching requires occupant generation and full process identity', async (t) => {
  const f = await fixture(t);
  const locator = {
    kind: 'tmux' as const,
    server: 'synthetic-server',
    session: 'synthetic-session',
    pane: '%321',
    process: stamp,
    occupantGeneration: 3,
  };
  const record = { ...f.registry(), locator };
  const context = { ...f.context, cwd: null, locator, registry: [record], processes: [stamp] };
  assert.deepEqual(await f.adapter.bind(context), {
    sessionRef: f.ref,
    harness: stamp,
    occupantGeneration: 3,
    managed: null,
  });
  assert.equal(await f.adapter.bind({ ...context, locator: { ...locator, occupantGeneration: null } }), null);
  assert.equal(
    await f.adapter.bind({ ...context, locator: { ...locator, process: { ...stamp, proc_start: 'reused-pid' } } }),
    null
  );
  assert.equal(await f.adapter.bind({ ...context, locator: { ...locator, server: 'other-server' } }), null);
});

test('candidate observation finds quiet older files and requires one exact cwd match', async (t) => {
  const f = await fixture(t);
  fs.utimesSync(f.file, new Date(TIME), new Date(TIME));
  assert.deepEqual((await f.adapter.bind(f.context))?.sessionRef, f.ref);
  f.write('synthetic-other', '/synthetic/unrelated');
  assert.deepEqual((await f.adapter.bind(f.context))?.sessionRef, f.ref);
  f.write('synthetic-other');
  assert.equal(await f.adapter.bind(f.context), null);
  assert.equal(await f.adapter.bind({ ...f.context, cwd: null }), null);
});

test('native agents retain root sessionId and their own threadId; children remains an empty placeholder', async (t) => {
  const f = await fixture(t);
  const sub = { ...f.ref, threadId: 'synthetic-agent' };
  const subfile = path.join(
    f.root,
    'projects',
    'synthetic-project',
    f.ref.sessionId,
    'subagents',
    'agent-synthetic-agent.jsonl'
  );
  fs.mkdirSync(path.dirname(subfile), { recursive: true });
  fs.writeFileSync(
    subfile,
    JSON.stringify({ type: 'assistant', sessionId: f.ref.sessionId, agentId: sub.threadId }) + '\n'
  );
  assert.deepEqual(
    (
      await f.adapter.bind({
        ...f.context,
        statusline: { session_id: f.ref.sessionId, transcript_path: subfile, agent_id: sub.threadId },
      })
    )?.sessionRef,
    sub
  );
  assert.deepEqual(await f.adapter.children(f.ref), []);
  assert.deepEqual(await f.adapter.children(sub), []);
  const files = new ClaudeTranscriptFiles(f.root, f.ref.sourceId);
  assert.equal(files.resolve(sub), subfile);
  assert.equal(
    (await f.adapter.bind({ ...f.context, explicitSession: { ...f.ref, threadId: '' } }))?.sessionRef.threadId,
    null
  );
});

test('transcript and session-file symlinks cannot escape the configured source', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const escaped = a.fileFor('synthetic-escaped');
  fs.symlinkSync(b.file, escaped);
  assert.deepEqual((await a.adapter.bind(a.context))?.sessionRef, a.ref);
  assert.equal(
    await a.adapter.bind({ ...a.context, statusline: { session_id: b.ref.sessionId, transcript_path: b.file } }),
    null
  );
  fs.symlinkSync(path.dirname(b.file), path.join(a.root, 'projects', 'escaped-project'));
  assert.deepEqual((await a.adapter.bind(a.context))?.sessionRef, a.ref);
  b.sessionFile();
  fs.symlinkSync(
    path.join(b.root, 'sessions', `${stamp.pid}.json`),
    path.join(a.root, 'sessions', `${stamp.pid}.json`)
  );
  assert.equal(await a.adapter.bind({ ...a.context, cwd: null, processes: [stamp] }), null);
  const files = new ClaudeTranscriptFiles(a.root, a.ref.sourceId);
  files.remember(a.ref, a.file);
  fs.unlinkSync(a.file);
  fs.symlinkSync(b.file, a.file);
  assert.throws(() => files.resolve(a.ref), /outside_source/);
});

test('identical session IDs in explicit sources remain isolated and open defers transcript I/O', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  assert.notEqual(a.ref.sourceId, b.ref.sourceId);
  assert.throws(() => a.adapter.open(b.ref), /unknown_claude_source/);
  const missing = { ...a.ref, sessionId: 'synthetic-unavailable' };
  const reader = a.adapter.open(missing);
  await assert.rejects(reader.read(), /transcript_unavailable/);
  assert.equal(new ClaudeTranscriptFiles(a.root, a.ref.sourceId).resolve(a.ref), a.file);
  assert.equal(new ClaudeTranscriptFiles(b.root, b.ref.sourceId).resolve(b.ref), b.file);
});

test('facade passes statusline metrics to its budgeted reader and preserves one observation object', async (t) => {
  const f = await fixture(t);
  await f.adapter.bind({
    ...f.context,
    statusline: {
      session_id: f.ref.sessionId,
      transcript_path: f.file,
      model: { id: 'synthetic-model' },
      context_window: { context_window_size: 1000, current_usage: { input_tokens: 30 } },
      cost: { total_cost_usd: 0 },
    },
  });
  const reader = f.adapter.open(f.ref);
  const deferred = await reader.read({ maxBytes: 4096, maxRecords: 10, budgetMs: 20, deadlineMs: 0 });
  assert.equal(deferred.checkpoint.offset, 0);
  const result = await reader.read();
  assert.strictEqual(result.observation, result.evidence.observation);
  assert.deepEqual(result.evidence.ref, f.ref);
  assert.equal(result.evidence.model.value?.id, 'synthetic-model');
  assert.equal(result.evidence.context.value?.used, 30);
  assert.equal(result.observation.spent.costUsd.value, 0);
  assert.equal(result.observation.coverage.state, 'complete');
  assert.deepEqual(result.evidence.native, []);
});

test('verified transcript paths remain cached across appended reads and duplicate files are ambiguous', async (t) => {
  const f = await fixture(t);
  const files = new ClaudeTranscriptFiles(f.root, f.ref.sourceId);
  assert.equal(files.resolve(f.ref), f.file);
  const duplicate = f.write(f.ref.sessionId, '/synthetic/workspace', 'synthetic-second-project');
  // Once verified, the mapping remains stable rather than re-scanning all projects on every read.
  assert.equal(files.resolve(f.ref), f.file);
  const cold = new ClaudeTranscriptFiles(f.root, f.ref.sourceId);
  assert.throws(() => cold.resolve(f.ref), /ambiguous_claude_transcript/);
  assert.equal(await f.adapter.bind(f.context), null);
  fs.unlinkSync(duplicate);
  assert.equal(cold.resolve(f.ref), f.file);
  assert.throws(() => files.resolve({ ...f.ref, sessionId: '../synthetic-root' }), /unknown_claude_source/);
});

test('cold zero-budget reads perform no discovery or transcript I/O, and byte statistics include all fetched bytes', async (t) => {
  const f = await fixture(t);
  const originalRead = mutableFs.readSync;
  const originalReaddir = mutableFs.readdirSync;
  const originalRealpath = mutableFs.realpathSync;
  let actualBytes = 0;
  let discoveryCalls = 0;
  mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
    const count = Reflect.apply(originalRead, mutableFs, args) as number;
    actualBytes += count;
    return count;
  }) as typeof originalRead;
  mutableFs.readdirSync = ((...args: Parameters<typeof originalReaddir>) => {
    discoveryCalls++;
    return Reflect.apply(originalReaddir, mutableFs, args);
  }) as typeof originalReaddir;
  mutableFs.realpathSync = Object.assign(
    ((...args: Parameters<typeof originalRealpath>) => {
      discoveryCalls++;
      return Reflect.apply(originalRealpath, mutableFs, args);
    }) as typeof originalRealpath,
    { native: originalRealpath.native }
  );
  syncBuiltinESMExports();
  try {
    const reader = f.adapter.open(f.ref);
    for (const budget of [
      { maxBytes: 0, maxRecords: 10, budgetMs: 20 },
      { maxBytes: 71, maxRecords: 0, budgetMs: 20 },
      { maxBytes: 71, maxRecords: 10, budgetMs: 0 },
      { maxBytes: 71, maxRecords: 10, budgetMs: 20, deadlineMs: 0 },
    ]) {
      const result = await reader.read(budget);
      assert.equal(result.stats?.bytesRead, 0);
      assert.equal(result.checkpoint.offset, 0);
      assert.equal(actualBytes, 0);
      assert.equal(discoveryCalls, 0);
    }
    const result = await reader.read({ maxBytes: 71, maxRecords: 10, budgetMs: 20 });
    assert.ok(actualBytes > 0 && actualBytes <= 71);
    assert.equal(actualBytes, result.stats?.bytesRead);
  } finally {
    mutableFs.readSync = originalRead;
    mutableFs.readdirSync = originalReaddir;
    mutableFs.realpathSync = originalRealpath;
    syncBuiltinESMExports();
  }
});

test('deadline-limited discovery resumes its saved directory cursor without reading transcript headers', async (t) => {
  const f = await fixture(t);
  const emptyProject = path.join(f.root, 'projects', 'aaa-empty');
  fs.mkdirSync(emptyProject);
  const files = new ClaudeTranscriptFiles(f.root, f.ref.sourceId);
  const originalRead = mutableFs.readSync;
  const originalReaddir = mutableFs.readdirSync;
  const originalRealpath = mutableFs.realpathSync;
  let clock = 0;
  const mockedNow = t.mock.method(performance, 'now', () => clock);
  let scans = 0;
  let reads = 0;
  let emptyProbes = 0;
  mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
    reads++;
    return Reflect.apply(originalRead, mutableFs, args);
  }) as typeof originalRead;
  mutableFs.readdirSync = ((...args: Parameters<typeof originalReaddir>) => {
    scans++;
    const entries = Reflect.apply(originalReaddir, mutableFs, args);
    clock = 2;
    return entries;
  }) as typeof originalReaddir;
  mutableFs.realpathSync = Object.assign(
    ((...args: Parameters<typeof originalRealpath>) => {
      if (String(args[0]) === path.join(emptyProject, `${f.ref.sessionId}.jsonl`)) {
        emptyProbes++;
        clock = 2;
      }
      return Reflect.apply(originalRealpath, mutableFs, args);
    }) as typeof originalRealpath,
    { native: originalRealpath.native }
  );
  syncBuiltinESMExports();
  try {
    assert.equal(files.resolve(f.ref, 0), null);
    assert.equal(scans, 0);
    assert.equal(files.resolve(f.ref, 1), null);
    assert.equal(scans, 1);
    clock = 0;
    assert.equal(files.resolve(f.ref, 1), null);
    assert.equal(emptyProbes, 1);
    clock = 0;
    assert.equal(files.resolve(f.ref, 1), f.file);
    assert.equal(scans, 1);
    assert.equal(emptyProbes, 1);
    assert.equal(reads, 0);
  } finally {
    mutableFs.readSync = originalRead;
    mutableFs.readdirSync = originalReaddir;
    mutableFs.realpathSync = originalRealpath;
    mockedNow.mock.restore();
    syncBuiltinESMExports();
  }
});
