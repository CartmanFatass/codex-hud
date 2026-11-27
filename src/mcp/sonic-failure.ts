/** Best-effort evidence when the runner itself dies, distinct from the harness's exit receipt. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readFileBounded, readJsonBounded, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { SALVAGED_SONIC_REASON } from '../worker/sonic-jobs.js';

export const missingRunnerReceipt = 'sonic runner exited without an exit receipt';
type Identity = Pick<JobStatus, 'pid' | 'pid_start_time' | 'boot_id'>;
type Death = Identity & { code: number | null; signal: NodeJS.Signals | null };
const sameRunner = (a: Identity, b: Identity) => a.pid === b.pid && a.pid_start_time === b.pid_start_time && a.boot_id === b.boot_id;

export function recordRunnerDeath(dir: string, id: Identity, code: number | null, signal: NodeJS.Signals | null) {
  try {
    if (fs.existsSync(join(dir, jobFiles.sonicExit))) return;
    if (!sameRunner(id, readJsonBounded(join(dir, jobFiles.status), 8192) as JobStatus)) return;
    writeJsonPrivate(join(dir, jobFiles.runnerDeath), { ...id, code, signal }, { mkdir: false });
  } catch { /* Retention, a replaced turn, or a failed write must not bring down the launcher. */ }
}

// A short-lived launcher may already have exited. Record what we can before the default termination.
export function observeOwnExit(dir: string, status: JobStatus) {
  const id = { pid: process.pid, pid_start_time: status.pid_start_time, boot_id: status.boot_id };
  process.once('exit', code => recordRunnerDeath(dir, id, code, null));
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, () => {
    recordRunnerDeath(dir, id, null, signal);
    process.kill(process.pid, signal);
  });
}

export function parentStartedAt(dir: string, job: Job) {
  if (!job.parent_job || !/^j[0-9a-f]{16}$/.test(job.parent_job)) return;
  try {
    const parent = readJsonBounded(join(dirname(dir), job.parent_job, jobFiles.status), 8192) as JobStatus;
    if (parent.started_at && Number.isFinite(Date.parse(parent.started_at))) return parent.started_at;
  } catch { /* No comparable parent turn. */ }
}

function tail(path: string, limit: number) {
  try {
    const offset = Math.max(0, fs.lstatSync(path).size - limit);
    return readFileBounded(path, limit, { offset }).bytes.toString('utf8');
  } catch { return null; }
}

function recoverPartialReport(dir: string) {
  const path = join(dir, jobFiles.report);
  if (fs.existsSync(path)) return;
  const session = tail(join(dir, jobFiles.sonicSession), 256 * 1024);
  if (!session) return;
  const text: string[] = [];
  for (const line of session.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // A cut first line or an interrupted append.
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const content = entry.message.content;
    if (typeof content === 'string') text.push(content);
    else if (Array.isArray(content)) for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
    }
  }
  const excerpt = text.join('\n\n').trim().slice(-8192);
  if (excerpt) try { writePrivateFile(path, `# Partial sonic report\n\n${excerpt}\n`, { exclusive: true, mkdir: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export function missingRunnerEvidence(dir: string, job: Job, status: Partial<JobStatus>) {
  let death;
  try {
    const record = readJsonBounded(join(dir, jobFiles.runnerDeath), 1024) as Death;
    if (sameRunner(status, record)) death = record;
  } catch { /* SIGKILL after launcher loss leaves no wait status; do not guess. */ }
  if (status.slot === 'sonic') recoverPartialReport(dir);
  const restart = status.parent_started_at && Date.parse(parentStartedAt(dir, job) ?? '') > Date.parse(status.parent_started_at);
  return { runner_exit_code: death?.code ?? null, runner_exit_signal: death?.signal ?? null,
    stderr_tail: tail(join(dir, jobFiles.sonicStderr), 1024), ...(restart && { exit_reason: `${missingRunnerReceipt}: parent session restarted` }) };
}

const TURN_ERROR_WINDOW = 256 * 1024;
const MAX_TURN_ERROR_LEN = 300;
const GENERIC_NO_REPORT = /^(?:process exited without a report|worker exited|(?:pi|claude|agy|codex) exited without a declared report)$/;

export const isGenericNoReportReason = (reason: string) => GENERIC_NO_REPORT.test(reason);

function cleanTurnError(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\r\n\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TURN_ERROR_LEN) : null;
}

function tailLinesBounded(path: string, minOffset = 0, windowBytes = TURN_ERROR_WINDOW): { lines: string[]; truncated: boolean } | null {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile()) return null;
    const offset = Math.max(minOffset, stat.size - windowBytes);
    if (offset >= stat.size) return null;
    const { bytes } = readFileBounded(path, windowBytes, { offset });
    let text = bytes.toString('utf8');
    // Drop a cut leading line when the window starts mid-file.
    if (offset > minOffset) {
      const nl = text.indexOf('\n');
      if (nl < 0) return { lines: [], truncated: true };
      text = text.slice(nl + 1);
    }
    return { lines: text.split('\n'), truncated: offset > minOffset };
  } catch { return null; }
}

