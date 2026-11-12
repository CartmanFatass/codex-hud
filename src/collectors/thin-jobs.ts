/** Read-only thin jobs. Package labels are display grouping, never execution identity. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { answerRecord, questionFields, reviewVerdict } from './work-artifacts.js';
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
  json?: Record<string, unknown> | null;
}
const cache = new Map<string, { stamp: string; snap: Snap }>();
const seen = new Set<string>();
function read(path: string, max = 65536): Snap | null {
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(path);
    if (!st.isFile()) return null;
    seen.add(path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = cache.get(path);
    if (hit?.stamp === stamp) return hit.snap;
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const buffer = Buffer.alloc(max + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const snap = { text: buffer.subarray(0, Math.min(size, max)).toString('utf8'), at: st.mtimeMs, whole: size <= max };
    cache.set(path, { stamp, snap });
    return snap;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function json(path: string, parse: (text: string) => unknown): { v: Record<string, unknown>; at: number } | null {
  const file = read(path);
  if (!file?.whole) return null;
  if (file.json === undefined) {
    try {
      const v = parse(file.text);
      file.json = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      file.json = null;
    }
  }
  return file.json ? { v: file.json, at: file.at } : null;
}
const when = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};
const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (text: string) =>
  text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.replace(/^#{1,6}\s+/, '')
    .trim() ?? '';
const number = (name: string) => Number.parseInt(name.match(/\d+/)?.[0] ?? '0', 10);
export interface ThinJobScope {
  project: string | null;
  pane: string | null;
}
/**
 * What a running job is doing, by role (owner, 2026-11-11): only an implementer builds; read-only roles review,
 * research or ask. An unknown role is just working.
 */
