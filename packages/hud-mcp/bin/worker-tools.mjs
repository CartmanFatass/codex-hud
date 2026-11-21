/** Worker protocol shared by MCP, the native pi extension and the CLI fallbacks. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { notify, taskDelivery } from './hud-notify.mjs';
import { sonicState } from './sonic-jobs.mjs';
import { LEASE_TOOL, takeLease } from '../dist/src/roles/lease.js';

const idPattern = /^j[0-9a-f]{16}$/;
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const dispatch = () => import('../dist/packages/hud-mcp/src/thin-main.js');
const judge = () => import('../dist/packages/hud-mcp/src/cli-judge.js');
function readJob(dir) {
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
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

function replace(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// Omit text for the fallback command, which declares a report the worker wrote itself.
export async function finishReport({ dir, job }, turn, text) {
  if (job.bro || job.jev) throw new Error('only local workers can declare a report');
  if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('write a nonempty report');
  const { DONE_FILE, readTurn, turnToken, reportSignature } = await judge();
  const path = join(dir, 'report.md');
  if (job.cli) {
    const current = readTurn(dir);
    if (!current || turn !== turnToken(current)) throw new Error('use the turn token from the prompt you are answering');
    if (text !== undefined) replace(path, text);
    const sig = reportSignature(dir);
    if (!sig || sig === current.report_sig) throw new Error('write a fresh report for this turn first');
    const latest = readTurn(dir);
    if (!latest || turnToken(latest) !== turn) throw new Error('the turn changed; no receipt recorded');
    replace(join(dir, DONE_FILE), JSON.stringify({ seq: current.seq, sent_at: current.sent_at, report_sig: sig, at: new Date().toISOString() }) + '\n');
  } else {
    // Pi declares completion natively. Capture ancestry before native shutdown can orphan it.
    if (turn !== undefined) throw new Error('pi does not use a turn token');
    const { rememberWorkerTree } = await import('../dist/src/roles/worker-tree.js');
    if (text !== undefined) replace(path, text);
    if (!reportSignature(dir)) throw new Error('write the pi report first');
    const status = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
    const { snapshot, issue } = rememberWorkerTree(dir, status);
    if (issue || !snapshot) throw new Error(issue ?? 'worker-tree snapshot unresolved: no ancestry snapshot could be captured');
  }
  return { path };
}

export function progress({ dir }, message) {
  const text = [...message.replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(/\p{Cc}/gu, '').trim()]
    .slice(0, 240).join('').trimEnd();
  if (!text) throw new Error('usage: hud-progress [--dir <job-dir>] <message>');
  const record = JSON.stringify({ at: new Date().toISOString(), text }) + '\n';
  const file = join(dir, 'progress.jsonl');
  const { O_RDWR, O_CREAT, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const limit = 64 * 1024;
    if (!fs.fstatSync(fd).isFile()) throw new Error('progress.jsonl is not a regular file');
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > limit) throw new Error('progress.jsonl exceeds 64 KiB');
    const previous = buffer.subarray(0, size).toString('utf8');
    const rows = previous.trimEnd().split('\n').filter(Boolean);
    if (rows.length < 50 && (!previous || previous.endsWith('\n'))) fs.appendFileSync(fd, record);
    else replace(file, [...rows.slice(-49), record.trimEnd()].join('\n') + '\n');
  } finally { fs.closeSync(fd); }
  return { ok: true };
}

export async function startSonic({ job: parent }, task, thinking) {
  if (parent.role === 'sonic') throw new Error('a sonic worker cannot start sonic');
  if (thinking !== undefined && !thinkingLevels.includes(thinking)) throw new Error('invalid sonic thinking level');
  if (!task.trim()) throw new Error('the sub-task is empty');
  const { dispatchJob } = await dispatch();
  const result = await dispatchJob({
    role: 'sonic', request_key: `sonic:${randomUUID()}`, cwd: parent.cwd, task, thinking,
  }, parent.herdr_pane, parent.job);
  if (!result.job) throw new Error(result.error ?? result.code);
  // A launch failure with a job receipt is also collectable via wait.
  return { job: result.job, thinking: result.thinking ?? null, attempts: result.attempts, used_place: result.used_place,
    ...(result.ok === false ? { error: result.reason } : {}) };
}

export async function waitSonic({ dir, root, job: parent }, ids, seconds = 480, signal) {
  if (!Number.isFinite(seconds * 1000) || seconds < 0) throw new Error('--timeout must be a nonnegative number of seconds');
  if (!ids?.length) {
    try { ids = fs.readdirSync(join(dir, '.sonic')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ids = []; }
    ids = ids.filter((id) => fs.existsSync(join(root, id, 'job.json')) && !fs.existsSync(join(root, id, 'sonic-collected')));
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
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    signal?.throwIfAborted();
    const states = children.map(({ id, child }) => ({ id, child, ...sonicState(child) }));
    const working = states.filter(({ state }) => state === 'open').map(({ id }) => id);
    const left = deadline - performance.now();
    if (working.length && left > 0) {
      await sleep(Math.min(250, left), undefined, { signal });
      continue;
    }
    const failed = states.filter(({ state }) => state === 'failed').map(({ id, reason }) => ({ id, reason }));
    const reports = [];
    for (const { id, child, state } of states) {
      if (state !== 'settled') continue;
      const path = join(child, 'report.md');
      try { reports.push({ id, path, body: fs.readFileSync(path, 'utf8') }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        failed.push({ id, reason: 'settled without a report on disk' });
      }
    }
    for (const { id } of reports) fs.writeFileSync(join(root, id, 'sonic-collected'), '', { mode: 0o600 });
    return { reports, working, failed };
  }
}

export const workerLease = ({ job, root }, args, signal, fallback = false) => takeLease(args,
  { home: dirname(root), cwd: job.cwd, holder: job.job, worker: true, fallback }, signal);

export async function callWorkerTool(name, args, signal) {
  const context = workerJob();
  const string = (key, value = args[key]) => {
    if (typeof value !== 'string') throw new Error(`invalid_arguments: ${key}`);
    return value;
  };
  const strings = (key) => {
    const value = args[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
      throw new Error(`invalid_arguments: ${key}`);
    }
    return value;
  };
  switch (name) {
    case 'hud_report': return finishReport(context, args.turn, string('text'));
    case 'hud_progress': return progress(context, string('message'));
    case 'hud_lease': return workerLease(context, args, signal);
    case 'hud_ask': return ask(context, { question: string('question'), default: string('default'), options: strings('options'),
      context: args.context === undefined ? undefined : string('context') }, undefined, signal);
    case 'hud_sonic':
      if (args.task !== undefined) {
        if (args.wait !== undefined || args.timeout_s !== undefined) throw new Error('start or wait for sonic, not both');
        return startSonic(context, string('task'), args.thinking);
      }
      if (args.thinking !== undefined || (args.timeout_s !== undefined && typeof args.timeout_s !== 'number')) {
        throw new Error('invalid_arguments: sonic wait');
      }
      return waitSonic(context, strings('wait'), args.timeout_s, signal);
  }
  throw new Error('unknown worker tool');
}

const string = { type: 'string' };
const strings = { type: 'array', items: string };
export async function listWorkerTools(cli) {
  let context;
  try { context = workerJob(); } catch { return workerTools(cli); }
  let supported;
  if (context.job.role !== 'sonic') {
    try { supported = await (await dispatch()).sonicThinking(context.job.cwd); }
    catch { /* Missing model facts do not prevent listing worker tools. */ }
  }
  return workerTools(cli && Boolean(context.job.cli), supported);
}

