/** On-demand cleanup of raw job logs, land flows and explicitly configured project scratch. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { projectRegistryRoots } from '../roles/projects.js';
import { readJsonBounded, readRegularNoFollow, writePrivateFile } from '../utils/atomic-fs.js';
import type { TarEntry, TarFileEntry, TarInput } from '../utils/tar-zst.js';
import {
  archiveFlowCold,
  archiveJobRawEntries,
  COLD_ID_RE,
  enforceColdRawCap,
  findColdMember,
} from '../roles/cold-archive.js';
import { epoch } from '../roles/job-usage.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { hasPendingFlakeCollection } from '../mcp/land-flakes.js';
import type { LandFlow } from '../mcp/land-state.js';
import { jobFiles } from '../mcp/paths.js';
import { DEFAULT_RESUME_S } from '../mcp/worker-resume.js';
import { isComposedId } from '../workflows/composed-state.js';
import { isNoticeKey } from '../workflows/store.js';
import type { TicketQueue } from '../mcp/ticket-queue-state.js';
import { hasOpenHold, pinnedQueueJobs, readRunIndex } from '../unattended/state.js';

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

function readPinnedRegularEntry(path: string, name: string): TarEntry | null {
  const read = readRegularNoFollow(path);
  return read ? { name, data: read.data, mode: 0o600, mtime: Math.floor(read.stat.mtimeMs / 1000) } : null;
}

function statPinnedRegular(path: string, name: string): { stat: fs.Stats; entry: TarFileEntry } | null {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    return {
      stat,
      entry: {
        name,
        filePath: path,
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        mode: 0o600,
        mtime: Math.floor(stat.mtimeMs / 1000),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function pruneJobLogs(dir: string, job: Job, status: Partial<JobStatus>, now: number, home = dirname(dirname(dir))): 'none' | 'archived' | 'failed' {
  if (status.state !== 'done' && (status.state !== 'closed' || status.output_written === false)) return 'none';
  // Headless and legacy jobs have no native resume receipt. Give their logs the default window.
  const seconds = job.resume_s ?? DEFAULT_RESUME_S;
  const ended = Date.parse(status.ended_at ?? status.settled_at ?? '');
  if (!Number.isFinite(ended) || !Number.isFinite(seconds) || seconds < 0 || now < ended + seconds * 1000) return 'none';
  const id = typeof job.job === 'string' && COLD_ID_RE.test(job.job) ? job.job : basename(dir);
  if (!COLD_ID_RE.test(id)) return 'none';
  try {
    let wrote = false;
    const result = inAbsoluteDir(dir, (jobDir) => {
      const stat = (name: string) => fs.lstatSync(join(jobDir, name), { throwIfNoEntry: false });
      if (stat(jobFiles.stopRequested) || (status.state === 'closed' && !stat(jobFiles.report)?.isFile())) return 'none';
      const targets: { name: string; stat: fs.Stats; entry: TarInput }[] = [];
      for (const name of [jobFiles.sonicStdout, jobFiles.sonicStderr]) {
        const pinned = statPinnedRegular(join(jobDir, name), name);
        if (!pinned) continue;
        targets.push({ name, stat: pinned.stat, entry: pinned.entry });
      }
      if (!targets.length) return 'none';
      // Move-then-delete: a failed archive write keeps the raw logs for the next sweep.
      const res = archiveJobRawEntries(home, id, targets.map((t) => t.entry), ended);
      wrote = res.written;
      let failed = false;
      for (const { name, stat: before } of targets) {
        try {
          const current = stat(name);
          if (current?.isFile() && sameInode(before, current) && current.size === before.size && current.mtimeMs === before.mtimeMs) {
            fs.unlinkSync(join(jobDir, name));
          }
        } catch (error) {
          // A concurrent disappearance is fine; other failures use the watcher's retry gate.
          if (!missing(error)) failed = true;
        }
      }
      return failed ? 'failed' : 'archived';
    });
    if (wrote) {
      try { enforceColdRawCap(home); } catch { /* Best-effort cap trim; retry next raw archive write. */ }
    }
    return result;
  } catch { /* Missing, redirected job directory, or archive write failure; keep source logs. */ return 'failed'; }
}

function sameInode(a: fs.Stats, b: fs.Stats | undefined): boolean {
  return a.dev === b?.dev && a.ino === b.ino;
}

function sameReceipt(path: string, stat: fs.Stats) {
  const current = fs.lstatSync(path, { throwIfNoEntry: false });
  return sameInode(stat, current) && stat.ctimeMs === current?.ctimeMs;
}

function isQueueRunFile(name: string): boolean {
  if (name === 'graph.json') return true;
  const marker = /^(.*?)\.(?:noticed|observed)$/.exec(name);
  return !!marker && isNoticeKey(marker[1]!);
}

