import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { resumeIdentity } from './worker-resume.js';

export const sonicSession = (dir: string) => join(dir, jobFiles.sonicSession);

function partialTail(path: string) {
  try {
    const limit = 8192;
    const offset = Math.max(0, fs.lstatSync(path).size - limit);
    const { bytes } = readFileBounded(path, limit, { offset });
    return (offset ? '…' : '') + bytes.toString('utf8').trim();
  } catch { return ''; } // Older jobs or an early stop may have no partial result.
}

/** A retry owns its own transcript snapshot: independent retries never append to each other's turns. */
export function prepareSonicRetry(dir: string, cwd: string, source: Job, sourceDir: string, status: JobStatus | null) {
  if (!source.headless || !status || !(status.state === 'stopped' ||
      (status.state === 'failed' && ['looping', 'stalled', 'timeout'].includes(status.exit_reason ?? '')))) return;
  const reason = status.exit_reason ?? status.state;
  const partial = partialTail(join(sourceDir, jobFiles.report)) || partialTail(join(sourceDir, jobFiles.sonicStdout));
  const brief = join(dir, jobFiles.brief);
  if (partial) writePrivateFile(brief, fs.readFileSync(brief, 'utf8') + `\nPartial result from the stopped query (${reason}):\n${partial}\n`, { mkdir: false });
  if (source.cwd !== cwd) return;
  try {
    // In JSON print mode pi emits its native session header before it takes input.
    const { bytes } = readFileBounded(join(sourceDir, jobFiles.sonicStdout), 64 * 1024);
    const header = JSON.parse(bytes.toString('utf8').split('\n', 1)[0]);
    if (header.type !== 'session' || typeof header.id !== 'string') return;
    const file = sonicSession(fs.realpathSync(sourceDir));
    const identity = resumeIdentity(source, { ...status, session_id: header.id, session_file: file });
    if (identity?.file !== file) return;
    fs.copyFileSync(file, sonicSession(dir), fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    return `Continue; you were stopped for ${reason}. Your current brief is ${brief}. Finish with hud_report.`;
  } catch { return; } // No usable native identity: dispatch the ordinary brief, with partial output.
}
