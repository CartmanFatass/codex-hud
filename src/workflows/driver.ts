import { join } from 'node:path';
import { notify } from '../roles/notify.js';
import { noticeResolver } from '../roles/select-send.js';
import { beginNotice, isDeliveryClaimable, settleNotice } from '../utils/delivery-record.js';
import { waitUntilFs, type WatchTarget } from '../utils/fs-wait.js';
import { procStat } from '../utils/proc.js';
import { advance, pauseRun, type Run, type Tick } from './engine.js';
import type { Graph, Step } from './graph.js';
import type { RunScope } from './scope.js';
import { currentNoticeKey, driverLock, noticeEvents, runDir, runLock } from './store.js';

type Plan = Pick<Graph, 'steps' | 'policy'>;
export interface DriverProfile<S> {
  read(): S;
  header(state: S): Run & RunScope & { pid?: number; start?: string };
  save(state: S): void;
  open(state: S): Plan; // recover staged effects before the first tick
  tick(state: S, id: string, step: Step, plan: Plan): Tick;
  watches(state: S): WatchTarget[];
  active(state: S): boolean;
  retiring?: AbortSignal; // Yield before the next turn; let an admitted effect finish first.
  errorLine(run: Run): string;
  // Some compatibility transports only claim notices in a watcher/MCP scan.
  readerNotices?: boolean;
  propagateSkips?: boolean;
  onEnd?(state: S): void;
  onError?(state: S, error: unknown): void;
}
/** One short-lived elected driver per run. Only the profile knows its output projection,
 * effect receipts and wording; election, scheduling, commit-before-effect and delivery are shared. */
export async function driveWorkflow<S>(home: string, id: string, profile: DriverProfile<S>) {
  const release = await driverLock(home, id);
  if (!release) return;
  const locked = <T>(f: (s: S) => T) => runLock(home, id, () => f(profile.read()));
  try {
    const graph = await locked(s => {
      const plan = profile.open(s), run = profile.header(s);
      run.pid = process.pid; run.start = procStat(process.pid)?.start; profile.save(s);
      return plan;
    });
    let watches: WatchTarget[] = [];
    await waitUntilFs({ timeoutMs: Infinity,
      targets: () => [{ dir: join(home, 'flows'), filter: f => !f || f === `${id}.json` }, ...watches],
      check: async () => {
        const turn = await locked(s => {
          if (profile.retiring?.aborted) return;
          const run = profile.header(s), turn = advance(graph, run, (key, step) => profile.tick(s, key, step, graph), profile.propagateSkips);
          if (turn.changed) {
            if (run.state === 'completed') profile.onEnd?.(s);
            profile.save(s);
          }
          watches = profile.watches(s);
          return { run, active: profile.active(s), effect: turn.effect, recheckMs: turn.recheckMs };
        });
        if (!turn) return { done: true, value: undefined };
        const { run, active, effect, recheckMs } = turn;
        const hasClaimable = !profile.readerNotices && Object.keys(run.notices).some(key =>
          currentNoticeKey(run, key) && isDeliveryClaimable(join(runDir(home, run.flow), `${key}.noticed`), undefined, run.epoch));
        if (hasClaimable) {
          const resolved = await noticeResolver(home)(run);
          if (resolved.kind === 'pane' && !resolved.watching) {
            for (const event of noticeEvents(home, run)) {
              if (!beginNotice(event)) continue;
              try {
                const sent = await notify(resolved.pane, event.line, home);
                settleNotice(event, sent.outcome, sent.via ?? 'herdr-prompt', sent.detail || sent.error?.message);
              } catch (err) { settleNotice(event, 'indeterminate', 'herdr-prompt', String(err)); }
            }
          }
        }
        if (effect) return { done: false, recheckMs: await effect() };
        return active ? { done: false, ...(recheckMs !== undefined && { recheckMs }) } : { done: true, value: undefined };
      },
    });
  } catch (error) {
    await locked(s => {
      if (profile.onError) return profile.onError(s, error);
      const run = profile.header(s);
      if (run.state === 'stopped' || run.state === 'completed') return;
      const step = Object.entries(run.steps ?? {}).find(([, c]) => c.state === 'running')?.[0] ?? 'run';
      pauseRun(run, step, String(error).slice(0, 300));
      run.notices[`error-${run.epoch}`] = profile.errorLine(run); profile.save(s);
    });
  } finally { await release(); }
}
