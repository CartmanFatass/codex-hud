import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { proxyTime } from '../exp-proxy.js';

// Canonical profile paths are keys, not filenames or data in the observation.
export const expNativePath = (hudHome: string, profile: string) =>
  join(hudHome, 'exp', `codex-native-${createHash('sha256').update(profile).digest('hex')}.json`);

export function readExpNativeSeen(file: string): number | undefined {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return;
    const buf = Buffer.alloc(stat.size + 1);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytes !== stat.size) return;
    const data = JSON.parse(buf.toString('utf8', 0, bytes));
    if (data?.version === 1 && proxyTime(data.lastSeenAt)) return data.lastSeenAt;
  } catch {
    // An optional observation, including the old unscoped file, is not profile evidence.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
