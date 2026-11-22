import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const releaseRoot = new URL('..', import.meta.url);

// Published (or touched for a script-only rebuild) by each successful main build.
export function buildStamp() {
  try {
    const s = statSync(new URL('../dist/index.js', import.meta.url), { bigint: true });
    return `${s.ino}:${s.ctimeNs}`;
  } catch { return null; }
}

export async function acquireBuildLock(kind, root = releaseRoot) {
  const name = `\0myhud-${kind}-${createHash('sha256').update(realpathSync(root)).digest('hex')}`;
  // Linux/WSL releases abstract sockets even after SIGKILL. No files or daemon to clean up.
  const lock = createServer((socket) => socket.destroy());
  const deadline = performance.now() + 15_000;
  for (;;) {
    const listening = once(lock, 'listening');
    lock.listen(name);
    try {
      await listening;
      return lock;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for the HUD ${kind === 'build' ? 'build lock' : 'dist lock'}`);
      await delay(Math.min(10, remaining));
    }
  }
}

// Take the same lock on both sides: a check alone can race the first rename.
// Release it after the startup imports, never hold it while running a command.
export async function withDistLock(load, root = releaseRoot) {
  const lock = await acquireBuildLock('dist', root);
  try {
    return await load();
  } finally {
    lock.close();
  }
}
