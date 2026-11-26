/** Shared QA protocol: question publication, fs-watch wake, and in-process notification. */
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Job } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { recordQuestionTimeout } from '../roles/job-archive.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { notify, taskDelivery } from '../roles/notify.js';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import { waitUntilFs } from '../utils/fs-wait.js';

export interface QuestionInput {
  question: string;
  default: string;
  options?: string[];
  context?: string;
}

export interface Question extends QuestionInput {
  n: number;
  tag: string;
  qfile: string;
  afile: string;
}

export interface PublishedQuestion extends Question {
  answerExistedAtCreation: boolean;
  questionMtimeMs: number;
}

export const DEFAULT_ASK_TIMEOUT_S = 1200;

export function parseAskTimeoutSeconds(raw = process.env.HUD_ASK_TIMEOUT): number {
  return raw !== undefined && /^\d+$/.test(String(raw)) ? Number(raw) : DEFAULT_ASK_TIMEOUT_S;
}

export function questionBody(q: Question): string {
  return [
    `# Question q${q.n} from ${q.tag}`, '', q.question.trim(), '',
    ...(q.options?.length ? ['Options:', ...q.options.map((o) => `- ${o}`), ''] : []),
    `Default if unanswered: ${q.default.trim()}`, '',
    ...(q.context ? ['', `Context: ${q.context.trim()}`] : []), '',
    `Answer: write the answer to ${q.afile}`, '',
  ].join('\n');
}

export function questionLine(q: Question, job: Pick<Job, 'job'>): string {
  const oneLine = q.question.replace(/\s+/g, ' ').trim().slice(0, 400);
  const options = q.options?.length ? ` | options: ${q.options.join(' / ')}` : '';
  return `[${q.tag}] QUESTION q${q.n}: ${oneLine}${options} | default: ${q.default.trim()} | full text: ${q.qfile} | reply: hud_respond job=${job.job} request_id=q${q.n}`;
}

