export interface TokenRateSnapshot {
  tokensPerSecond: number;
  sampleMs: number;
  sampledAt: Date;
}

interface OutputSample {
  total: number;
  atMs: number;
}

const WINDOW_MS = 30_000;
const MIN_SAMPLE_MS = 1000;
const STALE_MS = 10_000;

/** An estimate from timestamped usage reports, not streaming decode telemetry. */
export class TokenRateTracker {
  private samples: OutputSample[] = [];
  private lastTotal: number | undefined;
  private lastAtMs: number | undefined;
  private latest: TokenRateSnapshot | undefined;

  clone(): TokenRateTracker {
    const copy = new TokenRateTracker();
    copy.samples = this.samples.map(sample => ({ ...sample }));
    copy.lastTotal = this.lastTotal;
    copy.lastAtMs = this.lastAtMs;
    copy.latest = this.latest;
    return copy;
  }

  observe(totalOutputTokens: number, at: Date): void {
    const atMs = at.getTime();
    if (!Number.isSafeInteger(totalOutputTokens) || totalOutputTokens < 0 ||
        !Number.isFinite(atMs)) return;
    if (this.lastAtMs !== undefined && (atMs < this.lastAtMs ||
        (atMs === this.lastAtMs && this.lastTotal !== undefined))) return;

    if (this.lastTotal !== undefined && totalOutputTokens < this.lastTotal) this.reset();
    this.lastTotal = totalOutputTokens;
    this.lastAtMs = atMs;
    const next = { total: totalOutputTokens, atMs };
    const last = this.samples[this.samples.length - 1];

    // Keep the initial baseline and at most one later observation per second.
    // This bounds storage without losing the elapsed interval during dense bursts.
    if (this.samples.length > 1 && Math.floor(last.atMs / MIN_SAMPLE_MS) === Math.floor(atMs / MIN_SAMPLE_MS)) {
      this.samples[this.samples.length - 1] = next;
    } else {
      this.samples.push(next);
    }
    // Retain the predecessor of the window boundary. Sparse reports can span
    // more than 30 seconds, so always expose their real elapsed time.
    while (this.samples.length > 2 && this.samples[1].atMs <= atMs - WINDOW_MS) {
      this.samples.shift();
    }

    const baseline = this.samples[0];
    const sampleMs = atMs - baseline.atMs;
    if (sampleMs < MIN_SAMPLE_MS) return;
    this.latest = {
      tokensPerSecond: (totalOutputTokens - baseline.total) / (sampleMs / 1000),
      sampleMs,
      sampledAt: new Date(atMs),
    };
  }

  startTurn(at: Date): void {
    const atMs = at.getTime();
    if (!Number.isFinite(atMs) || (this.lastAtMs !== undefined && atMs <= this.lastAtMs)) return;
    this.lastAtMs = atMs;
    this.samples = this.lastTotal === undefined ? [] : [{ total: this.lastTotal, atMs }];
  }

  reset(): void {
    this.samples = [];
    this.lastTotal = undefined;
    this.lastAtMs = undefined;
    this.latest = undefined;
  }

  get snapshot(): TokenRateSnapshot | undefined { return this.latest; }
}

export function formatTokenRate(snapshot: TokenRateSnapshot | undefined, nowMs = Date.now()): string | null {
  if (!snapshot || !Number.isFinite(snapshot.tokensPerSecond) || snapshot.tokensPerSecond < 0 ||
      !Number.isFinite(snapshot.sampleMs) || snapshot.sampleMs < MIN_SAMPLE_MS ||
      !Number.isFinite(snapshot.sampledAt.getTime()) || !Number.isFinite(nowMs)) return null;
  const prefix = nowMs - snapshot.sampledAt.getTime() >= STALE_MS ? 'last ' : '';
  return `${prefix}~${snapshot.tokensPerSecond.toFixed(1)} tok/s`;
}
