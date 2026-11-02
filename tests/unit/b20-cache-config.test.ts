import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  adviceFor,
  CACHE_CONFIG_MAX_AUTH_ALTERNATIVES,
  CACHE_CONFIG_MAX_BYTES,
  CACHE_CONFIG_MAX_ENTRIES,
  DEFAULT_HANDOFF_MIN_TOKENS,
  emptyCacheConfig,
  handoffMinTokensFor,
  loadCacheConfig,
  parseCacheConfig,
  validateCacheConfig,
  type CacheAdvice,
  type CacheConfigErrorCode,
  type CacheConfigInvalid,
  type CacheConfigLoad,
  type CacheConfigParse,
  type CacheConfigSnapshot,
} from '../../src/core/cache-config.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'b20');

function fixtureText(name: string): string {
  return fs.readFileSync(join(FIXTURES, name), 'utf8');
}

/** A private temporary HUD_HOME, holding `cache.json` when `text` is given. */
function home(t: test.TestContext, text?: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-b20-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (text !== undefined) fs.writeFileSync(join(dir, 'cache.json'), text);
  return dir;
}

function loaded(result: CacheConfigLoad | CacheConfigParse): CacheConfigSnapshot {
  if (!result.ok) assert.fail(`unexpected ${result.detail} at ${result.at}`);
  return result.snapshot;
}

function invalid(result: CacheConfigLoad | CacheConfigParse): CacheConfigInvalid {
  if (result.ok) assert.fail(`expected an invalid result, got ${JSON.stringify(result.snapshot)}`);
  return result;
}

function assertInvalid(
  result: CacheConfigLoad | CacheConfigParse,
  detail: CacheConfigErrorCode,
  at: string | null
): CacheConfigInvalid {
  const problem = invalid(result);
  assert.equal(problem.reason, 'cache_config_invalid');
  assert.equal(problem.detail, detail);
  assert.equal(problem.at, at);
  return problem;
}

/** One entry with a pi wildcard match, overridden field by field. */
function oneEntry(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: 2, entries: [{ match: { harness: 'pi' }, ...fields }] });
}

test('the §5.2 example loads once and answers each of its four entries', (t) => {
  const dir = home(t, fixtureText('cache-v2.json'));
  const result = loadCacheConfig(dir);
  const snapshot = loaded(result);
  assert.ok(result.ok);
  assert.equal(result.origin, 'file');
  assert.equal(result.path, join(dir, 'cache.json'));
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.handoffMinTokens, 60000);
  assert.equal(handoffMinTokensFor(snapshot), 60000);
  assert.equal(snapshot.entries.length, 4);
  // The loader reads and validates; it never writes or creates anything.
  assert.deepEqual(fs.readdirSync(dir), ['cache.json']);

  // Entry 1: a subscription's main conversation, configured and documented alike.
  assert.deepEqual(
    adviceFor(snapshot, { harness: 'claude', auth: 'subscription_included', model: 'claude-fable-5-1' }),
    {
      harness: 'claude',
      auth: 'subscription_included',
      model: 'claude-fable-5-1',
      configuredTtlMs: 3600000,
      documentedTtlMs: 3600000,
      planningTtlMs: null,
      provenance: {
        entry: 0,
        authMatch: 'listed',
        configuredSource: 'promptCacheTtl unset = automatic (binary text 2.1.305)',
        documentedSource: 'code.claude.com prompt-caching; platform docs',
        observedSource: null,
        planningAssumptionLabel: null,
        observed: false,
      },
      lastQualifyingRequestStartAt: null,
      remainingWarmWindowMs: null,
      warming: 'off',
    }
  );

  // Entry 2: every listed alternative of the usage-credits/API row answers the same.
  for (const auth of ['usage_credits', 'api', 'bedrock', 'vertex', 'foundry']) {
    const advice = adviceFor(snapshot, { harness: 'claude', auth });
    assert.equal(advice.provenance.entry, 1, auth);
    assert.equal(advice.provenance.authMatch, 'listed', auth);
    assert.equal(advice.configuredTtlMs, null, auth);
    assert.equal(advice.documentedTtlMs, 300000, auth);
    assert.equal(advice.planningTtlMs, null, auth);
    assert.equal(advice.warming, 'off', auth);
  }

  // Entry 3: Codex documents nothing for the ChatGPT backend; the assumption stays separate.
  const codex = adviceFor(snapshot, { harness: 'codex', auth: 'chatgpt', model: 'gpt-6.1-sol' });
  assert.equal(codex.provenance.entry, 2);
  assert.equal(codex.configuredTtlMs, null);
  assert.equal(codex.documentedTtlMs, null);
  assert.equal(codex.planningTtlMs, 300000);
  assert.equal(codex.provenance.configuredSource, '0.166 sends no retention option');
  assert.equal(codex.provenance.documentedSource, null);
  assert.equal(codex.provenance.planningAssumptionLabel, 'conservative, display only');
  assert.equal(codex.warming, 'off');

  // Entry 4: pi has no auth key and is the only native warming owner.
  const pi = adviceFor(snapshot, { harness: 'pi', auth: 'subscription_included' });
  assert.equal(pi.provenance.entry, 3);
  assert.equal(pi.provenance.authMatch, 'wildcard');
  assert.equal(pi.configuredTtlMs, null);
  assert.equal(pi.documentedTtlMs, null);
  assert.equal(pi.planningTtlMs, null);
  assert.equal(pi.provenance.documentedSource, 'models.json promptCache, best-effort');
  assert.equal(pi.warming, 'native');
  assert.equal(pi.model, null);
});