function tailLines(path: string, minOffset = 0): string[] | null {
  return tailLinesBounded(path, minOffset)?.lines ?? null;
}

type AssistantCheck = { done: true; error: string | null } | { done: false };
function checkPiMessage(message: unknown): AssistantCheck {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { done: false };
  const m = message as Record<string, unknown>;
  if (m.role === 'user') return { done: true, error: null };
  if (m.role !== 'assistant') return { done: false };
  return { done: true, error: m.stopReason === 'error' ? cleanTurnError(m.errorMessage) : null };
}

function piSessionTurnError(file: string): string | null {
  const lines = tailLines(file);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (row.type !== 'message') continue;
    const res = checkPiMessage(row.message);
    if (res.done) return res.error;
  }
  return null;
}

function piStdoutTurnError(file: string, minOffset = 0): string | null {
  const lines = tailLines(file, minOffset);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (row.type === 'session' || row.type === 'agent_start') return null;
    if (row.type === 'message_end' || row.type === 'turn_end') {
      const res = checkPiMessage(row.message);
      if (res.done) return res.error;
    } else if (row.type === 'agent_end' && Array.isArray(row.messages)) {
      for (let j = row.messages.length - 1; j >= 0; j--) {
        const res = checkPiMessage(row.messages[j]);
        if (res.done) return res.error;
      }
    }
  }
  return null;
}

function claudeMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return cleanTurnError(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && !Array.isArray(part) && (part as Record<string, unknown>).type === 'text') {
      const t = (part as Record<string, unknown>).text;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
  }
  return cleanTurnError(parts.join(' '));
}

function cliStdoutTurnError(file: string, agent: string, minOffset = 0): string | null {
  const lines = tailLines(file, minOffset);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (agent === 'claude') {
      if (row.type === 'system' && row.subtype === 'init') return null;
      if (row.type === 'result') {
        if (row.is_error === true) {
          const firstErr = Array.isArray(row.errors) ? row.errors.find((e) => typeof e === 'string' && e.trim()) : undefined;
          return cleanTurnError(row.result) ?? cleanTurnError(firstErr) ?? cleanTurnError(row.error);
        }
        return null;
      }
      if (row.type === 'assistant') {
        if (typeof row.error === 'string' && row.error.trim()) {
          const text = claudeMessageText(row.message);
          return text ? cleanTurnError(`${row.error}: ${text}`) : cleanTurnError(row.error);
        }
        return null;
      }
    } else if (agent === 'agy') {
      if (row.event === 'init') return null;
      if (row.event === 'result' && row.result && typeof row.result === 'object' && !Array.isArray(row.result)) {
        return cleanTurnError((row.result as Record<string, unknown>).error);
      }
      if (row.event === 'error') return cleanTurnError(row.error) ?? cleanTurnError(row.message);
    } else if (agent === 'codex') {
      if (row.type === 'thread.started' || row.type === 'turn.completed') return null;
      if (row.type === 'turn.failed') {
        const err = row.error && typeof row.error === 'object' && !Array.isArray(row.error)
          ? (row.error as Record<string, unknown>).message : row.error;
        return cleanTurnError(err) ?? cleanTurnError(row.message);
      }
      if (row.type === 'error') return cleanTurnError(row.message) ?? cleanTurnError(row.error);
    }
  }
  return null;
}

/** Read the last assistant turn's provider error from a pi session/stdout or CLI stream-json log. */
export function lastTurnError(dir: string, status: Partial<JobStatus>, job?: Partial<Job> | null): string | null {
  const agent = status.harness === 'cli' ? status.agent : job?.cli?.agent;
  const minOffset = typeof status.stdout_start === 'number' && Number.isSafeInteger(status.stdout_start) && status.stdout_start >= 0
    ? status.stdout_start : 0;
  const stdout = join(dir, jobFiles.sonicStdout);
  if (agent) return cliStdoutTurnError(stdout, agent, minOffset);
  const sessionFile =
    (typeof status.session_file === 'string' && isAbsolute(status.session_file) ? status.session_file : null) ??
    job?.sessions?.find((s) => s.harness === 'pi' && typeof s.path === 'string' && isAbsolute(s.path))?.path ??
    join(dir, jobFiles.sonicSession);
  return piSessionTurnError(sessionFile) ?? piStdoutTurnError(stdout, minOffset);
}

