/** Shared sonic settlement and collection protocol for wait and both parent drivers. */
import { replyWords, needsTranslation } from '../collectors/reply-language.js';
import { jobFiles } from '../mcp/paths.js';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { readJsonFile } from '../utils/atomic-fs.js';

export const SALVAGED_SONIC_DETAIL = 'final message without hud_report';
export const SALVAGED_SONIC_REASON = `salvaged: ${SALVAGED_SONIC_DETAIL}`;

export const SONIC_FACTS_EN =
  'Sonic facts: unverified starting points with file:line; its unchecked list is where it did not look; read yourself any code you base a decision on.';
export const SONIC_FACTS_ZH =
  'Sonic 事实：带 file:line 的未核实起点；未检查列表是它没有看的地方；凡是据此做决定的代码，请亲自阅读。';

export function sonicFactsPrefix(task: unknown): string {
  if (typeof task !== 'string' || !task.trim()) return SONIC_FACTS_EN;
  const words = replyWords(task).replace(/\b(?:[\w]+[-./#][\w./#-]+|[A-Z\d_]{2,}|[0-9a-f]{7,40})\b/g, ' ');
  const han = words.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const other = words.match(/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu)?.length ?? 0;
  const latin = words.match(/[A-Za-z]/g)?.length ?? 0;
  return han > 0 && !(other >= 4 && other >= 0.2 * (han + other)) && (han >= 0.25 * (han + latin) || needsTranslation(task, 'en'))
    ? SONIC_FACTS_ZH
    : SONIC_FACTS_EN;
}

type SonicState =
  | { state: 'failed'; reason: string }
  | { state: 'settled'; reason?: string }
  | { state: 'open'; reason?: undefined };
export function sonicState(dir: string): SonicState {
  let status: JobStatus | undefined;
  try { status = readJsonFile(join(dir, jobFiles.status)) as JobStatus; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (status && ['failed', 'stopped'].includes(status.state)) {
    return { state: 'failed', reason: status.exit_reason ?? status.error ?? status.reason ?? status.state };
  }
  if (['idle_grace', 'closed', 'done'].includes(status?.state ?? '')) {
    return status?.exit_reason === SALVAGED_SONIC_REASON ? { state: 'settled', reason: SALVAGED_SONIC_REASON } : { state: 'settled' };
  }
  return { state: 'open' };
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
      const status = sonicState(child);
      return [{ id, dir: child, state: status.state, ...(status.state === 'settled' && status.reason ? { reason: status.reason } : {}) }];
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
  const salvaged: string[] = [];
  for (const id of ids) {
    const child = join(dirname(dir), id);
    fs.writeFileSync(join(child, 'sonic-prompted'), '', { mode: 0o600 });
    const status = sonicState(child);
    if (status.state === 'settled' && status.reason === SALVAGED_SONIC_REASON) salvaged.push(id);
  }
  const note = salvaged.length
    ? ` (${salvaged.length === ids.length ? SALVAGED_SONIC_REASON : `${salvaged.join(', ')}: ${SALVAGED_SONIC_REASON}`})`
    : '';
  return tools
    ? `Collect these sonic reports with hud_sonic (wait: ${JSON.stringify(ids)})${note}. Then finish with hud_report.`
    : `Collect these sonic reports with the Collect command from your brief: ${ids.join(', ')}${note}. Then finish your work and write your report to ${output}.`;
}
