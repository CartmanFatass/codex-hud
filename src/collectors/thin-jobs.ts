/** Read-only thin jobs. Package labels are display grouping, never execution identity. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { herdrId } from '../roles/herdr-run.js';
import { answerRecord, questionFields, reviewVerdict } from './work-artifacts.js';
import type { DecisionRecord, EvidenceRef, OwnerWorker, WorkLane } from './workboard-types.js';

let complete = false;
function entries(path: string, missingOK = false): string[] {
  try {
    return fs.readdirSync(path);
  } catch (error) {
    if (!missingOK || (error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
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
let cacheHome = '', saved = '';
// Persist only receipt/STATUS facts, never reports, questions or transcript text.
const factKeys = new Set(['job', 'role', 'herdr_pane', 'created_at', 'title', 'package', 'dispatch_exit_code',
  'state', 'started_at', 'settled_at', 'ended_at', 'output_written', 'harness', 'model', 'provider', 'thinking', 'exit_reason', 'reason']);
function restore(home: string): void {
  if (cacheHome === home) return;
  cacheHome = home; cache.clear(); saved = '';
  try {
    const file = join(home, 'display/thin-jobs.json');
    if (fs.statSync(file).size > 1048576) return;
    const text = fs.readFileSync(file, 'utf8'), rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 400) return;
    for (const [rel, stamp, snap] of rows) {
      if (!/^j[0-9a-f]{16}\/(job|STATUS)\.json$/.test(rel) || typeof stamp !== 'string' ||
        !snap || typeof snap.at !== 'number' || typeof snap.whole !== 'boolean' ||
        !(snap.json === null || (snap.json && typeof snap.json === 'object'))) throw Error('cache');
      cache.set(join(home, 'jobs', rel), { stamp, snap: { ...snap, text: '' } });
    }
    saved = text;
  } catch { cache.clear(); }
}
function persist(home: string): void {
  const root = join(home, 'jobs') + '/';
  const rows = [...cache].filter(([p]) => /\/(job|STATUS)\.json$/.test(p)).map(([p, { stamp, snap }]) =>
    [p.slice(root.length), stamp, { at: snap.at, whole: snap.whole, json: snap.json ?
      Object.fromEntries(Object.entries(snap.json).filter(([k]) => factKeys.has(k))) : null }]);
  const text = JSON.stringify(rows);
  if (text === saved || text.length > 1048576) return;
  const file = join(home, 'display/thin-jobs.json'), temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(join(home, 'display'), { recursive: true });
    fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file); saved = text;
  } catch { /* An unavailable display cache must not stop collection. */ }
  finally { try { fs.unlinkSync(temp); } catch { /* renamed or unavailable */ } }
}
function read(path: string, max = 65536): Snap | null {
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(path);
    if (!st.isFile()) throw new Error('nonregular_job_file');
    seen.add(path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = cache.get(path);
    if (hit?.stamp === stamp && !hit.snap.whole) complete = false;
    if (hit?.stamp === stamp) return hit.snap;
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const buffer = Buffer.alloc(max + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const snap = { text: buffer.subarray(0, Math.min(size, max)).toString('utf8'), at: st.mtimeMs, whole: size <= max };
    complete &&= snap.whole;
    cache.set(path, { stamp, snap });
    return snap;
  } catch (error) {
    cache.delete(path);
    seen.delete(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function json(path: string, parse: (text: string) => unknown): { v: Record<string, unknown>; at: number } | null {
  const file = read(path);
  if (!file?.whole) complete = false;
  if (!file?.whole) return null;
  if (file.json === undefined) {
    try {
      const v = parse(file.text);
      file.json = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      file.json = null;
    }
  }
  if (!file.json) complete = false;
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
/** Share the existing session selection/stat with sentence material; never read its body here. */
function latestSession(directory: string): OwnerWorker['sessionFile'] {
  const root = join(directory, 'sessions');
  try {
    if (fs.realpathSync(root) !== root) return undefined;
    return fs.readdirSync(root).slice(0, 400)
      .filter((n) => n.endsWith('.jsonl'))
      .flatMap((n) => {
        try {
          const path = fs.realpathSync(join(root, n)), st = fs.statSync(path);
          return path.endsWith('.jsonl') && st.isFile() ? [{ path, at: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at)[0];
  } catch {
    return undefined;
  }
}
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
export function readThinJobs(
  home: string,
  scope: ThinJobScope,
  parse = JSON.parse,
  options?: { settledBefore?: number; openedAt?: number },
  observation?: { complete: boolean }
): WorkLane[] {
  complete = herdrId(scope.pane);
  seen.clear();
  restore(home);
  const root = join(home, 'jobs');
  const candidates = entries(root).filter((id) => /^j[0-9a-f]{16}$/.test(id)).flatMap((id) => {
    try { const st = fs.lstatSync(join(root, id)); return st.isDirectory() ? [{ id, at: st.mtimeMs }] : []; }
    catch { complete = false; return []; }
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  if (candidates.length > 200) complete = false;
  const jobs = candidates.slice(0, 200)
    .flatMap(({ id }) => {
      // Filter from STATUS facts before reading receipts or artifacts; active/unknown jobs always stay.
      const status = options ? json(join(root, id, 'STATUS.json'), parse) : null;
      if (
        status &&
        ['done', 'closed', 'idle_grace', 'failed', 'stopped'].includes(String(status.v.state)) &&
        ((when(status.v.ended_at) ?? when(status.v.settled_at) ?? status.at) < (options?.settledBefore ?? -Infinity) ||
          (when(status.v.settled_at) ?? when(status.v.ended_at) ?? status.at) < (options?.openedAt ?? -Infinity))
      )
        return [];
      const file = json(join(root, id, 'job.json'), parse),
        job = file?.v;
      // Bars may have read STATUS before the directory vanished during the receipt read.
      if (!file) seen.delete(join(root, id, 'STATUS.json'));
      if (!file || !job || job.job !== id || typeof job.role !== 'string') complete = false;
      if (
        !file ||
        !job ||
        job.job !== id ||
        typeof job.role !== 'string' ||
        !herdrId(scope.pane) ||
        job.herdr_pane !== scope.pane
      )
        return [];
      const created = when(job.created_at);
      if (created === null) complete = false;
      return created === null ? [] : [{ id, job, created, jobAt: file.at, status }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const lanes = new Map<string, WorkLane>();
  for (const { id, job, created, jobAt, status: checkedStatus } of jobs.slice(0, 200)) {
    const directory = join(root, id),
      status = checkedStatus ?? json(join(directory, 'STATUS.json'), parse),
      s = status?.v ?? {};
    // A job closed after it wrote its report finished its task; only the close raced settlement (owner, 2026-11-12).
    const state =
      s.state === 'stopped'
        ? s.output_written === true
          ? 'done'
          : 'stopped'
        : s.state === 'failed' ||
            (!status && typeof job.dispatch_exit_code === 'number' && job.dispatch_exit_code !== 0)
          ? 'failed'
          : ['closed', 'idle_grace', 'done'].includes(String(s.state))
            ? 'done'
            : 'working';
    const at = status?.at ?? jobAt;
    // When the work settled, not when the process later exited: closing an idle job must not reset its age or outcome label.
    const settledAt = state === 'working' ? null : (when(s.settled_at) ?? when(s.ended_at) ?? at);
    if (settledAt !== null && settledAt < (options?.openedAt ?? -Infinity)) continue;
    const briefFile = read(join(directory, 'brief.md')),
      brief = briefFile?.text ?? '';
    const briefTitle = first(brief.split(/\r?\n/).find((line) => /^#{1,6}\s/.test(line)) ?? '');
    const title = briefTitle || first(brief) || first(word(job.title) ?? '') || id.slice(-6);
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
    const files: NonNullable<OwnerWorker['files']>[number][] = [];
    const addFile = (rel: string, kind: 'brief' | 'report' | 'review', snap: Snap | null, verdict?: string) => {
      if (snap) files.push({ rel, kind, at: snap.at, paths: [join(directory, rel)], verdict });
    };
    addFile('brief.md', 'brief', briefFile);
    let pending: { fields: ReturnType<typeof questionFields>; evidence: EvidenceRef; id: string } | undefined;
    const qa = join(directory, 'qa'),
      names = new Set(entries(qa, true));
    for (const name of [...names].filter((n) => /^q\d+\.md$/.test(n)).sort((a, b) => number(a) - number(b))) {
      const answerName = name.replace('.md', '.answer.md');
      const q = read(join(qa, name)),
        a = names.has(answerName) ? read(join(qa, answerName)) : null;
      if (!q || (names.has(answerName) && !a)) complete = false;
      if (!q) continue;
      const fields = questionFields(q.text);
      files.push({
        rel: `qa/${name}`,
        kind: 'question',
        at: a?.at ?? q.at,
        paths: [join(qa, name), ...(a ? [join(qa, answerName)] : [])],
        qid: name.slice(0, -3),
        title: fields.question,
        state: a ? 'answered' : 'open',
      });
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
        if (record) {
          decisions.push(record);
          Object.assign(files.at(-1)!, {
            title: record.option ?? fields.question,
            state: record.departure ? 'departure' : 'answered',
          });
        }
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
      if (!review) complete = false;
      if (!review) continue;
      const verdict = reviewVerdict(review.text);
      const major = review.text.match(/\b(\d+)\s+(?:major|important)\b/i)?.[1];
      const minor = review.text.match(/\b(\d+)\s+minor\b/i)?.[1];
      const result =
        verdict === 'accept'
          ? 'accept'
          : [major ? `${major} major` : '', minor ? `${minor} minor` : ''].filter(Boolean).join(' ') || (verdict ?? '');
      addFile(name, 'review', review, result);
      phases.push(`review r${number(name)}${result ? ' ' + result : ''}`);
      phaseAt = review.at;
      lastResult = first(review.text);
    }
    const phase =
      state === 'stopped'
        ? 'stopped'
        : waiting
          ? 'asking'
          : state === 'failed'
            ? 'failed'
            : settledAt !== null
              ? 'done'
              : reviews.length
                ? 'fixing'
                : verb;
    phases.push(phase);
    const sessionFile = state === 'working' ? latestSession(directory) : undefined;
    const activityAt = Math.max(created, status?.at ?? 0, report?.at ?? 0, phaseAt, sessionFile?.at ?? 0);
    const sentence =
      waiting?.fields.question ||
      (state === 'failed' ? (word(s.exit_reason) ?? word(s.reason)) : null) ||
      (report && report.at >= phaseAt ? first(report.text) : lastResult) ||
      '';
    addFile('report.md', 'report', report);
    const worker: OwnerWorker = {
      files,
      sessionFile,
      id: workerId,
      laneId,
      role: String(job.role),
      harness: word(s.harness) ?? word(job.harness) ?? 'pi',
      task: title,
      ...(briefTitle ? { briefTitle } : {}),
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
  // Retain only signatures used by this bounded scan.
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  persist(home);
  if (observation) observation.complete = complete;
  return [...lanes.values()];
}
