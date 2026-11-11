#!/usr/bin/env node
// Resolve current sources rather than globbing stale tsc outputs after a test moves.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mcp = process.argv[2] === 'hud-mcp';
const source = mcp ? 'tests/hud-mcp' : 'tests/unit';
const output = mcp ? 'packages/hud-mcp/dist' : 'dist-test';
const files = readdirSync(source)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `${output}/${source}/${name.replace(/\.ts$/, '.js')}`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
