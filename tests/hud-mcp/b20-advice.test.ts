import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { loadCacheConfig, type CacheConfigLoad } from '../../src/core/cache-config.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import type { Ledger } from '../../src/ledger/ledger.js';
import type { DelegateProfile } from '../../src/core/types/capabilities.js';
import type { PreparedRunLaunch } from '../../src/core/launch/index.js';

// Compiled under packages/hud-mcp/dist/tests/hud-mcp, so the repository root is five levels up.
const FIXTURES = fileURLToPath(new URL('../../../../../tests/fixtures/b20/', import.meta.url));
const sectionFiveTwo = fs.readFileSync(join(FIXTURES, 'cache-v2.json'), 'utf8');
/** The §5.2 shape with a harness wildcard, so an `auth: 'unknown'` caller can match. */
const wildcardCache = JSON.stringify({
  version: 2,
  handoffMinTokens: 60000,
  entries: [
    {
      match: { harness: 'codex' },
      configured: { ttlMs: 1800000, source: 'synthetic configured' },
      documented: {
        ttlMs: 900000,
        writeMultiplier: 1.25,
        readMultiplier: { default: 0.1 },
        lifetimeFrom: 'request_start',
        source: 'synthetic documented',
      },
      planningAssumption: { ttlMs: 300000, label: 'synthetic planning' },
      warming: 'off',
    },
    { match: { harness: 'pi' }, documented: { source: 'synthetic pi' }, warming: 'native' },
  ],
});
const EMPTY_ADVICE = {
  harness: 'codex',
  auth: 'unknown',
  model: 'synthetic-model',
  configuredTtlMs: null,
  documentedTtlMs: null,
  planningTtlMs: null,
  provenance: {
    entry: null,
    authMatch: null,
    configuredSource: null,
    documentedSource: null,
    observedSource: null,
    planningAssumptionLabel: null,
    observed: false,
  },
  lastQualifyingRequestStartAt: null,
  remainingWarmWindowMs: null,
  warming: 'off',
};
const MATCHED_ADVICE = {
  ...EMPTY_ADVICE,
  configuredTtlMs: 1800000,
  documentedTtlMs: 900000,
  planningTtlMs: 300000,
  provenance: {
    entry: 0,
    authMatch: 'wildcard',
    configuredSource: 'synthetic configured',
    documentedSource: 'synthetic documented',
    observedSource: null,
    planningAssumptionLabel: 'synthetic planning',
    observed: false,
  },
};

async function fixture(t: test.TestContext) {
  const f = await handshakeFixture();
  t.after(async () => {
    await f.close();
  });
  const brief = join(f.root, 'brief.md');
  fs.writeFileSync(brief, 'Synthetic task bytes.');
  fs.writeFileSync(join(f.root, 'config.toml'), '[mcp_servers.hud]\ncommand="/synthetic/bin/node"\n');
  const profile: DelegateProfile = {
    name: 'codex',
    harness: 'codex',
    source: { root: f.root, label: 'Synthetic' },
    launch: { argv: ['/synthetic/bin/codex'] },
    headless: { argv: ['/synthetic/bin/codex', 'exec', '-'] },
    resume: { argv: ['/synthetic/bin/codex', 'resume', '{{sessionId}}'] },
    resumeHeadless: { argv: ['/synthetic/bin/codex', 'exec', 'resume', '{{sessionId}}', '-'] },
    host: { kind: 'none', layout: 'none' },
    env: { CODEX_HOME: f.root },
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
  };
  const launches: PreparedRunLaunch[] = [];
  const config = { version: 1 as const, profiles: [profile] };
  const options = {
    ledger: f.ledger,
    home: f.root,
    config,
    registration: f.parent.registration,
    reader: f.reader,
    env: {},
    hudRunPath: resolve('bin/hud-run'),
    capability: { verify: () => ({ ok: true as const, reason: null }) },
    launch: async (p: PreparedRunLaunch) => {
      launches.push(p);
      return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
    },
  };
  function source() {
    return {
      ok: true as const,
      callId: 'synthetic-call-' + performance.now(),
      sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey,
      evidenceDigest: hashClaim('synthetic source'),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
      ),
    };
  }
  const args = {
    backend: 'codex',
    role: 'implementer',
    brief,
    cwd: f.root,
    mode: 'headless',
    request_key: 'synthetic-request',
  };
  return { ...f, brief, profile, options, source, args, launches };
}

function service(options: ConstructorParameters<typeof DelegationService>[0], cache: CacheConfigLoad) {
  return new DelegationService({ ...options, cache });
}

