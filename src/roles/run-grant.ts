import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

export type OwnerGrant = { via: 'cli' | 'claude-mod' | 'pi' | 'panel'; created_at: string };

/** An owner-issued, single-use reservation. The private claim stays spent after the
 * first input; only the owning run may return a completely unused reservation. */
export function runGrantStore(name: string) {
  const file = (home: string) => join(home, `${name}.json`);
  const lock = <T>(home: string, run: () => T) => withAbstractLock(name, realpathSync(home), run);
  function read(home: string) {
    try { return readJsonBounded(file(home), 1024) as OwnerGrant & { claimed_by?: string }; }
    catch { return undefined; }
  }
  function available(home: string): OwnerGrant | undefined {
    const record = read(home);
    if (!record || record.claimed_by !== undefined || !['cli', 'claude-mod', 'pi', 'panel'].includes(record.via) || typeof record.created_at !== 'string') return;
    const age = Date.now() - Date.parse(record.created_at);
    if (age >= 0 && age < 30 * 60_000) return { via: record.via, created_at: record.created_at };
  }
  return { available,
    issue(home: string, via: OwnerGrant['via']) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      return lock(home, () => writeJsonPrivate(file(home), { via, created_at: new Date().toISOString() }));
    },
    reserve(home: string, run: string) {
      return lock(home, () => {
        const grant = available(home);
        if (grant) writeJsonPrivate(file(home), { ...grant, claimed_by: run });
        return grant;
      });
    },
    releaseUnused(home: string, run: string) {
      return lock(home, () => {
        const record = read(home);
        if (record?.claimed_by === run) writeJsonPrivate(file(home), { via: record.via, created_at: record.created_at });
      });
    },
  };
}
