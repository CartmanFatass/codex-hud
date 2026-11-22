/** Identify a worker whose native session survived but whose HUD_JOB_DIR did not. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './herdr-run.js';

const MAX_ENTRIES = 512;
const MAX_STATUS_BYTES = 16 * 1024;
const JOB_ID = /^j[0-9a-f]{16}$/;
type Identity = { agent: 'claude' | 'codex'; id: string } | { agent: 'pi'; id: string; file?: string };

function matches(status: Record<string, unknown>, identity: Identity): boolean {
  if (identity.agent !== 'pi') return status.agent === identity.agent && status.agent_session_id === identity.id;
  if (status.harness === 'cli') return false;
  if (typeof status.session_id === 'string' && status.session_id) return status.session_id === identity.id;
  return !!identity.file && status.session_file === identity.file;
}

/** One read-only, bounded scan. Exact sessions still match after a job is marked failed. */
export function resumedWorkerRefusal(hudHome: string, identity: Identity): string | undefined {
  const root = join(hudHome, 'jobs');
  const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
  let unreadable = 0, exhausted = false;
  try {
    const jobs = fs.opendirSync(root);
    try {
      for (let n = 0; n <= MAX_ENTRIES; n++) {
        const job = jobs.readSync();
        if (!job) break;
        if (n === MAX_ENTRIES) { exhausted = true; break; }
        if (!job.isDirectory() || !JOB_ID.test(job.name)) continue;
        try {
          const fd = fs.openSync(join(root, job.name, 'STATUS.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            if (!fs.fstatSync(fd).isFile()) { unreadable++; continue; }
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (bytes > MAX_STATUS_BYTES) { unreadable++; continue; }
            const status: unknown = JSON.parse(buffer.toString('utf8', 0, bytes));
            if (!isRecord(status)) { unreadable++; continue; }
            if (matches(status, identity)) {
              return `This is worker job ${job.name}, resumed without its HUD binding. Recovery is manual: use hud_create({ retry_of: '${job.name}' }) from a main session or rerun in a fresh tab.`;
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          unreadable++;
        }
      }
    } finally {
      jobs.closeSync();
    }
  } catch (error) {
    // A fresh HUD_HOME has no jobs yet: the normal main-session case stays silent.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`HUD resume guard (${identity.agent}): jobs directory unreadable; allowing main-session tools.`);
    return;
  }
  // Silent on a clean miss; speak only when the scan could not see everything.
  if (exhausted || unreadable) console.error(`HUD resume guard (${identity.agent}): no matching worker session${exhausted ? ' within the scan limit' : ''}${unreadable ? ` (${unreadable} unreadable status records)` : ''}; allowing main-session tools.`);
}
