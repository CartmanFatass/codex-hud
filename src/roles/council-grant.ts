import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

export type CouncilGrant = { via: 'cli' | 'claude-mod' | 'pi' | 'panel'; created_at: string };
const file = (home: string) => join(home, 'council-grant.json');
const lock = <T>(home: string, run: () => T) => withAbstractLock('council-grant', realpathSync(home), run);
function read(home: string) {
  try { return readJsonBounded(file(home), 1024) as CouncilGrant & { claimed_by?: string }; }
  catch { return undefined; }
}

export function availableCouncilGrant(home: string): CouncilGrant | undefined {
  const record = read(home);
  if (!record || record.claimed_by !== undefined || !['cli', 'claude-mod', 'pi', 'panel'].includes(record.via) || typeof record.created_at !== 'string') return;
  const age = Date.now() - Date.parse(record.created_at);
  if (age >= 0 && age < 30 * 60_000) return { via: record.via, created_at: record.created_at };
}

export async function allowCouncil(home: string, via: CouncilGrant['via']) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return lock(home, () => writeJsonPrivate(file(home), { via, created_at: new Date().toISOString() }));
}

/** Reserve before publishing any jobs. Once a member starts the durable claim is spent;
 * only an all-before-start failure may release it, never over a newer owner action. */
export async function reserveCouncilGrant(home: string, job: string) {
  return lock(home, () => {
    const grant = availableCouncilGrant(home);
    if (!grant) return;
    writeJsonPrivate(file(home), { ...grant, claimed_by: job });
    return { grant, releaseUnused: () => lock(home, () => {
      if (read(home)?.claimed_by === job) writeJsonPrivate(file(home), grant);
    }) };
  });
}
