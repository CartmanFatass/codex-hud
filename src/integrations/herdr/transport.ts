import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { canonicalJson } from '../../core/canonical.js';
import { readProcess, sameStamp } from '../../core/run/process.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { isAbsolute } from 'node:path';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('herdr_invalid_response');
  return value as ObjectValue;
}

/** Injectable transport. Mutating tests must use a private server or a fake. */
export interface HerdrTransport {
  command(argv: readonly string[]): Promise<unknown>;
  request(method: string, params: ObjectValue): Promise<ObjectValue>;
  instance(): Promise<string | null>;
}

/** Every CLI call has an explicit socket; no focused-session fallback. */
export class CliHerdrTransport implements HerdrTransport {
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    readonly socketPath: string,
    env: NodeJS.ProcessEnv = process.env,
    readonly binary = 'herdr',
    readonly timeoutMs = 1500,
    /** Trusted composition supplies a full server stamp; inherited IDs/socket metadata never prove it. */
    private readonly server: ProcessStamp | null = null
  ) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0')) throw new Error('herdr_socket_required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3000) throw new Error('herdr_invalid_timeout');
    this.server = server ? Object.freeze({ ...server }) : null;
    this.env = { ...env, HERDR_SOCKET_PATH: socketPath };
    delete this.env.HERDR_SOCKET;
  }
  async instance(): Promise<string | null> {
    try {
      if (!this.server) return null;
      const before = readProcess(this.server.pid);
      if (!before || !sameStamp(before.stamp, this.server)) return null;
      const stat = await lstat(this.socketPath, { bigint: true });
      if (!stat.isSocket()) return null;
      const rows = (await readFile('/proc/net/unix', 'utf8')).split('\n').map((line) => line.trim().split(/\s+/));
      const inodes = new Set(
        rows.filter((row) => row[7] === this.socketPath && row[3] === '00010000').map((row) => row[6])
      );
      if (inodes.size !== 1) return null;
      const fds = await readdir(`/proc/${this.server.pid}/fd`);
      if (fds.length > 4096) return null;
      let owns = false;
      for (const fd of fds) {
        try {
          if ((await readlink(`/proc/${this.server.pid}/fd/${fd}`)) === `socket:[${[...inodes][0]}]`) {
            owns = true;
            break;
          }
        } catch {
          /* descriptor churn cannot establish ownership */
        }
      }
      const after = readProcess(this.server.pid);
      if (!owns || !after || !sameStamp(after.stamp, this.server)) return null;
      return `herdr:${canonicalJson(this.server)}:${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
    } catch {
      return null;
    }
  }
  async command(argv: readonly string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        [...argv],
        {
          env: this.env,
          encoding: 'utf8',
          timeout: this.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) return reject(new Error('herdr_transport_unavailable'));
          if (argv[0] === '--version') return resolve(stdout.trim());
          if (!stdout.trim() && argv[0] !== 'api') return resolve({ result: { type: 'ok' } });
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('herdr_invalid_response'));
          }
        }
      );
    });
  }
  async request(method: string, params: ObjectValue): Promise<ObjectValue> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = new Socket();
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (result?: ObjectValue) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (result) resolve(result);
        else reject(new Error('herdr_transport_unavailable'));
      };
      const timer = setTimeout(() => finish(), this.timeoutMs);
      socket.on('error', () => finish());
      socket.on('end', () => finish());
      socket.on('close', () => finish());
      socket.on('data', (chunk: Buffer) => {
        if (buffer.length + chunk.length > 2 * 1024 * 1024) return finish();
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const reply = object(JSON.parse(buffer.subarray(0, end).toString('utf8')));
          if (reply.id !== id || reply.error) return finish();
          finish(object(reply.result));
        } catch {
          finish();
        }
      });
      socket.connect(this.socketPath, () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    });
  }
}
