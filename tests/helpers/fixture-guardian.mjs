// Detached test helper: when a test worker dies, clean up only its registered temporary fixtures.
import { isProcAlive } from '../../dist/utils/proc.js';
import { reapFixtureProcesses, removeFixtureRoot } from './process-cleanup.mjs';

const { worker, owner } = JSON.parse(process.argv[2]);
const fixtures = new Map();
process.on('message', ({ spec, active }) => {
  const key = JSON.stringify(spec);
  if (active) fixtures.set(key, spec);
  else fixtures.delete(key);
});

process.once('disconnect', async () => {
  clearInterval(timer);
  // Kill immediately: the test isn't present to consume a graceful shutdown, and a child may be stopped.
  for (const spec of fixtures.values()) {
    if (!(await reapFixtureProcesses({ ...spec, graceMs: 0 })).length) removeFixtureRoot(spec);
  }
});

const timer = setInterval(() => {
  if (!owner?.start || isProcAlive(owner.pid, owner.start)) return;
  // The coordinator may have been killed without signaling its test workers. Stop this exact
  // worker first so it cannot spawn another watcher after we reap. IPC then closes and drains.
  if (worker.start && isProcAlive(worker.pid, worker.start)) {
    try { process.kill(worker.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}, 250);
