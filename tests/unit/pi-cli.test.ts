import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PI_HELP, inspectPiFile, parsePiInspect, piCommand } from '../../src/cli/pi.js';
import { makeSourceId } from '../../src/core/identity.js';
import type { HudIO } from '../../src/cli/link-export.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const header = { type: 'session', id: 'synthetic-pi', version: 3, timestamp, cwd: '/synthetic/private-project' };
function message(id = 'one', cost: number | null = 0.125, model = 'synthetic-model') {
  return {
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'assistant',
      model,
      provider: 'synthetic',
      content: [
        { type: 'text', text: 'PRIVATE_BODY' },
        { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      ],
      usage: {
        input: 20,
        output: 5,
        cacheRead: 10,
        cacheWrite: 2,
        ...(cost === null ? {} : { cost: { total: cost } }),
      },
      stopReason: 'stop',
    },
  };
}
function fixture(t: test.TestContext, rows: unknown[] = [header, message()]) {
  const root = mkdtempSync(join(tmpdir(), 'hud-pi-inspect-'));
  const file = join(root, 'arbitrary-name.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { sourceRoot: root, file };
}
function io(env: NodeJS.ProcessEnv = { HUD_HOME: '/unavailable/not-needed' }) {
  let stdout = '';
  let stderr = '';
  const value: HudIO = {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return { value, output: () => ({ stdout, stderr }) };
}
test('pi inspect parses exactly one explicit source, absolute file and optional positive context window', () => {
  assert.deepEqual(
    parsePiInspect([
      'inspect',
      '--source',
      '/synthetic/root',
      '--session',
      '/synthetic/root/a.jsonl',
      '--json',
      '--context-window',
      '1000',
    ]),
    {
      sourceRoot: '/synthetic/root',
      profile: undefined,
      file: '/synthetic/root/a.jsonl',
      contextWindow: 1000,
    }
  );
  for (const args of [
    [],
    ['launch'],
    ['inspect'],
    ['inspect', '--session', '/synthetic/a'],
    ['inspect', '--source', 'relative', '--session', '/synthetic/a'],
    ['inspect', '--source', '/synthetic', '--session', 'relative'],
    ['inspect', '--profile', '', '--session', '/synthetic/a'],
    ['inspect', '--source', '/synthetic', '--profile', 'pi', '--session', '/synthetic/a'],
    ['inspect', '--source', '/synthetic', '--session', '/synthetic/a', '--source', '/other'],
    ['inspect', '--source', '/synthetic', '--session', '/synthetic/a', '--context-window', '0'],
    ['inspect', '--source', '/synthetic', '--session', '/synthetic/a', '--context-window', '-1'],
    ['inspect', '--source', '/synthetic', '--session', '/synthetic/a', '--context-window', '1.5'],
    ['inspect', '--source', '/synthetic', '--session', '/synthetic/a', '--resume', 'other'],
  ])
    assert.throws(() => parsePiInspect(args));
});
test('pi help is available without HUD_HOME, a ledger, pi or built MCP configuration', async () => {
  for (const args of [['--help'], ['inspect', '--help']]) {
    const output = io();
    assert.equal(await piCommand(args, output.value), 0);
    assert.deepEqual(output.output(), { stdout: PI_HELP, stderr: '' });
  }
});
test('pi inspection uses exact file header identity and returns only bounded observation presentation', async (t) => {
  const input = fixture(t, [header, message(), message()]);
  const original = readFileSync(input.file);
  const files = readdirSync(input.sourceRoot);
  const result = await inspectPiFile({ ...input, contextWindow: 1000 });
  assert.deepEqual(result.ref, {
    harness: 'pi',
    sourceId: makeSourceId('pi', input.sourceRoot),
    sessionId: header.id,
    threadId: null,
  });
  assert.equal(result.coverage.state, 'complete');
  assert.equal(result.context.value?.used, 32);
  assert.equal(result.context.value?.window, 1000);
  assert.equal(result.spent.costUsd.value, 0.125);
  assert.equal(result.spent.tokens.value?.input, 20);
  assert.equal(result.branchView, 'last_observed');
  assert.equal(result.incomplete, false);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'format',
      'ref',
      'observedAt',
      'model',
      'context',
      'spent',
      'cacheWarm',
      'coverage',
      'continuation',
      'branchView',
      'incomplete',
      'stats',
    ].sort()
  );
  const text = JSON.stringify(result);
  assert.ok(!text.includes('PRIVATE_'));
  assert.ok(!text.includes('private-project'));
  assert.ok(!text.includes('checkpoint'));
  assert.ok(!text.includes('recoveryIndex'));
  assert.deepEqual(readFileSync(input.file), original);
  assert.deepEqual(readdirSync(input.sourceRoot), files);
});
test('pi inspect keeps unknown window and cost null and preserves a reported zero cost', async (t) => {
  const missing = await inspectPiFile(fixture(t, [header, message('one', null)]));
  assert.deepEqual([missing.context.value, missing.context.quality], [null, 'unknown']);
  assert.deepEqual([missing.spent.costUsd.value, missing.spent.costUsd.quality], [null, 'unknown']);
  const zero = await inspectPiFile(fixture(t, [header, message('one', 0)]));
  assert.deepEqual([zero.spent.costUsd.value, zero.spent.costUsd.quality], [0, 'reported']);
});
test('pi inspect exposes incomplete coverage and byte continuation rather than silently draining', async (t) => {
  const input = fixture(t);
  const byRecords = await inspectPiFile(input, { maxBytes: 10000, maxRecords: 1, budgetMs: 20 });
  assert.equal(byRecords.stats?.recordsRead, 1);
  assert.equal(byRecords.coverage.state, 'catching_up');
  assert.equal(byRecords.incomplete, true);
  assert.equal(byRecords.spent.tokens.value, null);
  const byBytes = await inspectPiFile(input, { maxBytes: 10, maxRecords: 100, budgetMs: 20 });
  assert.ok(byBytes.stats!.bytesRead <= 10);
  assert.equal(byBytes.incomplete, true);
  assert.equal(byBytes.continuation?.kind, 'record_needs_larger_slice');
  assert.ok(byBytes.coverage.remainingBytes! > 0);
  const many = fixture(t, [header, ...Array.from({ length: 2100 }, (_, i) => message(`record-${i}`))]);
  const clamped = await inspectPiFile(many, { maxBytes: 10000000, maxRecords: 10000, budgetMs: 1000 });
  assert.ok(clamped.stats!.bytesRead <= 4 * 1024 * 1024);
  assert.ok(clamped.stats!.recordsRead <= 2000);
  assert.equal(clamped.incomplete, true);
  for (const budget of [
    { maxBytes: 0, maxRecords: 1, budgetMs: 20 },
    { maxBytes: 10, maxRecords: 1, budgetMs: Infinity },
  ]) {
    await assert.rejects(inspectPiFile(input, budget), /invalid_arguments/);
  }
});
test('pi inspect rejects outside-source paths, escaped symlinks, invalid headers and non-files', async (t) => {
  const inside = fixture(t);
  const outside = fixture(t);
  await assert.rejects(
    inspectPiFile({ sourceRoot: inside.sourceRoot, file: outside.file }),
    /pi_transcript_outside_source/
  );
  const link = join(inside.sourceRoot, 'escape.jsonl');
  symlinkSync(outside.file, link);
  await assert.rejects(inspectPiFile({ sourceRoot: inside.sourceRoot, file: link }), /pi_transcript_outside_source/);
  const directory = join(inside.sourceRoot, 'not-file');
  mkdirSync(directory);
  await assert.rejects(
    inspectPiFile({ sourceRoot: inside.sourceRoot, file: directory }),
    /pi_transcript_outside_source/
  );
  const invalid = fixture(t, [{ type: 'message', id: 'not-header' }]);
  await assert.rejects(inspectPiFile(invalid), /invalid_pi_header/);
  await assert.rejects(inspectPiFile({ sourceRoot: inside.file, file: inside.file }), /invalid_pi_source/);
});
test('pi CLI emits terminal-safe JSON without needing HUD_HOME and uses exit 6 for incomplete observations', async (t) => {
  const model = 'synthetic\u001b[31m\n\u009b2J\u202e';
  const input = fixture(t, [header, message('one', 0, model)]);
  const output = io();
  assert.equal(await piCommand(['inspect', '--source', input.sourceRoot, '--session', input.file], output.value), 0);
  const text = output.output().stdout;
  assert.equal(JSON.parse(text).model.value.id, model);
  assert.ok(!/[\u001b\u009b\u202e]/.test(text));
  assert.equal(output.output().stderr, '');
  writeFileSync(input.file, JSON.stringify(header) + '\n{"type":');
  const partial = io();
  assert.equal(
    await piCommand(['inspect', '--source', input.sourceRoot, '--session', input.file, '--json'], partial.value),
    6
  );
  assert.equal(JSON.parse(partial.output().stdout).coverage.reason, 'incomplete_tail');
});
test('pi inspect profile selection is exact and read-only, without executing the profile launcher', async (t) => {
  const input = fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'hud-pi-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = {
    name: 'synthetic-pi',
    harness: 'pi',
    source: { root: input.sourceRoot, label: 'Synthetic' },
    launch: { argv: ['/never/execute/this/profile'] },
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
  };
  const config = join(home, 'delegate.json');
  writeFileSync(config, JSON.stringify({ version: 1, profiles: [profile] }));
  const before = readFileSync(config);
  const output = io({ HUD_HOME: home });
  assert.equal(
    await piCommand(['inspect', '--profile', profile.name, '--session', input.file, '--json'], output.value),
    0
  );
  assert.equal(JSON.parse(output.output().stdout).ref.sessionId, header.id);
  await assert.rejects(
    piCommand(['inspect', '--profile', 'Synthetic', '--session', input.file], output.value),
    /pi_profile_required/
  );
  writeFileSync(config, JSON.stringify({ version: 1, profiles: [{ ...profile, harness: 'claude' }] }));
  await assert.rejects(
    piCommand(['inspect', '--profile', profile.name, '--session', input.file], output.value),
    /pi_profile_required/
  );
  writeFileSync(config, before);
  assert.deepEqual(readFileSync(config), before);
  assert.deepEqual(readdirSync(home), ['delegate.json']);
});
test('pi inspect does not retry a failed output write', async (t) => {
  const input = fixture(t);
  let writes = 0;
  await assert.rejects(
    piCommand(['inspect', '--source', input.sourceRoot, '--session', input.file], {
      ...io().value,
      stdout: () => {
        writes++;
        throw new Error('synthetic_output_failed');
      },
    }),
    /synthetic_output_failed/
  );
  assert.equal(writes, 1);
});
