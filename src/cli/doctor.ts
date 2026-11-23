import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { jobRow, readJobProgress } from '../collectors/thin-jobs.js';
import type { DoneReceipt, Job, JobStatus, Turn } from '../mcp/job-contracts.js';
import { jobFiles as files } from '../mcp/paths.js';
import { receiptForTurn, turnToken } from '../roles/cli-turn.js';
import { JobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { isActiveProcState, isValidPid, readProcStat } from '../utils/proc.js';
import type { HudIO } from './hud.js';
import { CliError, privateHome } from './private-home.js';

const usage = 'Usage: hud doctor <jobId>';
const limit = 64 * 1024;
type Unavailable = 'missing' | 'unreadable';
const unavailable = (error: unknown): Unavailable =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
function observe<T>(read: () => T): T | Unavailable {
  try { return read(); } catch (error) { return unavailable(error); }
}
function objectFile<T extends object>(file: string, max = limit, valid?: (value: T) => boolean) {
  return observe(() => {
    const value = readJsonBounded(file, max) as T;
    if (!value || typeof value !== 'object' || Array.isArray(value) || (valid && !valid(value))) throw new Error();
    return value;
  });
}
const presence = (file: string) => observe(() => { lstatSync(file); return 'present' as const; });
const validTurn = (t: Turn) => Number.isSafeInteger(t.seq) && t.seq > 0 && typeof t.sent_at === 'string' &&
  Number.isFinite(Date.parse(t.sent_at)) && (t.report_sig === null || typeof t.report_sig === 'string');

function processFact(pid: unknown, start?: unknown, pidOnly = false) {
  if (!isValidPid(pid)) return { pid: null, liveness: 'unknown' };
  const liveness = observe(() => {
    const proc = readProcStat(pid, { strict: true });
    if (!proc || !isActiveProcState(proc.state)) return 'not alive';
    if (typeof start === 'string' && start) return proc.start === start ? 'alive' : 'start time differs';
    return pidOnly ? 'alive (PID only)' : 'unknown (no start time)';
  });
  return { pid, liveness };
}

/** Read one job only. No store calls: MCP readRow can record failure exhaustion. */
export function collectDoctor(dir: string) {
  const path = (file: string) => join(dir, file);
  const jobFile = objectFile<Partial<Job>>(path(files.job));
  const statusFile = objectFile<Partial<JobStatus>>(path(files.status));
  const j = typeof jobFile === 'object' ? jobFile : {};
  const s = typeof statusFile === 'object' ? statusFile : null;
  const browser = j.bro || j.jev || s?.harness === 'bro' || j.place?.harness === 'bro';
  const cli = !browser && (s?.harness === 'cli' || !!j.cli || j.place?.harness === 'cli');
  const shared = observe(() => {
    const cache = new JobIndexCache(dirname(dirname(dir)));
    const { display_state, state, reason, blocked, report_unread, question_ids } = jobRow(j, s, { dir, cache });
    return { display_state, state, reason, blocked, report_unread, question_ids };
  });
  const report = observe(() => {
    // Same signature as reportSignature, from one opened inode and with a hard byte cap.
    const { bytes, stat, truncated } = readFileBounded(path(files.report), limit);
    if (truncated) throw new Error();
    return { report_sig: bytes.toString('utf8').trim()
      ? `${stat.mtimeMs}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}` : null };
  });
  const turn = cli ? objectFile<Turn>(path(files.turn), limit, validTurn) : 'n/a';
  const done = cli ? objectFile<DoneReceipt>(path(files.done), 1024, (d) => validTurn(d) &&
    typeof d.report_sig === 'string' && typeof d.at === 'string') : 'n/a';
  const sig = typeof report === 'object' ? report.report_sig : null;
  const current = typeof turn === 'object' && typeof done === 'object' ? receiptForTurn(turn, done) : 'unknown';
  const changed = sig && typeof turn === 'object' ? sig !== turn.report_sig : 'unknown';
  const matches = sig && typeof done === 'object' ? done.report_sig === sig : 'unknown';
  const notes: string[] = [];
  if (typeof turn === 'object' && typeof done === 'object' && !current) {
    notes.push(done.seq !== turn.seq ? `done.json seq ${done.seq} differs from turn.json seq ${turn.seq}.`
      : done.sent_at !== turn.sent_at ? 'done.json sent_at differs from turn.json sent_at.'
        : done.report_sig === turn.report_sig ? 'done.json report_sig equals the turn.json baseline report_sig.'
          : 'done.json at is not a valid timestamp.');
  }
  if (matches === false) notes.push('done.json report_sig differs from the current report.md signature; the receipt does not match.');
  if (changed === false) notes.push('report.md signature equals turn.json report_sig; no new report signature for this turn.');
  const questions = typeof shared === 'object' ? shared.question_ids : shared;
  if (Array.isArray(questions) && questions.length) notes.push(`qa has no matching .answer.md for: ${questions.join(', ')}.`);

  const facts = {
    job: basename(dir),
    identity: typeof jobFile === 'string' ? jobFile : {
      role: j.role, harness: s?.harness ?? j.place?.harness ?? (cli ? 'cli' : browser ? 'bro' : 'pi'),
      agent: s?.agent ?? j.cli?.agent, headless: j.headless, place: j.place, model: s?.model ?? j.model,
      project: j.project_root ?? j.cwd, worktree: j.worktree, attempts: j.attempts, used_place: j.used_place,
    },
    shared, report: cli && typeof report === 'object' ? { ...report, changed_since_turn: changed } : report,
    turn: typeof turn === 'object' ? { seq: turn.seq, sent_at: turn.sent_at, report_sig: turn.report_sig } : turn,
    receipt: typeof done === 'object' ? { seq: done.seq, sent_at: done.sent_at, report_sig: done.report_sig, at: done.at,
      for_current_turn: current, matches_report_on_disk: matches } : done,
    questions, status: statusFile,
  };
  if (browser) return { ...facts, notes };

  const checkFile = presence(path(files.checks));
  const check = checkFile === 'present' ? readCheckReceipt(dir) : null;
  // Compare the check binding against the bounded reads above; jobChecks re-reads the turn and report without a cap.
  const token = cli ? (typeof turn === 'object' ? turnToken(turn) : null) : j.pi_sent_at ?? j.created_at;
  const bound = check && token && sig ? sameChecks(check, { turn: token, report_sig: sig }) : 'unknown';
  if (bound === false) notes.push('checks.json turn or report_sig differs from the current turn or report.md signature.');
  const supervisor = observe(() => {
    const { bytes, truncated } = readFileBounded(path(files.supervisorPid), 256);
    const pid = Number(bytes.toString('utf8').trim());
    if (truncated || !isValidPid(pid)) throw new Error();
    return pid;
  });
  const progress = readJobProgress(dir).latest_progress;
  return { ...facts,
    checks: {
      defined: Array.isArray(j.checks) ? j.checks.length : typeof jobFile === 'string' ? 'unknown' : 0,
      receipt: check ? { turn: check.turn, report_sig: check.report_sig, state: check.state, bound_to_current_report: bound,
        results: check.results.map((result) => ({ command: result?.command, exit_code: result?.exit_code })) }
        : checkFile === 'present' ? 'unreadable' : checkFile,
    },
    progress: progress ?? (presence(path(files.progress)) === 'missing' ? 'missing' : 'unreadable'),
    markers: { stop_requested: presence(path(files.stopRequested)), close_requested: presence(path(files.closeRequested)) },
    processes: { supervisor_pid_file: supervisor, supervisor: processFact(typeof supervisor === 'number' ? supervisor : s?.supervisor_pid, null, true),
      worker: processFact(s?.pid, s?.pid_start_time) },
    notes,
  };
}

export type DoctorReport = ReturnType<typeof collectDoctor>;
export function formatDoctor(report: DoctorReport): string {
  const { notes, ...sections } = report;
  // JSON keeps control bytes in job-provided text out of the terminal, including C1 and bidi controls.
  const json = (value: unknown, indent?: number) => JSON.stringify(value, null, indent)
    .replace(/[\u007f-\u009f\p{Bidi_Control}\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Object.entries(sections).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : json(value, key === 'status' ? 2 : undefined)}\n`).join('') +
    `notes:\n${notes.length ? notes.map((note) => `  - ${note}\n`).join('') : '  none\n'}`;
}

export async function doctorCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length !== 1) throw new CliError(usage);
  const [id] = args;
  if (!JOB_ID_RE.test(id)) throw new CliError(`invalid_job_id: ${usage}`);
  const dir = join(privateHome(io.env), 'jobs', id);
  const found = observe(() => lstatSync(dirname(dir)).isDirectory() && lstatSync(dir).isDirectory());
  if (found !== true) throw new CliError(`${found === 'unreadable' ? 'unreadable_job_directory' : 'job_not_found'}: ${id}`, 1);
  await io.stdout(formatDoctor(collectDoctor(dir)));
  return 0;
}
