#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const start = await withDistLock(async () => (await import('../../../dist/runtime/watch.js')).openWatcher());
await start();
