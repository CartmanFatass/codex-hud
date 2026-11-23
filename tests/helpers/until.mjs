import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// A lifecycle condition with no latency contract can use the enclosing test's signal
// rather than racing a second, shorter timer against process startup or settlement.
export async function until(check, signalOrLimit, message = 'condition did not settle') {
  const timed = typeof signalOrLimit === 'number';
  const signal = timed ? undefined : signalOrLimit;
  if (!timed && !signal) throw new TypeError('until requires a test signal or a timing bound');
  const end = timed ? Date.now() + signalOrLimit : Infinity;
  while (!check()) {
    assert.ok(Date.now() < end, message);
    try {
      await delay(20, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
      throw new Error(message, { cause: error });
    }
  }
}
