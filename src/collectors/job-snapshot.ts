/** Client for the process's background collector. No job tree I/O on the caller's thread. */
import { Worker } from 'node:worker_threads';
import type { ThinJobScope, WatchJobRow } from './thin-jobs.js';
import type { WorkBatch, WorkLane } from './workboard-types.js';
import type { resumedWorkerRefusal } from '../roles/resume-guard.js';
import { herdrId } from '../roles/herdr-run.js';

type LaneView = { kind: 'lanes'; home: string; scope: ThinJobScope; options?: { openedAt?: number; settledBefore?: number | 'now' } };
type View = LaneView | { kind: 'codex'; home: string };
export type Request =
  | { kind: 'read'; view: View; key: number }
  | { kind: 'project'; view: LaneView }
  | { kind: 'close'; key: number }
  | { kind: 'watch'; home: string; key: number }
  | { kind: 'rows'; home: string; pane: string; cwd: string; env: NodeJS.ProcessEnv }
  | { kind: 'resume'; args: Parameters<typeof resumedWorkerRefusal> };
export type Lanes = { lanes: WorkLane[]; complete: boolean; batches?: WorkBatch[] };
type Result = Lanes | string[] | WatchJobRow[] | string | undefined;

let worker: Worker | undefined;
let serial = 0, views = 0;
const pending = new Map<number, { resolve(value: Result): void; reject(error: Error): void }>();
const listeners = new Map<number, () => void>();

function send(request: Request): Promise<Result> {
  if (!worker) {
    const active = new Worker(new URL('./job-snapshot-worker.js', import.meta.url), { execArgv: [] });
    worker = active;
    active.on('message', ({ id, value, error, notice }) => {
      if (notice !== undefined) { listeners.get(notice)?.(); return; }
      const call = pending.get(id);
      pending.delete(id);
      if (!pending.size) active.unref();
      if (error) call?.reject(new Error(error));
      else call?.resolve(value);
    });
    const fail = (error: Error) => {
      if (worker !== active) return;
      worker = undefined;
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      for (const changed of listeners.values()) changed();
    };
    active.on('error', fail);
    active.on('exit', (code) => fail(new Error(`HUD job collector exited (${code})`)));
  }
  const active = worker, id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.ref();
    try { active.postMessage({ id, request }); }
    catch (error) {
      pending.delete(id);
      if (!pending.size) active.unref();
      reject(error);
    }
  });
}
function close(key: number) {
  if (worker) void send({ kind: 'close', key }).catch(() => {});
}
function snapshot<T extends Lanes | string[]>(view: View) {
  const key = ++views;
  let closed = false, current: T | undefined, pendingRead: Promise<T | undefined> | undefined;
  return {
    read() {
      if (closed) return Promise.resolve(undefined);
      return (pendingRead ??= send({ kind: 'read', view, key }).then((value) => {
        if (!closed && value !== undefined) current = value as T;
        return current;
      }).finally(() => { pendingRead = undefined; }));
    },
    close() { if (!closed) { closed = true; current = undefined; close(key); } },
  };
}
export function jobLaneSnapshot(home: string, scope: ThinJobScope, options?: LaneView['options']) {
  // A non-pane caller has no thin lanes and should not even start a collector.
  if (!herdrId(scope.pane)) return { async read(): Promise<Lanes> { return { lanes: [], complete: false }; }, close() {} };
  return snapshot<Lanes>({ kind: 'lanes', home, scope, options });
}
/** A one-shot command never installs a recursive jobs watch of its own. */
export async function collectJobLanes(home: string, scope: ThinJobScope, options?: LaneView['options']): Promise<Lanes | undefined> {
  if (!herdrId(scope.pane)) return;
  return (await send({ kind: 'project', view: { kind: 'lanes', home, scope, options } })) as Lanes;
}
export const codexJobSnapshot = (home: string) => snapshot<string[]>({ kind: 'codex', home });
export const collectSessionJobRows = (home: string, pane: string, cwd: string, env: NodeJS.ProcessEnv) =>
  send({ kind: 'rows', home, pane, cwd, env }) as Promise<WatchJobRow[]>;
export const collectResumeRefusal = (...args: Parameters<typeof resumedWorkerRefusal>) => send({ kind: 'resume', args }) as Promise<string | undefined>;

export function watchJobsInBackground(home: string, changed: () => void) {
  const key = ++views;
  listeners.set(key, changed);
  return {
    attach() { if (listeners.has(key)) void send({ kind: 'watch', home, key }).catch(() => {}); },
    close() { if (listeners.delete(key)) close(key); },
  };
}
