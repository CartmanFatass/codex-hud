import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ClaudePrintJsonReader } from '../../src/harness/claude/print-json.js';
import { ClaudePrintTransport, type ClaudePrintTransportInput } from '../../src/harness/claude/print-transport.js';

const uuid = '11111111-1111-4111-8111-111111111111';
function setup(
  scenario: string,
  mode: 'default' | 'bare' = 'bare',
  prompt = 'synthetic prompt',
  resumeSessionId?: string
) {
  const root = mkdtempSync(join(tmpdir(), 'claude-print-transport-'));
  const input: ClaudePrintTransportInput = {
    executable: resolve('tests/fixtures/claude-print-transport/synthetic-client.mjs'),
    cwd: root,
    mode,
    ...(mode === 'default' ? { allowDefaultDiscovery: true } : {}),
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      HUD_CLAIM: 'SYNTHETIC_SECRET',
      SYNTHETIC_MODE: scenario,
      SYNTHETIC_BARE: mode === 'bare' ? '1' : '0',
      SYNTHETIC_PROMPT_BYTES: String(Buffer.byteLength(prompt)),
      SYNTHETIC_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex'),
      SYNTHETIC_COUNTER_FILE: join(root, 'count'),
      SYNTHETIC_DISCOVERY_OUTPUT: join(root, 'discovery'),
      SYNTHETIC_HOOK_OUTPUT: join(root, 'hooks'),
      ...(resumeSessionId ? { SYNTHETIC_RESUME: resumeSessionId } : {}),
    },
    prompt,
    timeoutMs: 5000,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
  return { root, input, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('synthetic subprocess receives exact argv and prompt, returns safe metadata only', async () => {
  const f = setup('success', 'bare', 'synthetic 中文 ' + 'x'.repeat(200000));
  try {
    const t = new ClaudePrintTransport(),
      r = await t.run(f.input);
    assert.equal(r.outcome, 'observed_complete');
    assert.equal(r.observation.result, 'success');
    assert.equal(r.closeObserved, true);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'discovery'), 'utf8')), {
      projectHooks: false,
      projectMcp: false,
    });
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
    assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SECRET'));
    await assert.rejects(t.run(f.input), /already_used/);
    assert.equal(readFileSync(join(f.root, 'count'), 'utf8'), 'spawn\n');
  } finally {
    f.close();
  }
});

test('default discovery needs explicit opt-in; fake documents normal versus bare behavior', async () => {
  const f = setup('success', 'default');
  try {
    await assert.rejects(
      new ClaudePrintTransport().run({ ...f.input, allowDefaultDiscovery: undefined }),
      /invalid_input/
    );
    assert.equal(existsSync(join(f.root, 'count')), false);
    const r = await new ClaudePrintTransport().run(f.input);
    assert.equal(r.outcome, 'observed_complete');
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'discovery'), 'utf8')), {
      projectHooks: true,
      projectMcp: true,
    });
  } finally {
    f.close();
  }
});

test('resume exact session ID, mismatch and option-like targets fail closed', async () => {
  const a = setup('success', 'bare', 'synthetic', uuid),
    b = setup('mismatch', 'bare', 'synthetic', uuid);
  try {
    assert.equal((await new ClaudePrintTransport().run(a.input)).outcome, 'observed_complete');
    const r = await new ClaudePrintTransport().run(b.input);
    assert.equal(r.outcome, 'uncertain');
    assert.ok(r.observation.malformed > 0);
    await assert.rejects(
      new ClaudePrintTransport().run({ ...a.input, resumeSessionId: '--continue' }),
      /invalid_input/
    );
    await assert.rejects(
      new ClaudePrintTransport().run({ ...a.input, resumeSessionId: 'named-session' }),
      /invalid_input/
    );
    assert.equal(readFileSync(join(a.root, 'count'), 'utf8'), 'spawn\n');
  } finally {
    a.close();
    b.close();
  }
});

test('error, missing result and existing partial fixture never manufacture success or retry', async () => {
  for (const scenario of ['error', 'missing', 'nonzero', 'existing']) {
    const f = setup(scenario);
    try {
      const t = new ClaudePrintTransport(),
        r = await t.run(f.input);
      assert.equal(r.outcome, 'uncertain', scenario);
      assert.equal(r.observation.complete, false);
      assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
      await assert.rejects(t.run(f.input), /already_used/);
      assert.equal(readFileSync(join(f.root, 'count'), 'utf8'), 'spawn\n');
    } finally {
      f.close();
    }
  }
});

