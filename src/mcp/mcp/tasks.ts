/** MCP task lifecycle, receipts, and batch delivery. */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { jobRowReportMeta, readJobProgress, type JobRow } from '../../collectors/thin-jobs.js';
import { questionFields } from '../../collectors/work-artifacts.js';
import { checkBinding, readCheckReceipt, sameChecks, CHECKS_FILE, CHECK_TIMEOUT_MS } from '../../roles/job-checks.js';
import { taskDelivery, notify } from '../../roles/notify.js';
import { writeJsonPrivate, readJsonBounded, readDirSafe, writePrivateFile } from '../../utils/atomic-fs.js';
import { procStat } from '../../utils/proc.js';
import { reportReadHint } from '../../utils/report-summary.js';
import { readTurn, turnToken } from '../cli-judge.js';
import type { BatchNotice, Job, McpTaskMarker } from '../job-contracts.js';
import { hasHeadlessSends, headlessFollowupReady } from '../headless-sends.js';
import { readLand, activeLand, isFlowId } from '../land-state.js';
import { landTask } from '../land.js';
import { jobFiles } from '../paths.js';
import {
  hudHome, findJob, directory, json, jobCache, readCachedStatus, readRow, slice, settled, fallbackResultLine,
  RESULT_HEAD_BYTES,
} from '../store/job-store.js';
import { locks, keyLock } from '../store/key-lock.js';
import { pruneTasks, MAX_MCP_TASKS } from '../task-bounds.js';
import { callerPane, session } from './session-state.js';

export const landActive = (id: string) => { const flow = readLand(hudHome, id); return !!flow && activeLand(flow); };

export const TASK_TTL = 3 * 60 * 60_000;
const TASK_POLL_MS = 5000;

export const taskContent = (text: string) => ({ content: [{ type: 'text', text }] });
type TaskStatus = BatchNotice['status'];
type TaskView = { status: TaskStatus; statusMessage: string; lastUpdatedAt: string; result?: ReturnType<typeof taskContent> };
export type HudTask = {
  id: string; job: string; role: string; pane: string; createdAt: string; fence?: string;
  reportBefore: number | null; seenQuestions: Set<string>; view: TaskView; attentionBefore?: number;
  expiresAt?: number; ttlMs?: number; recovered?: true;
};
export let tasks = new Map<string, HudTask>(), activeTasks = new Map<string, HudTask>();

