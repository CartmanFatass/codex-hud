/** Shared sonic settlement and collection protocol for wait and both parent drivers. */
import { jobFiles } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { readJsonFile } from '../utils/atomic-fs.js';

type SonicState = { state: 'failed'; reason: string } | { state: 'settled' | 'open'; reason?: undefined };
export function sonicState(dir: string): SonicState {
  let status: JobStatus | undefined;
  try { status = readJsonFile(join(dir, jobFiles.status)) as JobStatus; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (status && ['failed', 'stopped'].includes(status.state)) {
    return { state: 'failed', reason: status.exit_reason ?? status.error ?? status.reason ?? status.state };
  }
  return { state: ['idle_grace', 'closed', 'done'].includes(status?.state ?? '') ? 'settled' : 'open' };
}

function childIds(dir: string): string[] {
  try { return fs.readdirSync(join(dir, jobFiles.sonic)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; }
}

/** Resolve the durable job relationship, including after a headless parent's runner has exited. */
export function headlessSonicChildren(dir: string) {
  return childIds(dir).flatMap(id => {
    if (!/^j[0-9a-f]{16}$/.test(id)) return [];
    const child = join(dirname(dir), id);
    try {
      if (!fs.lstatSync(child).isDirectory()) return [];
      const job = readJsonFile(join(child, jobFiles.job)) as Job;
      if (job.job !== id || job.role !== 'sonic' || !job.headless || job.parent_job !== basename(dir)) return [];
      return [{ id, dir: child, state: sonicState(child).state }];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; }
  });
}

export function sonicChildren(dir: string) {
  const ids = childIds(dir);
  const uncollected = [];
  const remind = [];
  let open = false;
  for (const id of ids) {
    const child = join(dirname(dir), id);
    if (!fs.existsSync(join(child, jobFiles.job))) continue; // Retention can remove settled children.
    const { state } = sonicState(child);
    if (state === 'open') open = true;
    if (state === 'settled' && fs.existsSync(join(child, jobFiles.report)) &&
        !fs.existsSync(join(child, 'sonic-collected'))) {
      uncollected.push(id);
      if (!fs.existsSync(join(child, 'sonic-prompted'))) remind.push(id);
    }
  }
  return { open, uncollected, remind };
}

export function sonicCollectPrompt(dir: string, output: string, ids: string[], tools = true) {
  // Record the input attempt before sending. Collection itself uses a separate receipt.
  for (const id of ids) fs.writeFileSync(join(dirname(dir), id, 'sonic-prompted'), '', { mode: 0o600 });
  return tools
    ? `Collect these sonic reports with hud_sonic (wait: ${JSON.stringify(ids)}). Then finish with hud_report.`
    : `Collect these sonic reports with the Collect command from your brief: ${ids.join(', ')}. Then finish your work and write your report to ${output}.`;
}
