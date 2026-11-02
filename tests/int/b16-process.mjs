// One owned synthetic writer, killed/reaped by b16-writer.test.ts at a deterministic transaction cut.
import { DatabaseSync } from 'node:sqlite';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { StatusWriter } from '../../dist/core/status/writer.js';
const original = DatabaseSync.prototype.exec;
let armed;
function cut(point) {
  process.send({ point });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
DatabaseSync.prototype.exec = function (sql) {
  if (armed === 'before_commit' && sql === 'COMMIT') cut(armed);
  const value = original.call(this, sql);
  if (armed === 'after_commit' && sql === 'COMMIT') cut(armed);
  return value;
};
process.once('message', async ({ home, ref, step, reading, point }) => {
  try {
    const store = await openObservationStore({ hudHome: home, sourceId: ref.sourceId, now: () => 4000 });
    const writer = new StatusWriter(store, ref, store.acquire(ref, 'synthetic-crash-writer'));
    const token = writer.prepare(
      reading,
      step.input.sources.filter((s) => s.evidence.origin === 'transcript'),
      step.input.target
    );
    armed = point;
    writer.publish(
      token,
      { ...step.input, sources: step.input.sources.filter((s) => s.evidence.origin !== 'transcript') },
      step.ruleVersion,
      step.nowMs
    );
  } catch (error) {
    process.send({ error: error.message });
  }
});
