import type { CallBudget } from '../../ledger/call-budget.js';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const MAX_BRIEF_BYTES = 262_144;

/** The owned buffer is private; callers only receive copies of the accepted bytes. */
export interface BriefSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  bytes(): Buffer;
}

/** Read a regular file once, outside the ledger transaction, with a hard allocation/read bound. */
export async function snapshotBrief(
  file: string,
  maxBytes = MAX_BRIEF_BYTES,
  budget?: CallBudget
): Promise<BriefSnapshot> {
  budget?.check();
  if (!isAbsolute(file) || file.includes('\0')) throw new Error('absolute_brief_path_required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BRIEF_BYTES)
    throw new Error('invalid_brief_limit');
  const canonical = await fs.realpath(file);
  budget?.check();
  // O_NONBLOCK also lets us refuse a FIFO without waiting for a writer.
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    budget?.check();
    const stat = await handle.stat();
    budget?.check();
    if (!stat.isFile()) throw new Error('brief_not_regular_file');
    if (stat.size > maxBytes) throw new Error('brief_too_large');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      budget?.check();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      budget?.check();
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error('brief_too_large');
    const bytes = Buffer.from(buffer.subarray(0, size));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    budget?.check();
    return Object.freeze({ path: canonical, sha256, byteLength: size, bytes: () => Buffer.from(bytes) });
  } finally {
    await handle.close();
  }
}
