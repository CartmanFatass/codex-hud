#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
// The shared watcher may be started by a worker, but is not scoped to that job.
delete process.env.HUD_JOB_DIR;
const start = await withDistLock(async () => (await import('../../../dist/runtime/watch.js')).openWatcher());
await start();
