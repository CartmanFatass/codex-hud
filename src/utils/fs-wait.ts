import * as fs from 'node:fs';

const MAX_TIMEOUT_MS = 0x7fffffff;
const DEFAULT_COALESCE_MS = 15;
const DEFAULT_FALLBACK_MS = 5000;
const DEFAULT_DEGRADED_MS = 500;
const TRANSIENT_RETRY_MS = 25;
const MAX_TRANSIENT_RETRIES = 5;

export interface WatchTarget {
  /** Directory path to watch (never watch a single file directly). */
  dir: string;
  /** Default false; enable only when watching a large or dynamic tree. */
  recursive?: boolean;
  /**
   * Optional filename filter. When the platform omits filename (`null`),
   * return `true` to trigger a conservative check rather than missing events.
   */
  filter?: (filename: string | null, eventType: string) => boolean;
}

export interface FsWaitCheckContext {
  timedOut: boolean;
  remainingMs: number;
  reason: 'initial' | 'catchup' | 'event' | 'fallback' | 'timeout';
}

export type FsWaitStep<T> =
  | { done: true; value: T }
  | { done: false; minDelayMs?: number };

export interface FsWaitOptions<T> {
  targets: readonly WatchTarget[] | (() => readonly WatchTarget[]);
  timeoutMs: number;
  check: (ctx: FsWaitCheckContext) => FsWaitStep<T> | Promise<FsWaitStep<T>>;
  signal?: AbortSignal;
  coalesceMs?: number;
  fallbackIntervalMs?: number;
  degradedIntervalMs?: number;
  isTransientError?: (error: unknown) => boolean;
  onWatchError?: (dir: string, error: unknown) => void;
}

interface WatcherEntry {
  dir: string;
  recursive: boolean;
  watcher: fs.FSWatcher;
  filter?: (filename: string | null, eventType: string) => boolean;
}