test('a listed unknown alternative matches like any other label and beats a wildcard', (t) => {
  const snapshot = loaded(loadCacheConfig(home(t, fixtureText('cache-v2.json'))));

  // No claude entry lists `unknown`, so the label matches none of them.
  const claude = adviceFor(snapshot, { harness: 'claude', auth: 'unknown' });
  assert.equal(claude.provenance.entry, null);
  assert.equal(claude.provenance.authMatch, null);
  assert.equal(claude.configuredTtlMs, null);
  assert.equal(claude.documentedTtlMs, null);
  assert.equal(claude.planningTtlMs, null);
  assert.equal(claude.warming, 'off');

  // The pi entry has no auth key, so it matches `unknown` as a wildcard.
  const pi = adviceFor(snapshot, { harness: 'pi', auth: 'unknown' });
  assert.equal(pi.provenance.entry, 3);
  assert.equal(pi.provenance.authMatch, 'wildcard');
  assert.equal(pi.warming, 'native');

  // A listed `unknown` is a literal label: it matches, and it wins over a wildcard.
  const listed = loaded(
    validateCacheConfig({
      version: 2,
      entries: [
        { match: { harness: 'pi' }, documented: { ttlMs: 300000 } },
        { match: { harness: 'pi', auth: 'unknown' }, documented: { ttlMs: 600000 }, warming: 'native' },
      ],
    })
  );
  const unknown = adviceFor(listed, { harness: 'pi', auth: 'unknown' });
  assert.equal(unknown.provenance.entry, 1);
  assert.equal(unknown.provenance.authMatch, 'listed');
  assert.equal(unknown.documentedTtlMs, 600000);
  assert.equal(unknown.warming, 'native');
  // The wildcard still answers every other label.
  assert.equal(adviceFor(listed, { harness: 'pi', auth: 'api' }).provenance.entry, 0);

  // `unknown` is never matched against `subscription_included`, and the listed label still is.
  const spelled = loaded(
    validateCacheConfig({
      version: 2,
      entries: [{ match: { harness: 'claude', auth: 'subscription_included' }, warming: 'native' }],
    })
  );
  assert.equal(adviceFor(spelled, { harness: 'claude', auth: 'unknown' }).provenance.entry, null);
  assert.equal(adviceFor(spelled, { harness: 'claude', auth: 'subscription_included' }).provenance.entry, 0);

  // An empty label is the unknown label, never a guess.
  assert.equal(adviceFor(snapshot, { harness: 'claude', auth: '' }).auth, 'unknown');
});