test('delegate_status and delegate_spawn carry the §5.2 advice from the startup snapshot', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), wildcardCache);
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok, true);
  const delegation = service(f.options, load);
  t.after(() => delegation.close());

  const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
    advice: unknown;
  };
  assert.deepEqual(status.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
  assert.equal('wake' in (status.advice as object), true);

  const spawn = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
    status: string;
    advice: unknown;
  };
  assert.equal(spawn.status, 'accepted');
  assert.deepEqual(spawn.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
  assert.deepEqual(await delegation.invoke(f.source(), 'delegate_spawn', f.args), spawn);
  assert.equal(f.launches.length, 1);
});

test('B19 merge: one real status and spawn response retain cache keys and advice.wake', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), wildcardCache);
  const delegation = service(f.options, loadCacheConfig(f.root));
  t.after(() => delegation.close());
  const spawned = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as { runId: string; advice: unknown };
  const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: spawned.runId })) as {
    advice: unknown;
  };
  for (const response of [spawned, status]) {
    assert.deepEqual(response.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
  }
});

test('the checked-in §5.2 file never guesses an auth label for a codex caller', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), sectionFiveTwo);
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok, true);
  const delegation = service(f.options, load);
  t.after(() => delegation.close());
  const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
    advice: unknown;
  };
  // The §5.2 codex entry lists `chatgpt`; `unknown` must not be promoted to it.
  assert.deepEqual(status.advice, { ...EMPTY_ADVICE, wake: { adapter: 'none', state: 'none' } });
});

test('a missing cache.json is a valid empty snapshot with empty advice', async (t) => {
  const f = await fixture(t);
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok && load.origin, 'missing');
  const delegation = service(f.options, load);
  t.after(() => delegation.close());
  const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
    advice: unknown;
  };
  assert.deepEqual(status.advice, { ...EMPTY_ADVICE, wake: { adapter: 'none', state: 'none' } });
  const spawn = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as { advice: unknown };
  assert.deepEqual(spawn.advice, { ...EMPTY_ADVICE, wake: { adapter: 'none', state: 'none' } });
});

test('an invalid cache.json still serves status and spawn with configError and empty advice', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), '{"version": 2, ');
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok, false);
  const delegation = service(f.options, load);
  t.after(() => delegation.close());
  const expected = { ...EMPTY_ADVICE, configError: 'invalid_json' };
  const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
    advice: unknown;
  };
  assert.deepEqual(status.advice, { ...expected, wake: { adapter: 'none', state: 'none' } });
  const spawn = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
    status: string;
    advice: unknown;
  };
  assert.equal(spawn.status, 'accepted');
  assert.deepEqual(spawn.advice, { ...expected, wake: { adapter: 'none', state: 'none' } });
});

