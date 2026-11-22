#!/usr/bin/env node
import { applyV8HeapCaps, withDistLock } from '../../../scripts/dist-lock.mjs';
// The shared watcher may be started by a worker, but is not scoped to that job.
delete process.env.HUD_JOB_DIR;
if (process.argv[2] === '--probe') await withDistLock(() => Promise.all([import('../../../dist/runtime/watch.js'), import('../../../dist/runtime/watch-runtime.js')]));
else { applyV8HeapCaps('watch'); await (await withDistLock(async () => (await import('../../../dist/runtime/watch.js')).openWatcher()))(); }
