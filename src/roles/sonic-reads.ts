/** Mechanical read-volume facts for settled sonic sessions. No model calls or network. */
import * as fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { count, epoch, record } from './job-usage.js';

export const MAX_SONIC_READS_BYTES = 50 * 1024 * 1024;
export const MAX_SONIC_BY_TOOL = 10;
const CHUNK_BYTES = 64 * 1024;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_CALL_NAME_CACHE = 4096;
const SETTLED_STATES = new Set(['idle_grace', 'done', 'closed', 'failed', 'stopped']);

export type SonicToolReads = { calls: number; bytes: number };
export type SonicReads = {
  tool_calls: number;
  tool_result_bytes: number;
  by_tool: Record<string, SonicToolReads>;
  truncated?: true;
};
export type SonicReadFacts = {
  reads: SonicReads | null;
  brief_bytes?: number;
  report_bytes?: number;
};

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_TOOL_NAME_LENGTH ? trimmed.slice(0, MAX_TOOL_NAME_LENGTH) : trimmed;
}

function payloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    let total = 0;
    for (const block of value) {
      if (typeof block === 'string') {
        total += Buffer.byteLength(block, 'utf8');
      } else if (block && typeof block === 'object') {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === 'string') total += Buffer.byteLength(text, 'utf8');
        else {
          const serialized = JSON.stringify(block);
          if (serialized) total += Buffer.byteLength(serialized, 'utf8');
        }
      } else if (block !== null && block !== undefined) {
        const serialized = JSON.stringify(block);
        if (serialized) total += Buffer.byteLength(serialized, 'utf8');
      }
    }
    return total;
  }
  if (value === null || value === undefined) return 0;
  const serialized = JSON.stringify(value);
  return serialized ? Buffer.byteLength(serialized, 'utf8') : 0;
}

