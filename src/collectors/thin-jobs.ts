/** Read-only thin-server jobs: one lane per job directory, built only from the files the thin layer and pi-roles write. */
import * as fs from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { answerRecord } from './work-artifacts.js';
import type { DecisionRecord, EvidenceRef, OwnerWorker, WorkLane } from './workboard-types.js';

function entries(path: string): string[] {
  try {
    return fs.readdirSync(path);
  } catch {
    return [];
  }
}
interface Snap {
  text: string;
  at: number;
  whole: boolean;
}
// The panel re-reads the same few job directories on every refresh: an unchanged file costs one lstat.
const cache = new Map<string, { stamp: string; snap: Snap }>();
function read(path: string, max = 16384): Snap | null {
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(path);
    if (!st.isFile()) return null;
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = cache.get(path);
    if (hit?.stamp === stamp) return hit.snap;
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const buffer = Buffer.alloc(max + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const snap = { text: buffer.subarray(0, Math.min(size, max)).toString('utf8'), at: st.mtimeMs, whole: size <= max };
    if (cache.size > 400) cache.clear();
    cache.set(path, { stamp, snap });
    return snap;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function json(path: string): { v: Record<string, unknown>; at: number } | null {
  const file = read(path);
  if (!file?.whole) return null;
  try {
    const v = JSON.parse(file.text);
    return v && typeof v === 'object' ? { v, at: file.at } : null;
  } catch {
    return null;
  }
}
const when = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};
const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (text: string, n = 160): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
/** The brief's first heading, else its first line. */
const taskOf = (brief: string): string => {
  const all = lines(brief);
  return clip((all.find((l) => /^#{1,6}\s/.test(l)) ?? all[0] ?? '').replace(/^#{1,6}\s+/, ''));
};
/** A question file opens with its own "# Question qN from ..." heading; the ask is the first line after it. */
const askOf = (question: string): string => {
  const all = lines(question);
  return clip((all.find((l) => !l.startsWith('#')) ?? all[0] ?? 'question').replace(/^#+\s*/, ''));
};
const number = (name: string): number => Number.parseInt(name.slice(1), 10);

export const isThinLane = (id: string): boolean => id.startsWith('thin-job:');
export interface ThinJobScope {
  project: string | null;
  pane: string | null;
}
export function readThinJobs(home: string, scope: ThinJobScope): WorkLane[] {
  const root = join(home, 'jobs');
  return entries(root)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .flatMap((id) => {
      const file = json(join(root, id, 'job.json')),
        job = file?.v;
      if (
        !file ||
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        typeof job.cwd !== 'string' ||
        typeof job.created_at !== 'string'
      )
        return [];
      const created = Date.parse(job.created_at);
      if (!Number.isFinite(created)) return [];
      const path = scope.project ? relative(resolve(scope.project), resolve(job.cwd)) : '..';
      if (scope.pane ? job.herdr_pane !== scope.pane : path === '..' || path.startsWith('../') || isAbsolute(path))
        return [];
      const launchFailed = typeof job.dispatch_exit_code === 'number' && job.dispatch_exit_code !== 0;
      return [{ id, role: job.role, created, jobAt: file.at, launchFailed }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .slice(0, 20)
    .map(({ id, role, created, jobAt, launchFailed }) => {
      const directory = join(root, id);
      const status = json(join(directory, 'STATUS.json')),
        s = status?.v ?? {};
      // The owner's words, not pi-roles' states: idle_grace is finished and still open, closed is finished.
      const state: OwnerWorker['state'] =
        s.state === 'failed' || (!status && launchFailed)
          ? 'failed'
          : s.state === 'closed'
            ? 'done'
            : s.state === 'idle_grace'
              ? 'idle'
              : 'working';
      const at = status?.at ?? jobAt;
      const settledAt =
        state === 'working'
          ? null
          : state === 'idle'
            ? (when(s.settled_at) ?? at)
            : (when(s.ended_at) ?? when(s.settled_at) ?? at);
      const laneId = `thin-job:${id}`;
      const task = taskOf(read(join(directory, 'brief.md'), 2048)?.text ?? '') || id.slice(-6);
      const qa = join(directory, 'qa'),
        names = new Set(entries(qa));
      const decisions: DecisionRecord[] = [];
      let pending: { ask: string; at: number } | undefined;
      const questions = [...names].filter((n) => /^q\d+\.md$/.test(n)).sort((a, b) => number(a) - number(b));
      for (const name of questions.slice(-8)) {
        const answerName = name.replace('.md', '.answer.md');
        const q = read(join(qa, name), 2048),
          a = names.has(answerName) ? read(join(qa, answerName), 2048) : null;
        if (!q) continue;
        const ref = (file: string, snap: Snap): EvidenceRef => ({
          sourceId: id,
          relativePath: `qa/${file}`,
          revision: String(snap.at),
          at: snap.at,
          timeBasis: 'file-mtime',
        });
        if (!a) pending ??= { ask: askOf(q.text), at: q.at };
        else {
          const record = answerRecord(laneId, `qa/${name}`, q.text, a.text, ref(name, q), ref(answerName, a));
          if (record) decisions.push(record);
        }
      }
      // A question left on a job that has finished was settled by its default; nobody can still answer it.
      const waiting = state === 'working' ? pending : undefined;
      const worker: OwnerWorker = {
        id: laneId,
        laneId,
        role,
        harness: 'pi',
        task,
        state,
        startedAt: when(s.started_at) ?? created,
        settledAt,
        phase: null,
        model: word(s.model),
        effort: word(s.thinking),
        homeNeedsHuman: !!waiting,
        humanEndedAt: waiting?.at ?? null,
        ...(waiting ? { ask: waiting.ask } : {}),
        stale: false,
        evidence: [],
      };
      return {
        id: laneId,
        identity: { kind: 'invocation', home, root: scope.pane ?? scope.project ?? '', jobId: id },
        label: role,
        title: task,
        startedAt: created,
        phase: null,
        workers: [worker],
        decisions,
        evidence: [],
      };
    });
}