test('a missing cache.json is a valid empty snapshot, not an error', (t) => {
  const dir = home(t);
  const result = loadCacheConfig(dir);
  assert.ok(result.ok);
  assert.equal(result.origin, 'missing');
  assert.equal(result.path, join(dir, 'cache.json'));
  assert.deepEqual(result.snapshot, { version: 2, handoffMinTokens: null, entries: [] });
  assert.deepEqual(emptyCacheConfig(), result.snapshot);
  assert.equal(handoffMinTokensFor(result.snapshot), DEFAULT_HANDOFF_MIN_TOKENS);
  assert.equal(DEFAULT_HANDOFF_MIN_TOKENS, 60000);
  assert.deepEqual(adviceFor(result.snapshot, { harness: 'pi', auth: 'unknown', model: 'synthetic-model' }), {
    harness: 'pi',
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
  });
  // A missing file is not created by the loader.
  assert.deepEqual(fs.readdirSync(dir), []);
});

const invalidCases: Array<[string, string, CacheConfigErrorCode, string | null]> = [
  ['malformed JSON', '{ "version": 2, ', 'invalid_json', null],
  ['a non-object document', '[2]', 'invalid_type', null],
  ['a missing version', '{"entries":[]}', 'invalid_type', 'version'],
  ['a wrong version', '{"version":1,"entries":[]}', 'wrong_version', 'version'],
  ['an unknown top-level key', '{"version":2,"entries":[],"warming":"off"}', 'unknown_key', 'warming'],
  ['a non-array entries value', '{"version":2,"entries":{}}', 'invalid_type', 'entries'],
  ['a missing entries value', '{"version":2}', 'invalid_type', 'entries'],
  ['a non-object entry', '{"version":2,"entries":[null]}', 'invalid_type', 'entries[0]'],
  [
    'a negative handoffMinTokens',
    '{"version":2,"handoffMinTokens":-5,"entries":[]}',
    'invalid_number',
    'handoffMinTokens',
  ],
  ['an unknown entry key', oneEntry({ warm: 'off' }), 'unknown_key', 'entries[0].warm'],
  ['a missing match', '{"version":2,"entries":[{}]}', 'invalid_type', 'entries[0].match'],
  [
    'an unknown match key',
    oneEntry({ match: { harness: 'pi', model: 'synthetic-model' } }),
    'unknown_key',
    'entries[0].match.model',
  ],
  ['an unknown harness', oneEntry({ match: { harness: 'cursor' } }), 'invalid_type', 'entries[0].match.harness'],
  ['a non-string auth', oneEntry({ match: { harness: 'pi', auth: 3 } }), 'invalid_type', 'entries[0].match.auth'],
  [
    'an empty auth alternative',
    oneEntry({ match: { harness: 'pi', auth: 'api|' } }),
    'invalid_type',
    'entries[0].match.auth',
  ],
  [
    'a duplicate auth alternative',
    oneEntry({ match: { harness: 'pi', auth: 'api|api' } }),
    'invalid_type',
    'entries[0].match.auth',
  ],
  ['a non-object configured block', oneEntry({ configured: [] }), 'invalid_type', 'entries[0].configured'],
  ['an empty configured block', oneEntry({ configured: {} }), 'invalid_type', 'entries[0].configured'],
  [
    'a non-string configured source',
    oneEntry({ configured: { source: 3 } }),
    'invalid_type',
    'entries[0].configured.source',
  ],
  [
    'a negative configured TTL',
    oneEntry({ configured: { ttlMs: -1 } }),
    'invalid_number',
    'entries[0].configured.ttlMs',
  ],
  ['a zero documented TTL', oneEntry({ documented: { ttlMs: 0 } }), 'invalid_number', 'entries[0].documented.ttlMs'],
  [
    'a fractional planning TTL',
    oneEntry({ planningAssumption: { ttlMs: 1.5 } }),
    'invalid_number',
    'entries[0].planningAssumption.ttlMs',
  ],
  ['an unknown documented key', oneEntry({ documented: { ttl: 300000 } }), 'unknown_key', 'entries[0].documented.ttl'],
  [
    'a negative write multiplier',
    oneEntry({ documented: { writeMultiplier: -2 } }),
    'invalid_number',
    'entries[0].documented.writeMultiplier',
  ],
  [
    'an infinite write multiplier',
    '{"version":2,"entries":[{"match":{"harness":"pi"},"documented":{"writeMultiplier":1e999}}]}',
    'invalid_number',
    'entries[0].documented.writeMultiplier',
  ],
  [
    'a non-object readMultiplier',
    oneEntry({ documented: { readMultiplier: 0.1 } }),
    'invalid_type',
    'entries[0].documented.readMultiplier',
  ],
  [
    'an empty readMultiplier',
    oneEntry({ documented: { readMultiplier: {} } }),
    'invalid_type',
    'entries[0].documented.readMultiplier',
  ],
  [
    'a negative readMultiplier value',
    oneEntry({ documented: { readMultiplier: { default: -0.1 } } }),
    'invalid_number',
    'entries[0].documented.readMultiplier.default',
  ],
  ['an unknown observed key', oneEntry({ observed: { ttl: 1 } }), 'unknown_key', 'entries[0].observed.ttl'],
  [
    'a non-object planningAssumption',
    oneEntry({ planningAssumption: 'conservative' }),
    'invalid_type',
    'entries[0].planningAssumption',
  ],
  ['an unknown warming value', oneEntry({ warming: 'auto' }), 'invalid_type', 'entries[0].warming'],
  [
    'a duplicate match',
    '{"version":2,"entries":[{"match":{"harness":"pi"}},{"match":{"harness":"pi"}}]}',
    'duplicate_match',
    'entries[1].match',
  ],
  [
    'a duplicate match with reordered alternatives',
    '{"version":2,"entries":[{"match":{"harness":"claude","auth":"api|bedrock"}},{"match":{"harness":"claude","auth":"bedrock|api"}}]}',
    'duplicate_match',
    'entries[1].match',
  ],
  [
    'a duplicate match with whitespace-normalized alternatives',
    '{"version":2,"entries":[{"match":{"harness":"claude","auth":" api | bedrock "}},{"match":{"harness":"claude","auth":"bedrock|api"}}]}',
    'duplicate_match',
    'entries[1].match',
  ],
  [
    'more auth alternatives than the cap',
    oneEntry({
      match: {
        harness: 'pi',
        auth: Array.from({ length: CACHE_CONFIG_MAX_AUTH_ALTERNATIVES + 1 }, (_, i) => `synthetic-${i}`).join('|'),
      },
    }),
    'too_many_alternatives',
    'entries[0].match.auth',
  ],
];