export function runningVerb(role: string, harness: string): string {
  if (/(^|-)imp$|implementer/.test(role)) return 'build';
  if (/reviewer/.test(role)) return 'reviewing';
  if (role === 'architect') return 'researching';
  if (harness === 'jev') return /^flow/.test(role) ? 'generating' : 'asking web';
  return 'working';
}
export function readThinJobs(home: string, scope: ThinJobScope, parse = JSON.parse,
  options?: { settledBefore: number }): WorkLane[] {
  seen.clear();
  const root = join(home, 'jobs');
  const jobs = entries(root)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .flatMap((id) => {
      // Bars have no history view. Keep active/unknown jobs for pinned questions, regardless of age.
      const status = options ? json(join(root, id, 'STATUS.json'), parse) : null;
      if (status && ['done', 'closed', 'idle_grace', 'failed', 'stopped'].includes(String(status.v.state)) &&
        (when(status.v.ended_at) ?? when(status.v.settled_at) ?? status.at) < options!.settledBefore) return [];
      const file = json(join(root, id, 'job.json'), parse),
        job = file?.v;
      if (
        !file ||
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        !scope.pane ||
        job.herdr_pane !== scope.pane
      )
        return [];
      const created = when(job.created_at);
      return created === null ? [] : [{ id, job, created, jobAt: file.at, status }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .slice(0, 200);
  const lanes = new Map<string, WorkLane>();
  for (const { id, job, created, jobAt, status: checkedStatus } of jobs) {
    const directory = join(root, id),
      status = checkedStatus ?? json(join(directory, 'STATUS.json'), parse),
      s = status?.v ?? {};
    // A job closed after it wrote its report finished its task; only the close raced settlement (owner, 2026-11-12).
    const state = s.state === 'stopped' ? (s.output_written === true ? 'done' : 'stopped') :
      s.state === 'failed' || (!status && typeof job.dispatch_exit_code === 'number' && job.dispatch_exit_code !== 0)
        ? 'failed'
        : ['closed', 'idle_grace', 'done'].includes(String(s.state))
          ? 'done'
          : 'working';
    const at = status?.at ?? jobAt;
    const settledAt = state === 'working' ? null : (when(s.ended_at) ?? when(s.settled_at) ?? at);
    const briefFile = read(join(directory, 'brief.md')),
      brief = briefFile?.text ?? '';
    const title =
      first(brief.split(/\r?\n/).find((line) => /^#{1,6}\s/.test(line)) ?? brief) || word(job.title) || id.slice(-6);
    const label = word(job.package) ?? (title.includes(':') ? title.split(':', 1)[0] : title);
    const laneId = `thin-job:package:${label}`,
      workerId = `thin-job:${id}`;
    const ref = (file: string, snap: Snap): EvidenceRef => ({
      sourceId: id,
      relativePath: file,
      revision: String(snap.at),
      at: snap.at,
      timeBasis: 'file-mtime',
    });
    const decisions: DecisionRecord[] = [];
    let pending: { fields: ReturnType<typeof questionFields>; evidence: EvidenceRef; id: string } | undefined;
    const qa = join(directory, 'qa'),
      names = new Set(entries(qa));
    for (const name of [...names].filter((n) => /^q\d+\.md$/.test(n)).sort((a, b) => number(a) - number(b))) {
      const answerName = name.replace('.md', '.answer.md');
      const q = read(join(qa, name)),
        a = names.has(answerName) ? read(join(qa, answerName)) : null;
      if (!q) continue;
      if (!a) pending ??= { fields: questionFields(q.text), evidence: ref(`qa/${name}`, q), id: name.slice(0, -3) };
      else {
        const record = answerRecord(
          laneId,
          `${id}/qa/${name}`,
          q.text,
          a.text,
          ref(`qa/${name}`, q),
          ref(`qa/${answerName}`, a)
        );
        if (record) decisions.push(record);
      }
    }
    const waiting = state === 'working' ? pending : undefined;
    const report = read(join(directory, 'report.md'));
    const reviews = entries(directory)
      .filter((n) => /^review-\d+\.md$/.test(n))
      .sort((a, b) => number(a) - number(b));
    const phases: string[] = [];
    const verb = runningVerb(String(job.role), word(s.harness) ?? word(job.harness) ?? 'pi');
    // Only a build is a step that later rounds follow; a read-only job's chain is just its state.
    if (verb === 'build' && (report || reviews.length)) phases.push('build ✓');
    let phaseAt = 0,
      lastResult = '';
    for (const name of reviews) {
      const review = read(join(directory, name));
      if (!review) continue;
      const verdict = reviewVerdict(review.text);
      const major = review.text.match(/\b(\d+)\s+(?:major|important)\b/i)?.[1];
      const minor = review.text.match(/\b(\d+)\s+minor\b/i)?.[1];
      const result =
        verdict === 'accept'
          ? 'accept'
          : [major ? `${major} major` : '', minor ? `${minor} minor` : ''].filter(Boolean).join(' ') || (verdict ?? '');
      phases.push(`review r${number(name)}${result ? ' ' + result : ''}`);
      phaseAt = review.at;
      lastResult = first(review.text);
    }
    const phase = state === 'stopped' ? 'stopped' : waiting
      ? 'asking'
      : state === 'failed'
        ? 'failed'
        : settledAt !== null
          ? 'done'
          : reviews.length
            ? 'fixing'
            : verb;
    phases.push(phase);
    const activityAt = Math.max(created, status?.at ?? 0, report?.at ?? 0, phaseAt);
    const sentence =
      waiting?.fields.question ||
      (state === 'failed' ? (word(s.exit_reason) ?? word(s.reason)) : null) ||
      (report && report.at >= phaseAt ? first(report.text) : lastResult) ||
      '';
    const worker: OwnerWorker = {
      id: workerId,
      laneId,
      role: String(job.role),
      harness: word(s.harness) ?? word(job.harness) ?? 'pi',
      task: title,
      state,
      startedAt: when(s.started_at) ?? created,
      settledAt,
      phase,
      model: word(s.model) ?? word(job.model),
      provider: word(s.provider) ?? word(job.provider),
      effort: word(s.thinking) ?? word(job.thinking),
      homeNeedsHuman: !!waiting,
      humanEndedAt: waiting?.evidence.at ?? null,
      ...(waiting ? { ask: waiting.fields.question } : {}),
      stale: false,
      // The last ref is the file Enter opens: the report, else the brief.
      evidence: [
        ref('job.json', { text: '', at: jobAt, whole: true }),
        ...(report ? [ref('report.md', report)] : briefFile ? [ref('brief.md', briefFile)] : []),
      ],
      work: {
        episode: id,
        signature: String(at),
        activityAt,
        activityBasis: 'observed',
        phases,
        request: !!waiting,
        failed: state === 'failed',
        result: settledAt !== null,
        // A settled job is done: no "report unread" stage, since only hud_read could tell (owner, 2026-11-11).
        facadeClosed: true,
        facadeClosedAt: settledAt,
        reason: sentence,
        ...(waiting
          ? {
              requestInfo: {
                id: waiting.id,
                question: waiting.fields.question,
                suggested: waiting.fields.suggested,
                options: waiting.fields.options,
                context: waiting.fields.context,
                evidence: waiting.evidence,
              },
            }
          : {}),
      },
    };
    const lane = lanes.get(laneId);
    lanes.set(laneId, {
      id: laneId,
      identity: { kind: 'invocation', home, root: scope.pane!, jobId: id },
      label,
      title: label,
      startedAt: lane?.startedAt ?? created,
      phase,
      workers: [...(lane?.workers ?? []), worker],
      decisions: [...(lane?.decisions ?? []), ...decisions],
      evidence: [],
    });
  }
  // Keep all receipt signatures, but only artifacts used by the retained lanes (no clear-all churn).
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  return [...lanes.values()];
}
