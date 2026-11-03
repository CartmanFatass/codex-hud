import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { DelegationWorkerClient } from '../../dist/core/link/worker-client.js';
import { HudHealth } from '../../dist/collectors/hud-health.js';
import { isMainThread, threadId } from 'node:worker_threads';
import { ObservationStore } from '../../dist/core/observation-store.js';
const require = createRequire(import.meta.url),
  threads = require('node:worker_threads'),
  Native = threads.Worker;
const event = (kind, extra = {}) =>
  appendFileSync(process.env.B10D_ENTRY_TRACE, JSON.stringify({ kind, isMainThread, threadId, ...extra }) + '\n');
threads.Worker = class extends Native {
  constructor(...args) {
    event('worker');
    super(...args);
  }
};
syncBuiltinESMExports();
for (const name of ['acquire', 'renew', 'publishPrepared']) {
  const original = ObservationStore.prototype[name];
  ObservationStore.prototype[name] = function (...args) {
    if (isMainThread) throw new Error('B10D_MAIN_THREAD_AUTHORITY');
    event(name);
    return original.apply(this, args);
  };
}

if (isMainThread && process.env.B10D_ENTRY_HEALTH === '1') {
  let client = null,
    allowed = false;
  const open = DelegationWorkerClient.open;
  DelegationWorkerClient.open = function (...args) {
    client = open.apply(this, args);
    return client;
  };
  const begin = DelegationWorkerClient.prototype.beginCollection;
  DelegationWorkerClient.prototype.beginCollection = function (...args) {
    const g = begin.apply(this, args);
    allowed = Boolean(g);
    event('root_opportunity', { allowed });
    return g;
  };
  const read = HudHealth.prototype.read;
  HudHealth.prototype.read = function (...args) {
    event('health_read', { allowed: !client || allowed });
    return read.apply(this, args);
  };
  const controller = setInterval(() => {
    if (client?.ready && client.worker && existsSync(process.env.B10D_ENTRY_TRACE + '.kill')) {
      unlinkSync(process.env.B10D_ENTRY_TRACE + '.kill');
      void client.worker.terminate();
    }
  }, 25);
  controller.unref();
}
if (!isMainThread && process.env.B10D_ENTRY_HEALTH === '1') {
  const pub = ObservationStore.prototype.publishPrepared;
  let stalled = false;
  ObservationStore.prototype.publishPrepared = function (...args) {
    if (!stalled) {
      stalled = true;
      event('storage_stall');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200);
    }
    return pub.apply(this, args);
  };
}
