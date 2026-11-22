/** Fallback: dispatch a sonic sub-task and collect it separately. */
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { startSonic, waitSonic, workerJob } from '../worker/tools.js';

export async function main() {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!['start', 'wait'].includes(command)) throw new Error('usage: hud-sonic start|wait --dir <own job dir>');
    const string = { type: 'string' } as const;
    const values: Partial<Record<string, string>> = command === 'start'
      ? parseArgs({ args, options: { dir: string, task: string, 'task-file': string } }).values
      : parseArgs({ args, options: { dir: string, job: string, timeout: string } }).values;
    if (!values.dir) throw new Error('--dir must name your job directory under HUD_HOME');
    const context = workerJob(values.dir);
    if (command === 'start') {
      if ((values.task === undefined) === (values['task-file'] === undefined)) {
        throw new Error('give the sub-task as --task <text> or --task-file <file>');
      }
      const task = values.task ?? fs.readFileSync(values['task-file']!, 'utf8');
      const launched = await startSonic(context, task);
      console.log(launched.job); // Keep the standalone command's machine-readable id on stdout.
      if (launched.thinking !== null) console.error(`thinking: ${launched.thinking} (${launched.thinking_source})`);
      if (launched.error) console.error(launched.error);
      else if (launched.attempts && launched.attempts.length > 1) {
        for (const { place, reason } of launched.attempts) console.error(`${place}: ${reason ?? 'started'}`);
      }
    } else {
      if (!values.job) throw new Error('--job must be a sonic child job id');
      const { reports, working, failed } = await waitSonic(context, [values.job], values.timeout?.trim() === '' ? NaN : Number(values.timeout ?? '480'));
      if (failed.length) throw new Error(failed[0].reason);
      if (working.length) {
        console.log('still working: run wait again');
        process.exitCode = 3;
      } else process.stdout.write(`${reports[0].path}\n${reports[0].body}`);
    }
  } catch (error) {
    console.error(`hud-sonic: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
