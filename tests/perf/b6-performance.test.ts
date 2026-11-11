import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
test(
  'B6 non-wait status/cancel p95 <50ms with four real SQLite writer processes',
  {
    skip: !ledgerRuntimeSupported()
      ? 'B6 requires Node 22.x >=22.13 or >=24'
      : process.env.B6_PERF !== '1'
        ? 'Run B6_PERF=1 node --test dist-test/tests/perf/b6-performance.test.js for isolated acceptance measurement'
        : false,
  },
  async () => {
    const { performanceRun } = await import(pathToFileURL(resolve('tests/int/b6-performance.mjs')).href);
    console.log(JSON.stringify(await performanceRun(), null, 2));
  }
);
