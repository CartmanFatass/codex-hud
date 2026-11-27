/** Harness-reported job totals only. Never price tokens or treat a partial sum as a total. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findRolloutBySessionId } from '../collectors/session-finder.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles as files } from '../mcp/paths.js';
import { readFileBounded, readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';

const WINDOW = 1024 * 1024;
const MAX_SERVED_MODELS = 4;
const MAX_MODEL_LEN = 160;
const fields = ['input', 'cache_read', 'cache_write', 'output', 'cost_usd'] as const;
type Totals = Partial<Record<(typeof fields)[number], number>>;
export type JobUsage = Totals & {
  served_model?: string;
  served_models?: string[];
};
export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown) => typeof v === 'string' && v ? v : undefined;
export const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
export const epoch = (v: unknown) => { const at = Date.parse(text(v) ?? ''); return Number.isFinite(at) ? at : undefined; };
const dollars = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
function modelId(value: unknown): string | undefined {
  const s = text(value)?.trim();
  if (!s || s.length > MAX_MODEL_LEN || /[\r\n\0]/.test(s) || s.toLowerCase() === '<synthetic>') return;
  return s;
}
class ServedModels {
  private readonly ids: string[] = [];

  get last() { return this.ids.at(-1); }

  private remember(id: string) {
    const i = this.ids.indexOf(id);
    if (i !== -1) this.ids.splice(i, 1);
    else if (this.ids.length === MAX_SERVED_MODELS) this.ids.shift();
    this.ids.push(id);
  }

  add(value: unknown) {
    const id = modelId(value);
    if (id) this.remember(id);
  }

  addUsage(raw: Record<string, unknown>) {
    if (Array.isArray(raw.served_models)) {
      for (const value of raw.served_models) this.add(value);
      if (raw.served_models.at(-1) === raw.served_model) return;
    }
    this.add(raw.served_model);
  }

  merge(other: ServedModels) {
    for (const id of other.ids) this.remember(id);
  }

  withTotals(totals: Totals | undefined): JobUsage | undefined {
    const last = this.last;
    if (!last) return totals;
    return this.ids.length > 1 ? { ...totals, served_model: last, served_models: [...this.ids] }
      : { ...totals, served_model: last };
  }
}
function numericUsage(raw: Record<string, unknown>): Totals | undefined {
  const usage: Totals = {};
  for (const key of fields) {
    const n = key === 'cost_usd' ? dollars(raw[key]) : count(raw[key]);
    if (n !== undefined) usage[key] = n;
  }
  return Object.keys(usage).length ? usage : undefined;
}
export function jobUsage(value: unknown): JobUsage | undefined {
  const raw = record(value), models = new ServedModels();
  models.addUsage(raw);
  return models.withTotals(numericUsage(raw));
}
function sum(a: Totals | undefined, b: Totals | undefined): Totals | undefined {
  if (!a || !b) return;
  return numericUsage(Object.fromEntries(fields.flatMap(key => a[key] === undefined || b[key] === undefined ? [] : [[key, a[key] + b[key]]])));
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

function piTierSuffix(rawTier: unknown, model: string): string {
  const tier = text(rawTier)?.trim().toLowerCase(), lower = model.toLowerCase();
  if (tier === 'priority' || tier === 'fast') return lower.endsWith(':fast') || lower.endsWith('-fast') ? '' : ':fast';
  if (tier === 'ultrafast' || tier === 'ultra_fast' || tier === 'ultra-fast')
    return lower.endsWith(':ultrafast') || lower.endsWith('-ultrafast') ? '' : ':ultrafast';
  return '';
}
function piModel(m: Record<string, unknown>, u: Record<string, unknown>, activeTier?: string): string | undefined {
  const responseModel = modelId(m.responseModel);
  // Pi can persist the requested alias and zero usage after a failed request.
  if ((m.stopReason === 'error' || m.stopReason === 'aborted') && !responseModel && !(count(u.input) || count(u.output))) return;
  const model = responseModel ?? modelId(m.model);
  if (!model) return;
  const provider = text(m.provider)?.trim();
  const qualified = provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
  const tier = text(m.serviceTier) ?? text(m.service_tier) ?? text(u.serviceTier) ?? text(u.service_tier) ?? text(u.speed) ?? activeTier;
  return qualified + piTierSuffix(tier, qualified);
}

// Same entry types as the pi footer, without its pricing fallback. A copied sonic
// session includes the source job's traffic; only count entries from this job.
function piTotals(path: string, job: Partial<Job>) {
  const window = rows(path);
  if (!window || window.cut || window.malformed || window.data[0]?.type !== 'session') return;
  const since = job.retry_of && epoch(job.created_at);
  let sessionTier: string | undefined;
  const providerTiers = new Map<string, string>();
  const entries: (Totals | undefined)[] = [];
  const models = new ServedModels();
  for (const row of window.data) {
    if (row.type === 'service_tier_change') {
      const st = row.serviceTier ?? row.service_tier;
      if (typeof st === 'string' && st.trim()) {
        sessionTier = st.trim();
        providerTiers.clear();
      } else if (st && typeof st === 'object' && !Array.isArray(st)) {
        sessionTier = undefined;
        providerTiers.clear();
        for (const [k, v] of Object.entries(st)) {
          const val = text(v)?.trim();
          if (val) providerTiers.set(k, val);
        }
      } else {
        sessionTier = undefined;
        providerTiers.clear();
      }
      continue;
    }
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
    if (row.type === 'message' && m.role === 'assistant' && raw !== undefined) {
      const provider = text(m.provider)?.trim();
      models.add(piModel(m, u, (provider ? providerTiers.get(provider) : undefined) ?? sessionTier));
    }
    // Pi can use an unmarked zero for an unpriced model.
    entries.push(numericUsage({ input: u.input, cache_read: u.cacheRead, cache_write: u.cacheWrite, output: u.output,
      cost_usd: (total !== undefined && total > 0) || cost.totalFromProvider === true ? total : undefined }));
  }
  return models.withTotals(entries.length ? entries.reduce(sum) : undefined);
}

function claudeUsage(raw: unknown, cost?: unknown) {
  const u = record(raw);
  return numericUsage({ input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens, cost_usd: cost });
}
function codexUsage(raw: unknown) {
  const u = record(raw), input = count(u.input_tokens), cached = count(u.cached_input_tokens);
  // Normalize to uncached input as in pi and Claude; Codex's raw input includes cache reads.
  return numericUsage({ input: input !== undefined && cached !== undefined ? input - cached : undefined,
    cache_read: cached, cache_write: u.cache_write_input_tokens, output: u.output_tokens });
}
function agyUsage(raw: unknown) {
  const u = record(raw);
  return numericUsage({ input: u.input_tokens, cache_read: u.cache_read_tokens, output: u.output_tokens });
}

function resultUsage(row: Record<string, unknown>, agent: string, models?: ServedModels) {
  if (agent === 'claude' && row.type === 'result') {
    if (models) for (const model of Object.keys(record(row.modelUsage))) models.add(model);
    return { usage: claudeUsage(row.usage, row.total_cost_usd) };
  }
  if (agent === 'codex' && row.type === 'turn.completed') return { usage: codexUsage(row.usage) };
  if (agent === 'agy' && row.event === 'result') {
    const res = record(row.result);
    models?.add(res.model);
    return { usage: agyUsage(res.usage) };
  }
}

function codexServedModels(rows: Record<string, unknown>[], models: ServedModels) {
  const metaModels = new ServedModels();
  const contexts = new Map<string | number, unknown>();
  const servedTurns = new Set<string | number>();
  let turn: string | number = -1, lastMeteredTotal: string | undefined, hasTotal = false;
  for (const [i, row] of rows.entries()) {
    const p = record(row.payload), turnId = text(p.turn_id);
    const event = row.type === 'event_msg' ? p.type : undefined;
    if (row.type === 'session_meta') metaModels.add(p.model);
    if (event === 'task_started' || event === 'turn_started') turn = turnId ?? i;
    if (row.type === 'turn_context') {
      // Without an ID, use the preceding start or open a new turn at this context.
      turn = turnId ?? (contexts.has(turn) ? i : turn);
      contexts.set(turn, p.model ?? record(record(p.collaboration_mode).settings).model);
    }
    if (event === 'token_count') {
      const info = record(p.info), total = info.total_token_usage;
      if (total) hasTotal = true;
      if (!info.last_token_usage) continue;
      // A repeated cumulative count can carry the previous response's last usage.
      const cumulative = total ? JSON.stringify(total) : undefined;
      if (cumulative && cumulative === lastMeteredTotal) continue;
      if (cumulative) lastMeteredTotal = cumulative;
    } else if (row.type !== 'token_usage_record' && event !== 'agent_message' &&
      !(row.type === 'response_item' && p.type === 'message' && p.role === 'assistant')) continue;
    servedTurns.add(turnId ?? turn);
  }
  for (const [key, model] of contexts) if (servedTurns.has(key)) models.add(model);
  // Old rollouts with only session metadata can prove usage at session scope.
  if (!models.last && (servedTurns.size || (!contexts.size && hasTotal))) models.merge(metaModels);
}

// Undefined means no native transcript; an incomplete read can still have cumulative totals.
type TranscriptUsage = { intact: boolean; totals?: Totals };
function transcriptUsage(agent: string, job: Partial<Job>, status: Partial<JobStatus>, models: ServedModels): TranscriptUsage | undefined {
  const id = status.agent_session_id ?? status.session_id;
  if (!id || !/^[\w-]{1,128}$/.test(id)) return;
  const userHome = homedir();
  let path: string | undefined;
  if (agent === 'agy') path = join(userHome, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (agent === 'claude' && job.cwd && isAbsolute(job.cwd))
    path = join(process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'), 'projects', job.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${id}.jsonl`);
  if (agent === 'codex') path = findRolloutBySessionId(id)?.path;
  if (!path) return;
  let window;
  try { window = rows(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { intact: false }; }
  if (!window) return { intact: false };
  const intact = !window.cut && !window.malformed;
  if (agent === 'codex') {
    // A cumulative count can survive a partial read; model history cannot.
    if (intact) codexServedModels(window.data, models);
    let newerRequest = false;
    for (const row of [...window.data].reverse()) {
      const p = record(row.payload);
      const total = row.type === 'event_msg' && p.type === 'token_count' ? record(p.info).total_token_usage : undefined;
      if (total && !newerRequest) return { intact, totals: codexUsage(total) };
      if (row.type === 'token_usage_record') newerRequest = true;
    }
    if (!intact) return { intact };
    // Modern per-response records and legacy per-request mirrors can coexist.
    // Prefer modern per turn (as the trace reader does), never sum both.
    const turns = new Map<string, { modern: (Totals | undefined)[]; legacy: (Totals | undefined)[] }>();
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
    return { intact, totals: usages.length ? usages.reduce(sum) : undefined };
  }
  // These transcripts have per-request, not cumulative, usage.
  if (!intact) return { intact };
  if (agent === 'agy') {
    const planner = window.data.filter(row => row.type === 'PLANNER_RESPONSE');
    for (const row of planner) models.add(row.model);
    return { intact, totals: planner.length ? planner.map(agyUsage).reduce(sum) : undefined };
  }
  const turns = new Map<string, Totals | undefined>();
  let unkeyed = false;
  for (const row of window.data) {
    if (row.type !== 'assistant') continue;
    const m = record(row.message), key = text(m.id) ?? text(row.requestId);
    if (typeof m.model === 'string' && m.model.trim().toLowerCase() === '<synthetic>') continue;
    models.add(m.model);
    if (!key) { unkeyed = true; continue; }
    const usage = claudeUsage(m.usage);
    if (usage || !turns.has(key)) turns.set(key, usage);
  }
  return { intact, totals: !unkeyed && turns.size ? [...turns.values()].reduce(sum) : undefined };
}

type Receipt = { key: string; usage?: JobUsage; stream?: { end: number; usage?: JobUsage; modelsComplete?: boolean } };
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
  let usage: JobUsage | undefined, stream: Receipt['stream'], totals: Totals | undefined;
  let native: TranscriptUsage | undefined, terminalModels: ServedModels | undefined;
  const models = new ServedModels(), nativeModels = new ServedModels();
  const agent = job.cli?.agent ?? (status.agent === 'pi' ? undefined : status.agent);
  if (agent) {
    // Consult both views for model evidence, even if the stream has all token totals.
    try { native = transcriptUsage(agent, job, status, nativeModels); }
    catch { /* Native transcript lookup is best effort. */ }
  }
  if (agent && (job.headless || status.slot === 'headless')) {
    try {
      const start = count(status.stdout_start), window = rows(join(dir, files.sonicStdout), start ?? 0);
      if (window) {
        const prefix = start && prior?.stream?.end === start ? prior.stream : undefined;
        const intact = !window.cut && !window.malformed;
        const resultModels = intact ? new ServedModels() : undefined;
        const results = window.data.map(row => resultUsage(row, agent, resultModels)).filter(r => r !== undefined);
        const starts = window.data.filter(row => row.type === 'thread.started' || row.event === 'init' ||
          (row.type === 'system' && row.subtype === 'init')).length;
        // A new runner supplies its byte start. Old receipts can use an uncut
        // stream only, and must not silently omit a paused or killed turn.
        const complete = start !== undefined ? results.length === 1 : intact && results.length > 0 && starts <= results.length;
        const current = complete ? results.map(r => r.usage).reduce(sum) : undefined;
        totals = start ? sum(numericUsage(record(prefix?.usage)), current) : current;
        // A terminal result cannot fill gaps in earlier turns or in an incomplete AGY planner log.
        const modelsComplete = complete && resultModels !== undefined && (!start || prefix?.modelsComplete === true) &&
          (agent !== 'agy' || native?.intact !== false);
        const streamModels = new ServedModels();
        if (modelsComplete) {
          models.addUsage(record(prefix?.usage));
          terminalModels = resultModels;
          if (agent === 'claude') {
            // Assistant observations give the order missing from modelUsage keys.
            for (const row of window.data) if (row.type === 'assistant') terminalModels.add(record(row.message).model);
          }
          streamModels.merge(models);
          streamModels.merge(terminalModels);
        }
        stream = { end: window.end, usage: streamModels.withTotals(totals), modelsComplete };
      }
    } catch { /* No readable result stream. */ }
  }
  if (agent) {
    // Select a numeric source instead of adding two views of the same traffic.
    if (native?.totals && (totals?.input === undefined || totals.output === undefined)) {
      // A headless receipt can still report cost even when native supplies the tokens.
      totals = totals?.cost_usd === undefined ? native.totals : { ...native.totals, cost_usd: totals.cost_usd };
    }
    // Prior stream observations precede native history; only the current turn can follow it.
    models.merge(nativeModels);
    if (terminalModels) models.merge(terminalModels);
    usage = models.withTotals(totals);
  } else {
    try {
      const path = status.session_file ?? (job.headless ? join(dir, files.sonicSession) : undefined);
      if (path && isAbsolute(path)) usage = piTotals(path, job);
    } catch { /* Native files can be absent, rotated or too large to total. */ }
  }
  try { writeJsonPrivate(join(dir, files.usage), { key, usage, stream }, { mkdir: false }); }
  catch { /* Best effort; never prevent settlement or retention. */ }
}
