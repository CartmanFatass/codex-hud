#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
const { runHeadlessTurn } = await withDistLock(() => import('../../../dist/mcp/sonic-process.js'));
await runHeadlessTurn(process.argv[2], process.argv.slice(3));