for (const [name, text, detail, at] of invalidCases) {
  test(`cache.json v2 refuses ${name}`, (t) => {
    const dir = home(t, text);
    const result = loadCacheConfig(dir);
    const problem = assertInvalid(result, detail, at);
    assert.equal(problem.path, join(dir, 'cache.json'));
    // The pure validator answers the same problem without a path.
    assert.equal(assertInvalid(parseCacheConfig(text), detail, at).path, null);
  });
}

test('cache.json v2 refuses files over 64 KiB and more than 64 entries', (t) => {
  const base = JSON.stringify({ version: 2, entries: [] });
  const padded = base + ' '.repeat(CACHE_CONFIG_MAX_BYTES - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(padded), CACHE_CONFIG_MAX_BYTES);
  assert.deepEqual(loaded(loadCacheConfig(home(t, padded))).entries, []);
  assertInvalid(loadCacheConfig(home(t, padded + ' ')), 'file_too_large', null);

  const atLimit = Array.from({ length: CACHE_CONFIG_MAX_ENTRIES }, (_, i) => ({
    match: { harness: 'pi', auth: `synthetic-${i}` },
  }));
  assert.equal(loaded(validateCacheConfig({ version: 2, entries: atLimit })).entries.length, CACHE_CONFIG_MAX_ENTRIES);
  const overLimit = [...atLimit, { match: { harness: 'pi', auth: 'synthetic-extra' } }];
  assertInvalid(validateCacheConfig({ version: 2, entries: overLimit }), 'too_many_entries', 'entries');
});

