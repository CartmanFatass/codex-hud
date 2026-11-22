#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { main } = await withDistLock(() => import('../../../dist/runtime/cli-supervisor.js'));
await main();
