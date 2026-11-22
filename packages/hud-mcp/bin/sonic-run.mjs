#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { runSonicPi } = await withDistLock(() => import('../../../dist/mcp/sonic-process.js'));
await runSonicPi(process.argv[2], process.argv.slice(3));
