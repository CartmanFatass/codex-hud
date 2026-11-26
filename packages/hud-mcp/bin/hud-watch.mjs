#!/usr/bin/env node
import { applyV8HeapCaps, withDistLock } from '../../../scripts/dist-lock.mjs';
delete process.env.HUD_JOB_DIR; // The shared watcher is not scoped to the job that started it.
const probe = process.argv[2] === '--probe';
if (!probe) applyV8HeapCaps('watch');
await (await withDistLock(async () => (await import('../../../dist/runtime/watch.js')).openWatcher(probe)))?.();
