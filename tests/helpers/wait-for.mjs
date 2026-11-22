import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(predicate, message) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}