test('status and every spawn outcome perform no cache file access after startup', async (t) => {
  const f = await fixture(t);
  const cachePath = join(f.root, 'cache.json');
  fs.writeFileSync(cachePath, wildcardCache);
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok, true);
  const delegation = service(f.options, load);
  t.after(() => delegation.close());
  const limited = service(
    { ...f.options, config: { ...f.options.config, limits: { maxActiveRuns: 1, maxActiveRunsPerOwner: 1 } } },
    load
  );
  t.after(() => limited.close());

  // Every guarded route records its target; only a call on the cache path (or on a
  // descriptor opened from it) counts as cache access. Launch I/O is recorded too
  // and filtered out, so a brief read can never be mistaken for a cache lookup.
  const calls: { route: string; cache: boolean }[] = [];
  const cacheFds = new Set<number>();
  // Node accepts strings, Buffers and file URLs. Normalise all of them before
  // comparing, so a URL cannot slip past the guard as "unrelated I/O".
  const normalise = (value: unknown): string | null => {
    if (typeof value === 'string') return resolve(value.startsWith('file:') ? fileURLToPath(value) : value);
    if (Buffer.isBuffer(value)) return resolve(value.toString());
    if (value instanceof URL) return resolve(fileURLToPath(value));
    return null;
  };
  const cacheTarget = resolve(cachePath);
  const isCache = (value: unknown) => normalise(value) === cacheTarget;
  const note = (route: string, cache: boolean) => calls.push({ route, cache });
  const cacheCalls = () => calls.filter((call) => call.cache).map((call) => call.route);
  const noCacheAccess = (label: string) =>
    assert.deepEqual(cacheCalls(), [], `${label} accessed the cache file after startup`);

  const original = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    fstatSync: fs.fstatSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    readFileSync: fs.readFileSync,
    closeSync: fs.closeSync,
    stat: fs.promises.stat,
    lstat: fs.promises.lstat,
    readFile: fs.promises.readFile,
    open: fs.promises.open,
    access: fs.promises.access,
  };
  const mocks = [
    t.mock.method(fs, 'existsSync', (...args: unknown[]) => {
      note('existsSync', isCache(args[0]));
      return Reflect.apply(original.existsSync, fs, args);
    }),
    t.mock.method(fs, 'statSync', (...args: unknown[]) => {
      note('statSync', isCache(args[0]));
      return Reflect.apply(original.statSync, fs, args);
    }),
    t.mock.method(fs, 'lstatSync', (...args: unknown[]) => {
      note('lstatSync', isCache(args[0]));
      return Reflect.apply(original.lstatSync, fs, args);
    }),
    t.mock.method(fs, 'fstatSync', (...args: unknown[]) => {
      note('fstatSync', cacheFds.has(Number(args[0])));
      return Reflect.apply(original.fstatSync, fs, args);
    }),
    t.mock.method(fs, 'openSync', (...args: unknown[]) => {
      const fd = Reflect.apply(original.openSync, fs, args) as number;
      if (isCache(args[0])) {
        cacheFds.add(fd);
        note('openSync', true);
      }
      return fd;
    }),
    t.mock.method(fs, 'readSync', (...args: unknown[]) => {
      note('readSync', cacheFds.has(Number(args[0])));
      return Reflect.apply(original.readSync, fs, args);
    }),
    t.mock.method(fs, 'readFileSync', (...args: unknown[]) => {
      note('readFileSync', isCache(args[0]));
      return Reflect.apply(original.readFileSync, fs, args);
    }),
    t.mock.method(fs, 'closeSync', (...args: unknown[]) => {
      cacheFds.delete(Number(args[0]));
      return Reflect.apply(original.closeSync, fs, args);
    }),
    t.mock.method(fs.promises, 'stat', async (...args: unknown[]) => {
      note('promises.stat', isCache(args[0]));
      return Reflect.apply(original.stat, fs.promises, args);
    }),
    t.mock.method(fs.promises, 'lstat', async (...args: unknown[]) => {
      note('promises.lstat', isCache(args[0]));
      return Reflect.apply(original.lstat, fs.promises, args);
    }),
    t.mock.method(fs.promises, 'readFile', async (...args: unknown[]) => {
      note('promises.readFile', isCache(args[0]));
      return Reflect.apply(original.readFile, fs.promises, args);
    }),
    t.mock.method(fs.promises, 'access', async (...args: unknown[]) => {
      note('promises.access', isCache(args[0]));
      return Reflect.apply(original.access, fs.promises, args);
    }),
    t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      const handle = await (Reflect.apply(original.open, fs.promises, args) as Promise<Record<string, any>>);
      if (!isCache(args[0])) return handle;
      note('promises.open', true);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      handle.stat = async (...rest: unknown[]) => {
        note('promises.fstat', true);
        return stat(...rest);
      };
      handle.read = async (...rest: unknown[]) => {
        note('promises.read', true);
        return read(...rest);
      };
      return handle;
    }),
  ];
  syncBuiltinESMExports();
  try {
    // A positive control for every guarded route: each must be seen on the cache path.
    const control = async (label: string, run: () => unknown, route = label) => {
      calls.length = 0;
      await run();
      assert.ok(
        calls.some((call) => call.cache && call.route === route),
        `positive control did not reach ${label}`
      );
    };
    await control('existsSync', () => fs.existsSync(cachePath));
    await control('statSync', () => fs.statSync(cachePath));
    await control('lstatSync', () => fs.lstatSync(cachePath));
    await control('readFileSync', () => fs.readFileSync(cachePath));
    await control('openSync', () => fs.closeSync(fs.openSync(cachePath, 'r')));
    await control('fstatSync', () => {
      const fd = fs.openSync(cachePath, 'r');
      try {
        fs.fstatSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
    await control('readSync', () => {
      const fd = fs.openSync(cachePath, 'r');
      try {
        fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        fs.closeSync(fd);
      }
    });
    await control('promises.stat', () => fs.promises.stat(cachePath));
    await control('promises.lstat', () => fs.promises.lstat(cachePath));
    await control('promises.readFile', () => fs.promises.readFile(cachePath));
    await control('promises.access', () => fs.promises.access(cachePath));
    await control('promises.open', async () => {
      const handle = await fs.promises.open(cachePath, 'r');
      await handle.close();
    });
    await control('promises.fstat', async () => {
      const handle = await fs.promises.open(cachePath, 'r');
      try {
        await handle.stat();
      } finally {
        await handle.close();
      }
    });
    await control('promises.read', async () => {
      const handle = await fs.promises.open(cachePath, 'r');
      try {
        await handle.read(Buffer.alloc(1), 0, 1, 0);
      } finally {
        await handle.close();
      }
    });

    // The same routes also accept file URLs; each must normalise to the cache path.
    await control('existsSync via URL', () => fs.existsSync(pathToFileURL(cachePath)), 'existsSync');
    await control('statSync via URL', () => fs.statSync(pathToFileURL(cachePath)), 'statSync');
    await control('lstatSync via URL', () => fs.lstatSync(pathToFileURL(cachePath)), 'lstatSync');
    await control('readFileSync via URL', () => fs.readFileSync(pathToFileURL(cachePath)), 'readFileSync');
    await control('openSync via URL', () => fs.closeSync(fs.openSync(pathToFileURL(cachePath), 'r')), 'openSync');
    await control('promises.stat via URL', () => fs.promises.stat(pathToFileURL(cachePath)), 'promises.stat');
    await control('promises.lstat via URL', () => fs.promises.lstat(pathToFileURL(cachePath)), 'promises.lstat');
    await control(
      'promises.readFile via URL',
      () => fs.promises.readFile(pathToFileURL(cachePath)),
      'promises.readFile'
    );
    await control('promises.access via URL', () => fs.promises.access(pathToFileURL(cachePath)), 'promises.access');
    await control(
      'promises.open via URL',
      async () => {
        const handle = await fs.promises.open(pathToFileURL(cachePath), 'r');
        await handle.close();
      },
      'promises.open'
    );
    // Descriptor tracking must also follow a file opened through a URL.
    await control(
      'fstatSync via URL open',
      () => {
        const fd = fs.openSync(pathToFileURL(cachePath), 'r');
        try {
          fs.fstatSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      },
      'fstatSync'
    );
    await control(
      'readSync via URL open',
      () => {
        const fd = fs.openSync(pathToFileURL(cachePath), 'r');
        try {
          fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
        } finally {
          fs.closeSync(fd);
        }
      },
      'readSync'
    );
    await control(
      'promises.fstat via URL open',
      async () => {
        const handle = await fs.promises.open(pathToFileURL(cachePath), 'r');
        try {
          await handle.stat();
        } finally {
          await handle.close();
        }
      },
      'promises.fstat'
    );
    await control(
      'promises.read via URL open',
      async () => {
        const handle = await fs.promises.open(pathToFileURL(cachePath), 'r');
        try {
          await handle.read(Buffer.alloc(1), 0, 1, 0);
        } finally {
          await handle.close();
        }
      },
      'promises.read'
    );

    calls.length = 0;
    const status = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
      advice: unknown;
    };
    assert.deepEqual(status.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
    noCacheAccess('status');

    const accepted = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
      status: string;
      advice: unknown;
    };
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(accepted.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
    noCacheAccess('accepted spawn');

    const replay = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
      status: string;
      advice: unknown;
    };
    assert.deepEqual(replay, accepted);
    noCacheAccess('replayed spawn');

    const refused = (await limited.invoke(f.source(), 'delegate_spawn', {
      ...f.args,
      request_key: 'capacity-refused',
    })) as { ok: boolean; code: string; advice: unknown };
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'concurrency_limit');
    assert.deepEqual(refused.advice, MATCHED_ADVICE);
    noCacheAccess('capacity refusal');

    // A change on disk cannot affect this process: the snapshot was loaded once.
    fs.writeFileSync(cachePath, JSON.stringify({ version: 2, entries: [] }));
    const third = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
      advice: unknown;
    };
    assert.deepEqual(third.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
    noCacheAccess('status after on-disk change');

    // Sensitivity: the review injected `fs.existsSync(pathToFileURL(cachePath))`
    // into each advice lookup and this test still passed. Reproduce that variant
    // in the guarded window: the empty-cache-access assertion must be what fails.
    calls.length = 0;
    const probe = (await delegation.invoke(f.source(), 'delegate_status', { runId: 'run-a' })) as {
      advice: unknown;
    };
    assert.deepEqual(probe.advice, { ...MATCHED_ADVICE, wake: { adapter: 'none', state: 'none' } });
    fs.existsSync(pathToFileURL(cachePath));
    assert.throws(() => noCacheAccess('sensitivity probe'), /sensitivity probe accessed the cache file after startup/);
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('status and spawn merge the cache advice over an existing advice object', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), wildcardCache);
  const load = loadCacheConfig(f.root);
  assert.equal(load.ok, true);
  const wake = { adapter: 'none', state: 'none' };

  // B19 projects `advice.wake` into the status snapshot; simulate it at the read
  // so the production composition point is what performs the merge.
  const ledger = {
    readSnapshot: (callback: (tx: unknown) => object) =>
      f.ledger.readSnapshot((tx) => ({ ...callback(tx), advice: { wake } })),
  } as unknown as Ledger;
  const reads = new ReadControlService(
    ledger,
    f.root,
    undefined,
    {},
    {},
    {
      load,
      harness: 'codex',
      model: () => 'synthetic-model',
    }
  );
  t.after(() => reads.close());
  const status = (await reads.status({ runId: 'run-a' }, () => f.parent.authority)) as { advice: unknown };
  assert.deepEqual(status.advice, { ...MATCHED_ADVICE, wake });

  // The replay outcome is persisted at acceptance; B19's wake must survive it.
  const delegation = service(f.options, load);
  t.after(() => delegation.close());
  const accepted = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
    runId: string;
    advice: unknown;
  };
  assert.deepEqual(accepted.advice, { ...MATCHED_ADVICE, wake });
  await f.ledger.transaction((tx) => {
    const row = tx.get("SELECT outcome FROM idempotency WHERE request_key='synthetic-request'")!;
    const outcome = JSON.parse(String(row.outcome)) as object;
    tx.run(
      "UPDATE idempotency SET outcome=? WHERE request_key='synthetic-request'",
      JSON.stringify({ ...outcome, advice: { wake } })
    );
  });
  const replay = (await delegation.invoke(f.source(), 'delegate_spawn', f.args)) as {
    runId: string;
    advice: unknown;
  };
  assert.equal(replay.runId, accepted.runId);
  assert.deepEqual(replay.advice, { ...MATCHED_ADVICE, wake });
  assert.equal(f.launches.length, 1);
});

