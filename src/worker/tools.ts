/** Worker protocol shared by MCP, the native pi extension and the CLI fallbacks. */
import { normalizeReportMeta, readReportMeta, REPORT_LINE_LIMIT, validPreviewPath, writeReportMeta } from '../roles/report-meta.js';
import { openPreview, publishPreview } from './preview.js';
import { DONE_FILE, readTurn, saveTurn, turnToken, reportSignature, withTurnLock, workerAlive } from '../mcp/cli-judge.js';
import { rememberWorkerTree } from '../roles/worker-tree.js';
import { readJsonBounded, readJsonFile, writePrivateFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import { takeLease, LEASE_TOOL } from '../roles/lease.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import type { Job, JobStatus, DoneReceipt, ManagedWorktree } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { piSessionIdentity } from '../mcp/worker-resume.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sonicChildren, sonicState } from '../worker/sonic-jobs.js';
import { dispatchJob } from '../mcp/dispatch/orchestrator.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { recordQuestionTimeout } from '../roles/job-archive.js';
import { notify, taskDelivery } from '../roles/notify.js';
import { readJobProgress } from '../collectors/thin-jobs.js';
import { worktreeGit as git } from '../collectors/worktrees.js';
import { neutralizeFilters } from '../utils/git-safety.js';
import { progress } from './progress.js';
import { runWorkerChecks } from './checks.js';

export { progress } from './progress.js';

const idPattern = /^j[0-9a-f]{16}$/;
type Worker = ReturnType<typeof workerJob>;
type QuestionInput = { question: string; default: string; options?: string[]; context?: string };
type Question = QuestionInput & { tag: string; n: number; qfile: string; afile: string };

function readJob(dir: string) {
  const job = readJsonFile(join(dir, jobFiles.job)) as Job;
  if (job.job !== basename(dir)) throw new Error('not a HUD job directory');
  return job;
}

export function workerJob(path = process.env.HUD_JOB_DIR) {
  const dir = path && fs.realpathSync(path);
  const own = process.env.HUD_JOB_DIR;
  const root = own !== undefined ? dirname(fs.realpathSync(own))
    : join(fs.realpathSync(process.env.HUD_HOME || join(homedir(), '.hud')), 'jobs');
  if (!dir || basename(root) !== 'jobs' || dirname(dir) !== root || !idPattern.test(basename(dir))) {
    throw new Error('--dir must name a job directory under HUD_HOME');
  }
  return { dir, root, job: readJob(dir) };
}

// Snapshot while the worker is still the parent: exit on a question can orphan helpers just like a report.
export function capturePiTree(dir: string) {
  const { snapshot, issue } = rememberWorkerTree(dir, readJsonFile(join(dir, jobFiles.status)));
  if (issue || !snapshot) throw new Error(issue ?? 'worker-tree snapshot unresolved: no ancestry snapshot could be captured');
}

const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function mergeConflictPaths(output: string): string[] {
  const fields = output.split('\0'), paths = new Set<string>();
  let i = 1; // The result tree comes first, then conflicted paths up to an empty field.
  while (fields[i]) paths.add(fields[i++]);
  // Logical conflicts (such as directory renames) may have no unmerged file entries.
  // Each message is path count, paths, stable type, and human-readable message.
  for (i++; i < fields.length - 1;) {
    const count = Number(fields[i++]), end = i + count;
    if (!Number.isSafeInteger(count) || count < 0 || end + 2 >= fields.length) break;
    if (fields[end].startsWith('CONFLICT')) for (; i < end; i++) paths.add(fields[i]);
    i = end + 2;
  }
  return [...paths];
}

