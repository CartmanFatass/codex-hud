#!/usr/bin/env node
/** Fallback for workers without HUD MCP. */
import { parseArgs } from 'node:util';
import { workerLease, workerJob } from './worker-tools.mjs';

try {
  const { values, positionals: [name, ...extra] } = parseArgs({ allowPositionals: true,
    options: { dir: { type: 'string' }, release: { type: 'boolean' }, 'wait-s': { type: 'string' } } });
  if (!name || extra.length) throw new Error('usage: hud-lease [--dir <own job dir>] [--release] [--wait-s N] <name>');
  const wait_s = values['wait-s'];
  console.log(JSON.stringify(await workerLease(workerJob(values.dir), {
    name, release: values.release, wait_s: wait_s === undefined ? undefined : wait_s.trim() ? Number(wait_s) : NaN,
  }, undefined, true)));
} catch (error) {
  console.error(`hud-lease: ${error.message}`);
  process.exitCode = 1;
}