test('a thrown spawn refusal carries advice at the server boundary for valid and invalid snapshots', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'cache.json'), wildcardCache);
  const valid = loadCacheConfig(f.root);
  assert.equal(valid.ok, true);
  fs.writeFileSync(join(f.root, 'cache.json'), '{"version": 2, ');
  const invalid = loadCacheConfig(f.root);
  assert.equal(invalid.ok, false);

  const refused = (cache: CacheConfigLoad) =>
    new DelegationService({
      ...f.options,
      cache,
      capability: { verify: () => ({ ok: false as const, reason: 'capability_unverified' }) },
    });
  const request = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'delegate_spawn', arguments: f.args },
  });
  const validService = refused(valid);
  t.after(() => validService.close());
  const validServer = new HudMcpServer({ resolve: async () => f.source() }, validService);
  const accepted = (await validServer.handle(request(1))) as any;
  assert.deepEqual(accepted.result.structuredContent, {
    ok: false,
    code: 'capability_unverified',
    advice: MATCHED_ADVICE,
  });
  assert.equal(accepted.result.isError, true);

  const invalidService = refused(invalid);
  t.after(() => invalidService.close());
  const invalidServer = new HudMcpServer({ resolve: async () => f.source() }, invalidService);
  const broken = (await invalidServer.handle(request(2))) as any;
  assert.deepEqual(broken.result.structuredContent, {
    ok: false,
    code: 'capability_unverified',
    advice: { ...EMPTY_ADVICE, configError: 'invalid_json' },
  });

  // A refusal produced before the body is reached (resolver) carries it too.
  const resolverRefusal = new HudMcpServer(
    { resolve: async () => ({ ok: false as const, code: 'identity_source_missing' as const }) },
    validService
  );
  const refusedReply = (await resolverRefusal.handle(request(3))) as any;
  assert.deepEqual(refusedReply.result.structuredContent, {
    ok: false,
    code: 'identity_source_missing',
    advice: MATCHED_ADVICE,
  });
});

test('hud-mcp starts and answers initialize with a valid and with an invalid cache.json', async (t) => {
  const bin = fileURLToPath(new URL('../../../bin/hud-mcp.mjs', import.meta.url));
  for (const text of [wildcardCache, '{"version": 2, ']) {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-b20-start-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(join(home, 'cache.json'), text);
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, HUD_HOME: home, HUD_MCP_PROFILE: '', HUD_MCP_REGISTRY_DIR: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const ended = once(child, 'exit');
    child.stdin.end(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n'
    );
    const [code] = await ended;
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).result.serverInfo.name, 'hud-mcp');
  }
});
