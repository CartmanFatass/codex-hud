import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { CodexExecTransport, type CodexExecTransportInput } from '../../src/harness/codex/exec-transport.js';

function setup(mode: string, prompt = 'synthetic prompt', resumeThreadId?: string) {
  const root = mkdtempSync(join(tmpdir(), 'codex-exec-transport-'));
  const input: CodexExecTransportInput = {
    executable: resolve('tests/fixtures/codex-exec-transport/synthetic-client.mjs'),
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      HUD_CLAIM: 'SYNTHETIC_SECRET',
      SYNTHETIC_MODE: mode,
      SYNTHETIC_PROMPT_BYTES: String(Buffer.byteLength(prompt)),
      SYNTHETIC_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex'),
      SYNTHETIC_COUNTER_FILE: join(root, 'count'),
      ...(resumeThreadId ? { SYNTHETIC_EXPECT_RESUME: resumeThreadId } : {}),
    },
    prompt,
    timeoutMs: 5000,
    ...(resumeThreadId ? { resumeThreadId } : {}),
  };
  return { root, input, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('spawned synthetic executable drains stdout, stderr and long prompt without exposing raw bodies', async () => {
  const f = setup('complete', 'x'.repeat(200000));
  try {
    const t = new CodexExecTransport(),
      r = await t.run(f.input);
    assert.equal(r.outcome, 'observed_complete');
    assert.equal(r.spawned, true);
    assert.equal(r.closeObserved, true);
    assert.equal(r.observation.threadId, 'synthetic-thread');
    assert.equal(r.observation.complete, true);
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SECRET'));
    await assert.rejects(t.run(f.input), /already_used/);
    assert.equal(readFileSync(join(f.root, 'count'), 'utf8'), 'spawn\n');
  } finally {
    f.close();
  }
});

test('resume supplies exact thread identity and mismatch cannot become complete', async () => {
  const good = setup('complete', 'synthetic prompt', '11111111-1111-4111-8111-111111111111');
  const bad = setup('mismatch', 'synthetic prompt', '11111111-1111-4111-8111-111111111111');
  try {
    assert.equal((await new CodexExecTransport().run(good.input)).outcome, 'observed_complete');
    const r = await new CodexExecTransport().run(bad.input);
    assert.equal(r.outcome, 'uncertain');
    assert.equal(r.observation.complete, false);
    assert.ok(r.observation.malformed > 0);
  } finally {
    good.close();
    bad.close();
  }
});

test('nonzero child exit is uncertain, stderr only counted, no automatic retry', async () => {
  const f = setup('nonzero');
  try {
    const t = new CodexExecTransport(),
      r = await t.run(f.input);
    assert.equal(r.outcome, 'uncertain');
    assert.equal(r.exit?.code, 7);
    assert.ok(r.stderrBytes > 0);
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
    await assert.rejects(t.run(f.input), /already_used/);
    assert.equal(readFileSync(join(f.root, 'count'), 'utf8'), 'spawn\n');
  } finally {
    f.close();
  }
});

test('timeout and abort terminate only direct synthetic child and retain uncertainty', async () => {
  const f = setup('hang');
  try {
    const timeout = await new CodexExecTransport().run({ ...f.input, timeoutMs: 300 });
    assert.equal(timeout.outcome, 'uncertain');
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.spawned, true);
    assert.equal(timeout.closeObserved, true);
    const controller = new AbortController();
    const promise = new CodexExecTransport().run({ ...f.input, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const aborted = await promise;
    assert.equal(aborted.outcome, 'uncertain');
    assert.equal(aborted.reason, 'aborted');
    assert.equal(aborted.closeObserved, true);
    const pre = new AbortController();
    pre.abort();
    const skipped = await new CodexExecTransport().run({ ...f.input, signal: pre.signal });
    assert.equal(skipped.outcome, 'not_started');
    assert.equal(skipped.reason, 'pre_aborted');
  } finally {
    f.close();
  }
});

test('stdout and stderr flooding terminate with bounded retained observation', async () => {
  const a = setup('stdout'),
    b = setup('stderr');
  try {
    const x = await new CodexExecTransport().run(a.input),
      y = await new CodexExecTransport().run(b.input);
    assert.equal(x.outcome, 'uncertain');
    assert.equal(x.reason, 'stdout_limit');
    assert.equal(y.outcome, 'uncertain');
    assert.equal(y.reason, 'stderr_limit');
    assert.equal(y.stderrBytes, 1024 * 1024 + 1);
  } finally {
    a.close();
    b.close();
  }
});

test('invalid input and missing executable fail without starting a child', async () => {
  const f = setup('complete');
  try {
    await assert.rejects(new CodexExecTransport().run({ ...f.input, resumeThreadId: '--dangerous' }), /invalid_input/);
    await assert.rejects(
      new CodexExecTransport().run({ ...f.input, resumeThreadId: 'synthetic-thread-name' }),
      /invalid_input/
    );
    assert.equal(existsSync(join(f.root, 'count')), false);
    await assert.rejects(
      new CodexExecTransport().run({ ...f.input, prompt: 'x'.repeat(1024 * 1024 + 1) }),
      /invalid_input/
    );
    const r = await new CodexExecTransport().run({ ...f.input, executable: '/synthetic/missing-binary' });
    assert.equal(r.outcome, 'not_started');
    assert.equal(r.spawned, false);
    assert.equal(r.reason, 'spawn_failed');
  } finally {
    f.close();
  }
});

test('closed stdin during large prompt cannot be reported complete', async () => {
  const f = setup('early-close', 'x'.repeat(1024 * 1024));
  try {
    const r = await new CodexExecTransport().run(f.input);
    assert.equal(r.outcome, 'uncertain');
    assert.ok(r.reason === 'stdin_error' || r.reason === 'child_exit');
    assert.equal(r.observation.complete, false);
  } finally {
    f.close();
  }
});
