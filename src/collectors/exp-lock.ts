import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

/** Linux/WSL abstract socket: bind is non-blocking; the kernel releases it even on a crash. */
export function tryExpLock(scope: string, key: string): Promise<(() => Promise<void>) | undefined> {
  const name = createHash('sha256').update(key).digest('hex');
  return new Promise((resolve, reject) => {
    const server = createServer((connection) => connection.destroy());
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(undefined) : reject(err)));
    server.listen(`\0myhud-exp-${scope}-${name}`, () => {
      server.unref();
      resolve(() => new Promise<void>((done) => server.close(() => done())));
    });
  });
}
