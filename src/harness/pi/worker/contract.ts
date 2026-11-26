import { basename, isAbsolute, join } from 'node:path';
import { isPiProfile, type GuardMode, type PiProfile } from '../../../roles/pi-defaults.js';
import { readJsonBounded, writeJsonPrivate } from '../../../utils/atomic-fs.js';

export const sonicProtocolTools = ['hud_report', 'hud_progress', 'hud_lease'] as const;

export const sessionProtocolTools = [...sonicProtocolTools, 'hud_ask', 'hud_sonic'] as const;

export interface TabContract {
  profile: PiProfile;
  effortSource?: string;
}

export interface WorkerContract {
  version: 1;
  job: string;
  role: string;
  instructions: string;
  model?: string;
  thinking?: string;
  guard?: GuardMode;
  session?: string; // Present for headless session workers and resumed tab workers; Sonic has its own one-shot file.
  explicitTools: boolean;
  tps: boolean;
  tab?: TabContract; // Present for tab Pi workers; omitted for headless workers.
}

export function writeContract(dir: string, contract: WorkerContract) {
  writeJsonPrivate(join(dir, 'pi-worker.json'), contract, { mkdir: false });
}

export function readContract(dir: string): WorkerContract {
  const c = readJsonBounded(join(dir, 'pi-worker.json'), 16384) as Partial<WorkerContract> | null;
  const nonempty = (s: unknown) => typeof s === 'string' && Boolean(s);
  const validTab = (t: unknown): t is TabContract => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    const { profile, effortSource } = t as Partial<TabContract>;
    return isPiProfile(profile) && (effortSource === undefined || nonempty(effortSource));
  };
  const validSession = c?.tab !== undefined
    ? c.session === undefined || (typeof c.session === 'string' && isAbsolute(c.session))
    : c?.role === 'sonic'
      ? c.session === undefined
      : typeof c?.session === 'string' && isAbsolute(c.session);
  if (
    c?.version !== 1 ||
    c.job !== basename(dir) ||
    !nonempty(c.role) ||
    typeof c.instructions !== 'string' ||
    !/^[\w-]+$/.test(c.instructions) ||
    (c.model !== undefined && !nonempty(c.model)) ||
    (c.thinking !== undefined && !nonempty(c.thinking)) ||
    (c.guard !== undefined && c.guard !== 'strict' && c.guard !== 'oracle') ||
    (c.tab !== undefined && !validTab(c.tab)) ||
    !validSession ||
    typeof c.explicitTools !== 'boolean' ||
    typeof c.tps !== 'boolean'
  ) {
    throw Error('Invalid pi worker contract');
  }
  return c as WorkerContract;
}
