import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpcTransport } from '../dist/harness/pi/rpc-transport.js';
import { PI_RPC_LEGACY, PI_RPC_SETTLED } from '../dist/harness/pi/rpc-observation.js';
console.log('SIMULATED Pi RPC peer, actual HUD child transport. No live Pi/provider/account.');
for (const [mode, sourceCommit] of [
  ['modern', PI_RPC_SETTLED],
  ['legacy', PI_RPC_LEGACY],
  ['modern', 'unknown'],
]) {
  const home = mkdtempSync(join(tmpdir(), 'hud-pi-transport-demo-'));
  const client = new PiRpcTransport({
    executable: fileURLToPath(new URL('../tests/fixtures/pi-rpc-transport/synthetic-pi.mjs', import.meta.url)),
    cwd: home,
    env: { HOME: home, PATH: dirname(process.execPath), SYNTHETIC_MODE: mode },
    sourceCommit,
    timeoutMs: 1000,
  });
  try {
    const result = await client.prompt('Synthetic demo only');
    console.log(JSON.stringify({ mode, sourceCommit, result }, null, 2));
    assert.equal(
      result.kind,
      sourceCommit === 'unknown' ? 'stopped' : mode === 'legacy' ? 'legacy_run_end' : 'settled'
    );
  } finally {
    const closed = await client.shutdown();
    assert.equal(closed.reaped, true);
    rmSync(home, { recursive: true, force: true });
  }
}
console.log(
  'PASS: native-shaped correlated prompt over real pipes; legacy end, modern settled and unknown deadline distinguished.'
);
