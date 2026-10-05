/**
 * Where a tick's time goes, when someone asks.
 *
 * `CODEX_HUD_PROFILE=1` times the stages of both processes' ticks (session
 * find, rollout parse, tree build, status build, git, render, write) and every
 * ~10 s appends one line per stage that ran (count, average, p95, max) to
 * `<CODEX_HOME>/hud/profile.log`. Never to stdout, which is the display, nor to
 * stderr, which lands in the same pane.
 *
 * Off, `time` and `timeAsync` are a null check and a call: no clock read, no
 * sample, no timer, no file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHudHome } from './codex-path.js';

export const PROFILE_FLUSH_MS = 10_000;
/** Samples kept per stage per window, for the p95; count, sum and max stay exact past it. */
const SAMPLE_LIMIT = 4096;
/** Past this the log starts over, keeping one previous file. A profile run is a session, not an archive. */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;

export interface StageSummary {
  count: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

interface StageWindow {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
}

/** Nearest-rank percentile of samples sorted ascending. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarizeStage(window: StageWindow): StageSummary {
  const sorted = [...window.samples].sort((a, b) => a - b);
  return {
    count: window.count,
    avgMs: window.count ? window.totalMs / window.count : 0,
    p95Ms: percentile(sorted, 95),
    maxMs: window.maxMs,
  };
}

const ms = (value: number): string => `${value < 10 ? value.toFixed(2) : value.toFixed(1)}ms`;

export function formatProfileLine(at: Date, role: string, pid: number, stage: string, summary: StageSummary): string {
  return `${at.toISOString()} ${role} pid=${pid} ${stage} n=${summary.count} avg=${ms(summary.avgMs)} p95=${ms(summary.p95Ms)} max=${ms(summary.maxMs)}`;
}

/**
 * The in-memory half: samples per stage for the current window, turned into
 * lines and cleared on `flush`. The clock and the destination are injected,
 * so the summary is testable without a timer or a file.
 */
export class ProfileRecorder {
  private stages = new Map<string, StageWindow>();

  constructor(
    private readonly role: string,
    private readonly sink: (lines: string[]) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly pid: number = process.pid
  ) {}

  record(stage: string, elapsedMs: number): void {
    let window = this.stages.get(stage);
    if (!window) {
      window = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
      this.stages.set(stage, window);
    }
    window.count++;
    window.totalMs += elapsedMs;
    if (elapsedMs > window.maxMs) window.maxMs = elapsedMs;
    if (window.samples.length < SAMPLE_LIMIT) window.samples.push(elapsedMs);
  }

  /** One line per stage that ran since the last flush, in stage-name order. */
  flush(): string[] {
    if (!this.stages.size) return [];
    const at = this.now();
    const lines = [...this.stages.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stage, window]) => formatProfileLine(at, this.role, this.pid, stage, summarizeStage(window)));
    this.stages = new Map();
    try {
      this.sink(lines);
    } catch {
      // A log nobody can write is not a reason to disturb the HUD.
    }
    return lines;
  }
}

let recorder: ProfileRecorder | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function profileLogPath(): string {
  return path.join(getHudHome(), 'profile.log');
}

function appendToLog(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.old`);
  } catch {
    // No log yet.
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

/**
 * Turn profiling on for this process when CODEX_HUD_PROFILE=1. `role` names
 * the process in the log (`bar`, `panel`); both append to the same file.
 */
export function startProfiling(role: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODEX_HUD_PROFILE !== '1' || recorder) return recorder !== null;
  let file: string;
  try {
    file = profileLogPath();
  } catch {
    return false;
  }
  recorder = new ProfileRecorder(role, (lines) => appendToLog(file, lines));
  flushTimer = setInterval(() => recorder?.flush(), PROFILE_FLUSH_MS);
  // The flush must never be what keeps a closing HUD alive.
  flushTimer.unref();
  return true;
}

/** Write what the current window holds; for shutdown. */
export function stopProfiling(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  recorder?.flush();
  recorder = null;
}

/** For tests and measurements: send samples to a recorder of the caller's. */
export function useProfileRecorder(next: ProfileRecorder | null): void {
  recorder = next;
}

export function time<T>(stage: string, fn: () => T): T {
  if (!recorder) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    recorder?.record(stage, performance.now() - started);
  }
}

export async function timeAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  if (!recorder) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    recorder?.record(stage, performance.now() - started);
  }
}
