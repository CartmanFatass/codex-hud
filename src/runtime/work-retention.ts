/** On-demand cleanup of raw job logs, land flows and explicitly configured project scratch. */
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { projectRegistryRoots } from '../roles/projects.js';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { DEFAULT_RESUME_S } from '../mcp/worker-resume.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const JOB_RETENTION_MS = DAY_MS;
const CONFIG_LIMIT = 256 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hasParentStep = (path: string) => path.split(sep).includes('..');

// The watcher runs on Linux/WSL. Pin each parent by fd before opening the next
// component, so a path swapped for a symlink between inspection and removal
// cannot redirect the walk. Never pass an unverified path to a recursive rm.
function inDirectory<T>(path: string, use: (dir: string, fd: number) => T): T {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { return use(`/proc/self/fd/${fd}`, fd); }
  finally { fs.closeSync(fd); }
}

function descend<T>(dir: string, parts: string[], use: (dir: string, fd: number) => T): T {
  return inDirectory(join(dir, parts[0]!), (child, fd) =>
    parts.length === 1 ? use(child, fd) : descend(child, parts.slice(1), use));
}

function inAbsoluteDir<T>(path: string, use: (dir: string, fd: number) => T): T {
  const parts = path.split(sep).filter(Boolean);
  return inDirectory(sep, (dir, fd) => parts.length ? descend(dir, parts, use) : use(dir, fd));
}

export function pruneJobLogs(dir: string, job: Job, status: Partial<JobStatus>, now: number): void {
  if (status.state !== 'done' && (status.state !== 'closed' || status.output_written === false)) return;
  // Headless and legacy jobs have no native resume receipt. Give their logs the default window.
  const seconds = job.resume_s ?? DEFAULT_RESUME_S;
  const ended = Date.parse(status.ended_at ?? status.settled_at ?? '');
  if (!Number.isFinite(ended) || !Number.isFinite(seconds) || seconds < 0 || now < ended + seconds * 1000) return;
  try {
    inAbsoluteDir(dir, (jobDir) => {
      const stat = (name: string) => fs.lstatSync(join(jobDir, name), { throwIfNoEntry: false });
      if (stat(jobFiles.stopRequested) || (status.state === 'closed' && !stat(jobFiles.report)?.isFile())) return;
      for (const name of [jobFiles.sonicStdout, jobFiles.sonicStderr]) {
        try { if (stat(name)?.isFile()) fs.unlinkSync(join(jobDir, name)); }
        catch { /* Missing or inaccessible log; continue with the other one. */ }
      }
    });
  } catch { /* Missing or redirected job directory; leave it alone. */ }
}

function sameInode(a: fs.Stats, b: fs.Stats | undefined): boolean {
  return a.dev === b?.dev && a.ino === b.ino;
}

// Resume/retry can reactivate even a completed batch. Recheck expiration under its state lock.
async function pruneExpiredWorkflow(home: string, id: string, cutoff: number) {
  const release = await tryAbstractLock('flow-state', `${home}\0${id}`);
  if (!release) return;
  try {
    inAbsoluteDir(join(home, 'flows'), dir => {
      const receipt = join(dir, `${id}.json`), stat = fs.lstatSync(receipt);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) return;
      const b = readJsonBounded(receipt, stat.size) as { template?: string; state: string; totals?: { running: number } };
      if (id.startsWith('j') ? b.template !== 'council' || !['completed', 'stopped', 'failed'].includes(b.state)
        : !['completed', 'stopped', 'paused'].includes(b.state) || b.totals?.running !== 0) return;
      inDirectory(join(dir, id), batch => {
        const files = fs.readdirSync(batch);
        if (!files.every(f => /^(?:graph|index|manifest)\.json$|^(?:failure-\d+-\d+|(?:end|pause|error)-\d+)\.(?:noticed|observed)$/.test(f) && fs.lstatSync(join(batch, f)).isFile())) return;
        for (const f of files) fs.unlinkSync(join(batch, f));
        fs.rmdirSync(join(dir, id)); fs.unlinkSync(receipt);
      });
    });
  } finally { await release(); }
}

