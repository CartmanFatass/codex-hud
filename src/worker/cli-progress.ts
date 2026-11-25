/** Fallback: publish a milestone or declare completion after writing a report. */
import { parseArgs } from 'node:util';
import { finishReport, progress, workerJob } from '../worker/tools.js';

const parseJsonFlag = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
};

export async function main() {
  try {
    const { values, positionals } = parseArgs({
      options: {
        dir: { type: 'string' }, done: { type: 'boolean' }, turn: { type: 'string' },
        summary: { type: 'string' }, file: { type: 'string', multiple: true }, 'skip-checks-reason': { type: 'string' }, preview: { type: 'string' },
        findings: { type: 'string' }, reviewed: { type: 'string' },
      },
      allowPositionals: true,
    });
    const context = workerJob(values.dir);
    if (values.done) {
      if (positionals.length || context.job.bro || context.job.jev) throw new Error('--done is for local worker reports, not milestones');
      await finishReport(context, values.turn, undefined, {
        summary: values.summary, files: values.file, skip_checks_reason: values['skip-checks-reason'], preview: values.preview,
        findings: parseJsonFlag(values.findings), reviewed: parseJsonFlag(values.reviewed),
      });
    } else {
      for (const key of ['turn', 'summary', 'file', 'skip-checks-reason', 'preview', 'findings', 'reviewed'] as const) {
        if (values[key] !== undefined) throw new Error(`--${key} requires --done`);
      }
      await progress(context, positionals.join(' '));
    }
  } catch (error) {
    console.error(`hud-progress: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
