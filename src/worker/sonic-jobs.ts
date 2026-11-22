/** Shared sonic settlement and collection protocol for wait and both parent drivers. */
import { jobFiles } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

import type { JobStatus } from '../mcp/job-contracts.js';
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

export function sonicChildren(dir: string) {
  let ids: string[];
  try { ids = fs.readdirSync(join(dir, jobFiles.sonic)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ids = []; }
  const uncollected = [];
  let open = false;
  for (const id of ids) {
    const child = join(dirname(dir), id);
    if (!fs.existsSync(join(child, jobFiles.job))) continue; // Retention can remove settled children.
    const { state } = sonicState(child);
    if (state === 'open') open = true;
    if (state === 'settled' && fs.existsSync(join(child, jobFiles.report)) &&
        !fs.existsSync(join(child, 'sonic-collected')) && !fs.existsSync(join(child, 'sonic-prompted'))) {
      uncollected.push(id);
    }
  }
  return { open, uncollected };
}

export function sonicCollectPrompt(dir: string, output: string, ids: string[], tools = true) {
  // Record the input attempt before sending. Collection itself uses a separate receipt.
  for (const id of ids) fs.writeFileSync(join(dirname(dir), id, 'sonic-prompted'), '', { mode: 0o600 });
  return tools
    ? `Collect these sonic reports with hud_sonic (wait: ${JSON.stringify(ids)}). Then finish with hud_report.`
    : `Collect these sonic reports with the Collect command from your brief: ${ids.join(', ')}. Then finish your work and write your report to ${output}.`;
}
