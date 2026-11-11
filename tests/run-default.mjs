#!/usr/bin/env node
// Resolve current sources rather than globbing stale tsc outputs after a test moves.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = 'tests/unit';
const output = 'dist-test';
const files = readdirSync(source)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `${output}/${source}/${name.replace(/\.ts$/, '.js')}`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
