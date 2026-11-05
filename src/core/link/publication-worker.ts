import { Worker } from 'node:worker_threads';

/** One owned worker and at most one coalesced refresh; no authority crosses the boundary. */
export class PublicationWorker {
  private worker: Worker | null;
  private ready = false;
  private active = false;
  private pending: string | null | undefined;
  private closed = false;
  private closePromise?: Promise<boolean>;
  private finishClose?: (clean: boolean) => void;

  constructor(
    home: string,
    ambientHome: string | undefined,
    private readonly onSettled: (changed: boolean, error: string | null) => void
  ) {
    this.worker = new Worker(new URL('./publication-worker-entry.js', import.meta.url), {
      workerData: { home, ambientHome },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    });
    this.worker.on(
      'message',
      (message: { type?: string; changed?: boolean; error?: string | null; clean?: boolean }) => {
        if (message.type === 'ready' && !this.closed) {
          this.ready = true;
          this.dispatch();
        } else if (message.type === 'settled') {
          this.active = false;
          if (!this.closed) this.onSettled(message.changed === true, message.error ?? null);
          this.dispatch();
        } else if (message.type === 'closed') {
          this.finishClose?.(message.clean === true);
        } else if (message.type === 'failed') {
          if (!this.closed) this.onSettled(false, 'observation_worker_unavailable');
        }
      }
    );
    this.worker.on('error', () => {
      if (!this.closed) this.onSettled(false, 'observation_worker_unavailable');
    });
    this.worker.on('exit', () => {
      this.worker = null;
      this.ready = false;
      if (!this.closed) this.onSettled(false, 'observation_worker_unavailable');
      this.finishClose?.(false);
    });
  }
  request(scope?: string): void {
    if (this.closed || !this.worker) return;
    this.pending = scope ?? null;
    this.dispatch();
  }
  private dispatch(): void {
    if (this.closed || !this.ready || this.active || this.pending === undefined || !this.worker) return;
    const scope = this.pending;
    this.pending = undefined;
    this.active = true;
    this.worker.postMessage({ type: 'collect', scope });
  }
  close(): Promise<boolean> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.pending = undefined;
    this.closePromise = new Promise((resolve) => {
      if (!this.worker) {
        resolve(false);
        return;
      }
      let finished = false;
      const finish = (clean: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.finishClose = undefined;
        resolve(clean);
      };
      const timer = setTimeout(() => {
        const worker = this.worker;
        if (worker) {
          worker.unref();
          void worker.terminate().catch(() => {});
        }
        finish(false);
      }, 2000);
      this.finishClose = finish;
      try {
        this.worker.postMessage({ type: 'close' });
      } catch {
        finish(false);
      }
    });
    return this.closePromise;
  }
}