const SALVAGE_WINDOW = 512 * 1024;
const PRE_SETTLED_EVENTS = new Set([
  'session', 'agent_start', 'turn_start', 'message_start', 'message_update',
  'message_end', 'turn_end', 'agent_end', 'tool_execution_start', 'tool_execution_end',
]);

type AssistantTextCheck = { done: true; text: string | null } | { done: false };
function extractPiAssistantText(message: unknown): AssistantTextCheck {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { done: false };
  const m = message as Record<string, unknown>;
  if (m.role === 'user' || m.role === 'toolResult') return { done: true, text: null };
  if (m.role !== 'assistant') return { done: false };
  if (m.stopReason !== undefined && m.stopReason !== 'stop' && m.stopReason !== 'length') return { done: true, text: null };
  if (typeof m.errorMessage === 'string' && m.errorMessage.trim()) return { done: true, text: null };
  const content = m.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return { done: true, text: text || null };
  }
  if (!Array.isArray(content)) return { done: true, text: null };
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;
    if (p.type === 'toolCall') return { done: true, text: null };
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) parts.push(p.text);
  }
  const text = parts.join('\n\n').trim();
  return { done: true, text: text || null };
}

function piSessionFinalText(file: string): string | null {
  const lines = tailLines(file);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (row.type !== 'message') continue;
    const res = extractPiAssistantText(row.message);
    if (res.done) return res.text;
  }
  return null;
}

/** Extract non-empty final assistant text when a headless pi sonic settled cleanly without hud_report. */
export function salvageableSonicFinalText(dir: string, status: Partial<JobStatus>, job?: Partial<Job> | null): string | null {
  const minOffset = typeof status.stdout_start === 'number' && Number.isSafeInteger(status.stdout_start) && status.stdout_start >= 0
    ? status.stdout_start : 0;
  const tailData = tailLinesBounded(join(dir, jobFiles.sonicStdout), minOffset, SALVAGE_WINDOW);
  if (!tailData) return null;
  let sawSettled = false;
  for (let i = tailData.lines.length - 1; i >= 0; i--) {
    const line = tailData.lines[i]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!sawSettled) {
      if (row.type === 'agent_settled') {
        if (row.aborted === true) return null;
        sawSettled = true;
        continue;
      }
      if (typeof row.type === 'string' && PRE_SETTLED_EVENTS.has(row.type)) return null;
      continue;
    }
    if (row.type === 'session' || row.type === 'agent_start') return null;
    if (row.type === 'agent_end') {
      if (row.willRetry === true) return null;
      if (Array.isArray(row.messages)) {
        for (let j = row.messages.length - 1; j >= 0; j--) {
          const res = extractPiAssistantText(row.messages[j]);
          if (res.done) return res.text;
        }
        return null;
      }
    } else if (row.type === 'turn_end') {
      if (Array.isArray(row.toolResults) && row.toolResults.length > 0) return null;
      const res = extractPiAssistantText(row.message);
      if (res.done) return res.text;
    } else if (row.type === 'message_end') {
      const res = extractPiAssistantText(row.message);
      if (res.done) return res.text;
    }
  }
  if (!sawSettled) return null;
  if (!tailData.truncated) return null;
  const sessionFile =
    (typeof status.session_file === 'string' && isAbsolute(status.session_file) ? status.session_file : null) ??
    job?.sessions?.find((s) => s.harness === 'pi' && typeof s.path === 'string' && isAbsolute(s.path))?.path ??
    join(dir, jobFiles.sonicSession);
  return piSessionFinalText(sessionFile);
}

/** Publish a salvaged final assistant message as report.md with the salvaged marker. */
export function publishSalvagedSonicReport(dir: string, status: Partial<JobStatus>, job?: Partial<Job> | null): boolean {
  const text = salvageableSonicFinalText(dir, status, job);
  if (!text) return false;
  const body = `> ${SALVAGED_SONIC_REASON}\n\n${text.endsWith('\n') ? text : `${text}\n`}`;
  writePrivateFile(join(dir, jobFiles.report), body, { mkdir: false });
  return true;
}
