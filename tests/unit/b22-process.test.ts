import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';

test(
  'B22 isolated real-process retirement acceptance matrix',
  {
    skip:
      process.env.B22_PROCESS !== '1'
        ? 'Run B22_PROCESS=1 node --test dist-test/tests/unit/b22-process.test.js'
        : !ledgerRuntimeSupported(),
    timeout: 240_000,
  },
  async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', 'tests/int/b22-process.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, output);
  }
);
