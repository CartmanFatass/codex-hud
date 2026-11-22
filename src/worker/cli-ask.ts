/** Fallback: ask the orchestrator from a CLI worker. */
import { jobFiles } from '../mcp/paths.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from '../mcp/job-contracts.js';
import { join } from 'node:path';
import { ask } from '../worker/tools.js';

export async function main() {
  const argv = process.argv.slice(2);
  const opts: Partial<Record<'dir' | 'question' | 'default' | 'context' | 'timeout', string>> & { option: string[] } = { option: [] };
  const positional = [];
  function usage() {
    process.stderr.write('usage: hud-ask --dir <job-dir> --question <text> --default <text> [--option <text> ...] [--context <text>]\n');
    process.exit(2);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || !['dir', 'job-dir', 'question', 'default', 'option', 'context', 'timeout'].includes(key)) usage();
    if (key === 'option') opts.option.push(value);
    else Object.assign(opts, { [key === 'job-dir' ? 'dir' : key]: value });
  }
  const dir = opts.dir || process.env.HUD_JOB_DIR || positional[0];
  const question = opts.question || positional[1];
  const fallback = opts.default ?? positional[2];
  if (!dir || !question || fallback === undefined) usage();
  const job = readJsonFile(join(dir, jobFiles.job)) as Job;
  console.log(await ask({ dir, job }, { question, default: fallback, options: opts.option, context: opts.context }, opts.timeout));
}
