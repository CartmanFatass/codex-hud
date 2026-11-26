/** Share jobs/ file events without making lifecycle or notification consumers own each other's state. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { watcherReady } from '../mcp/watch-pid.js';
import { binScript } from '../mcp/paths.js';
import { JOB_ID_RE } from '../roles/job-index-cache.js';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { RUNNER_READY } from '../utils/runner-lifetime.js';

const REVISION = 'jobs-revision.json';
const WATCH_PID = 'watch.pid';
const RECHECK_MS = 30_000;
export const jobNoticeFile = (path: string) =>
  !path.endsWith('.tmp') && !path.endsWith('supervisor.pid') && !path.endsWith(`/${RUNNER_READY}`) && !path.endsWith('/stdout.jsonl') && !path.endsWith('/stderr.log') &&
  !path.endsWith('/sonic-session.jsonl') && !path.endsWith('/report-meta.json') && !path.includes('/sessions/');

type Revision = { owner: number; epoch: number; notice: number; change: number; through: number; jobs: Record<string, number> };
const MAX_DELTA = 64;
const jobId = (path: string) => {
  const id = path.split(/[\\/]/, 1)[0];
  return JOB_ID_RE.test(id) ? id : undefined;
};

/** Published only while the lifecycle jobs watch is healthy. Atomic replacement wakes directory watchers. */
export function jobChangePublisher(home: string) {
  const file = join(home, REVISION);
  let revision: Revision | undefined, timer: NodeJS.Timeout | undefined;
  const publish = () => {
    timer = undefined;
    if (!revision) return;
    try { writePrivateFile(file, JSON.stringify(revision), { mkdir: false }); }
    catch { stop(); } // An unavailable relay must not prevent standalone consumers watching directly.
  };
  function stop() {
    clearTimeout(timer);
    timer = undefined;
    if (!revision) return;
    revision = undefined;
    try { fs.unlinkSync(file); } catch { /* Best-effort sidecar; consumers also verify the PID. */ }
  }
  return {
    start() {
      if (revision) return;
      revision = { owner: process.pid, epoch: Date.now(), notice: 0, change: 0, through: 0, jobs: {} };
      publish();
    },
    change(path: string) {
      if (!revision || path.endsWith('.tmp')) return;
      revision.change++;
      if (jobNoticeFile(path)) revision.notice++;
      const id = jobId(path);
      if (!id) {
        revision.through = revision.change;
        revision.jobs = {};
      } else {
        delete revision.jobs[id];
        revision.jobs[id] = revision.change;
        const keys = Object.keys(revision.jobs);
        if (keys.length > MAX_DELTA) {
          revision.through = revision.jobs[keys[0]];
          delete revision.jobs[keys[0]];
        }
      }
      timer ??= setTimeout(publish, 25).unref();
    },
    stop,
  };
}

// A null delta asks readers to reconcile (unknown event, source swap or missed history).
type Listener = { changed(notice: boolean, ids: readonly string[] | null): void; persistent: boolean };
const watchers = new Map<string, ReturnType<typeof openChanges>>();
function openChanges(home: string) {
  const listeners = new Set<Listener>();
  let root: fs.FSWatcher | undefined, jobs: fs.FSWatcher | undefined, flows: fs.FSWatcher | undefined;
  let revision: Revision | undefined, lastCheck = -Infinity;
  const emit = (notice: boolean, ids: readonly string[] | null = null) => {
    for (const listener of listeners) listener.changed(notice, ids);
  };
  const ref = () => {
    const method = [...listeners].some((listener) => listener.persistent) ? 'ref' : 'unref';
    root?.[method]();
    jobs?.[method]();
  };
  function attach(force = false) {
    if (!listeners.size || (!force && performance.now() - lastCheck < RECHECK_MS)) return;
    lastCheck = performance.now();
    if (!root) try {
      root = fs.watch(home, { persistent: false }, (_event, name) => {
        const file = name?.toString();
        if (file === 'tries.jsonl') { emit(false, []); return; }
        if (file && file !== 'jobs' && file !== 'flows' && file !== REVISION && file !== WATCH_PID) return;
        if (!file || file === 'jobs') { jobs?.close(); jobs = undefined; }
        if (!file || file === 'flows') { flows?.close(); flows = undefined; }
        attach(true);
        if (!file || file === 'jobs') emit(true);
        else if (file === 'flows') emit(false, []);
      }).on('error', () => { root?.close(); root = undefined; });
    } catch { /* May not exist on a fresh HUD_HOME. */ }
    if (!flows) try {
      flows = fs.watch(join(home, 'flows'), { persistent: false }, (_event, name) => {
        if (!name || name.endsWith('.json')) emit(false, []);
      }).on('error', () => { flows?.close(); flows = undefined; emit(false, []); });
    } catch { /* No flows yet. */ }
    let next: Revision | undefined;
    try {
      const row = readJsonBounded(join(home, REVISION), 4096) as Revision;
      if (row && Number.isSafeInteger(row.owner) && Number.isSafeInteger(row.epoch) && Number.isSafeInteger(row.notice) &&
          Number.isSafeInteger(row.change) && Number.isSafeInteger(row.through) && row.jobs && typeof row.jobs === 'object' &&
          Number(fs.readFileSync(join(home, WATCH_PID), 'utf8').trim()) === row.owner &&
          watcherReady(join(home, WATCH_PID), binScript('hud-watch'))) next = row;
    } catch { /* Missing or unavailable relay: keep a direct watch. */ }
    const prior = revision;
    revision = next;
    if (next) {
      jobs?.close();
      jobs = undefined;
    } else if (!jobs) try {
      jobs = fs.watch(join(home, 'jobs'), { recursive: true, persistent: false }, (_event, name) => {
        const file = name?.toString() ?? '';
        const id = jobId(file);
        if (!file.endsWith('.tmp')) emit(jobNoticeFile(file), id ? [id] : null);
      }).on('error', () => { jobs?.close(); jobs = undefined; emit(true); });
    } catch { /* The next attach retries. */ }
    ref();
    if (prior?.owner !== next?.owner || prior?.epoch !== next?.epoch || (prior && next && prior.change > next.change)) emit(true);
    else if (prior && next && prior.change !== next.change) {
      const ids = prior.change < next.through ? null : Object.entries(next.jobs)
        .filter(([id, at]) => JOB_ID_RE.test(id) && at > prior.change).map(([id]) => id);
      emit(prior.notice !== next.notice, ids);
    }
  }
  return { listeners, attach, ref, close() { root?.close(); jobs?.close(); flows?.close(); } };
}

/** One subscription source per HUD_HOME per process; a standalone process keeps its own fallback watch. */
export function watchJobChanges(home: string, changed: Listener['changed'], persistent = false) {
  home = resolve(home);
  let shared = watchers.get(home);
  if (!shared) watchers.set(home, (shared = openChanges(home)));
  const source = shared;
  const listener = { changed, persistent };
  source.listeners.add(listener);
  return {
    attach() { source.attach(); source.ref(); },
    close() {
      if (!source.listeners.delete(listener)) return;
      if (source.listeners.size) source.ref();
      else { source.close(); watchers.delete(home); }
    },
  };
}
