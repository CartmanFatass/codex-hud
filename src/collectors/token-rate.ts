import type { EventMsgPayload, ResponseItemPayload, RolloutLine } from '../types.js';

export interface TokenRateSnapshot {
  tokensPerSecond: number;
  /** Estimated model wall time, including TTFT/stalls but excluding known tool waits. */
  sampleMs: number;
  sampledAt: Date;
}

interface OutputSample {
  total: number;
  atMs: number;
}

const STALE_MS = 10_000;
const validTotal = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

/**
 * Turn-level wallclock proxy, not exact request telemetry. Codex rollouts do
 * not expose request start/stream end. Use turn/report timestamps and subtract
 * the union of identifiable tool waits; keep TTFT and generation stalls.
 * No rolling window, smoothing, speed cap or minimum one-second window.
 */
export class TokenRateTracker {
  private baseline: OutputSample | undefined;
  private lastTotal: number | undefined;
  private lastAtMs: number | undefined;
  private latest: TokenRateSnapshot | undefined;
  private tools = new Set<string>();
  private toolsStartedAtMs: number | undefined;
  private toolsLastAtMs: number | undefined;
  private excludedMs = 0;

  clone(): TokenRateTracker {
    const copy = new TokenRateTracker();
    copy.baseline = this.baseline && { ...this.baseline };
    copy.lastTotal = this.lastTotal;
    copy.lastAtMs = this.lastAtMs;
    copy.latest = this.latest;
    copy.tools = new Set(this.tools);
    copy.toolsStartedAtMs = this.toolsStartedAtMs;
    copy.toolsLastAtMs = this.toolsLastAtMs;
    copy.excludedMs = this.excludedMs;
    return copy;
  }

  observe(totalOutputTokens: number, at: Date): void {
    const atMs = at.getTime();
    if (!validTotal(totalOutputTokens) || !Number.isFinite(atMs) ||
        (this.lastAtMs !== undefined && (atMs < this.lastAtMs ||
          (atMs === this.lastAtMs && this.lastTotal !== undefined))) ||
        (this.toolsLastAtMs !== undefined && atMs < this.toolsLastAtMs)) return;

    // Quota-only/duplicate reports are not another model call. Do not dilute
    // the rate with time elapsed since the exact same cumulative usage.
    if (this.lastTotal === totalOutputTokens) {
      this.lastAtMs = atMs;
      return;
    }
    if (this.lastTotal !== undefined && totalOutputTokens < this.lastTotal) this.reset();
    this.lastTotal = totalOutputTokens;
    this.lastAtMs = atMs;

    if (!this.baseline) {
      // A first tail report's last_token_usage may repeat the previous turn.
      // Without a prior cumulative counter, do not attribute it to this turn.
      this.baseline = { total: totalOutputTokens, atMs };
      this.excludedMs = 0;
      if (this.tools.size > 0) this.toolsStartedAtMs = atMs;
    }
    // Only deduct closed wait unions. A missing output must not freeze the
    // denominator forever while later model output keeps increasing.
    const sampleMs = atMs - this.baseline.atMs - this.excludedMs;
    if (sampleMs <= 0) return;
    this.latest = {
      tokensPerSecond: (totalOutputTokens - this.baseline.total) * 1000 / sampleMs,
      sampleMs,
      sampledAt: new Date(atMs),
    };
  }

  startTurn(at: Date): void {
    const atMs = at.getTime();
    if (!Number.isFinite(atMs) || (this.lastAtMs !== undefined && atMs <= this.lastAtMs) ||
        (this.toolsLastAtMs !== undefined && atMs < this.toolsLastAtMs)) return;
    this.lastAtMs = atMs;
    this.baseline = this.lastTotal === undefined ? undefined : { total: this.lastTotal, atMs };
    this.tools.clear();
    this.toolsStartedAtMs = undefined;
    this.toolsLastAtMs = undefined;
    this.excludedMs = 0;
  }

  startTool(id: string, at: Date): void {
    const atMs = at.getTime();
    if (!id || !this.validToolTime(atMs) || this.tools.has(id)) return;
    if (this.tools.size === 0) this.toolsStartedAtMs = atMs;
    this.tools.add(id);
    this.toolsLastAtMs = atMs;
  }

  endTool(id: string, at: Date): void {
    const atMs = at.getTime();
    if (!this.tools.has(id) || !this.validToolTime(atMs)) return;
    this.tools.delete(id);
    this.toolsLastAtMs = atMs;
    if (this.tools.size === 0 && this.toolsStartedAtMs !== undefined) {
      this.excludedMs += atMs - this.toolsStartedAtMs;
      this.toolsStartedAtMs = undefined;
    }
  }

  private validToolTime(atMs: number): boolean {
    return Number.isFinite(atMs) && (this.lastAtMs === undefined || atMs >= this.lastAtMs) &&
      (this.toolsLastAtMs === undefined || atMs >= this.toolsLastAtMs);
  }

  reset(): void {
    this.baseline = undefined;
    this.lastTotal = undefined;
    this.lastAtMs = undefined;
    this.latest = undefined;
    this.tools.clear();
    this.toolsStartedAtMs = undefined;
    this.toolsLastAtMs = undefined;
    this.excludedMs = 0;
  }

  get snapshot(): TokenRateSnapshot | undefined { return this.latest; }
}

/** Shared evidence handling keeps the full parser and agent tail reader aligned. */
export function observeTokenRateRecord(tracker: TokenRateTracker, row: RolloutLine): void {
  const at = new Date(row.timestamp);
  if (row.type === 'event_msg') {
    const payload = row.payload as EventMsgPayload;
    if (payload.type === 'task_started' || payload.type === 'turn_started') tracker.startTurn(at);
    else if (payload.type === 'token_count' && typeof payload.info?.total_token_usage?.output_tokens === 'number') {
      tracker.observe(payload.info.total_token_usage.output_tokens, at);
    }
  } else if (row.type === 'response_item') {
    const payload = row.payload as ResponseItemPayload;
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const id = payload.call_id ?? payload.id;
      if (id) tracker.startTool(id, at);
    } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && payload.call_id) {
      tracker.endTool(payload.call_id, at);
    }
  }
}

export function formatTokenRate(snapshot: TokenRateSnapshot | undefined, nowMs = Date.now()): string | null {
  if (!snapshot || !Number.isFinite(snapshot.tokensPerSecond) || snapshot.tokensPerSecond < 0 ||
      !Number.isFinite(snapshot.sampleMs) || snapshot.sampleMs <= 0 ||
      !Number.isFinite(snapshot.sampledAt.getTime()) || !Number.isFinite(nowMs)) return null;
  const prefix = nowMs - snapshot.sampledAt.getTime() >= STALE_MS ? 'last ' : '';
  return `${prefix}~${snapshot.tokensPerSecond.toFixed(1)} tok/s`;
}
