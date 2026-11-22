#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { main } = await withDistLock(() => import('../../../dist/runtime/browser-runner.js'));
await main();