type TaskReceipt = { id: string; expiresAt: number };
type JobTaskReceipt = TaskReceipt & Omit<HudTask, 'seenQuestions'> & { seenQuestions: string[] };
const taskRoot = join(hudHome, 'mcp-tasks');
const jobTaskId = /^j[0-9a-f]{16}:[0-9a-f]{16}$/;
const nativeCaller = process.env.CLAUDE_CODE_SESSION_ID || null;
// Scope receipts to the reconnecting caller, including predictable land IDs. Do not store the native session ID.
const taskCaller = createHash('sha256').update(JSON.stringify([
  callerPane, nativeCaller, callerPane || nativeCaller ? null : process.cwd(),
])).digest('hex').slice(0, 32);
const taskFile = (id: string) => join(taskRoot, `${id}.${taskCaller}.json`);
export function saveTaskReceipt(receipt: TaskReceipt | JobTaskReceipt) {
  try { writeJsonPrivate(taskFile(receipt.id), receipt); } catch { /* Live tasks still work without disk recovery. */ }
}
export function persistTask(task: HudTask) {
  // Batch notices have no client task ID and stay tied to their live connection.
  if (!tasks.has(task.id) || task.expiresAt === undefined) return;
  saveTaskReceipt({ ...task, expiresAt: task.expiresAt, seenQuestions: [...task.seenQuestions] });
}
export function loadTaskReceipt(id: string): TaskReceipt | JobTaskReceipt | undefined {
  if (!jobTaskId.test(id) && !isFlowId(id)) return;
  try {
    const receipt = readJsonBounded(taskFile(id), 1024 * 1024) as TaskReceipt | JobTaskReceipt;
    if (receipt.id !== id || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= Date.now()) return;
    if (jobTaskId.test(id) && (!('job' in receipt) || receipt.job !== id.split(':')[0] ||
      typeof receipt.createdAt !== 'string' || !Array.isArray(receipt.seenQuestions) || !receipt.view)) return;
    return receipt;
  } catch { /* Missing, damaged or unreadable receipts are unknown tasks. */ }
}
let taskSweep: NodeJS.Timeout | undefined;
function sweepTaskReceipts(): string[] {
  const keep: string[] = [], cutoff = Date.now() - TASK_TTL;
  try {
    for (const file of readDirSafe(taskRoot)) {
      const match = /^([^.]+)\.([0-9a-f]{32})\.json(\.\d+\.[0-9a-f-]+\.tmp)?$/.exec(file);
      if (!match || (!jobTaskId.test(match[1]) && !isFlowId(match[1]))) continue;
      const path = join(taskRoot, file);
      try {
        // Age from the last write is only for cleanup; polling always checks expiresAt.
        if (fs.lstatSync(path).mtimeMs <= cutoff) fs.unlinkSync(path);
        else if (!match[3] && match[2] === taskCaller) keep.push(match[1]);
      } catch { /* The file may have disappeared during a concurrent sweep. */ }
    }
  } catch { /* Persistence is best-effort. */ }
  return keep;
}
function recoverTask(receipt: JobTaskReceipt): HudTask {
  const task: HudTask = { ...receipt, seenQuestions: new Set(receipt.seenQuestions), recovered: true };
  tasks.set(task.id, task);
  armExpiry(task);
  pruneTasks(tasks, Date.now(), evictTask);
  return task;
}
export function resumeTaskReceipts() {
  if (taskSweep) return;
  const pending = sweepTaskReceipts().map(loadTaskReceipt).filter((entry): entry is JobTaskReceipt =>
    !!entry && 'job' in entry && entry.view.status === 'working');
  // Reattach active tasks even if the first call after reconnect is a follow-up instead of a poll.
  for (const entry of pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (tasks.size >= MAX_MCP_TASKS) break;
    if (tasks.has(entry.id) || activeTasks.has(entry.job)) continue;
    try {
      const job = findJob(entry.job);
      if (!job || job.herdr_pane !== entry.pane || taskFence(job) !== entry.fence ||
          (callerPane && taskDelivery(directory(entry.job), callerPane))) continue;
      const task = recoverTask(entry);
      activeTasks.set(task.job, task);
      claimTask(task, job);
    } catch { /* A broken job receipt must not prevent discovery. */ }
  }
  taskSweep = setInterval(sweepTaskReceipts, 60_000).unref();
}
type PendingBatchNotice = { job: string; fence: string; status: TaskStatus; text: string };
export let batchTasks = new Map<string, HudTask>();
export let batchPending = new Map<string, PendingBatchNotice>();
let batchTimer: NodeJS.Timeout | undefined;
let batchSending: Promise<void> | undefined;
export let handedOff = false;
export let landTasks = new Set<string>();
const expiry = new Map<string, NodeJS.Timeout>();
function disarmExpiry(id: string) {
  const timer = expiry.get(id);
  if (timer) { clearTimeout(timer); expiry.delete(id); }
}
function armExpiry(task: HudTask) {
  disarmExpiry(task.id);
  const timer = setTimeout(() => {
    if (expiry.get(task.id) !== timer) return;
    expiry.delete(task.id);
    tasks.delete(task.id);
    releaseTask(task);
  }, Math.max(0, task.expiresAt! - Date.now())).unref();
  expiry.set(task.id, timer);
}
export function evictTask(task: HudTask) {
  disarmExpiry(task.id);
  releaseTask(task);
}
const markerFile = (task: HudTask) => join(directory(task.job), jobFiles.task);
export function claimTask(task: HudTask, job: Job) {
  if (!callerPane || job.herdr_pane !== callerPane) return;
  try {
    writePrivateFile(markerFile(task), JSON.stringify({ id: task.id, pane: callerPane, pid: process.pid,
      start: procStat(process.pid)?.start, expires: task.expiresAt ?? (Date.parse(task.createdAt) + TASK_TTL) } satisfies McpTaskMarker), { mkdir: false });
  } catch { /* If not recorded, question delivery keeps its ordinary fallback. */ }
}
export function extendTask(task: HudTask, job: Job) {
  const now = Date.now();
  task.expiresAt = now + TASK_TTL;
  task.ttlMs = Math.max(TASK_TTL, task.expiresAt - Date.parse(task.createdAt));
  if (tasks.has(task.id)) {
    tasks.delete(task.id);
    tasks.set(task.id, task);
    armExpiry(task);
  }
  persistTask(task);
  claimTask(task, job);
}
export function supersedeTask(id: string, detail: string) {
  const oldTask = activeTasks.get(id);
  if (!oldTask || oldTask.view.status !== 'working') return;
  const message = `${taskLabel(oldTask, detail)}. Use hud_read for the job's current state.`;
  updateTask(oldTask, 'cancelled', message, message);
}
export function releaseTask(task: HudTask) {
  if (activeTasks.get(task.job) === task) activeTasks.delete(task.job);
  try {
    const marker = json<McpTaskMarker>(markerFile(task));
    if (marker?.id === task.id && marker.pid === process.pid) fs.unlinkSync(markerFile(task));
  } catch { /* Stale delivery markers expire and cannot authorize cancellation. */ }
}
const questionFiles = (dir: string) => jobCache.readQa(dir).allQuestionFiles;
export const taskLabel = (task: HudTask, state: string) => `${task.job} (${task.role}) — ${state}`;
export const needsAttention = (row: JobRow) => row.blocked || row.state === 'blocked' || row.state === 'waiting_orchestrator';
export function beginTask(job: Job, reportBefore: number | null = null, answer?: string, prior?: JobRow, priorStatusAt?: number | null): HudTask {
  const createdAt = new Date().toISOString(), dir = directory(job.job);
  const qa = jobCache.readQa(dir);
  const openSet = new Set(qa.openIds);
  const task: HudTask = {
    id: `${job.job}:${randomBytes(8).toString('hex')}`, job: job.job, role: job.role, pane: job.herdr_pane, createdAt,
    reportBefore,
    attentionBefore: prior && needsAttention(prior)
      ? (priorStatusAt !== undefined ? (priorStatusAt ?? undefined) : (readCachedStatus(job.job).at ?? undefined))
      : undefined,
    seenQuestions: new Set(qa.allQuestionFiles.filter((name) =>
      !answer || name === `${answer}.md` || !openSet.has(name.slice(0, -3)))),
    view: { status: 'working', statusMessage: `${job.job} (${job.role}) — working`, lastUpdatedAt: createdAt },
  };
  claimTask(task, job);
  return task;
}
export function taskFence(job: Job) {
  if (job.headless_task_fence) return job.headless_task_fence;
  const turn = job.cli ? readTurn(directory(job.job)) : null;
  if (turn) return turn.caller_token ?? turnToken(turn);
  const sends = job.send_outcomes ?? [];
  for (let i = sends.length - 1; i >= 0; i--) if (!sends[i].exit_code) return sends[i].key;
  return job.created_at;
}
function wireTask(task: HudTask) {
  return { taskId: task.id, createdAt: task.createdAt, ttlMs: task.ttlMs ?? TASK_TTL, pollIntervalMs: TASK_POLL_MS, ...task.view };
}
export type TaskReply = ReturnType<typeof wireTask> & { resultType: 'task' };
export const isTaskReply = (value: unknown): value is TaskReply =>
  !!value && typeof value === 'object' && 'resultType' in value && value.resultType === 'task';