test('the loader refuses a file that grows past the limit between fstat and read', (t) => {
  const base = JSON.stringify({ version: 2, entries: [] });
  const atLimit = base + ' '.repeat(CACHE_CONFIG_MAX_BYTES - Buffer.byteLength(base));
  const dir = home(t, atLimit);
  const file = join(dir, 'cache.json');
  assert.equal(fs.statSync(file).size, CACHE_CONFIG_MAX_BYTES);
  const originalRead = fs.readSync;
  let grown = false;
  let requested = 0;
  const read = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    if (!grown) {
      grown = true;
      fs.appendFileSync(file, ' '.repeat(2 * CACHE_CONFIG_MAX_BYTES));
    }
    requested += args[3] as number;
    return Reflect.apply(originalRead, fs, args);
  });
  syncBuiltinESMExports();
  try {
    // The bounded read sees the extra bytes and refuses instead of reading to EOF.
    assertInvalid(loadCacheConfig(dir), 'file_too_large', null);
    assert.equal(requested, CACHE_CONFIG_MAX_BYTES + 1);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the loader refuses a snapshot whose size changes between fstat and read', (t) => {
  const text = JSON.stringify({ version: 2, entries: [{ match: { harness: 'pi' } }] });
  const loadWithChange = (change: (file: string) => void): CacheConfigLoad => {
    const dir = home(t, text);
    const file = join(dir, 'cache.json');
    const originalRead = fs.readSync;
    let changed = false;
    const read = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
      if (!changed) {
        changed = true;
        change(file);
      }
      return Reflect.apply(originalRead, fs, args);
    });
    syncBuiltinESMExports();
    try {
      return loadCacheConfig(dir);
    } finally {
      read.mock.restore();
      syncBuiltinESMExports();
    }
  };
  // Fewer bytes than fstat reported is an inconsistent snapshot, not a valid one.
  assertInvalid(
    loadWithChange((file) => fs.truncateSync(file, 4)),
    'file_unreadable',
    null
  );
  // More bytes, still under the limit, are inconsistent too.
  assertInvalid(
    loadWithChange((file) => fs.appendFileSync(file, ' ')),
    'file_unreadable',
    null
  );
});

test('the loader refuses a symlinked cache.json instead of following it', (t) => {
  if (process.platform === 'win32') return t.skip('O_NOFOLLOW is not available on Windows');
  const target = join(home(t), 'elsewhere.json');
  fs.writeFileSync(target, '{"version":2,"entries":[]}');
  const dir = home(t);
  fs.symlinkSync(target, join(dir, 'cache.json'));
  assert.equal(assertInvalid(loadCacheConfig(dir), 'file_unreadable', null).path, join(dir, 'cache.json'));

  // A dangling symlink is refused too, not reported as a missing file.
  const dangling = home(t);
  fs.symlinkSync(join(dangling, 'absent.json'), join(dangling, 'cache.json'));
  assert.equal(assertInvalid(loadCacheConfig(dangling), 'file_unreadable', null).path, join(dangling, 'cache.json'));
});