export function pruneLandFlows(home: string, now = Date.now()): void {
  const cutoff = now - JOB_RETENTION_MS;
  try {
    inAbsoluteDir(join(home, 'flows'), (dir) => {
      const jobs = new Map<string, string[]>();
      const names = fs.readdirSync(dir);
      for (const name of names) {
        if (/^[bj][a-f0-9]{16}\.json$/.test(name)) {
          if (fs.lstatSync(join(dir, name)).mtimeMs < cutoff) void pruneExpiredWorkflow(home, name.slice(0, -5), cutoff).catch(() => {});
          continue;
        }
        if (/^q[a-f0-9]{16}\.json$/.test(name)) {
          try {
            const path = join(dir, name), stat = fs.lstatSync(path);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              // Terminal queue IDs are never reused. Remove sidecars with their receipt.
              const receipt = readJsonBounded(path, stat.size) as { state?: unknown } | null;
              if (receipt?.state === 'completed' || receipt?.state === 'failed' || receipt?.state === 'cancelled') {
                fs.unlinkSync(path);
                for (const suffix of ['cancel', 'noticed', 'observed']) fs.rmSync(`${path}.${suffix}`, { force: true });
              }
            }
          } catch { /* Missing or unreadable queue receipt: leave it alone. */ }
          continue;
        }
        const match = /^f([a-f0-9]{16})(?:-[1-9]\d*)?\.json(?:\.(?:cancel|noticed|observed|gate-[1-9]\d*(?:-rerun)?\.log))?$/.exec(name);
        if (!match) continue;
        const job = `j${match[1]}`, files = jobs.get(job);
        if (files) files.push(name); else jobs.set(job, [name]);
      }
      for (const [job, names] of jobs) {
        try {
          // Keep all attempts until the job (and its archive read) is gone.
          if (fs.lstatSync(join(home, 'jobs', job), { throwIfNoEntry: false })) continue;
          const files = names.map((name) => ({ path: join(dir, name), stat: fs.lstatSync(join(dir, name)) }));
          if (files.some(({ stat }) => !stat.isFile() || stat.mtimeMs >= cutoff)) continue;
          if (files.some(({ path }) => {
            if (!path.endsWith('.json')) return false;
            const receipt = readJsonBounded(path, 128 * 1024) as { state?: unknown } | null;
            return receipt?.state !== 'completed' && receipt?.state !== 'failed' && receipt?.state !== 'cancelled';
          })) continue;
          for (const { path, stat } of files) {
            try {
              const current = fs.lstatSync(path, { throwIfNoEntry: false });
              if (sameInode(stat, current) && current?.ctimeMs === stat.ctimeMs) fs.unlinkSync(path);
            } catch { /* Missing, replaced or inaccessible artifact; retry next pass. */ }
          }
        } catch { /* Unreadable receipt or job state: keep this flow family. */ }
      }
    });
  } catch { /* Missing, unreadable or redirected flows directory. */ }
}

function oldEntry(path: string, cutoff: number, device: number, remove: boolean): boolean {
  const stat = fs.lstatSync(path);
  if (stat.dev !== device) return false;
  if (stat.isDirectory()) {
    const old = inDirectory(path, (dir, fd) => {
      if (!sameInode(stat, fs.fstatSync(fd))) return false;
      const names = fs.readdirSync(dir);
      // For an empty entry, use the directory timestamp; otherwise only its contents matter.
      return names.length ? names.every((name) => oldEntry(join(dir, name), cutoff, device, remove))
        : stat.mtimeMs < cutoff;
    });
    if (!old || !sameInode(stat, fs.lstatSync(path, { throwIfNoEntry: false }))) return false;
    if (remove) fs.rmdirSync(path);
    return true;
  }
  if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.mtimeMs >= cutoff) return false;
  if (remove) fs.unlinkSync(path); // Links are leaves; the target never participates in age or removal.
  return true;
}

export function pruneProjectScratch(home: string, now = Date.now()): number | null {
  try {
    return inAbsoluteDir(home, (hud) => {
      const stamp = join(hud, 'scratch-pruned');
      try {
        const last = readJsonBounded(stamp, 64);
        if (typeof last !== 'number' || now - last < HOUR_MS) return null;
      } catch (error) { if (!missing(error)) return null; }
      const registered = projectRegistryRoots(readJsonBounded(join(hud, 'projects.json'), CONFIG_LIMIT));
      const roots = new Set(registered.filter((root) => isAbsolute(root) && !hasParentStep(root)).map((root) => resolve(root)));
      let count = 0, attempted = false;
      for (const root of roots) {
        try {
          inAbsoluteDir(root, (project, fd) => {
            const config = inDirectory(join(project, '.hud'), (dir) =>
              readJsonBounded(join(dir, 'project.json'), CONFIG_LIMIT)) as { scratch?: { paths?: unknown; keep_days?: unknown } } | null;
            const { paths, keep_days: days = 7 } = config?.scratch ?? {};
            if (!Array.isArray(paths) || !paths.length || typeof days !== 'number' || !Number.isFinite(days) || days < 0) return;
            if (!attempted) {
              // Record the attempt before deletion, including across watcher restarts or reloads.
              writePrivateFile(stamp, String(now), { mkdir: false });
              attempted = true;
            }
            const cutoff = now - days * DAY_MS, device = fs.fstatSync(fd).dev;
            for (const path of paths) {
              if (typeof path !== 'string' || !path || hasParentStep(path)) continue;
              const local = relative(root, resolve(root, path));
              if (!local || local === '..' || local.startsWith(`..${sep}`)) continue;
              try {
                descend(project, local.split(sep), (dir, childFd) => {
                  if (fs.fstatSync(childFd).dev !== device) return;
                  for (const name of fs.readdirSync(dir)) {
                    try {
                      const entry = join(dir, name);
                      if (oldEntry(entry, cutoff, device, false) && oldEntry(entry, cutoff, device, true)) count++;
                    } catch { /* Replaced or inaccessible entry; continue with siblings. */ }
                  }
                });
              } catch { /* Missing, inaccessible or symlinked scratch path. */ }
            }
          });
        } catch { /* Missing, unreadable or symlinked project/config; continue with other roots. */ }
      }
      return attempted ? count : null;
    });
  } catch { return null; }
}