function clampDelay(ms: number): number {
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function combineFilters(
  a?: (filename: string | null, eventType: string) => boolean,
  b?: (filename: string | null, eventType: string) => boolean
): ((filename: string | null, eventType: string) => boolean) | undefined {
  if (!a || !b) return undefined;
  return (filename, eventType) => a(filename, eventType) || b(filename, eventType);
}

/**
 * Wait for a filesystem-backed condition using `fs.watch` with a bounded fallback tick,
 * non-sliding event coalescing, dynamic target reconciliation, and guaranteed cleanup
 * on settle, timeout, error, or abort.
 */
export function waitUntilFs<T>(options: FsWaitOptions<T>): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  const budgetMs = Number.isNaN(options.timeoutMs) ? 0 : Math.max(0, options.timeoutMs);
  const coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);
  const fallbackIntervalMs = Math.max(10, options.fallbackIntervalMs ?? DEFAULT_FALLBACK_MS);
  const degradedIntervalMs = Math.max(10, options.degradedIntervalMs ?? DEFAULT_DEGRADED_MS);
  const deadline = performance.now() + budgetMs;
  const remainingMs = () => (Number.isFinite(deadline) ? Math.max(0, deadline - performance.now()) : Infinity);

  return new Promise<T>((resolve, reject) => {
    const watchers = new Map<string, WatcherEntry>();
    const erroredKeys = new Set<string>();
    let settled = false;
    let inFlight = false;
    let recheckPending = false;
    let degraded = false;
    let transientErrors = 0;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackMode: 'none' | 'healthy' | 'degraded' = 'none';
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (coalesceTimer !== undefined) {
        clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
      }
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
        fallbackMode = 'none';
      }
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      for (const entry of watchers.values()) {
        try {
          entry.watcher.close();
        } catch {
          /* Ignore close errors on already-errored watchers. */
        }
      }
      watchers.clear();
      erroredKeys.clear();
    }

    function finishResolve(value: T) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function finishReject(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function onAbort() {
      finishReject(abortReason(signal!));
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function armFallbackTimer(reset: boolean) {
      if (settled) return;
      const mode = degraded ? 'degraded' : 'healthy';
      if (!reset && fallbackTimer !== undefined && fallbackMode === mode) return;
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
        fallbackMode = 'none';
      }
      const interval = degraded ? degradedIntervalMs : fallbackIntervalMs;
      const rem = remainingMs();
      if (rem <= 0 || rem <= interval) return;
      fallbackMode = mode;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;
        fallbackMode = 'none';
        if (settled) return;
        if (inFlight) {
          recheckPending = true;
          return;
        }
        void evaluate('fallback');
      }, clampDelay(interval));
    }

    function armDeadlineTimer() {
      if (settled || !Number.isFinite(deadline)) return;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      const rem = deadline - performance.now();
      if (rem <= 0) {
        if (!inFlight) void evaluate('timeout');
        return;
      }
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        if (settled) return;
        const left = deadline - performance.now();
        if (left > 0) {
          armDeadlineTimer();
          return;
        }
        if (!inFlight) void evaluate('timeout');
      }, clampDelay(rem));
    }

    function scheduleCoalesce(delayMs: number, reason: 'event' | 'catchup' = 'event') {
      if (settled || coalesceTimer !== undefined) return;
      const rem = remainingMs();
      if (rem <= 0) {
        if (!inFlight) void evaluate('timeout');
        return;
      }
      const delay = Math.min(Math.max(0, delayMs), rem);
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined;
        if (settled) return;
        if (inFlight) {
          recheckPending = true;
          return;
        }
        void evaluate(reason);
      }, clampDelay(delay));
    }

    function onMatchingEvent() {
      if (settled) return;
      if (inFlight) {
        recheckPending = true;
        return;
      }
      if (coalesceTimer !== undefined) {
        // Non-sliding window: ignore follow-up events until the armed check runs.
        return;
      }
      scheduleCoalesce(coalesceMs, 'event');
    }

    function reconcile(): { attachedAny: boolean } {
      if (settled) return { attachedAny: false };
      const list = typeof options.targets === 'function' ? options.targets() : options.targets;
      const desired = new Map<string, WatchTarget>();
      for (const target of list) {
        const recursive = Boolean(target.recursive);
        const key = `${target.dir}\0${recursive ? 1 : 0}`;
        const existing = desired.get(key);
        if (existing) {
          desired.set(key, { ...existing, filter: combineFilters(existing.filter, target.filter) });
        } else {
          desired.set(key, { dir: target.dir, recursive, filter: target.filter });
        }
      }

      for (const [key, entry] of watchers) {
        if (!desired.has(key)) {
          watchers.delete(key);
          try {
            entry.watcher.close();
          } catch {
            /* Ignore close errors on already-closed watchers. */
          }
        }
      }
      for (const key of erroredKeys) {
        if (!desired.has(key)) erroredKeys.delete(key);
      }

      let attachedAny = false;
      let missingAny = false;
      for (const [key, target] of desired) {
        if (settled) return { attachedAny: false };
        const existing = watchers.get(key);
        if (existing) {
          existing.filter = target.filter;
          continue;
        }
        if (erroredKeys.has(key)) {
          missingAny = true;
          continue;
        }
        try {
          const watcher = fs.watch(target.dir, { recursive: Boolean(target.recursive) }, (eventType, filename) => {
            if (settled) return;
            const current = watchers.get(key);
            if (!current || current.watcher !== watcher) return;
            const name = filename === null || filename === undefined ? null : String(filename);
            let match = true;
            if (current.filter) {
              try {
                match = current.filter(name, eventType);
              } catch {
                match = true;
              }
            }
            if (match) onMatchingEvent();
          });
          if (settled) {
            try {
              watcher.close();
            } catch {
              /* Ignore close errors after late settle. */
            }
            return { attachedAny: false };
          }
          watcher.on('error', (error) => {
            if (settled) return;
            const current = watchers.get(key);
            if (current && current.watcher === watcher) {
              watchers.delete(key);
            }
            erroredKeys.add(key);
            try {
              watcher.close();
            } catch {
              /* Ignore close errors on errored watchers. */
            }
            degraded = true;
            try {
              options.onWatchError?.(target.dir, error);
            } catch {
              /* Ignore diagnostic hook errors. */
            }
            // Never reattach or check synchronously here (prevents async error-loop storms).
            armFallbackTimer(false);
          });
          watchers.set(key, { dir: target.dir, recursive: Boolean(target.recursive), watcher, filter: target.filter });
          attachedAny = true;
        } catch (error) {
          erroredKeys.add(key);
          missingAny = true;
          try {
            options.onWatchError?.(target.dir, error);
          } catch {
            /* Ignore diagnostic hook errors. */
          }
        }
      }

      degraded = missingAny;
      return { attachedAny };
    }

    async function evaluate(reason: FsWaitCheckContext['reason']) {
      if (settled || inFlight) {
        if (!settled && reason === 'event') recheckPending = true;
        return;
      }
      if (coalesceTimer !== undefined) {
        clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
      }

      inFlight = true;
      let runTimeoutNow = false;
      try {
        if (reason === 'fallback') {
          // Recover broken/missing watchers BEFORE checking so events during check are captured.
          erroredKeys.clear();
          reconcile();
          if (settled) return;
        }

        const rem = remainingMs();
        const timedOut = reason === 'timeout' || rem <= 0;
        const effectiveReason = timedOut && reason !== 'initial' ? 'timeout' : reason;

        let step: FsWaitStep<T>;
        try {
          step = await options.check({
            timedOut,
            remainingMs: rem,
            reason: effectiveReason,
          });
          transientErrors = 0;
        } catch (error) {
          if (settled) return;
          if (!timedOut && options.isTransientError?.(error) && transientErrors < MAX_TRANSIENT_RETRIES) {
            transientErrors++;
            step = { done: false, minDelayMs: TRANSIENT_RETRY_MS };
          } else {
            finishReject(error);
            return;
          }
        }

        if (settled) return;

        if (step.done) {
          finishResolve(step.value);
          return;
        }

        if (timedOut) {
          finishReject(new Error('waitUntilFs check returned done:false on timeout'));
          return;
        }

        if (remainingMs() <= 0) {
          runTimeoutNow = true;
          return;
        }

        if (typeof options.targets === 'function') {
          const { attachedAny } = reconcile();
          if (settled) return;
          if (attachedAny) recheckPending = true;
        }

        armFallbackTimer(true);

        const minDelay = step.minDelayMs !== undefined ? Math.max(0, step.minDelayMs) : undefined;
        if (minDelay !== undefined || recheckPending) {
          const wasPending = recheckPending;
          recheckPending = false;
          const nextDelay = minDelay !== undefined ? minDelay : wasPending ? coalesceMs : 0;
          scheduleCoalesce(nextDelay, 'event');
        }
      } catch (error) {
        finishReject(error);
      } finally {
        inFlight = false;
      }

      if (runTimeoutNow && !settled) {
        void evaluate('timeout');
      }
    }

    async function start() {
      inFlight = true;
      let runTimeoutNow = false;
      let runCatchupNow = false;
      let delayedCatchupMs: number | undefined;
      try {
        const initialTimedOut = budgetMs <= 0;
        let step: FsWaitStep<T>;
        try {
          step = await options.check({
            timedOut: initialTimedOut,
            remainingMs: remainingMs(),
            reason: 'initial',
          });
          transientErrors = 0;
        } catch (error) {
          if (settled) return;
          if (!initialTimedOut && options.isTransientError?.(error) && transientErrors < MAX_TRANSIENT_RETRIES) {
            transientErrors++;
            step = { done: false, minDelayMs: TRANSIENT_RETRY_MS };
          } else {
            finishReject(error);
            return;
          }
        }

        if (settled) return;

        if (step.done) {
          finishResolve(step.value);
          return;
        }

        if (initialTimedOut) {
          finishReject(new Error('waitUntilFs check returned done:false on timeout'));
          return;
        }

        if (remainingMs() <= 0) {
          runTimeoutNow = true;
          return;
        }

        reconcile();
        if (settled) return;
        armDeadlineTimer();
        if (settled) return;

        if (step.minDelayMs !== undefined) {
          armFallbackTimer(true);
          delayedCatchupMs = Math.max(0, step.minDelayMs);
        } else {
          runCatchupNow = true;
        }
      } catch (error) {
        finishReject(error);
      } finally {
        inFlight = false;
      }

      if (settled) return;
      if (runTimeoutNow) {
        void evaluate('timeout');
      } else if (delayedCatchupMs !== undefined) {
        scheduleCoalesce(delayedCatchupMs, 'catchup');
      } else if (runCatchupNow) {
        void evaluate('catchup');
      }
    }

    void start();
  });
}
