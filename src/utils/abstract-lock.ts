import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export class AbstractLockTimeoutError extends Error {
  constructor(readonly scope: string) {
    super(`abstract lock timeout (${scope})`);
    this.name = 'AbstractLockTimeoutError';
  }
}

export function abstractAddress(scope: string, key: string): string {
  // Keep the full address under sockaddr_un's 108-byte limit.
  if (!/^[a-z0-9-]{1,24}$/.test(scope)) throw new Error(`invalid abstract lock scope: ${scope}`);
  const name = createHash('sha256').update(key).digest('hex');
  return `\0myhud-${scope}-${name}`;
}

/** Try a Linux/WSL abstract socket mutex. The kernel releases it even on SIGKILL. */
export async function tryAbstractLock(scope: string, key: string): Promise<(() => Promise<void>) | undefined> {
  const address = abstractAddress(scope, key);
  return new Promise((resolve, reject) => {
    const server = createServer((connection) => connection.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(undefined);
      else reject(error);
    });
    server.listen(address, () => {
      server.unref();
      let closed: Promise<void> | undefined;
      resolve(() => closed ??= new Promise<void>((done) => server.close(() => done())));
    });
  });
}

/** Retry short mutex contention; socket close does not emit a filesystem event. */
export async function withAbstractLock<T>(
  scope: string,
  key: string,
  run: () => T | Promise<T>,
  { timeoutMs = 1000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const release = await tryAbstractLock(scope, key);
    if (release) {
      try {
        signal?.throwIfAborted();
        return await run();
      } finally {
        await release();
      }
    }
    const left = deadline - performance.now();
    if (left <= 0) throw new AbstractLockTimeoutError(scope);
    await sleep(Math.min(left, 3 + Math.random() * 7), undefined, { signal });
  }
}
