#!/usr/bin/env node
// Intentionally separate from the default/merge suites. No real providers or shared browser.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { hostname, loadavg } from 'node:os';

const revision = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
console.log(
  `perf host=${hostname()} node=${process.version} revision=${revision.stdout?.trim() || 'unknown'} load=${loadavg().join(',')}`
);
const files = readdirSync('tests/perf')
  .filter((name) => /\.test\.(ts|mjs)$/.test(name))
  .sort()
  .map((name) =>
    name.endsWith('.ts') ? `dist-test/tests/perf/${name.replace(/\.ts$/, '.js')}` : `tests/perf/${name}`
  );
if (files.length === 0) throw new Error('No performance tests found');
// Existing opt-in profiles and their original strict thresholds, now behind one explicit command.
const env = {
  ...process.env,
  B10B_PERF: '1',
  B6_PERF: '1',
  B21_PERF: '1',
  B12_BENCHMARK: '1',
  HUD_LEDGER_BENCHMARK: '1',
  HUD_B45_BENCH: '1',
  HUD_EXPORT_BENCHMARK: '1',
};
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
  env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
