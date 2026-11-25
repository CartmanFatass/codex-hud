#!/usr/bin/env node
import { withDistLock } from '../../../scripts/dist-lock.mjs';
if (process.argv[2] === '--exec-witness') {
  const { execWitness } = await withDistLock(() => import('../../../dist/runtime/cli-invocation.js'));
  execWitness(process.argv[3], process.argv[4], process.argv.slice(5));
} else await (await withDistLock(() => import('../../../dist/runtime/cli-supervisor.js'))).main();