export function launchSummary(job: Job) {
  const facts = [job.used_place && `used_place: ${job.used_place}`, job.thinking && `thinking: ${job.thinking}`,
    job.thinking_source && `thinking_source: ${job.thinking_source}`, job.overflow_from && `overflowed from ${job.overflow_from}`,
    job.repair_of && `continued_as: ${job.job}`];
  if (job.attempts && job.attempts.length > 1) facts.push(`attempts: ${job.attempts.map(({ place, reason }) =>
    reason ? `${place} (${reason.replace(/\s+/g, ' ').slice(0, 160)})` : place).join(' → ')}`);
  return facts.filter(Boolean).join('; ');
}
export function finishTask(task: HudTask | undefined, job: Job, ok: boolean, launch?: string): TaskReply | undefined {
  if (!task) return;
  if (!ok) { releaseTask(task); return; }
  task.fence = taskFence(job);
  if (launch) task.view.statusMessage += ` — ${launch}`;
  tasks.delete(task.id);
  tasks.set(task.id, task);
  activeTasks.set(task.job, task);
  task.expiresAt = Date.now() + TASK_TTL;
  armExpiry(task);
  pruneTasks(tasks, Date.now(), evictTask);
  persistTask(task);
  return { resultType: 'task', ...wireTask(task), ...(job.route && { route: job.route }) };
}
export function registerBatchTask(task: HudTask | undefined, job: Job, ok: boolean): void {
  if (!task) return;
  if (!ok) { releaseTask(task); return; }
  task.fence = taskFence(job);
  activeTasks.set(task.job, task);
  task.expiresAt = Date.now() + TASK_TTL;
  batchTasks.set(task.job, task);
  ensureBatchTimer();
}
function stopBatchTimerIfIdle() {
  if (!batchTasks.size && !batchPending.size && batchTimer) {
    clearInterval(batchTimer);
    batchTimer = undefined;
  }
}
export function ensureBatchTimer() {
  if (!batchTimer && session.taskClient && !session.resumeRefusal && (batchTasks.size || batchPending.size)) {
    batchTimer = setInterval(() => { void pushBatchNotices(); }, 250).unref();
  }
}
function recordBatchNotice(item: PendingBatchNotice, taskId: string, via: 'push' | 'changes') {
  try {
    writePrivateFile(join(directory(item.job), jobFiles.batchNotice), JSON.stringify({
      task_id: taskId, fence: item.fence, status: item.status, delivered_at: new Date().toISOString(), via,
    } satisfies BatchNotice, null, 2) + '\n');
  } catch { /* Job directory gone or unreadable. */ }
}
function sampleBatchTasks() {
  const now = Date.now();
  for (const [id, task] of [...batchTasks.entries()]) {
    if (locks.has(`job:${id}`)) continue;
    if (task.expiresAt && now >= task.expiresAt) {
      batchTasks.delete(id);
      releaseTask(task);
      continue;
    }
    if (activeTasks.get(id) !== task) {
      batchTasks.delete(id);
      continue;
    }
    const job = findJob(id);
    if (!job || job.herdr_pane !== task.pane || taskFence(job) !== task.fence) {
      batchTasks.delete(id);
      releaseTask(task);
      continue;
    }
    const view = sampleTask(task);
    if (view.status === 'working') continue;
    batchTasks.delete(id);
    const text = view.result?.content[0]?.text ?? view.statusMessage;
    batchPending.set(task.id, { job: task.job, fence: task.fence ?? '', status: view.status, text });
  }
  stopBatchTimerIfIdle();
}
async function pushBatchNotices() {
  if (batchSending || !session.taskClient || session.resumeRefusal) return;
  sampleBatchTasks();
  if (!callerPane || !batchPending.size) return;
  const run = (async () => {
    for (const [id, item] of [...batchPending.entries()]) {
      if (!session.taskClient || session.resumeRefusal) break;
      try {
        if ((await notify(callerPane, item.text, hudHome)).status === 0) {
          batchPending.delete(id);
          recordBatchNotice(item, id, 'push');
        }
      } catch { /* Retry on next tick or deliver via withChanges. */ }
    }
  })().finally(() => {
    batchSending = undefined;
    stopBatchTimerIfIdle();
  });
  batchSending = run;
  await run;
}
export async function drainBatchChanges(): Promise<string[]> {
  if (batchSending) await batchSending;
  sampleBatchTasks();
  if (!batchPending.size) return [];
  const lines: string[] = [];
  for (const [id, item] of [...batchPending.entries()]) {
    batchPending.delete(id);
    recordBatchNotice(item, id, 'changes');
    lines.push(item.text);
  }
  stopBatchTimerIfIdle();
  return lines;
}
export async function stopBatchDelivery(releaseMarkers: boolean) {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = undefined;
  }
  await batchSending;
  if (releaseMarkers) {
    for (const task of batchTasks.values()) releaseTask(task);
  }
  batchTasks.clear();
  batchPending.clear();
}
export function updateTask(task: HudTask, status: TaskStatus, statusMessage: string, text?: string): TaskView {
  if (task.view.status !== status || task.view.statusMessage !== statusMessage) {
    task.view = { status, statusMessage, lastUpdatedAt: new Date().toISOString(), ...(text ? { result: taskContent(text) } : {}) };
    persistTask(task);
  }
  if (status !== 'working') releaseTask(task);
  return task.view;
}
// null means the current report is still awaiting its checks; a stale receipt never supplies an outcome.
function taskCheckOutcome(dir: string, job: Job, status: ReturnType<typeof readRow>['status']) {
  if (!job.checks?.length) return '';
  const binding = checkBinding(dir, { ...job }, status);
  if (!binding) return '\nChecks: unavailable';
  const receipt = readCheckReceipt(dir);
  const current = receipt && sameChecks(receipt, binding);
  if (current && receipt.state === 'done') {
    const passed = receipt.results.filter((result) => result.exit_code === 0).length;
    return `\nChecks: ${passed}/${job.checks.length} passed`;
  }
  // Bound a missing helper from declaration, or an interrupted run from its running receipt.
  // Allow one poll for the helper to publish the last command's timeout result.
  const started = current && fs.statSync(join(dir, CHECKS_FILE), { throwIfNoEntry: false })?.mtimeMs;
  const deadline = (started || Date.parse(status!.settled_at!)) + job.checks.length * CHECK_TIMEOUT_MS + TASK_POLL_MS;
  return Date.now() < deadline ? null : '\nChecks: result unavailable (timed out)';
}
export function sampleTask(task: HudTask): TaskView {
  if (task.view.status !== 'working') return task.view;
  const job = findJob(task.job);
  if (!job || job.herdr_pane !== task.pane || taskFence(job) !== task.fence) {
    const reason = !job
      ? 'job no longer present'
      : job.herdr_pane !== task.pane
        ? `moved to pane ${job.herdr_pane}`
        : 'superseded by a newer turn';
    const message = `${taskLabel(task, reason)}. Use hud_read for the job's current state.`;
    return updateTask(task, 'cancelled', message, message);
  }
  if (job.role !== task.role) task.role = job.role;
  const dir = directory(job.job), pending = job.headless && hasHeadlessSends(dir);
  const { row, status, statusAt } = readRow(job, false);
  const state = row.state ?? row.display_state;
  if (state === 'queued') {
    const label = row.queue_position !== undefined ? `${taskLabel(task, 'queued')} (#${row.queue_position})` : taskLabel(task, 'queued');
    return updateTask(task, 'working', label);
  }
  const label = taskLabel(task, state);
  if (pending && headlessFollowupReady(status) && !fs.existsSync(join(dir, jobFiles.stopRequested)))
    return updateTask(task, 'working', taskLabel(task, 'queued follow-up'));
  if (state === 'failed' || state === 'stopped' || fs.existsSync(join(dir, jobFiles.stopRequested))) {
    const stopped = state !== 'failed';
    const message = `${taskLabel(task, stopped ? 'stopped' : state)} — ${row.reason ?? (stopped ? 'stop requested' : 'worker failed')}`;
    return updateTask(task, stopped ? 'cancelled' : 'failed', message, message);
  }
  // An answer can arrive between polls (for example from the panel). That question still ended this task.
  const question = questionFiles(dir).find((name) => !task.seenQuestions.has(name));
  if (question) {
    const id = question.slice(0, -3), fields = questionFields(slice(join(dir, jobFiles.qa, question), 2048)?.text ?? '');
    const message = taskLabel(task, 'waiting_orchestrator');
    const choices = [...fields.options, ...(fields.suggested ? [`Default: ${fields.suggested}`] : [])];
    return updateTask(task, 'completed', `${message} — ${id}`, `${message}\nQuestion ${id}: ${fields.question}${choices.length ? `\n${choices.join(' | ')}` : ''}`);
  }
  // A send or answer may not have reached the worker when Claude first polls.
  if (!row.open_questions && needsAttention(row) &&
      (task.attentionBefore === undefined || (statusAt ?? undefined) !== task.attentionBefore)) {
    const message = `${taskLabel(task, row.blocked ? 'blocked' : state)} — ${row.reason ?? 'worker needs attention'}`;
    return updateTask(task, 'completed', message, `${message}. Use hud_read/hud_peek for details.`);
  }
  const report = join(dir, jobFiles.report);
  const currentSettlement = typeof status?.settled_at !== 'string' || status.settled_at >= task.createdAt;
  if (settled(state) && currentSettlement && row.report_mtime !== null && row.report_mtime !== task.reportBefore) {
    const outcome = taskCheckOutcome(dir, job, status);
    if (outcome === null) return updateTask(task, 'working', `${label} — awaiting checks`);
    const meta = jobRowReportMeta(row, dir);
    const summary = meta?.summary ?? fallbackResultLine(slice(report, RESULT_HEAD_BYTES)?.text ?? '');
    return updateTask(task, 'completed', `${label} — report ready`, `${label}\nReport: ${reportReadHint(task.job)}\nSummary: ${summary}${outcome}`);
  }
  if (state === 'closed' || state === 'done') {
    const message = `${label} — no report for this turn`;
    return updateTask(task, 'failed', message, message);
  }
  const progress = readJobProgress(dir).latest_progress;
  const message = (progress && progress.at >= task.createdAt ? progress.text : null) ?? row.reason;
  return updateTask(task, 'working', `${taskLabel(task, settled(state) ? 'working' : state)}${message ? ` — ${message}` : ''}`);
}
function unknownTask(taskId: string) {
  const now = new Date().toISOString(), statusMessage = 'Unknown or expired task. Use hud_read to find the job and collect its report.';
  return { taskId, status: 'failed', statusMessage, createdAt: now, lastUpdatedAt: now, ttlMs: TASK_TTL, pollIntervalMs: TASK_POLL_MS };
}
export async function taskRequest(taskId: string, cancel: boolean,
  closeJob: (job: Job, stop: boolean) => Promise<{ exit_code: number; last_line: string }>) {
  if (isFlowId(taskId)) {
    const live = landTasks.has(taskId);
    if (!live && (cancel || !loadTaskReceipt(taskId))) return unknownTask(taskId);
    const flow = readLand(hudHome, taskId);
    if (!flow || Date.parse(flow.created_at) + TASK_TTL <= Date.now()) {
      landTasks.delete(taskId);
      return unknownTask(taskId);
    }
    if (live) { landTasks.delete(taskId); landTasks.add(taskId); }
    return landTask(hudHome, flow, cancel);
  }
  let task = tasks.get(taskId);
  if (!task && !cancel) {
    const receipt = loadTaskReceipt(taskId);
    if (receipt && 'job' in receipt) task = recoverTask(receipt);
  }
  // Disk recovery restores polling, not authority to stop a prior connection's work.
  if (!task || (cancel && task.recovered)) return unknownTask(taskId);
  const current = task;
  return keyLock(`job:${current.job}`, async () => {
    if (current.expiresAt !== undefined && current.expiresAt <= Date.now()) return unknownTask(taskId);
    if (sampleTask(current).status === 'working' && cancel) {
      const closed = await closeJob(findJob(current.job)!, true);
      const message = closed.exit_code === 0 ? taskLabel(current, 'stopped') : `${taskLabel(current, 'stop failed')} — ${closed.last_line}`;
      updateTask(current, closed.exit_code === 0 ? 'cancelled' : 'failed', message, message);
    }
    return wireTask(current);
  });
}

export function beginHandoff() {
  handedOff = true;
}

export function restoreTaskMaps(state: {
  tasks: typeof tasks; activeTasks: typeof activeTasks; landTasks: typeof landTasks;
  batchTasks?: typeof batchTasks; batchPending?: typeof batchPending;
}) {
  ({ tasks, activeTasks, landTasks } = state);
  batchTasks = state.batchTasks ?? new Map();
  batchPending = state.batchPending ?? new Map();
  for (const task of tasks.values()) {
    armExpiry(task);
    // A live generation from before persistence may have issued this task.
    if (!loadTaskReceipt(task.id)) persistTask(task);
  }
}

export function clearTaskSweep() {
  clearInterval(taskSweep);
}

export function clearTaskMaps() {
  for (const timer of expiry.values()) clearTimeout(timer);
  expiry.clear(); tasks.clear(); activeTasks.clear(); landTasks.clear();
}
