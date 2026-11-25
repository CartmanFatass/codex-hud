import * as fs from 'node:fs';
import { join } from 'node:path';
import { notify, watching } from '../roles/notify.js';
import { waitUntilFs, type WatchTarget } from '../utils/fs-wait.js';
import { procStat } from '../utils/proc.js';
import { advance, pauseRun, type Run, type Tick } from './engine.js';
import type { Graph, Step } from './graph.js';
import { directRecipient, type RunScope } from './scope.js';
import { driverLock, noticeEvents, runLock } from './store.js';

type Plan = Pick<Graph, 'steps' | 'policy'>;
export interface DriverProfile<S> {
  read(): S;
  header(state: S): Run & RunScope & { pid?: number; start?: string };
  save(state: S): void;
  open(state: S): Plan; // recover staged effects before the first tick
  tick(state: S, id: string, step: Step, plan: Plan): Tick;
  watches(state: S): WatchTarget[];
  active(state: S): boolean;
  errorLine(run: Run): string;
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
        const { run, active, effect } = await locked(s => {
          const run = profile.header(s), turn = advance(graph, run, (key, step) => profile.tick(s, key, step, graph));
          if (turn.changed) profile.save(s);
          watches = profile.watches(s);
          return { run, active: profile.active(s), effect: turn.effect };
        });
        // If the original main exited, leave the outbox unclaimed for the next project
        // reader. Its PID/pane never determine whether this or any subsequent step runs.
        if (Object.keys(run.notices).length && directRecipient(run) && !watching(run.pane, home)) for (const { line, marker } of noticeEvents(home, run)) {
          try {
            const sent = await notify(run.pane, line, home);
            if (!sent.skipped && sent.status === 0) continue;
          } catch { /* The watcher/MCP can still deliver this notice. */ }
          fs.rmSync(marker, { force: true });
        }
        if (effect) return { done: false, recheckMs: await effect() };
        return active ? { done: false } : { done: true, value: undefined };
      },
    });
  } catch (error) {
    await locked(s => {
      const run = profile.header(s);
      if (run.state === 'stopped' || run.state === 'completed') return;
      const step = Object.entries(run.steps ?? {}).find(([, c]) => c.state === 'running')?.[0] ?? 'run';
      pauseRun(run, step, String(error).slice(0, 300));
      run.notices[`error-${run.epoch}`] = profile.errorLine(run); profile.save(s);
    });
  } finally { await release(); }
}
