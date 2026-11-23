/** Harness-reported job totals only. Never price tokens or treat a partial sum as a total. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findRolloutBySessionId } from '../collectors/session-finder.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles as files } from '../mcp/paths.js';
import { readFileBounded, readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const WINDOW = 1024 * 1024;
const fields = ['input', 'cache_read', 'cache_write', 'output', 'cost_usd'] as const;
export type JobUsage = Partial<Record<(typeof fields)[number], number>>;
export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown) => typeof v === 'string' && v ? v : undefined;
export const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
export const epoch = (v: unknown) => { const at = Date.parse(text(v) ?? ''); return Number.isFinite(at) ? at : undefined; };
const dollars = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
export function jobUsage(value: unknown): JobUsage | undefined {
  const raw = record(value), usage: JobUsage = {};
  for (const key of fields) {
    const n = key === 'cost_usd' ? dollars(raw[key]) : count(raw[key]);
    if (n !== undefined) usage[key] = n;
  }
  return Object.keys(usage).length ? usage : undefined;
}
function sum(a: JobUsage | undefined, b: JobUsage | undefined): JobUsage | undefined {
  if (!a || !b) return;
  return jobUsage(Object.fromEntries(fields.flatMap(key => a[key] === undefined || b[key] === undefined ? [] : [[key, a[key] + b[key]]])));
}

function rows(path: string, start = 0) {
  const before = fs.lstatSync(path), offset = Math.max(start, before.size - WINDOW);
  if (offset > before.size) return;
  const { bytes, stat, truncated } = readFileBounded(path, WINDOW, { offset });
  if (stat.ino !== before.ino || stat.dev !== before.dev || truncated || bytes.length !== before.size - offset) return;
  const lines = bytes.toString('utf8').split('\n');
  if (offset > start) lines.shift(); // First line may be an event fragment.
  const data = [];
  let malformed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) malformed = true;
      else data.push(row as Record<string, unknown>);
    } catch { malformed = true; }
  }
  return { data, cut: offset > start, malformed, end: before.size };
}

// Same entry types as the pi footer, without its pricing fallback. A copied sonic
// session includes the source job's traffic; only count entries from this job.
function piTotals(path: string, job: Partial<Job>) {
  const window = rows(path);
  if (!window || window.cut || window.malformed || window.data[0]?.type !== 'session') return;
  const since = job.retry_of && epoch(job.created_at);
  const entries: (JobUsage | undefined)[] = [];
  for (const row of window.data) {
    const m = record(row.message);
    // Pi may record a failed/aborted assistant with no metered usage; it still
    // makes the job's totals uncertain rather than free.
    const raw = row.type === 'message' && (m.role === 'assistant' || (m.role === 'toolResult' && m.usage)) ? m.usage
      : row.type === 'usage' || row.type === 'compaction' || row.type === 'branch_summary' ? row.usage : undefined;
    if (raw === undefined && !(row.type === 'message' && m.role === 'assistant')) continue;
    if (job.retry_of) {
      const at = epoch(row.timestamp);
      if (at === undefined || typeof since !== 'number') return;
      if (at < since) continue;
    }
    const u = record(raw), cost = record(u.cost), total = dollars(cost.total);
    // Pi can use an unmarked zero for an unpriced model.
    entries.push(jobUsage({ input: u.input, cache_read: u.cacheRead, cache_write: u.cacheWrite, output: u.output,
      cost_usd: (total !== undefined && total > 0) || cost.totalFromProvider === true ? total : undefined }));
  }
  return entries.length ? entries.reduce(sum) : undefined;
}

function claudeUsage(raw: unknown, cost?: unknown) {
  const u = record(raw);
  return jobUsage({ input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens, cost_usd: cost });
}
function codexUsage(raw: unknown) {
  const u = record(raw), input = count(u.input_tokens), cached = count(u.cached_input_tokens);
  // Normalize to uncached input as in pi and Claude; Codex's raw input includes cache reads.
  return jobUsage({ input: input !== undefined && cached !== undefined ? input - cached : undefined,
    cache_read: cached, cache_write: u.cache_write_input_tokens, output: u.output_tokens });
}
function agyUsage(raw: unknown) {
  const u = record(raw);
  return jobUsage({ input: u.input_tokens, cache_read: u.cache_read_tokens, output: u.output_tokens });
}

function resultUsage(row: Record<string, unknown>, agent: string) {
  if (agent === 'claude' && row.type === 'result') return { usage: claudeUsage(row.usage, row.total_cost_usd) };
  if (agent === 'codex' && row.type === 'turn.completed') return { usage: codexUsage(row.usage) };
  if (agent === 'agy' && row.event === 'result') return { usage: agyUsage(record(row.result).usage) };
}

function transcriptUsage(agent: string, job: Partial<Job>, status: Partial<JobStatus>) {
  const id = status.agent_session_id ?? status.session_id;
  if (!id || !/^[\w-]{1,128}$/.test(id)) return;
  const userHome = homedir();
  let path: string | undefined;
  if (agent === 'agy') path = join(userHome, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (agent === 'claude' && job.cwd && isAbsolute(job.cwd))
    path = join(process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'), 'projects', job.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${id}.jsonl`);
  if (agent === 'codex') path = findRolloutBySessionId(id)?.path;
  if (!path) return;
  const window = rows(path);
  if (!window) return;
  if (agent === 'codex') {
    let newerRequest = false;
    for (const row of [...window.data].reverse()) {
      const p = record(row.payload);
      const total = row.type === 'event_msg' && p.type === 'token_count' ? record(p.info).total_token_usage : undefined;
      if (total && !newerRequest) return codexUsage(total);
      if (row.type === 'token_usage_record') newerRequest = true;
    }
    if (window.cut || window.malformed) return;
    // Modern per-response records and legacy per-request mirrors can coexist.
    // Prefer modern per turn (as the trace reader does), never sum both.
    const turns = new Map<string, { modern: (JobUsage | undefined)[]; legacy: (JobUsage | undefined)[] }>();
    const responses = new Set<string>();
    let turn = '', lastTotal = '';
    for (const row of window.data) {
      const p = record(row.payload);
      if (row.type === 'turn_context' || row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(p.type)))
        turn = text(p.turn_id) ?? turn;
      const modern = row.type === 'token_usage_record', info = record(p.info);
      if (!modern && !(row.type === 'event_msg' && p.type === 'token_count' && info.last_token_usage)) continue;
      const id = modern ? text(p.response_id) : undefined;
      if (id && responses.has(id)) continue;
      if (id) responses.add(id);
      if (!modern && info.total_token_usage) {
        const next = JSON.stringify(info.total_token_usage);
        if (lastTotal === next) continue;
        lastTotal = next;
      }
      const key = text(p.turn_id) ?? turn, entry = turns.get(key) ?? { modern: [], legacy: [] };
      entry[modern ? 'modern' : 'legacy'].push(codexUsage(modern ? p.usage : info.last_token_usage));
      turns.set(key, entry);
    }
    const usages = [...turns.values()].flatMap(t => t.modern.length ? t.modern : t.legacy);
    return usages.length ? usages.reduce(sum) : undefined;
  }
  // These transcripts have per-request, not cumulative, usage.
  if (window.cut || window.malformed) return;
  if (agent === 'agy') {
    const turns = window.data.filter(row => row.type === 'PLANNER_RESPONSE').map(agyUsage);
    return turns.length ? turns.reduce(sum) : undefined;
  }
  const turns = new Map<string, JobUsage | undefined>();
  for (const row of window.data) {
    if (row.type !== 'assistant') continue;
    const m = record(row.message), key = text(m.id) ?? text(row.requestId);
    if (m.model === '<synthetic>') continue;
    if (!key) return;
    const usage = claudeUsage(m.usage);
    if (usage || !turns.has(key)) turns.set(key, usage);
  }
  return turns.size ? [...turns.values()].reduce(sum) : undefined;
}

type Receipt = { key: string; usage?: JobUsage; stream?: { end: number; usage?: JobUsage } };
const stamp = (status: Partial<JobStatus>) => status.settled_at ?? status.ended_at ?? status.started_at;
function load(dir: string): Receipt | undefined {
  try { return readJsonBounded(join(dir, files.usage), 4096) as Receipt; } catch { return; }
}
export function readJobUsage(dir: string, status: Partial<JobStatus>) {
  const receipt = load(dir), key = stamp(status);
  // A paused headless turn also has a receipt. Don't expose it as the current
  // total if the job has since reopened.
  return key && receipt?.key === key ? jobUsage(receipt.usage) : undefined;
}

export function recordJobUsage(dir: string, job: Partial<Job>, status: Partial<JobStatus>): void {
  const key = stamp(status);
  if (!key || job.bro || job.jev || job.scout_only || status.harness === 'bro') return;
  const prior = load(dir);
  if (prior?.key === key) return;
  let usage: JobUsage | undefined, stream: Receipt['stream'];
  const agent = job.cli?.agent ?? (status.agent === 'pi' ? undefined : status.agent);
  if (agent && (job.headless || status.slot === 'headless')) {
    try {
      const start = count(status.stdout_start), window = rows(join(dir, files.sonicStdout), start ?? 0);
      if (window) {
        const results = window.data.map(row => resultUsage(row, agent)).filter(r => r !== undefined);
        const starts = window.data.filter(row => row.type === 'thread.started' || row.event === 'init' ||
          (row.type === 'system' && row.subtype === 'init')).length;
        // A new runner supplies its byte start. Old receipts can use an uncut
        // stream only, and must not silently omit a paused or killed turn.
        const complete = start !== undefined ? results.length === 1 : !window.cut && !window.malformed &&
          results.length > 0 && starts <= results.length;
        const current = complete ? results.map(r => r.usage).reduce(sum) : undefined;
        usage = start ? (prior?.stream?.end === start ? sum(prior.stream.usage, current) : undefined) : current;
        stream = { end: window.end, usage };
      }
    } catch { /* No readable result stream. */ }
  }
  try {
    if (agent) {
      // Native transcripts may supply token totals when a stream has no result
      // (for example, a pause). Never add two views of the same traffic.
      if (!usage || usage.input === undefined || usage.output === undefined)
        usage = jobUsage({ ...transcriptUsage(agent, job, status), ...usage });
    } else {
      const path = status.session_file ?? (job.headless ? join(dir, files.sonicSession) : undefined);
      if (path && isAbsolute(path)) usage = piTotals(path, job);
    }
  } catch { /* Native files can be absent, rotated or too large to total. */ }
  try { writeJsonPrivate(join(dir, files.usage), { key, usage, stream }, { mkdir: false }); }
  catch { /* Best effort; never prevent settlement or retention. */ }
}
