import { createConnection, type Socket } from 'node:net';
import { runnerAddress } from '../utils/runner-lifetime.js';

type Entry = { dir: string; socket?: Socket; retryAt: number; delay: number };

/** One subscription per live process. A close only schedules a fresh identity/receipt check. */
export class RunnerWatches {
  private entries = new Map<string, Entry>();
  private wanted = new Set<string>();
  constructor(private wake: () => void) {}

  watch(dir: string, pid: number): number {
    const key = `${dir}\0${pid}`;
    this.wanted.add(key);
    const entry: Entry = this.entries.get(key) ?? { dir, retryAt: 0, delay: 50 };
    this.entries.set(key, entry);
    if (entry.socket) return Infinity;
    if (entry.retryAt > Date.now()) return entry.retryAt;
    const socket = entry.socket = createConnection(runnerAddress(dir, pid));
    socket.on('error', () => {}); // close is also emitted on a refused pre-listen connection.
    socket.once('connect', () => { entry.delay = 50; });
    socket.once('close', () => {
      if (this.entries.get(key) !== entry) return;
      entry.socket = undefined;
      entry.retryAt = Date.now() + entry.delay;
      entry.delay = Math.min(30_000, entry.delay * 2);
      this.wake();
    });
    return Infinity;
  }

  ready(dir: string) {
    for (const entry of this.entries.values()) if (entry.dir === dir) {
      entry.retryAt = 0;
      entry.delay = 50; // A pre-listen refusal may still be in flight.
    }
  }

  finishScan() {
    for (const [key, entry] of this.entries) if (!this.wanted.has(key)) {
      this.entries.delete(key);
      entry.socket?.destroy();
    }
    this.wanted.clear();
  }

  close() {
    this.wanted.clear();
    this.finishScan();
  }
}