function archiveTicketQueue(home: string, path: string, stat: fs.Stats, q: TicketQueue, now: number): boolean {
  const marker = `${path}.archived`;
  let claim: number;
  try { claim = fs.openSync(marker, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = fs.lstatSync(marker, { throwIfNoEntry: false });
    return Boolean(prior?.isFile() && prior.size === 1); // Only a confirmed append permits unlinking.
  }
  let wrote = false;
  try {
    // A concurrent scan may have removed both the receipt and its marker since our read.
    if (!sameReceipt(path, stat)) return false;
    const line = Buffer.from(JSON.stringify({
      v: 1, kind: 'ticket_queue', flow: q.flow, project: q.project_root ?? q.root, feature: q.feature,
      state: q.state, created_at: q.created_at, updated_at: q.updated_at, repair_rounds: q.repair_rounds ?? 0,
      tickets: q.tickets.map(({ ticket, role, job, land, landed, round, repairs }) =>
        ({ ticket, role, job, land, landed, round, ...(repairs?.length && { repairs }) })),
      decisions: (q.decisions ?? []).map(({ step, kind, job, decision, at, ticket, worker_job }) =>
        ({ step, kind, job, decision, at, ticket, worker_job })),
      reviews: (q.reviews ?? []).map(({ round, job, findings, reviewed }) => ({ round, job,
        findings: findings && { blocker: findings.blocker, major: findings.major, minor: findings.minor },
        reviewed: reviewed && { base: reviewed.base, head: reviewed.head },
      })),
    }) + '\n');
    const month = new Date(epoch(q.updated_at) ?? now).toISOString().slice(0, 7);
    return inAbsoluteDir(home, hud => {
      const events = join(hud, 'events');
      fs.mkdirSync(events, { recursive: true, mode: 0o700 });
      return inDirectory(events, dir => {
        const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
        const fd = fs.openSync(join(dir, `${month}.jsonl`), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
        try {
          if (!fs.fstatSync(fd).isFile()) return false;
          fs.fchmodSync(fd, 0o600);
          const written = fs.writeSync(fd, line);
          wrote = written > 0;
          if (written !== line.length) return false;
          return fs.writeSync(claim, '1') === 1;
        } finally { fs.closeSync(fd); }
      });
    });
  } finally {
    try { fs.closeSync(claim); }
    finally {
      // A known no-write failure can retry; an interrupted or partial append must leave the receipt intact.
      if (!wrote) fs.unlinkSync(marker);
    }
  }
}

// Resume/retry can reactivate even a completed batch. Recheck expiration under its state lock.
async function pruneExpiredWorkflow(home: string, id: string, cutoff: number) {
  const release = await tryAbstractLock('flow-state', `${home}\0${id}`);
  if (!release) return;
  try {
    inAbsoluteDir(join(home, 'flows'), dir => {
      const receipt = join(dir, `${id}.json`), stat = fs.lstatSync(receipt);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) return;
      const b = readJsonBounded(receipt, stat.size) as { template?: string; state: string; totals?: { running: number }; updated_at?: string; created_at?: string };
      const composed = isComposedId(id);
      if (composed ? b.template !== 'composed' || !['proposed', 'completed', 'stopped', 'failed'].includes(b.state)
        : id.startsWith('j') ? (b.template !== 'council' && b.template !== 'prewalk') || !['completed', 'stopped', 'failed'].includes(b.state)
        : !['completed', 'stopped', 'paused'].includes(b.state) || b.totals?.running !== 0) return;
      inDirectory(join(dir, id), batch => {
        const files = fs.readdirSync(batch);
        const composedFile = /^(?:[a-z][a-z0-9_-]{0,47}\.(?:index|check)\.json|(?:handback-[a-z][a-z0-9_-]{0,47}|failure-\d+-[a-z][a-z0-9_-]{0,47})\.(?:noticed|observed))$/;
        if (!files.every(f => (/^(?:graph|index|manifest)\.json$|^(?:failure-\d+-\d+|(?:end|pause|error)-\d+)\.(?:noticed|observed)$/.test(f) ||
          (composed && composedFile.test(f))) && fs.lstatSync(join(batch, f)).isFile())) return;
        const prefix = id.startsWith('j') ? 'flows/' : '';
        const entries: TarInput[] = [];
        const receiptPinned = statPinnedRegular(receipt, `${prefix}${id}.json`);
        if (!receiptPinned) return;
        entries.push(receiptPinned.entry);
        for (const f of files) {
          const pinned = statPinnedRegular(join(batch, f), `${prefix}${id}/${f}`);
          if (!pinned) return;
          entries.push(pinned.entry);
        }
        const ts = epoch(b.updated_at) ?? epoch(b.created_at) ?? stat.mtimeMs;
        archiveFlowCold(home, id, entries, ts);
        for (const f of files) fs.unlinkSync(join(batch, f));
        fs.rmdirSync(join(dir, id)); fs.unlinkSync(receipt);
      });
    });
  } finally { await release(); }
}

function pruneOrphanGateLog(home: string, dir: string, name: string, flow: string, job: string, cutoff: number): boolean {
  const receipt = join(dir, `${flow}.json`);
  if (fs.lstatSync(receipt, { throwIfNoEntry: false })) return false;
  const path = join(dir, name), stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.mtimeMs >= cutoff) return true;
  // Land IDs encode the candidate job. Keep merging into it after job expiry if it was archived.
  const owned = fs.lstatSync(join(home, 'jobs', job), { throwIfNoEntry: false })?.isDirectory() ||
    findColdMember(home, job, 'text') || findColdMember(home, job, 'raw');
  const pinned = statPinnedRegular(path, owned ? `flows/${name}` : name);
  if (!pinned || !sameInode(stat, pinned.stat) || stat.ctimeMs !== pinned.stat.ctimeMs) return true;
  archiveFlowCold(home, owned ? job : flow, [pinned.entry], stat.mtimeMs);
  if (!fs.lstatSync(receipt, { throwIfNoEntry: false }) && sameReceipt(path, stat)) fs.unlinkSync(path);
  return true;
}

