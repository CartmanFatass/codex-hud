import { performance } from 'node:perf_hooks';
import { watch, lstatSync, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WaitPage } from '../types/lifecycle.js';

export interface WaitSubscription {
  close(): void;
  readonly unavailable: boolean;
}
export type SubscribeWait = (runId: string, hint: () => void) => WaitSubscription;
export type WaitResult<T extends WaitPage> = T & { watchUnavailable: boolean };
interface SharedHints {
  watcher?: FSWatcher;
  unavailable: boolean;
  identity?: { dev: number; ino: number };
  listeners: Map<string, Set<() => void>>;
  lastSeq: Map<string, number>;
  pending: Set<string>;
  immediate?: NodeJS.Immediate;
}
const hintHomes = new Map<string, SharedHints>();
/** One watcher/home, with run filtering and coalesced duplicate sequence hints. */
export function hintSubscription(
  home: string,
  openWatch: (directory: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher = (
    directory,
    listener
  ) => watch(directory, listener)
): SubscribeWait {
  const directory = join(resolve(home), 'hints');
  return (runId, hint) => {
    let shared = hintHomes.get(directory);
    if (!shared) {
      shared = { unavailable: false, listeners: new Map(), lastSeq: new Map(), pending: new Set() };
      hintHomes.set(directory, shared);
    }
    const state = shared;
    const schedule = (runs: Iterable<string>) => {
      for (const run of runs) state.pending.add(run);
      state.immediate ??= setImmediate(() => {
        state.immediate = undefined;
        const pending = [...state.pending];
        state.pending.clear();
        for (const run of pending) for (const callback of state.listeners.get(run) ?? []) callback();
      });
    };
    const unavailable = () => {
      state.unavailable = true;
      state.watcher?.close();
      state.watcher = undefined;
      schedule(state.listeners.keys());
    };
    const sameDirectory = () => {
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.dev !== state.identity?.dev || stat.ino !== state.identity?.ino) {
          unavailable();
          return false;
        }
        return true;
      } catch {
        unavailable();
        return false;
      }
    };
    if (!state.watcher) {
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory()) throw new Error('hint_directory_unavailable');
        state.identity = { dev: stat.dev, ino: stat.ino };
        state.watcher = openWatch(directory, (_kind, filename) => {
          if (!sameDirectory()) return;
          const name = filename?.toString();
          if (name == null) {
            schedule(state.listeners.keys());
            return;
          }
          const split = name.lastIndexOf('.');
          const run = name.slice(0, split),
            seq = Number(name.slice(split + 1));
          if (
            split < 1 ||
            !/^\d+$/.test(name.slice(split + 1)) ||
            !Number.isSafeInteger(seq) ||
            !state.listeners.has(run)
          )
            return;
          if (seq <= (state.lastSeq.get(run) ?? -1)) return;
          state.lastSeq.set(run, seq);
          schedule([run]);
        });
        state.watcher.on('error', unavailable);
        state.unavailable = false;
      } catch {
        state.unavailable = true;
      }
    }
    const listeners = state.listeners.get(runId) ?? new Set();
    listeners.add(hint);
    state.listeners.set(runId, listeners);
    let closed = false;
    return {
      get unavailable() {
        if (state.watcher) sameDirectory();
        return state.unavailable;
      },
      close() {
        if (closed) return;
        closed = true;
        listeners.delete(hint);
        if (listeners.size === 0) {
          state.listeners.delete(runId);
          state.lastSeq.delete(runId);
          state.pending.delete(runId);
        }
        if (state.listeners.size === 0) {
          state.watcher?.close();
          if (state.immediate) clearImmediate(state.immediate);
          hintHomes.delete(directory);
        }
      },
    };
  };
}
/**
 * Shared by MCP and B11's CLI: snapshot -> subscribe -> fresh snapshot -> hint/deadline.
 * read() owns only a short transaction; the core owns no writer, polling loop or cursor.
 * Pages with hasMore return immediately; callers drain with nextSeq and captured asOfSeq.
 */
export async function waitForRun<T extends WaitPage>(options: {
  read: (runId?: string) => Promise<T>;
  subscribe: SubscribeWait;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<WaitResult<T>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 120000)
    throw new Error('invalid_wait_timeout');
  const deadline = performance.now() + options.timeoutMs;
  const check = () => options.signal?.throwIfAborted();
  check();
  let page = await options.read();
  check();
  if (page.matched || page.hasMore || options.timeoutMs === 0)
    return { ...page, timedOut: !page.matched && options.timeoutMs === 0, watchUnavailable: false };
  let generation = 0;
  let wake: (() => void) | undefined;
  const subscription = options.subscribe(page.runId, () => {
    generation++;
    wake?.();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    for (;;) {
      const before = generation;
      check();
      // The second snapshot closes the read/registration race; fixed run never changes.
      page = await options.read(page.runId);
      check();
      const remaining = deadline - performance.now();
      if (page.matched || page.hasMore || remaining <= 0)
        return { ...page, timedOut: !page.matched && remaining <= 0, watchUnavailable: subscription.unavailable };
      if (generation !== before) continue;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort!);
          wake = undefined;
          resolve();
        };
        abort = () => {
          clearTimeout(timer);
          wake = undefined;
          reject(options.signal?.reason ?? new Error('request_cancelled'));
        };
        wake = done;
        timer = setTimeout(done, Math.max(0, remaining));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        else if (generation !== before) done();
      });
    }
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    wake = undefined;
    subscription.close();
  }
}

/** B11/B19 drain every page through ONE captured high-water without consuming later commits. */
export async function* drainWaitPages<T extends WaitPage>(
  read: (afterSeq: number, throughSeq?: number) => Promise<T>,
  afterSeq: number
): AsyncGenerator<T & { throughSeq: number }> {
  let throughSeq: number | undefined;
  let runId: string | undefined;
  for (;;) {
    const page = await read(afterSeq, throughSeq);
    throughSeq ??= page.asOfSeq;
    runId ??= page.runId;
    if (
      page.runId !== runId ||
      page.asOfSeq < throughSeq ||
      page.events.some((event) => event.seq > throughSeq!) ||
      (page.hasMore && page.nextSeq <= afterSeq)
    )
      throw new Error('invalid_event_cursor');
    yield { ...page, throughSeq };
    if (!page.hasMore) return;
    afterSeq = page.nextSeq;
  }
}