async function reportConflict({ root, main_root, branch, base_head }: ManagedWorktree) {
  try {
    let baseRef = 'HEAD';
    try {
      const project = readJsonBounded(join(main_root, '.hud', 'project.json'), 256 * 1024) as
        { land?: { base?: unknown } } | null;
      const ref = project?.land?.base;
      if (typeof ref === 'string' && ref) baseRef = `refs/heads/${ref}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const [base, head] = (await git(main_root, ['rev-parse', '--revs-only', `${baseRef}^{commit}`, `refs/heads/${branch}^{commit}`])).trim().split('\n');
    if (!commitId.test(base) || !commitId.test(head) || head === base_head || head === base) return;
    // Unlike status, a real merge can run repository-configured merge drivers. Only preview built-in merges.
    try {
      await git(root, ['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$']);
      return;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    try {
      await git(root, ['-c', 'merge.renormalize=false', 'merge-tree', '--write-tree', '--name-only', '-z', '--messages', base, head], 1000);
    } catch (error) {
      const { code, stdout } = error as { code?: number; stdout?: string };
      if (code === 1 && stdout && commitId.test(stdout.split('\0', 1)[0])) {
        return { base, paths: mergeConflictPaths(stdout) };
      }
    }
  } catch { /* Best effort: an unavailable preview must not prevent land from doing the real check. */ }
}

// Omit text for the fallback command, which declares a report the worker wrote itself.
export async function finishReport({ dir, job }: Worker, turn: unknown, text?: string,
  metadata: Parameters<typeof normalizeReportMeta>[0] & { preview?: unknown } = {}, opener = openPreview) {
  if (job.bro || job.jev) throw new Error('only local workers can declare a report');
  if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('write a nonempty report');
  const fields = normalizeReportMeta(metadata);
  const requestedPreview = metadata.preview;
  if (requestedPreview !== undefined && !validPreviewPath(requestedPreview)) throw new Error('invalid_arguments: preview');
  async function publishMetadata(sig: string) {
    const previous = readReportMeta(dir, false)?.preview;
    const source = job.preview ?? requestedPreview ?? previous?.source;
    if (validPreviewPath(source)) fields.preview = await publishPreview(dir, job, source, previous, opener);
    writeReportMeta(dir, sig, fields);
  }
  if (job.worktree) {
    const { root, branch } = job.worktree;
    let status: string;
    try {
      const filters = await neutralizeFilters(git, root);
      status = await git(root, [...filters, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal', '--ignore-submodules=dirty']);
    } catch (cause) {
      throw new Error('Could not check the worktree for uncommitted changes', { cause });
    }
    if (status) throw new Error(`Commit your changes on ${branch} first (git -c user.name='HUD worker' -c user.email=worker@hud.invalid commit -- <paths>), then report.`);
    const warned = join(dir, 'report-conflict-warned');
    const conflict = !fs.existsSync(warned) && await reportConflict(job.worktree);
    if (conflict) {
      let first = true;
      try { writePrivateFile(warned, '', { mkdir: false, exclusive: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        first = false;
      }
      if (first) {
        const { base, paths } = conflict;
        const names = paths.slice(0, 20).map((name) => JSON.stringify(name)).join(', ');
        const more = paths.length > 20 ? ` (+${paths.length - 20} more)` : '';
        throw new Error(`Merge conflict with the current base${names ? ` in ${names}${more}` : ''}. Rebase onto ${base}, rerun tests, then report again. This check only refuses once.`);
      }
    }
    if (!fields.skip_checks_reason) await runWorkerChecks(dirname(dirname(dir)), job.role, job.worktree);
  }
  const path = join(dir, jobFiles.report);
  if (job.cli) {
    await withTurnLock(dir, async () => {
      const current = readTurn(dir);
      const prior = current?.pending_from;
      const answering = current && turn === turnToken(current) ? current :
        prior && turn === turnToken(prior) && workerAlive(prior.pid, prior.start) === true ? prior : null;
      if (!current || !answering) throw new Error('use the turn token from the prompt you are answering');
      if (text !== undefined) writePrivateFile(path, text, { mkdir: false });
      const sig = reportSignature(dir);
      if (!sig || sig === answering.report_sig) throw new Error('write a fresh report for this turn first');
      const latest = readTurn(dir);
      if (!latest || turnToken(latest) !== turnToken(current)) throw new Error('the turn changed; no receipt recorded');
      if (job.headless) capturePiTree(dir);
      await publishMetadata(sig);
      if (prior) {
        if (answering === prior) current.report_sig = sig; // The next turn needs its own fresh report.
        else delete current.pending_from; // Its token proves the prompt already arrived.
        saveTurn(dir, current);
      }
      writeJsonPrivate(join(dir, DONE_FILE), { seq: answering.seq, sent_at: answering.sent_at, report_sig: sig, at: new Date().toISOString() } satisfies DoneReceipt, { mkdir: false });
    });
  } else {
    // Pi declares completion natively. Capture ancestry before native shutdown can orphan it.
    if (turn !== undefined) throw new Error('pi does not use a turn token');
    if (job.headless && job.role !== 'sonic') {
      const children = sonicChildren(dir);
      if (children.open || children.uncollected.length) throw new Error('collect outstanding children with hud_sonic before reporting');
    }
    if (text !== undefined) writePrivateFile(path, text, { mkdir: false });
    const sig = reportSignature(dir);
    if (!sig) throw new Error('write the pi report first');
    capturePiTree(dir);
    await publishMetadata(sig);
    if (job.headless) writeJsonPrivate(join(dir, DONE_FILE), { report_sig: sig }, { mkdir: false });
  }
  return { path };
}

export async function startSonic({ dir, job: parent }: Pick<Worker, 'dir' | 'job'>, task: string, cwd?: unknown) {
  if (parent.role === 'sonic') throw new Error('a sonic worker cannot start sonic');
  if (!task.trim()) throw new Error('the sub-task is empty');
  let status: Partial<JobStatus> | undefined;
  try { status = readJsonBounded(join(dir, jobFiles.status), 64 * 1024) as JobStatus; }
  catch { /* No known worker session yet. */ }
  const harness = parent.cli?.agent ?? 'pi';
  const id = parent.cli ? status?.agent_session_id : status?.session_id ?? piSessionIdentity(parent, status?.session_file)?.id;
  const dispatcher = ['pi', 'claude', 'codex'].includes(harness) && typeof id === 'string' && id ? { harness, id } : undefined;
  const result = await dispatchJob({
    role: 'sonic', request_key: `sonic:${randomUUID()}`, cwd, task,
  }, jobCallerPane(parent), { parent, dispatcher });
  if (!('job' in result) || !result.job) {
    const code = 'code' in result ? result.code : undefined;
    const message = ('error' in result ? result.error : undefined) ?? code;
    if (code === 'invalid_arguments') {
      throw Object.assign(new Error(`invalid_arguments: ${message}`), { code });
    }
    throw new Error(message);
  }
  // A launch failure with a job receipt is also collectable via wait.
  return { job: result.job, thinking: result.thinking ?? null, thinking_source: result.thinking_source,
    attempts: result.attempts, used_place: result.used_place,
    ...(result.route ? { route: result.route } : {}),
    ...('ok' in result && result.ok === false ? { error: result.reason } : {}) };
}

// A native pi start watches only its own launch receipt. This notice never collects the report.
export function watchSonicReady(id: string, signal: AbortSignal, ready: (state: 'settled' | 'failed') => void,
  onCheckpoint?: (text: string) => void) {
  if (signal.aborted) return;
  const child = join(workerJob().root, id);
  let watcher: fs.FSWatcher, lastCheckpoint: string | undefined;
  function check(file?: string) {
    if (signal.aborted) return;
    const { state } = sonicState(child);
    if (state === 'open') {
      if (onCheckpoint && (!file || file === jobFiles.progress)) {
        const checkpoint = readJobProgress(child).progress.filter(p => p.source === 'checkpoint').at(-1);
        if (checkpoint && (!lastCheckpoint || checkpoint.at > lastCheckpoint)) {
          lastCheckpoint = checkpoint.at;
          onCheckpoint(checkpoint.text);
        }
      }
      return;
    }
    watcher.close();
    if (!fs.existsSync(join(child, 'sonic-collected'))) ready(state);
  }
  try {
    watcher = fs.watch(child, { persistent: false, signal }, (_event, file) => {
      if (file && file !== jobFiles.status && file !== jobFiles.progress) return;
      try { check(file ?? undefined); } catch { /* Retry on the next write. */ }
    });
    watcher.on('error', () => watcher.close());
    check(); // Subscribe before reading: the child may already have settled during launch.
  } catch { /* Best effort; explicit wait and the end-of-turn collection prompt remain available. */ }
}

export async function waitSonic({ dir, root, job: parent }: Worker, ids?: string[], seconds = 480, signal?: AbortSignal) {
  if (!Number.isFinite(seconds * 1000) || seconds < 0) throw new Error('--timeout must be a nonnegative number of seconds');
  if (!ids?.length) {
    try { ids = fs.readdirSync(join(dir, jobFiles.sonic)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ids = []; }
    ids = ids.filter((id) => fs.existsSync(join(root, id, jobFiles.job)) && !fs.existsSync(join(root, id, 'sonic-collected')));
  }
  const children = [...new Set(ids)].map((id) => {
    if (!idPattern.test(id)) throw new Error('--job must be a sonic child job id');
    const child = join(root, id);
    const job = readJob(child);
    if (fs.realpathSync(child) !== child || job.parent_job !== parent.job || job.role !== 'sonic') {
      throw new Error('job is not a sonic child of this --dir');
    }
    return { id, child };
  });
  signal?.throwIfAborted();
  const readStates = () => children.map(({ id, child }) => ({ id, child, ...sonicState(child) }));
  let states;
  if (children.length === 0 || seconds === 0) {
    states = readStates();
  } else {
    let openChildren = children;
    const openIds = new Set(children.map(({ id }) => id));
    states = await waitUntilFs<ReturnType<typeof readStates>>({
      targets: () => {
        if (openChildren.length <= 32) {
          return openChildren.map(({ child }) => ({
            dir: child,
            filter: (name) => name === null || name === jobFiles.status || name === jobFiles.report,
          }));
        }
        return [{
          dir: root,
          recursive: true,
          filter: (name) => {
            if (name === null) return true;
            const sep = name.indexOf('/');
            if (sep < 0) return openIds.has(name);
            const id = name.slice(0, sep);
            const file = name.slice(sep + 1);
            return openIds.has(id) && (file === jobFiles.status || file === jobFiles.report);
          },
        }];
      },
      timeoutMs: seconds * 1000,
      signal,
      coalesceMs: 15,
      fallbackIntervalMs: 5000,
      isTransientError: (error) => error instanceof SyntaxError,
      check: ({ timedOut }) => {
        const current = readStates();
        openChildren = current.filter(({ state }) => state === 'open');
        openIds.clear();
        for (const { id } of openChildren) openIds.add(id);
        if (openChildren.length === 0 || timedOut) return { done: true, value: current };
        return { done: false };
      },
    });
  }
  const working = states.filter(({ state }) => state === 'open').map(({ id }) => id);
  const failed = states.filter(({ state }) => state === 'failed').map(({ id, child, reason }) => {
    const latest_progress = readJobProgress(child).latest_progress;
    return { id, reason, ...(latest_progress ? { latest_progress } : {}) };
  });
  const reports = [];
  for (const { id, child, state } of states) {
    if (state !== 'settled') continue;
    const path = join(child, jobFiles.report);
    try { reports.push({ id, path, body: fs.readFileSync(path, 'utf8') }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      failed.push({ id, reason: 'settled without a report on disk' });
    }
  }
  for (const { id } of reports) fs.writeFileSync(join(root, id, 'sonic-collected'), '', { mode: 0o600 });
  return { reports, working, failed };
}

export async function workerLease({ job, root }: Worker, args: Record<string, unknown>, signal?: AbortSignal, fallback = false) {
  return takeLease(args, { home: dirname(root), cwd: job.cwd, holder: job.job, worker: true, fallback }, signal);
}

export async function callWorkerTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const context = workerJob();
  const string = (key: string, value = args[key]) => {
    if (typeof value !== 'string') throw new Error(`invalid_arguments: ${key}`);
    return value;
  };
  const strings = (key: string) => {
    const value = args[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
      throw new Error(`invalid_arguments: ${key}`);
    }
    return value;
  };
  switch (name) {
    case 'hud_report': return finishReport(context, args.turn, string('text'), args);
    case 'hud_progress': return progress(context, string('message'));
    case 'hud_lease': return workerLease(context, args, signal);
    case 'hud_ask': return ask(context, { question: string('question'), default: string('default'), options: strings('options'),
      context: args.context === undefined ? undefined : string('context') }, undefined, signal);
    case 'hud_sonic':
      for (const key of ['preset', 'on', 'model', 'thinking'])
        if (args[key] !== undefined) throw new Error(`invalid_arguments: unexpected ${key}`);
      if (args.task !== undefined) {
        if (args.wait !== undefined) throw new Error('start or wait for sonic, not both (wait cannot be passed with task)');
        return startSonic(context, string('task'), args.cwd);
      }
      if (args.cwd !== undefined) throw new Error('cwd is only used when starting sonic');
      if (args.timeout_s !== undefined && typeof args.timeout_s !== 'number') {
        throw new Error('invalid_arguments: sonic wait');
      }
      return waitSonic(context, strings('wait'), args.timeout_s, signal);
  }
  throw new Error('unknown worker tool');
}

const string = { type: 'string' };
const strings = { type: 'array', items: string };
// MCP checks calls against workerTools and advertises listWorkerTools; use the same role-aware list.
export { workerTools as listWorkerTools };
export async function workerTools(cli = false) {
  let role: string | undefined, headless = false;
  try {
    const { job } = workerJob();
    role = job.role;
    cli = cli && Boolean(job.cli);
    headless = cli && job.headless === true;
  } catch { /* Keep the caller's schema when no job receipt is available. */ }
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  return [
    tool('hud_report', 'Finish the turn by publishing your report. Returns its path. Give a one-line plain summary of the result; code roles list the files changed.',
      {
        text: string,
        ...(cli ? { turn: { ...string, description: 'Use the token in the prompt you are answering, not a newer turn.' } } : {}),
        summary: { ...string, maxLength: REPORT_LINE_LIMIT, description: `One-line result summary (up to ${REPORT_LINE_LIMIT} code points, no Markdown heading).` },
        files: { type: 'array', items: { ...string, maxLength: 260 }, maxItems: 50, description: 'Optional list of relative paths to files changed by code roles (up to 50).' },
        skip_checks_reason: { ...string, minLength: 1, maxLength: REPORT_LINE_LIMIT, description: 'If blocked, skip the project’s worker checks and include this reason in the report digest.' },
        preview: { ...string, maxLength: 260, description: 'HTML preview path relative to cwd, if the brief did not specify one.' },
      },
      cli ? ['text', 'turn'] : ['text']),
    tool('hud_ask', headless ? 'Ask the orchestrator and end the turn. The answer resumes this session.'
      : 'Ask the orchestrator and wait for an answer. Never wait on terminal input.',
      { question: string, default: string, options: strings, context: string }, ['question', 'default']),
    tool('hud_sonic', 'Start one sonic child with task; returns its id without waiting for the report. Sonic cannot start children. To collect, pass wait with ids, or omit task and ids for all uncollected children (timeout_s applies to wait; defaults to 480). Pi sends a ready notice.',
      { task: string, cwd: { ...string, description: "Start only. Defaults to the parent job's working directory. Resolve relative paths there; the destination must stay inside the parent project." },
        wait: strings, timeout_s: { type: 'number', minimum: 0, description: 'Wait only. Seconds to wait before returning still-working ids; defaults to 480.' } }),
    tool('hud_progress', 'Publish an optional milestone (one line, up to 240 characters).', { message: string }, ['message']),
    LEASE_TOOL,
  ].filter(({ name }) => role !== 'sonic' || (name !== 'hud_sonic' && name !== 'hud_ask'));
}

function questionBody(q: Question) {
  return [
    `# Question q${q.n} from ${q.tag}`, '', q.question.trim(), '',
    ...(q.options?.length ? ['Options:', ...q.options.map((o) => `- ${o}`), ''] : []),
    `Default if unanswered: ${q.default.trim()}`, '',
    ...(q.context ? ['', `Context: ${q.context.trim()}`] : []), '',
    `Answer: write the answer to ${q.afile}`, '',
  ].join('\n');
}
function questionLine(q: Question, job: Job) {
  const oneLine = q.question.replace(/\s+/g, ' ').trim().slice(0, 400);
  const options = q.options?.length ? ` | options: ${q.options.join(' / ')}` : '';
  return `[${q.tag}] QUESTION q${q.n}: ${oneLine}${options} | default: ${q.default.trim()} | full text: ${q.qfile} | reply: hud_respond job=${job.job} request_id=q${q.n}`;
}
function publishQuestion(qa: string, input: QuestionInput & { tag: string }) {
  let highest = 0;
  for (const file of fs.readdirSync(qa)) {
    const match = /^q(\d+)(?:\.answer)?\.md$/.exec(file);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (let n = highest + 1;; n++) {
    const q = { ...input, n, qfile: join(qa, `q${n}.md`), afile: join(qa, `q${n}.answer.md`) };
    const answerExistedAtCreation = fs.existsSync(q.afile);
    try { writePrivateFile(q.qfile, questionBody(q), { exclusive: true, mkdir: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    return { ...q, answerExistedAtCreation, questionMtimeMs: fs.statSync(q.qfile).mtimeMs };
  }
}
function readQuestionAnswer(q: ReturnType<typeof publishQuestion>) {
  try {
    const answer = fs.statSync(q.afile);
    if (!answer.isFile() || answer.size === 0 || (q.answerExistedAtCreation && answer.mtimeMs < q.questionMtimeMs)) return undefined;
    return fs.readFileSync(q.afile, 'utf8').trim() || undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function orchestrator(dir: string) {
  try {
    const line = fs.readFileSync(join(dir, jobFiles.session), 'utf8').split('\n').find((row) => row.startsWith('ORCH='));
    return line?.slice(5) ?? '';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return ''; }
}

export async function ask({ dir, job }: Pick<Worker, 'dir' | 'job'>, input: QuestionInput, timeoutRaw = process.env.HUD_ASK_TIMEOUT, signal?: AbortSignal) {
  if (job.role === 'sonic') throw new Error('sonic cannot ask questions');
  signal?.throwIfAborted();
  const tag = `${typeof job.role === 'string' ? job.role : 'cli'}@${basename(job.cwd || dir)}`;
  const qa = join(dir, jobFiles.qa);
  fs.mkdirSync(qa, { recursive: true, mode: 0o700 });
  const published = publishQuestion(qa, { ...input, tag });
  let pushed = 'not pushed (no --notify / --orchestrator)';
  // SESSION.txt describes the launch. The receipt can name a new main session after a handoff.
  const receipt = readJob(dir);
  const orch = jobCallerPane(receipt) || orchestrator(dir);
  if (receipt.scout_only === true) pushed = 'handled by scouted dispatch';
  else if (receipt.ticket_queue) pushed = 'handled by the ticket queue';
  else if (taskDelivery(dir, orch)) pushed = 'delivered by MCP task';
  else if (typeof orch === 'string' && orch && !/[\u0000-\u001f\u007f-\u009f]/.test(orch)) {
    const ran = await notify(orch, questionLine(published, job), dirname(dirname(resolve(dir))), { signal });
    signal?.throwIfAborted();
    const detail = ran.error?.message ?? ((ran.stderr || ran.stdout || '').trim().slice(0, 200) || `exit ${ran.status}`);
    pushed = ran.skipped ? 'delivered by hud watch' : ran.status === 0 ? (ran.detail || `pushed via "herdr agent prompt ${orch}"`) : `notify failed (${ran.detail ? `${ran.detail}; ` : ''}${detail})`;
  }
  if (job.headless) {
    if (job.cli) {
      capturePiTree(dir);
      writePrivateFile(join(dir, jobFiles.pauseRequested), `q${published.n}`, { mkdir: false });
      // Keep the CLI inside the tool call until its runner ends this process. No next model action.
      return new Promise<never>(() => {});
    }
    return `Question q${published.n} recorded (${pushed}); end this turn without acting on a default. The orchestrator's answer resumes this session.`;
  }
  const timeoutSec = timeoutRaw !== undefined && /^\d+$/.test(String(timeoutRaw)) ? Number(timeoutRaw) : 1200;
  const started = performance.now();
  let answer;
  if (timeoutSec > 0) {
    const answerName = `q${published.n}.answer.md`;
    answer = await waitUntilFs({
      targets: [{ dir: qa, filter: (name) => name === null || name === answerName }],
      timeoutMs: timeoutSec * 1000,
      signal,
      coalesceMs: 15,
      fallbackIntervalMs: 5000,
      check: ({ timedOut }) => {
        const value = readQuestionAnswer(published);
        if (value !== undefined) return { done: true, value };
        if (timedOut) return { done: true, value: undefined };
        return { done: false };
      },
    });
  }
  const waited = Math.round((performance.now() - started) / 1000);
  if (!answer && timeoutSec > 0) recordQuestionTimeout(dir, `q${published.n}`);
  const defaultLine = `Proposed default: ${input.default.trim()}. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report.`;
  return answer
    ? `ANSWER from the orchestrator (q${published.n}, after ${waited}s):\n\n${answer}`
    : timeoutSec === 0
      ? `Question q${published.n} recorded (${pushed}); not waiting. ${defaultLine}`
      : `No answer to q${published.n} within ${timeoutSec}s (${pushed}). ${defaultLine}`;
}
