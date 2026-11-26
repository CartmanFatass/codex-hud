#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
await (await withDistLock(() => import('../../../dist/runtime/cli-supervisor.js'))).main();
