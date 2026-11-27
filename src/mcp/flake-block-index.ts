import { join } from 'node:path';
import { JOB_ID_RE } from '../roles/job-index-cache.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const MAX_JOBS = 512;
const MAX_BYTES = 16 * 1024;
const indexFile = (home: string) => join(home, 'flake-block-index.json');

export function readFlakeBlockJobs(home: string): string[] {
  try {
    const ids = readJsonBounded(indexFile(home), MAX_BYTES);
    if (!Array.isArray(ids)) throw new Error('invalid flake block index');
    return ids.slice(0, MAX_JOBS).filter((id): id is string => typeof id === 'string' && JOB_ID_RE.test(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Called under the per-home flake-block-index lock, before writing the job's
 * refusal. Keep claims in the index: a failed delivery can release its marker. */
export function indexFlakeBlockJob(home: string, id: string): void {
  const ids = readFlakeBlockJobs(home).filter(candidate => candidate !== id);
  writeJsonPrivate(indexFile(home), [id, ...ids].slice(0, MAX_JOBS));
}
