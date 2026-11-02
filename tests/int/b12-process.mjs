// Owned synthetic subprocess. The parent always kills/reaps this exact ChildProcess.
import { DatabaseSync } from 'node:sqlite';
import { openObservationStore } from '../../dist/core/observation-store.js';

let store;
let now;
let crash;
const originalExec = DatabaseSync.prototype.exec;
function stopAt(point) {
  process.send({ point });
  // Deterministic crash cut: no timer/polling and no other work before the parent's SIGKILL.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
DatabaseSync.prototype.exec = function (sql) {
  if (crash === 'before_commit' && sql === 'BEGIN IMMEDIATE') originalExec.call(this, 'PRAGMA cache_size=1');
  if (crash === 'before_commit' && sql === 'COMMIT') stopAt('before_commit');
  const result = originalExec.call(this, sql);
  if (crash === 'after_commit' && sql === 'COMMIT') stopAt('after_commit');
  return result;
};
process.on('message', async (message) => {
  const { id, op } = message;
  try {
    if (op === 'open') {
      now = message.now;
      store = await openObservationStore({ ...message.options, now: () => now });
      process.send({ id, result: true });
      return;
    }
    if (message.now !== undefined) now = message.now;
    let result;
    switch (op) {
      case 'acquire':
        result = store.acquire(message.ref, message.holder);
        break;
      case 'renew':
        result = store.renew(message.ref, message.lease);
        break;
      case 'release':
        result = store.release(message.ref, message.lease);
        break;
      case 'read':
        result = store.readCurrent(message.ref);
        break;
      case 'publish':
        crash = message.crash;
        if (crash === 'before_prepare') stopAt('before_prepare');
        result = store.publish(message.candidate, message.lease);
        break;
      case 'close':
        store.close();
        result = true;
        break;
      default:
        throw new Error('unknown_synthetic_operation');
    }
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
