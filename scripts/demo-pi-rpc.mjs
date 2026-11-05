import assert from 'node:assert/strict';
import { PiRpcObserver, PI_RPC_LEGACY, PI_RPC_SETTLED } from '../dist/harness/pi/rpc-observation.js';
console.log('SIMULATED Pi RPC records, actual HUD observation seam. No pi executable or provider.');
for (const version of [PI_RPC_LEGACY, PI_RPC_SETTLED, 'unknown']) {
  const reader = new PiRpcObserver(version, 0, 100);
  reader.observe({ type: 'agent_start' }, 1);
  reader.observe({ type: 'agent_end', messages: [] }, 2);
  reader.observe({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2, errorMessage: 'synthetic' }, 3);
  reader.observe({ type: 'auto_retry_end', success: true, attempt: 2 }, 4);
  reader.observe({ type: 'agent_start' }, 5);
  reader.observe({ type: 'agent_end', messages: [] }, 6);
  if (version !== PI_RPC_LEGACY) reader.observe({ type: 'agent_settled', aborted: false }, 7);
  const result = reader.tick(100);
  assert.equal(result.quiescence, version === PI_RPC_SETTLED ? 'reported' : 'unknown');
  console.log(JSON.stringify({ simulated: true, version, observation: result }, null, 2));
}
console.log(
  'PASS: legacy end, modern settled, and bounded unknown-version handling remain distinct. Not task success, live compatibility or MCP verification.'
);
