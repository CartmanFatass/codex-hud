import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PiRpcTransport } from '../../src/harness/pi/rpc-transport.js';
import { PI_RPC_LEGACY, PI_RPC_SETTLED } from '../../src/harness/pi/rpc-observation.js';
function fixture(t: test.TestContext, mode = 'modern', source = PI_RPC_SETTLED, timeoutMs = 3000) {
  const home = mkdtempSync(join(tmpdir(), 'hud-pi-rpc-'));
  const c = new PiRpcTransport({
    executable: resolve('tests/fixtures/pi-rpc-transport/synthetic-pi.mjs'),
    cwd: home,
    env: {
      HOME: home,
      PATH: dirname(process.execPath),
      HUD_CLAIM: 'synthetic',
      PI_SESSION_ID: 'stale',
      SYNTHETIC_MODE: mode,
    },
    sourceCommit: source,
    timeoutMs,
  });
  t.after(async () => {
    await c.shutdown();
    rmSync(home, { recursive: true, force: true });
  });
  return c;
}
test('actual modern peer: correlated prompt, LF framing, split UTF8, retry and settled', async (t) => {
  const c = fixture(t);
  const r = await c.prompt('synthetic');
  assert.equal(r.kind, 'settled');
  assert.equal(r.acceptance, 'accepted');
  assert.equal(r.promptWriteFlushed, true);
  assert.equal(r.observation.endedRuns, 2);
  assert.equal(r.observation.quiescence, 'reported');
  assert.throws(() => c.prompt('again'));
  assert.equal((await c.shutdown()).reaped, true);
});
test('legacy boundary is only low-level end; unknown version stops without invented completion', async (t) => {
  const old = fixture(t, 'legacy', PI_RPC_LEGACY);
  const r = await old.prompt('synthetic');
  assert.equal(r.kind, 'legacy_run_end');
  assert.equal(r.observation.quiescence, 'unknown');
  const unknown = fixture(t, 'modern', 'unknown', 300);
  const u = await unknown.prompt('synthetic');
  assert.equal(u.kind, 'stopped');
  assert.equal(u.reason, 'deadline');
  assert.equal(u.observation.quiescence, 'unknown');
  assert.equal((await unknown.closed).reaped, true);
});
test('handled, aborted and rejected remain distinct; handled never means session quiescence', async (t) => {
  for (const mode of ['handled', 'aborted', 'rejected']) {
    const c = fixture(t, mode);
    const r = await c.prompt('synthetic');
    assert.equal(r.kind, mode === 'handled' ? 'no_run' : mode);
    if (mode === 'handled') assert.equal(r.observation.quiescence, 'unknown');
  }
});
test('mismatched response and UI request stop without reply or automatic retry', async (t) => {
  for (const mode of ['mismatch', 'ui']) {
    const c = fixture(t, mode);
    const r = await c.prompt('synthetic');
    assert.equal(r.kind, 'stopped');
    assert.equal(r.reason, mode === 'ui' ? 'unsupported_ui_request' : 'uncorrelated_response');
    assert.equal((await c.closed).reaped, true);
  }
});
test('silent peer is bounded, partial EOF cannot establish boundary', async (t) => {
  for (const mode of ['silent', 'truncated']) {
    const c = fixture(t, mode, PI_RPC_SETTLED, 300);
    const r = await c.prompt('synthetic');
    assert.equal(r.kind, 'stopped');
    assert.equal(r.observation.quiescence, 'unknown');
    assert.equal((await c.closed).reaped, true);
  }
});
