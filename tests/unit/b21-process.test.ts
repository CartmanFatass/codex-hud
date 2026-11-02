import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
test(
  'B21 real-process capacity, crash rollback and concurrent performance acceptance',
  { skip: !ledgerRuntimeSupported(), timeout: 120000 },
  async () => {
    const child = spawn(process.execPath, ['--test', 'tests/int/b21-process.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    let output = '';
    child.stdout.on('data', (x) => (output += x));
    child.stderr.on('data', (x) => (output += x));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    console.log(output);
    assert.equal(code, 0, output);
  }
);
