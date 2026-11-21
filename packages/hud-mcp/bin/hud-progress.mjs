#!/usr/bin/env node
/** Fallback: publish a milestone or declare completion after writing a report. */
import { parseArgs } from 'node:util';
import { finishReport, progress, workerJob } from './worker-tools.mjs';

try {
  const { values, positionals } = parseArgs({
    options: { dir: { type: 'string' }, done: { type: 'boolean' }, turn: { type: 'string' } },
    allowPositionals: true,
  });
  const context = workerJob(values.dir);
  if (values.done) {
    if (positionals.length || context.job.bro || context.job.jev) throw new Error('--done is for local worker reports, not milestones');
    await finishReport(context, values.turn);
  } else {
    if (values.turn !== undefined) throw new Error('--turn requires --done');
    progress(context, positionals.join(' '));
  }
} catch (error) {
  console.error(`hud-progress: ${error.message}`);
  process.exitCode = 1;
}