test('the loader refuses a FIFO without waiting for a writer', (t) => {
  if (process.platform === 'win32') return t.skip('FIFOs are POSIX only');
  const dir = home(t);
  const fifo = join(dir, 'cache.json');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip(`mkfifo unavailable: ${made.error?.message ?? made.stderr}`);
  // A blocking open would never return, so the load runs in a child with a deadline.
  const module = new URL('../../src/core/cache-config.js', import.meta.url).href;
  const script = `import { loadCacheConfig } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(loadCacheConfig(${JSON.stringify(dir)})));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(assertInvalid(JSON.parse(child.stdout) as CacheConfigLoad, 'file_unreadable', null).path, fifo);
});

test('TTL fields are null, never zero or negative, when the input is unknown', (t) => {
  const snapshot = loaded(loadCacheConfig(home(t, fixtureText('cache-v2.json'))));

  // `configured.ttlMs: null` and `documented.ttlMs: null` stay unknown; the assumption is separate.
  const codex = adviceFor(snapshot, { harness: 'codex', auth: 'chatgpt' });
  assert.equal(codex.configuredTtlMs, null);
  assert.equal(codex.documentedTtlMs, null);
  assert.equal(codex.planningTtlMs, 300000);

  // A documented block without a TTL has no documented TTL.
  const pi = adviceFor(snapshot, { harness: 'pi', auth: 'unknown' });
  assert.equal(pi.documentedTtlMs, null);

  // An explicit null assumption TTL stays null.
  const assumption = loaded(
    validateCacheConfig({
      version: 2,
      entries: [{ match: { harness: 'codex' }, planningAssumption: { ttlMs: null, label: 'synthetic' } }],
    })
  );
  assert.equal(adviceFor(assumption, { harness: 'codex', auth: 'chatgpt' }).planningTtlMs, null);

  // A hand-built snapshot cannot smuggle a zero, negative or non-finite TTL into the advice.
  const hand: CacheConfigSnapshot = {
    version: 2,
    handoffMinTokens: null,
    entries: [
      {
        match: { harness: 'pi', auth: null },
        configured: { ttlMs: 0, source: null, note: null },
        documented: {
          ttlMs: -5,
          writeMultiplier: null,
          readMultiplier: null,
          lifetimeFrom: null,
          source: null,
          note: null,
        },
        observed: { ttlMs: Number.NaN, source: null, note: null },
        planningAssumption: { ttlMs: Number.POSITIVE_INFINITY, label: null },
        warming: 'off',
      },
    ],
  };
  const advice = adviceFor(hand, { harness: 'pi', auth: 'unknown' });
  assert.equal(advice.configuredTtlMs, null);
  assert.equal(advice.documentedTtlMs, null);
  assert.equal(advice.planningTtlMs, null);
});

test('an observed block never changes documentedTtlMs', (t) => {
  const snapshot = loaded(loadCacheConfig(home(t, fixtureText('cache-v2-observed.json'))));
  const entry = snapshot.entries[0];
  assert.equal(entry.documented?.ttlMs, 3600000);
  assert.equal(entry.observed?.ttlMs, 600000);

  const advice: CacheAdvice = adviceFor(snapshot, { harness: 'claude', auth: 'subscription_included' });
  assert.equal(advice.documentedTtlMs, 3600000);
  assert.equal(advice.configuredTtlMs, 3600000);
  assert.equal(advice.planningTtlMs, 300000);
  assert.equal(advice.provenance.observed, true);
  assert.equal(advice.provenance.observedSource, 'synthetic observation, never overrides documented');
  assert.equal(advice.provenance.documentedSource, 'synthetic documented source');
  assert.equal(advice.provenance.configuredSource, 'synthetic configured source');
  assert.equal(advice.provenance.planningAssumptionLabel, 'synthetic planning assumption');
});

test('a planning assumption is never reported as configured or documented', (t) => {
  const snapshot = loaded(loadCacheConfig(home(t, fixtureText('cache-v2-assumption-only.json'))));
  const advice = adviceFor(snapshot, { harness: 'codex', auth: 'chatgpt' });
  assert.equal(advice.configuredTtlMs, null);
  assert.equal(advice.documentedTtlMs, null);
  assert.equal(advice.planningTtlMs, 300000);
  assert.equal(advice.provenance.configuredSource, null);
  assert.equal(advice.provenance.documentedSource, null);
  assert.equal(advice.provenance.observed, false);
  assert.equal(advice.provenance.planningAssumptionLabel, 'synthetic planning assumption');
});

test('a listed auth alternative wins over a wildcard entry', () => {
  const snapshot = loaded(
    validateCacheConfig({
      version: 2,
      entries: [
        { match: { harness: 'claude' }, documented: { ttlMs: 300000 } },
        { match: { harness: 'claude', auth: 'api' }, documented: { ttlMs: 600000 } },
      ],
    })
  );
  const listed = adviceFor(snapshot, { harness: 'claude', auth: 'api' });
  assert.equal(listed.provenance.entry, 1);
  assert.equal(listed.provenance.authMatch, 'listed');
  assert.equal(listed.documentedTtlMs, 600000);
  const wildcard = adviceFor(snapshot, { harness: 'claude', auth: 'bedrock' });
  assert.equal(wildcard.provenance.entry, 0);
  assert.equal(wildcard.provenance.authMatch, 'wildcard');
  assert.equal(wildcard.documentedTtlMs, 300000);
});

test('the alternative cap accepts 16 alternatives and refuses 17', () => {
  const alternatives = Array.from({ length: CACHE_CONFIG_MAX_AUTH_ALTERNATIVES }, (_, i) => `synthetic-${i}`);
  const snapshot = loaded(
    validateCacheConfig({ version: 2, entries: [{ match: { harness: 'pi', auth: alternatives.join('|') } }] })
  );
  for (const auth of alternatives)
    assert.equal(adviceFor(snapshot, { harness: 'pi', auth }).provenance.authMatch, 'listed', auth);
  assert.equal(adviceFor(snapshot, { harness: 'pi', auth: 'synthetic-absent' }).provenance.entry, null);
  const over = [...alternatives, 'synthetic-extra'];
  assertInvalid(
    validateCacheConfig({ version: 2, entries: [{ match: { harness: 'pi', auth: over.join('|') } }] }),
    'too_many_alternatives',
    'entries[0].match.auth'
  );
});

test('adviceFor answers from the precomputed auth index, not a scan of the alternatives', () => {
  const snapshot = loaded(
    validateCacheConfig({ version: 2, entries: [{ match: { harness: 'pi', auth: 'api|bedrock|vertex' } }] })
  );
  const entry = snapshot.entries[0];
  // The index is built at validation, so an array that throws on any scan is never
  // touched; a per-call scan or rebuild would fail this test.
  const hostile = new Proxy(entry.match.auth as string[], {
    get(target, property, receiver) {
      if (property === 'includes' || property === Symbol.iterator) throw new Error('alternatives were scanned');
      return Reflect.get(target, property, receiver);
    },
  });
  (entry.match as { auth: readonly string[] }).auth = hostile;
  assert.equal(adviceFor(snapshot, { harness: 'pi', auth: 'bedrock' }).provenance.authMatch, 'listed');
  assert.equal(adviceFor(snapshot, { harness: 'pi', auth: 'synthetic-absent' }).provenance.entry, null);
});

test('1000 adviceFor calls do no file I/O and never mutate the snapshot', (t) => {
  const dir = home(t, fixtureText('cache-v2.json'));
  const snapshot = loaded(loadCacheConfig(dir));
  const calls = { openSync: 0, fstatSync: 0, readSync: 0, closeSync: 0 };
  const originalOpen = fs.openSync;
  const originalFstat = fs.fstatSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const open = t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    calls.openSync += 1;
    return Reflect.apply(originalOpen, fs, args);
  });
  const fstat = t.mock.method(fs, 'fstatSync', (...args: unknown[]) => {
    calls.fstatSync += 1;
    return Reflect.apply(originalFstat, fs, args);
  });
  const read = t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    calls.readSync += 1;
    return Reflect.apply(originalRead, fs, args);
  });
  const close = t.mock.method(fs, 'closeSync', (...args: unknown[]) => {
    calls.closeSync += 1;
    return Reflect.apply(originalClose, fs, args);
  });
  syncBuiltinESMExports();
  try {
    // The spy sees the loader's own open, stat, read and close, so a zero count below is meaningful.
    loaded(loadCacheConfig(dir));
    assert.equal(calls.openSync, 1);
    assert.equal(calls.fstatSync, 1);
    assert.ok(calls.readSync >= 1);
    assert.equal(calls.closeSync, 1);

    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
    const before = structuredClone(snapshot);
    const query = { harness: 'claude', auth: 'subscription_included', model: 'claude-fable-5-1' };
    const first = adviceFor(snapshot, query);
    for (let i = 0; i < 1000; i++) assert.deepEqual(adviceFor(snapshot, query), first);
    assert.deepEqual(calls, { openSync: 0, fstatSync: 0, readSync: 0, closeSync: 0 });
    assert.deepEqual(snapshot, before);
  } finally {
    open.mock.restore();
    fstat.mock.restore();
    read.mock.restore();
    close.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the loader and validators never throw into callers', (t) => {
  assertInvalid(validateCacheConfig(null), 'invalid_type', null);
  assertInvalid(validateCacheConfig([]), 'invalid_type', null);
  assertInvalid(validateCacheConfig('cache'), 'invalid_type', null);
  assertInvalid(parseCacheConfig(''), 'invalid_json', null);
  assertInvalid(parseCacheConfig('null'), 'invalid_type', null);
  assertInvalid(loadCacheConfig(undefined as unknown as string), 'file_unreadable', null);
  assertInvalid(loadCacheConfig(''), 'file_unreadable', null);

  const dir = home(t);
  fs.mkdirSync(join(dir, 'cache.json'));
  assertInvalid(loadCacheConfig(dir), 'file_unreadable', null);

  // A UTF-8 BOM is tolerated; the document is otherwise the same JSON.
  assert.deepEqual(loaded(loadCacheConfig(home(t, '\uFEFF{"version":2,"entries":[]}'))).entries, []);
});
