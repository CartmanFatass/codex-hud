import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { abstractAddress } from './abstract-lock.js';
import { writePrivateFile } from './atomic-fs.js';

export const RUNNER_READY = 'runner.ready';
// A wake-up edge, never evidence that the PID is still alive or listening.
export const notifyRunner = (dir: string, pid: number) => writePrivateFile(join(dir, RUNNER_READY), String(pid), { mkdir: false });
export const runnerAddress = (dir: string, pid: number) => abstractAddress('runner', `${realpathSync(dir)}\0${pid}`);

/** Subscribers observe EOF at process exit (including SIGKILL). Neither the listener nor accepted sockets keep the runner alive. */
export async function publishRunnerLifetime(dir: string) {
  const server = createServer(socket => { socket.on('error', () => {}).unref(); });
  server.listen(runnerAddress(dir, process.pid));
  await once(server, 'listening');
  server.unref();
  // STATUS/flow may have been published by the launcher before this process finished importing.
  notifyRunner(dir, process.pid);
}