/** Include answer-only slots and gaps, even after this writer has already asked a question. */
export function nextQuestionNumber(existingFiles: string[], counter = 0): number {
  let highest = counter;
  for (const file of existingFiles) {
    const match = /^q(\d+)(?:\.answer)?\.md$/.exec(file);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** wx is the reservation: competing writers may pick the same n, but never overwrite each other. */
export function publishQuestion(qaDir: string, input: QuestionInput & { tag: string }, counter = 0): PublishedQuestion {
  fs.mkdirSync(qaDir, { recursive: true, mode: 0o700 });
  for (let n = nextQuestionNumber(fs.readdirSync(qaDir), counter); ; n++) {
    const q: Question = { ...input, n, qfile: join(qaDir, `q${n}.md`), afile: join(qaDir, `q${n}.answer.md`) };
    const answerExistedAtCreation = fs.existsSync(q.afile);
    try {
      writePrivateFile(q.qfile, questionBody(q), { exclusive: true, mkdir: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    return { ...q, answerExistedAtCreation, questionMtimeMs: fs.statSync(q.qfile).mtimeMs };
  }
}

/** A pre-existing answer is only eligible after it has been refreshed for this question. */
export function readQuestionAnswer(q: PublishedQuestion, deadlineMs = Infinity): string | undefined {
  try {
    const answer = fs.statSync(q.afile);
    if (
      !answer.isFile() ||
      answer.size === 0 ||
      answer.mtimeMs > deadlineMs ||
      (q.answerExistedAtCreation && answer.mtimeMs < q.questionMtimeMs)
    ) {
      return undefined;
    }
    return fs.readFileSync(q.afile, 'utf8').trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export function orchestratorPane(dir: string): string {
  try {
    const line = fs.readFileSync(join(dir, jobFiles.session), 'utf8').split('\n').find((row) => row.startsWith('ORCH='));
    return line?.slice(5) ?? '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}

function readReceipt(dir: string, fallback: Job): Job {
  try {
    const job = readJsonFile(join(dir, jobFiles.job)) as Job;
    if (job.job === basename(dir)) return job;
  } catch {
    /* Fall back to the caller's job receipt if unreadable. */
  }
  return fallback;
}

/** Deliver the question notice in-process (no shell/hud-notify spawn). */
export async function notifyQuestion(
  dir: string,
  job: Job,
  published: PublishedQuestion,
  signal?: AbortSignal
): Promise<string> {
  let pushed = 'not pushed (no --notify / --orchestrator)';
  // SESSION.txt describes the launch. The receipt can name a new main session after a handoff.
  const receipt = readReceipt(dir, job);
  const orch = jobCallerPane(receipt) || orchestratorPane(dir);
  if (receipt.scout_only === true) pushed = 'handled by scouted dispatch';
  else if (receipt.ticket_queue) pushed = 'handled by the ticket queue';
  else if (taskDelivery(dir, orch)) pushed = 'delivered by MCP task';
  else if (typeof orch === 'string' && orch && !/[\u0000-\u001f\u007f-\u009f]/.test(orch)) {
    const ran = await notify(orch, questionLine(published, job), dirname(dirname(resolve(dir))), { signal });
    signal?.throwIfAborted();
    const detail = ran.error?.message ?? ((ran.stderr || ran.stdout || '').trim().slice(0, 200) || `exit ${ran.status}`);
    pushed = ran.skipped
      ? 'delivered by hud watch'
      : ran.status === 0
        ? (ran.detail || `pushed via "herdr agent prompt ${orch}"`)
        : `notify failed (${ran.detail ? `${ran.detail}; ` : ''}${detail})`;
  }
  return pushed;
}

export function questionTag(dir: string, job: Pick<Job, 'role' | 'cwd'>): string {
  return `${typeof job.role === 'string' ? job.role : 'cli'}@${basename(job.cwd || dir)}`;
}

/** Watch a QA directory for answer writes, coalescing bursts (~15 ms wake). */
export function watchQaDir(qaDir: string, onChange: () => void, coalesceMs = 15): () => void {
  let closed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;
  const trigger = () => {
    if (closed || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!closed) onChange();
    }, coalesceMs);
    pending.unref?.();
  };
  try {
    fs.mkdirSync(qaDir, { recursive: true, mode: 0o700 });
    watcher = fs.watch(qaDir, { persistent: false }, (_event, file) => {
      if (!file || /^q\d+\.answer\.md$/.test(String(file))) trigger();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    /* Fallback timer in the caller still polls if fs.watch is unavailable. */
  }
  return () => {
    closed = true;
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
    watcher?.close();
    watcher = undefined;
  };
}

/** Synchronous QA wait using fs-watch wake. */
export async function waitForQuestionAnswer(
  dir: string,
  qaDir: string,
  published: PublishedQuestion,
  timeoutSec: number,
  pushed: string,
  signal?: AbortSignal
): Promise<{ text: string; answer?: string; waitedSeconds: number }> {
  const started = performance.now();
  let answer: string | undefined;
  if (timeoutSec > 0) {
    const answerName = `q${published.n}.answer.md`;
    answer = await waitUntilFs({
      targets: [{ dir: qaDir, filter: (name) => name === null || name === answerName }],
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
  const waitedSeconds = Math.round((performance.now() - started) / 1000);
  if (!answer && timeoutSec > 0) recordQuestionTimeout(dir, `q${published.n}`);
  const defaultLine = `Proposed default: ${published.default.trim()}. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report.`;
  const text = answer
    ? `ANSWER from the orchestrator (q${published.n}, after ${waitedSeconds}s):\n\n${answer}`
    : timeoutSec === 0
      ? `Question q${published.n} recorded (${pushed}); not waiting. ${defaultLine}`
      : `No answer to q${published.n} within ${timeoutSec}s (${pushed}). ${defaultLine}`;
  return { text, answer, waitedSeconds };
}