test('timeout, abort and overflowing output stop only direct synthetic child and remain uncertain', async () => {
  const f = setup('hang'),
    a = setup('stdout'),
    b = setup('stderr');
  try {
    const timeout = await new ClaudePrintTransport().run({ ...f.input, timeoutMs: 300 });
    assert.equal(timeout.outcome, 'uncertain');
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.closeObserved, true);
    const controller = new AbortController(),
      pending = new ClaudePrintTransport().run({ ...f.input, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const aborted = await pending;
    assert.equal(aborted.reason, 'aborted');
    assert.equal(aborted.closeObserved, true);
    const pre = new AbortController();
    pre.abort();
    assert.equal((await new ClaudePrintTransport().run({ ...f.input, signal: pre.signal })).outcome, 'not_started');
    assert.equal((await new ClaudePrintTransport().run(a.input)).reason, 'stdout_limit');
    const err = await new ClaudePrintTransport().run(b.input);
    assert.equal(err.reason, 'stderr_limit');
    assert.equal(err.stderrBytes, 1024 * 1024 + 1);
  } finally {
    f.close();
    a.close();
    b.close();
  }
});

test('missing executable and early stdin close do not become complete', async () => {
  const f = setup('early-close', 'bare', 'x'.repeat(1024 * 1024));
  try {
    const r = await new ClaudePrintTransport().run(f.input);
    assert.equal(r.outcome, 'uncertain');
    assert.equal(r.observation.complete, false);
    const x = await new ClaudePrintTransport().run({ ...f.input, executable: '/synthetic/missing' });
    assert.equal(x.outcome, 'not_started');
    await assert.rejects(
      new ClaudePrintTransport().run({ ...f.input, prompt: 'x'.repeat(1024 * 1024 + 1) }),
      /invalid_input/
    );
  } finally {
    f.close();
  }
});

test('a zero-exit result cannot hide an unfinished large stdin write', async () => {
  const f = setup('success-no-input', 'bare', 'x'.repeat(1024 * 1024));
  try {
    const r = await new ClaudePrintTransport().run(f.input);
    assert.equal(r.outcome, 'uncertain');
    assert.equal(r.observation.complete, false);
  } finally {
    f.close();
  }
});

test('byte-level framing validates UTF-8, duplicates, unknown records and incomplete EOF', () => {
  const line = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
  const r = new ClaudePrintJsonReader(uuid);
  const bytes = Buffer.concat([
    line({ type: 'system', subtype: 'init', session_id: uuid }),
    line({ type: 'assistant', message: 'synthetic 中文' }),
    line({ type: 'result', subtype: 'success', is_error: false, session_id: uuid, result: 'synthetic' }),
  ]);
  for (const b of bytes) r.push(Uint8Array.of(b));
  assert.equal(r.finish({ code: 0 }).complete, true);
  const bad = new ClaudePrintJsonReader();
  bad.push(Buffer.from([0xff, 10]));
  bad.push(line({ type: 'future_event' }));
  bad.push(Buffer.from('{"type":'));
  const x = bad.finish({ code: 0 });
  assert.equal(x.complete, false);
  assert.equal(x.malformed, 2);
  assert.equal(x.unknownEvents, 1);
  const dup = new ClaudePrintJsonReader();
  dup.push(
    Buffer.concat([
      line({ type: 'result', subtype: 'success', is_error: false, session_id: uuid, result: 'one' }),
      line({ type: 'result', subtype: 'success', is_error: false, session_id: uuid, result: 'two' }),
    ])
  );
  assert.equal(dup.finish({ code: 0 }).complete, false);
  const later = new ClaudePrintJsonReader();
  later.push(
    Buffer.concat([
      line({ type: 'result', subtype: 'success', is_error: false, session_id: uuid, result: 'one' }),
      line({ type: 'system', subtype: 'error' }),
    ])
  );
  assert.equal(later.finish({ code: 0 }).complete, false);
  const laterAssistant = new ClaudePrintJsonReader();
  laterAssistant.push(
    Buffer.concat([
      line({ type: 'result', subtype: 'success', is_error: false, session_id: uuid, result: 'one' }),
      line({ type: 'assistant', message: 'synthetic' }),
    ])
  );
  assert.equal(laterAssistant.finish({ code: 0 }).complete, false);
});
