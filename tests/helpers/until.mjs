import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// A lifecycle condition with no latency contract can use the enclosing test's signal
// rather than racing a second, shorter timer against process startup or settlement.
export async function until(check, limit = 10000, message = 'condition did not settle') {
  const signal = typeof limit === 'number' ? undefined : limit;
  const end = signal ? Infinity : Date.now() + limit;
  while (!check()) {
    assert.ok(Date.now() < end, message);
    await delay(20, undefined, { signal });
  }
}
