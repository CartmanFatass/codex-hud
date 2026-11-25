import { basename, isAbsolute, join } from 'node:path';
import type { GuardMode } from '../../../roles/pi-defaults.js';
import { readJsonBounded, writeJsonPrivate } from '../../../utils/atomic-fs.js';

export const sonicProtocolTools = ['hud_report', 'hud_progress', 'hud_lease'] as const;

export const sessionProtocolTools = [...sonicProtocolTools, 'hud_ask', 'hud_sonic'] as const;

export interface WorkerContract {
  version: 1;
  job: string;
  role: string;
  instructions: string;
  model?: string;
  thinking?: string;
  guard?: GuardMode;
  session?: string; // Present for session workers; Sonic has its own one-shot file.
  explicitTools: boolean;
  tps: boolean;
}

export function writeContract(dir: string, contract: WorkerContract) {
  writeJsonPrivate(join(dir, 'pi-worker.json'), contract, { mkdir: false });
}

export function readContract(dir: string): WorkerContract {
  const c = readJsonBounded(join(dir, 'pi-worker.json'), 16384) as Partial<WorkerContract> | null;
  const nonempty = (s: unknown) => typeof s === 'string' && Boolean(s);
  if (c?.version !== 1 || c.job !== basename(dir) || !nonempty(c.role) || typeof c.instructions !== 'string' ||
      !/^[\w-]+$/.test(c.instructions) || (c.model !== undefined && !nonempty(c.model)) ||
      (c.thinking !== undefined && !nonempty(c.thinking)) || (c.guard !== undefined && c.guard !== 'strict' && c.guard !== 'oracle') ||
      (c.role === 'sonic' ? c.session !== undefined : typeof c.session !== 'string' || !isAbsolute(c.session)) ||
      typeof c.explicitTools !== 'boolean' || typeof c.tps !== 'boolean') throw Error('Invalid pi worker contract');
  return c as WorkerContract;
}
