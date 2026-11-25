import { basename, join } from 'node:path';
import { readJsonBounded, writeJsonPrivate } from '../../../utils/atomic-fs.js';

export const sonicProtocolTools = ['hud_report', 'hud_progress', 'hud_lease'] as const;

export interface SonicContract {
  version: 1;
  job: string;
  role: 'sonic';
  instructions: string;
  model: string;
  thinking: string;
  explicitTools: boolean;
  tps: boolean;
}

export function writeContract(dir: string, contract: SonicContract) {
  writeJsonPrivate(join(dir, 'pi-worker.json'), contract, { mkdir: false });
}

export function readContract(dir: string): SonicContract {
  const c = readJsonBounded(join(dir, 'pi-worker.json'), 16384) as Partial<SonicContract> | null;
  if (c?.version !== 1 || c.job !== basename(dir) || c.role !== 'sonic' || typeof c.instructions !== 'string' ||
      !/^[\w-]+$/.test(c.instructions) || typeof c.model !== 'string' || !c.model || typeof c.thinking !== 'string' ||
      !c.thinking || typeof c.explicitTools !== 'boolean' || typeof c.tps !== 'boolean') throw Error('Invalid pi worker contract');
  return c as SonicContract;
}
