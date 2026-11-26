/**
 * Thumbnails of tab workers' screens for the Execution page, read from herdr outside paint. One round at a time, at most one
 * per interval, a bounded batch per round, and nothing at all while stopped.
 */
import { request as herdrRequest, type HerdrReply } from '../runtime/herdr-socket.js';

export const SCREEN_INTERVAL_MS = 2000;
export const SCREEN_BATCH = 8;
export const SCREEN_ROWS = 6;
const TIMEOUT_MS = 1000;
const MAX_LINE = 512;

/** A job's own pane, with what proves the pane is still that job's: the launch identity of a direct launch, else its tab. */
export interface ScreenTarget { jobId: string; pane: string; launchId?: string; terminalId?: string; tab?: string }
export type ExecutionScreen =
  | { readonly state: 'ok'; readonly lines: readonly string[] }
  /** The pane is gone, or now belongs to someone else. */
  | { readonly state: 'closed' }
  | { readonly state: 'unavailable' };

/** Blank lines and bare rules (box drawing, dashes) say nothing in six rows. */
const RULE = /^[\s─-▟|_=-]*$/;
export const thumbnailLines = (screen: string): string[] => screen.split('\n')
  .map((line) => line.replace(/\r$/, '').replace(/\t/g, '    ').trimEnd())
  .filter((line) => !RULE.test(line))
  .slice(-SCREEN_ROWS)
  .map((line) => line.slice(0, MAX_LINE));

export async function readScreen(target: ScreenTarget, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ExecutionScreen> {
  const ask = (method: string, params: Record<string, unknown>): Promise<HerdrReply | null> =>
    herdrRequest(method, params, { env, signal, timeoutMs: TIMEOUT_MS });
  const read = await ask('pane.read', { pane_id: target.pane, source: 'visible', format: 'text', strip_ansi: true });
  if (read?.error?.code === 'pane_not_found') return { state: 'closed' };
  const screen = read?.result?.read?.text;
  if (typeof screen !== 'string') return { state: 'unavailable' };
  // The reply names only the public pane ID, which herdr can reuse: check whose it is after reading it.
  const got = await ask('pane.get', { pane_id: target.pane });
  if (got?.error?.code === 'pane_not_found') return { state: 'closed' };
  const pane = got?.result?.pane;
  if (!pane) return { state: 'unavailable' };
  const own = target.launchId ? pane.launch_id === target.launchId && pane.terminal_id === target.terminalId : pane.tab_id === target.tab;
  return own ? { state: 'ok', lines: thumbnailLines(screen) } : { state: 'closed' };
}

export class ScreenSampler {
  private targets: readonly ScreenTarget[] = [];
  private readonly screens = new Map<string, ExecutionScreen>();
  private timer?: ReturnType<typeof setTimeout>;
  private round?: AbortController;
  private running = false;
  private startedAt = -Infinity;
  private next = 0;

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly changed: () => void,
    private readonly intervalMs = SCREEN_INTERVAL_MS) {}

  current(): ReadonlyMap<string, ExecutionScreen> { return this.screens; }

  /** Replace what is watched; the next round picks it up. */
  watch(targets: readonly ScreenTarget[]): void {
    this.targets = targets;
    const kept = new Set(targets.map((target) => target.jobId));
    for (const id of this.screens.keys()) if (!kept.has(id)) this.screens.delete(id);
    this.schedule();
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  /** Cancels the round in flight. What was read is dropped: an old screen must not return as a live one. */
  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.round?.abort();
    this.round = undefined;
    this.screens.clear();
  }

  private schedule(): void {
    if (!this.running || this.timer || this.round || !this.targets.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sample();
    }, Math.max(0, this.startedAt + this.intervalMs - performance.now()));
    this.timer.unref();
  }

  private async sample(): Promise<void> {
    if (!this.targets.length) return;
    const round = this.round = new AbortController();
    this.startedAt = performance.now();
    // More workers than one batch take turns.
    const from = this.targets.length > SCREEN_BATCH ? this.next % this.targets.length : 0;
    const batch = [...this.targets.slice(from), ...this.targets.slice(0, from)].slice(0, SCREEN_BATCH);
    this.next = from + batch.length;
    const read = await Promise.all(batch.map(async (target) =>
      [target, await readScreen(target, this.env, round.signal).catch((): ExecutionScreen => ({ state: 'unavailable' }))] as const));
    if (this.round !== round) return;
    this.round = undefined;
    let changed = false;
    for (const [target, screen] of read) {
      // A job whose pane changed during the round waits for the next one.
      if (!this.targets.some((t) => t.jobId === target.jobId && t.pane === target.pane && t.launchId === target.launchId)) continue;
      if (JSON.stringify(this.screens.get(target.jobId)) === JSON.stringify(screen)) continue;
      this.screens.set(target.jobId, screen);
      changed = true;
    }
    // One repaint for the whole round, and none when nothing moved.
    if (changed) this.changed();
    this.schedule();
  }
}
