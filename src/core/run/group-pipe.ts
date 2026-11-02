import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** One private, unlinked FIFO. The supervisor passes only its open descriptors;
 * no path survives for reopening, and it owns/closes every temporary descriptor.
 */
export function createGroupPipe(): { read: number; write: number; close(): void } {
  const directory = mkdtempSync('/tmp/hud-group-control-');
  const path = join(directory, 'control');
  const owned: number[] = [];
  let created = false;
  const close = () => {
    for (const fd of owned.splice(0)) closeSync(fd);
    if (created) {
      unlinkSync(path);
      created = false;
    }
    rmdirSync(directory);
  };
  try {
    const result = spawnSync('/usr/bin/mkfifo', ['-m', '600', path], { env: {}, stdio: 'ignore', timeout: 2000 });
    if (result.error || result.status !== 0) throw new Error('headless_control_pipe_unavailable');
    created = true;
    const holder = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    owned.push(holder);
    const read = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    owned.push(read);
    const write = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    owned.push(write);
    const identity = fstatSync(holder);
    for (const fd of [read, write]) {
      const stat = fstatSync(fd);
      if (
        !stat.isFIFO() ||
        stat.uid !== process.getuid!() ||
        stat.mode & 0o077 ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino
      )
        throw new Error('headless_control_pipe_unavailable');
    }
    return { read, write, close };
  } catch (error) {
    close();
    throw error;
  }
}
