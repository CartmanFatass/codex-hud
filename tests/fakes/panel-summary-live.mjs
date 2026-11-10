// Runs the actual panel collection/paint/finish lifecycle in one synthetic process.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[2];
const scenario = process.argv[3] || 'normal';
const { RoleSummaryPublisher } = await import(pathToFileURL(join(root, 'dist/roles/role-summary.js')));
const { runLivePage } = await import(pathToFileURL(join(root, 'dist/tree-page.js')));
const { SessionFinder } = await import(pathToFileURL(join(root, 'dist/collectors/session-finder.js')));
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'];
const before = signals.map((name) => process.listenerCount(name));
const original = RoleSummaryPublisher.prototype.publish;
const invalidate = RoleSummaryPublisher.prototype.invalidate;
let invalidations = 0;
RoleSummaryPublisher.prototype.invalidate = function () {
  invalidations++;
  invalidate.call(this);
  if (scenario !== 'normal' && !disposed) setImmediate(() => end());
};
let publications = 0,
  paints = 0,
  disposed = 0,
  inPaint = false,
  end;
RoleSummaryPublisher.prototype.publish = function (...args) {
  publications++;
  inPaint ||= /at (?:Object\.)?render\b/.test(new Error().stack);
  const written = original.apply(this, args);
  if (scenario === 'failure')
    SessionFinder.prototype.check = () => {
      throw Error('synthetic outer collection failure');
    };
  else setImmediate(() => end());
  return written;
};
const write = process.stdout.write;
process.stdout.write = function () {
  paints++;
  return true;
};
let timer;
try {
  await runLivePage({
    installCleanup(finish) {
      end = finish;
      timer = setTimeout(finish, 5000);
      return () => {
        disposed++;
        clearTimeout(timer);
      };
    },
  });
} finally {
  process.stdout.write = write;
  clearTimeout(timer);
}
if (scenario === 'unbound') assert.equal(publications, 0, 'unbound root never publishes zero');
else assert.ok(publications > 0, 'actual collection publishes');
if (scenario !== 'normal') assert.ok(invalidations >= 2, 'unavailable collection invalidates before finish');
assert.ok(paints > 0, 'actual panel paints');
assert.equal(inPaint, false, 'publication must not run from paint');
assert.equal(disposed, 1, 'existing finish disposes lifetime hook');
assert.deepEqual(
  signals.map((name) => process.listenerCount(name)),
  before,
  'finish removes signal handlers'
);
console.log(JSON.stringify({ publications, paints, disposed, invalidations }));