function topByTool(map: Map<string, SonicToolReads>, limit = MAX_SONIC_BY_TOOL): Record<string, SonicToolReads> {
  const sorted = [...map.entries()].sort(
    (a, b) => b[1].bytes - a[1].bytes || b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const out: Record<string, SonicToolReads> = {};
  for (const [name, stats] of sorted.slice(0, limit)) {
    Object.defineProperty(out, name, {
      value: { calls: stats.calls, bytes: stats.bytes },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function fileSizeBytes(filePath: string): number | undefined {
  try {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    return stat?.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSonicSessionPath(
  dir: string,
  job: Partial<Job>,
  status: Partial<JobStatus>,
): string | undefined {
  if (job.cli || job.bro || job.jev) return undefined;
  if (typeof status.session_file === 'string' && isAbsolute(status.session_file)) {
    return status.session_file;
  }
  if (job.headless || status.slot === 'sonic') {
    return join(dir, jobFiles.sonicSession);
  }
  if (Array.isArray(job.sessions)) {
    for (const s of job.sessions) {
      if (s?.harness === 'pi' && typeof s.path === 'string' && isAbsolute(s.path)) {
        return s.path;
      }
    }
  }
  return undefined;
}

/** Stream a pi session JSONL once in bounded chunks and stop counting after maxBytes. */
export function countSonicSessionReads(
  filePath: string,
  options: { maxBytes?: number; sinceMs?: number } = {},
): SonicReads | null {
  if (!filePath || !isAbsolute(filePath)) return null;
  const maxBytes = options.maxBytes ?? MAX_SONIC_READS_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  const sinceMs = options.sinceMs;

  let realPath: string;
  try { realPath = fs.realpathSync(filePath); } catch { return null; }
  let fd: number;
  try {
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch { return null; }

  let toolCalls = 0;
  let toolResultBytes = 0;
  let validLines = 0;
  let truncated = false;
  const byTool = new Map<string, SonicToolReads>();
  const callNames = new Map<string, string>();

  const processLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    validLines += 1;
    const row = parsed as Record<string, unknown>;
    if (row.type !== 'message') return;
    const msg = record(row.message);
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = record(block);
        if (b.type === 'toolCall' && typeof b.id === 'string' && b.id) {
          const name = normalizeToolName(b.name);
          if (name) {
            if (callNames.size >= MAX_CALL_NAME_CACHE) {
              const oldest = callNames.keys().next().value;
              if (oldest !== undefined) callNames.delete(oldest);
            }
            callNames.set(b.id, name);
          }
        }
      }
      return;
    }
    if (msg.role !== 'toolResult') return;
    if (sinceMs !== undefined) {
      const at = epoch(row.timestamp);
      if (at !== undefined && at < sinceMs) return;
    }
    const callId = typeof msg.toolCallId === 'string' && msg.toolCallId ? msg.toolCallId : undefined;
    const matchedName = callId ? callNames.get(callId) : undefined;
    if (callId) callNames.delete(callId);
    const toolName = normalizeToolName(msg.toolName) ?? matchedName ?? 'unknown';
    const bytes = payloadBytes(msg.content);
    toolCalls += 1;
    toolResultBytes += bytes;
    const entry = byTool.get(toolName);
    if (entry) {
      entry.calls += 1;
      entry.bytes += bytes;
    } else {
      byTool.set(toolName, { calls: 1, bytes });
    }
  };

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;

    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes));
    const probe = Buffer.allocUnsafe(1);
    let totalBytes = 0;
    let lineChunks: Buffer[] = [];
    let lineLen = 0;

    const flushLine = () => {
      if (lineLen === 0) return;
      const text = lineChunks.length === 1
        ? lineChunks[0]!.toString('utf8')
        : Buffer.concat(lineChunks, lineLen).toString('utf8');
      lineChunks = [];
      lineLen = 0;
      processLine(text);
    };

    while (totalBytes < maxBytes) {
      const toRead = Math.min(buf.length, maxBytes - totalBytes);
      const n = fs.readSync(fd, buf, 0, toRead, null);
      if (n === 0) break;
      totalBytes += n;

      const view = buf.subarray(0, n);
      let start = 0;
      while (start < n) {
        const nl = view.indexOf(0x0a, start);
        if (nl === -1) {
          const tail = Buffer.from(view.subarray(start, n));
          lineChunks.push(tail);
          lineLen += tail.length;
          break;
        }
        if (lineLen === 0) {
          if (nl > start) processLine(view.toString('utf8', start, nl));
        } else {
          if (nl > start) {
            const part = Buffer.from(view.subarray(start, nl));
            lineChunks.push(part);
            lineLen += part.length;
          }
          flushLine();
        }
        start = nl + 1;
      }
    }

    if (totalBytes >= maxBytes) {
      if (fs.readSync(fd, probe, 0, 1, null) > 0) {
        truncated = true;
      }
    }

    if (!truncated) {
      flushLine();
    }
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* Best effort close. */ }
  }

  if (validLines === 0 && !truncated) return null;
  return {
    tool_calls: toolCalls,
    tool_result_bytes: toolResultBytes,
    by_tool: topByTool(byTool),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

export function shouldRecordSonicReads(job: Partial<Job>, status: Partial<JobStatus>): boolean {
  return job.role === 'sonic' &&
    job.reads === undefined &&
    typeof status.state === 'string' &&
    SETTLED_STATES.has(status.state);
}

export function collectSonicReadFacts(
  dir: string,
  job: Partial<Job>,
  status: Partial<JobStatus>,
): SonicReadFacts {
  const sessionPath = resolveSonicSessionPath(dir, job, status);
  const sinceMs = job.retry_of ? epoch(job.created_at) : undefined;
  const reads = sessionPath ? countSonicSessionReads(sessionPath, { sinceMs }) : null;
  const brief_bytes = fileSizeBytes(join(dir, jobFiles.brief));
  const report_bytes = fileSizeBytes(join(dir, jobFiles.report));
  return {
    reads,
    ...(brief_bytes !== undefined ? { brief_bytes } : {}),
    ...(report_bytes !== undefined ? { report_bytes } : {}),
  };
}

export function jobSonicReads(value: unknown): SonicReads | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const raw = record(value);
  const tool_calls = count(raw.tool_calls);
  const tool_result_bytes = count(raw.tool_result_bytes);
  if (tool_calls === undefined || tool_result_bytes === undefined) return undefined;
  const rawByTool = raw.by_tool;
  if (!rawByTool || typeof rawByTool !== 'object' || Array.isArray(rawByTool)) return undefined;
  const byToolMap = new Map<string, SonicToolReads>();
  for (const [key, item] of Object.entries(rawByTool as Record<string, unknown>)) {
    const name = normalizeToolName(key);
    if (!name) continue;
    const entry = record(item);
    const calls = count(entry.calls);
    const bytes = count(entry.bytes);
    if (calls === undefined || bytes === undefined) continue;
    byToolMap.set(name, { calls, bytes });
  }
  return {
    tool_calls,
    tool_result_bytes,
    by_tool: topByTool(byToolMap),
    ...(raw.truncated === true ? { truncated: true as const } : {}),
  };
}
