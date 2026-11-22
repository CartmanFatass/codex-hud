#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { main } = await withDistLock(() => import('../../../dist/worker/cli-lease.js'));
await main();