export function workerTools(cli, supported) {
  const tool = (name, description, properties, required = []) => ({ name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  return [
    tool('hud_report', 'Finish the turn by publishing your report. Returns its path.',
      { text: string, ...(cli ? { turn: { ...string, description: 'Use the token in the prompt you are answering, not a newer turn.' } } : {}) },
      cli ? ['text', 'turn'] : ['text']),
    tool('hud_ask', 'Ask the orchestrator and wait for an answer. Never wait on terminal input.',
      { question: string, default: string, options: strings, context: string }, ['question', 'default']),
    tool('hud_sonic', 'Start one sonic child with task and optional thinking; returns its id and effective thinking without waiting for the report. Sonic cannot start children. To collect, pass wait with ids, or omit task and ids for all uncollected children. timeout_s defaults to 480; 0 checks once.',
      { task: string, thinking: { ...string, ...(supported?.length ? { enum: supported } : { description: thinkingLevels.join(', ') }) },
        wait: strings, timeout_s: { type: 'number', minimum: 0 } }),
    tool('hud_progress', 'Publish an optional milestone (one line, up to 240 characters).', { message: string }, ['message']),
    LEASE_TOOL,
  ];
}

function questionBody(q) {
  return [
    `# Question q${q.n} from ${q.tag}`, '', q.question.trim(), '',
    ...(q.options?.length ? ['Options:', ...q.options.map((o) => `- ${o}`), ''] : []),
    `Default if unanswered: ${q.default.trim()}`, '',
    ...(q.context ? ['', `Context: ${q.context.trim()}`] : []), '',
    `Answer: write the answer to ${q.afile}`, '',
  ].join('\n');
}
function questionLine(q, job) {
  const oneLine = q.question.replace(/\s+/g, ' ').trim().slice(0, 400);
  const options = q.options?.length ? ` | options: ${q.options.join(' / ')}` : '';
  return `[${q.tag}] QUESTION q${q.n}: ${oneLine}${options} | default: ${q.default.trim()} | full text: ${q.qfile} | reply: hud_respond job=${job.job} request_id=q${q.n}`;
}
function publishQuestion(qa, input) {
  let highest = 0;
  for (const file of fs.readdirSync(qa)) {
    const match = /^q(\d+)(?:\.answer)?\.md$/.exec(file);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (let n = highest + 1;; n++) {
    const q = { ...input, n, qfile: join(qa, `q${n}.md`), afile: join(qa, `q${n}.answer.md`) };
    const answerExistedAtCreation = fs.existsSync(q.afile);
    try { fs.writeFileSync(q.qfile, questionBody(q), { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    return { ...q, answerExistedAtCreation, questionMtimeMs: fs.statSync(q.qfile).mtimeMs };
  }
}
function readQuestionAnswer(q) {
  try {
    const answer = fs.statSync(q.afile);
    if (!answer.isFile() || answer.size === 0 || (q.answerExistedAtCreation && answer.mtimeMs < q.questionMtimeMs)) return undefined;
    return fs.readFileSync(q.afile, 'utf8').trim() || undefined;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function orchestrator(dir) {
  try {
    const line = fs.readFileSync(join(dir, 'SESSION.txt'), 'utf8').split('\n').find((row) => row.startsWith('ORCH='));
    return line?.slice(5) ?? '';
  } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

export async function ask({ dir, job }, input, timeoutRaw = process.env.HUD_ASK_TIMEOUT, signal) {
  const tag = `${typeof job.role === 'string' ? job.role : 'cli'}@${basename(job.cwd || dir)}`;
  const qa = join(dir, 'qa');
  fs.mkdirSync(qa, { recursive: true, mode: 0o700 });
  const published = publishQuestion(qa, { ...input, tag });
  let pushed = 'not pushed (no --notify / --orchestrator)';
  // SESSION.txt describes the launch. The receipt can name a new main session after a handoff.
  const orch = readJob(dir).herdr_pane || orchestrator(dir);
  if (taskDelivery(dir, orch)) pushed = 'delivered by MCP task';
  else if (typeof orch === 'string' && orch && !/[\u0000-\u001f\u007f-\u009f]/.test(orch)) {
    const ran = notify(orch, questionLine(published, job), dirname(dirname(resolve(dir))));
    const detail = ran.error?.message ?? ((ran.stderr || ran.stdout || '').trim().slice(0, 200) || `exit ${ran.status}`);
    pushed = ran.skipped ? 'delivered by hud watch' : ran.status === 0 ? (ran.detail || `pushed via "herdr agent prompt ${orch}"`) : `notify failed (${ran.detail ? `${ran.detail}; ` : ''}${detail})`;
  }
  const timeoutSec = timeoutRaw !== undefined && /^\d+$/.test(String(timeoutRaw)) ? Number(timeoutRaw) : 1200;
  const started = Date.now();
  let answer;
  while (timeoutSec > 0 && Date.now() - started < timeoutSec * 1000) {
    answer = readQuestionAnswer(published);
    if (answer !== undefined) break;
    const left = timeoutSec * 1000 - (Date.now() - started);
    if (left <= 0) break;
    await sleep(Math.min(2000, left), undefined, { signal });
  }
  const waited = Math.round((Date.now() - started) / 1000);
  const defaultLine = `Proposed default: ${input.default.trim()}. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report.`;
  return answer
    ? `ANSWER from the orchestrator (q${published.n}, after ${waited}s):\n\n${answer}`
    : timeoutSec === 0
      ? `Question q${published.n} recorded (${pushed}); not waiting. ${defaultLine}`
      : `No answer to q${published.n} within ${timeoutSec}s (${pushed}). ${defaultLine}`;
}
