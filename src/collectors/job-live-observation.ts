/** Narrow read-only live evidence. Never imports an execution runtime or connects a socket. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { listedAgents, type ListedAgent } from '../roles/herdr-run.js';

export const LIVE_CADENCE_MS = 5000;
export const LIVE_EXPIRY_MS = 15000;
export const LIVE_TIMEOUT_MS = 250;
export const HERDR_LIST_MAX_BYTES = 256 * 1024;
export type HerdrListRunner = (signal: AbortSignal) => Promise<string>;

export function runHerdrList(env: NodeJS.ProcessEnv = process.env): HerdrListRunner {
  return (signal) =>
    new Promise((resolve, reject) => {
      const child = spawn('herdr', ['agent', 'list', '--json'], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        signal,
        killSignal: 'SIGKILL',
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > HERDR_LIST_MAX_BYTES) {
          child.kill('SIGKILL');
          child.stdout.destroy();
        } else chunks.push(data);
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 && bytes <= HERDR_LIST_MAX_BYTES
          ? resolve(Buffer.concat(chunks).toString('utf8'))
          : reject(new Error('herdr_unavailable'))
      );
    });
}
export class HerdrListSampler {
  private flight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private lastAttempt = -Infinity;
  private goodAt: number | null = null;
  private agents: readonly ListedAgent[] | null = null;
  private generation = 0;
  constructor(private readonly run: HerdrListRunner = runHerdrList()) {}
  tick(nowMs: number): void {
    if (this.flight || nowMs - this.lastAttempt < LIVE_CADENCE_MS) return;
    this.lastAttempt = nowMs;
    const generation = this.generation;
    const abort = (this.abort = new AbortController());
    const timer = setTimeout(() => {
      if (generation === this.generation) {
        this.agents = null;
        abort.abort();
      }
    }, LIVE_TIMEOUT_MS);
    this.flight = Promise.resolve()
      .then(() => this.run(abort.signal))
      .then((text) => {
        if (generation !== this.generation || abort.signal.aborted) return;
        this.agents = Buffer.byteLength(text) <= HERDR_LIST_MAX_BYTES ? listedAgents(text) : null;
        this.goodAt = this.agents === null ? this.goodAt : nowMs;
      })
      .catch(() => {
        if (generation === this.generation) this.agents = null;
      })
      .finally(() => {
        clearTimeout(timer);
        this.flight = null;
        this.abort = null;
      });
  }
  async settled(): Promise<void> {
    await this.flight;
  }
  match(
    location: { agent: string | null; pane_id: string | null; tab_id: string | null },
    nowMs: number
  ): { status: string; at: number; deadline: number } | null {
    if (
      !location.agent ||
      !location.pane_id ||
      !location.tab_id ||
      this.goodAt === null ||
      nowMs > this.goodAt + LIVE_EXPIRY_MS
    )
      return null;
    const matches = this.agents?.filter(
      (a) => a.name === location.agent && a.paneId === location.pane_id && a.tabId === location.tab_id
    );
    if (matches?.length !== 1 || !matches[0]!.status) return null;
    return { status: matches[0]!.status!, at: this.goodAt, deadline: this.goodAt + LIVE_EXPIRY_MS };
  }
  dispose(): void {
    this.generation++;
    this.agents = null;
    this.abort?.abort();
  }
}

export interface JevProcessProbe {
  alive(pid: number): boolean;
  cmdline(pid: number): string | null;
}
export const procProbe: JevProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  cmdline(pid) {
    try {
      const fd = fs.openSync(`/proc/${pid}/cmdline`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const buffer = Buffer.alloc(16384);
        const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return n < buffer.length ? buffer.subarray(0, n).toString('utf8') : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  },
};
/** A numeric live pid alone is not evidence that it still belongs to this runtime. */
export function jevRuntimeAlive(value: unknown, probe: JevProcessProbe = procProbe): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(v.pid) ||
    Number(v.pid) < 2 ||
    typeof v.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.startedAt))
  )
    return false;
  const pid = Number(v.pid);
  if (!probe.alive(pid)) return false;
  const args = probe.cmdline(pid)?.split('\0') ?? [];
  return args.some((arg) => /(?:^|\/)jev\/runtime\/entry\.(?:js|ts)$/.test(arg));
}