export function pruneLandFlows(home: string, now = Date.now()): void {
  const cutoff = now - JOB_RETENTION_MS;
  try {
    inAbsoluteDir(join(home, 'flows'), (dir) => {
      const jobs = new Map<string, string[]>();
      const names = fs.readdirSync(dir), unattended = new Set(readRunIndex(home));
      for (const name of names) {
        if (/^[bjw][a-f0-9]{16}\.json$/.test(name)) {
          if (fs.lstatSync(join(dir, name)).mtimeMs < cutoff) void pruneExpiredWorkflow(home, name.slice(0, -5), cutoff).catch(() => {});
          continue;
        }
        if (/^q[a-f0-9]{16}\.json$/.test(name)) {
          try {
            const flowId = name.slice(0, -5);
            const path = join(dir, name), stat = fs.lstatSync(path);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              // Terminal queue IDs are never reused. Archive the full receipt and its facts before cleanup.
              const receipt = readJsonBounded(path, stat.size) as TicketQueue | null;
              if (!unattended.has(flowId) && !hasOpenHold(receipt) && (receipt?.state === 'completed' || receipt?.state === 'failed' ||
                  receipt?.state === 'cancelled' || receipt?.state === 'superseded' || (receipt?.state === 'paused' && 'unattended' in receipt))) {
                const entries: TarInput[] = [];
                const receiptPinned = statPinnedRegular(path, name);
                if (!receiptPinned || !sameInode(stat, receiptPinned.stat) || stat.ctimeMs !== receiptPinned.stat.ctimeMs) continue;
                entries.push(receiptPinned.entry);
                const sidecarSuffixes = ['cancel', 'noticed', 'observed'] as const;
                for (const suffix of sidecarSuffixes) {
                  const pinned = statPinnedRegular(`${path}.${suffix}`, `${name}.${suffix}`);
                  if (pinned) entries.push(pinned.entry);
                }
                const sub = join(dir, flowId), subStat = fs.lstatSync(sub, { throwIfNoEntry: false });
                const subFiles = new Map<string, fs.Stats>();
                // Leave the receipt as a retry anchor unless the whole run directory is collected.
                if (subStat && (!subStat.isDirectory() || !inDirectory(sub, (run, fd) => {
                  if (!sameInode(subStat, fs.fstatSync(fd))) return false;
                  for (const f of fs.readdirSync(run)) {
                    if (!isQueueRunFile(f)) return false;
                    const read = readRegularNoFollow(join(run, f));
                    if (!read) return false;
                    subFiles.set(f, read.stat);
                    entries.push({ name: `${flowId}/${f}`, data: read.data, mode: 0o600, mtime: Math.floor(read.stat.mtimeMs / 1000) });
                  }
                  return true;
                }))) continue;
                const ts = epoch(receipt?.updated_at) ?? epoch(receipt?.created_at) ?? stat.mtimeMs;
                archiveFlowCold(home, flowId, entries, ts);
                if (!archiveTicketQueue(home, path, stat, receipt, now) || !sameReceipt(path, stat)) continue;
                if (subStat) {
                  const cleaned = inDirectory(sub, (run, fd) => {
                    if (!sameInode(subStat, fs.fstatSync(fd))) return false;
                    const files = fs.readdirSync(run);
                    if (files.length !== subFiles.size || !files.every(f => {
                      const prior = subFiles.get(f);
                      return isQueueRunFile(f) && prior && sameReceipt(join(run, f), prior);
                    })) return false;
                    for (const f of files) fs.unlinkSync(join(run, f));
                    return true;
                  });
                  if (!cleaned || !sameInode(subStat, fs.lstatSync(sub, { throwIfNoEntry: false }))) continue;
                  fs.rmdirSync(sub);
                } else if (fs.lstatSync(sub, { throwIfNoEntry: false })) continue;
                if (!sameReceipt(path, stat)) continue;
                fs.unlinkSync(path);
                fs.rmSync(`${path}.archived`, { force: true });
                for (const suffix of sidecarSuffixes) fs.rmSync(`${path}.${suffix}`, { force: true });
              }
            }
          } catch { /* Missing or unreadable queue receipt, or archive failure: leave it alone. */ }
          continue;
        }
        const match = /^(f([a-f0-9]{16})(?:-[1-9]\d*)?)(?:\.json(?:\.(?:cancel|noticed|observed|(gate-[1-9]\d*(?:-rerun)?\.log)))?)?$/.exec(name);
        if (!match) continue;
        const [, flow, hex, gateLog] = match;
        const job = `j${hex}`;
        if (gateLog) {
          try { if (pruneOrphanGateLog(home, dir, name, flow!, job, cutoff)) continue; }
          catch { continue; /* Unreadable log or archive failure: keep the orphan for the next sweep. */ }
        }
        const files = jobs.get(job);
        if (files) files.push(name); else jobs.set(job, [name]);
      }
      const pinned = jobs.size ? pinnedQueueJobs(home) : null;
      for (const [job, names] of jobs) {
        try {
          // Keep all attempts until the job (and its archive read) is gone, or while an open ordinary queue still needs its land evidence.
          if (pinned && (pinned.held.has(job) || pinned.evidence.has(job))) continue;
          if (fs.lstatSync(join(home, 'jobs', job), { throwIfNoEntry: false })) continue;
          const files = names.map(name => {
            const path = join(dir, name);
            return { name, path, graphDir: !name.includes('.'), stat: fs.lstatSync(path) };
          });
          if (files.some(({ graphDir, stat }) => stat.mtimeMs >= cutoff || (graphDir ? !stat.isDirectory() : !stat.isFile()))) continue;
          let latestReceiptTs: number | undefined;
          if (files.some(({ path }) => {
            if (!path.endsWith('.json')) return false;
            const receipt = readJsonBounded(path, 128 * 1024) as Partial<LandFlow> | null;
            const ts = epoch(receipt?.landed_at) ?? epoch(receipt?.updated_at) ?? epoch(receipt?.created_at);
            if (ts !== undefined && (latestReceiptTs === undefined || ts > latestReceiptTs)) latestReceiptTs = ts;
            return (receipt?.state !== 'completed' && receipt?.state !== 'failed' && receipt?.state !== 'cancelled') ||
              hasPendingFlakeCollection(home, receipt);
          })) continue;
          const entries: TarInput[] = [];
          let maxMtime = 0;
          for (const { name, path, stat } of files) {
            if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
            if (stat.isFile()) {
              const pinned = statPinnedRegular(path, `flows/${name}`);
              if (pinned) entries.push(pinned.entry);
            } else {
              inDirectory(path, graph => {
                const graphNames = fs.readdirSync(graph);
                if (!graphNames.every(f => f === 'graph.json' && fs.lstatSync(join(graph, f)).isFile())) return;
                for (const f of graphNames) {
                  const entry = readPinnedRegularEntry(join(graph, f), `flows/${name}/${f}`);
                  if (entry) entries.push(entry);
                }
              });
            }
          }
          if (entries.length) {
            archiveFlowCold(home, job, entries, latestReceiptTs ?? (maxMtime || now));
          }
          for (const { path, stat } of files) {
            try {
              const current = fs.lstatSync(path, { throwIfNoEntry: false });
              if (!sameInode(stat, current) || current?.ctimeMs !== stat.ctimeMs) continue;
              if (stat.isFile()) fs.unlinkSync(path);
              else {
                const empty = inDirectory(path, graph => {
                  const graphNames = fs.readdirSync(graph);
                  if (!graphNames.every(name => name === 'graph.json' && fs.lstatSync(join(graph, name)).isFile())) return false;
                  for (const name of graphNames) fs.unlinkSync(join(graph, name));
                  return true;
                });
                if (empty) fs.rmdirSync(path);
              }
            } catch { /* Missing, replaced or inaccessible artifact; retry next pass. */ }
          }
        } catch { /* Unreadable receipt, job state, or cold archive failure: keep this flow family. */ }
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
