/** Retention ledger. Project individual facts; never serialize whole receipts. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { objectiveLink } from '../collectors/objectives.js';
import type { AnswerActor, Job, JobStatus, StopOrigin } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import { getJobIndexCache, type JobIndexCache } from './job-index-cache.js';
import { jobChecks } from './job-checks.js';
import { cliSession } from './job-sessions.js';
import { archiveJobLand, type JobLand } from './job-land.js';
import { epoch, readJobUsage, record, text, type JobUsage } from './job-usage.js';
import { normalizeReportMeta, readReportMeta } from './report-meta.js';
import { jobCitations } from './sonic-citations.js';
function reason(value: unknown) {
  if (typeof value !== 'string') return;
  const bytes = Buffer.alloc(200);
  return bytes.toString('utf8', 0, bytes.write(value)); // write stops at a complete UTF-8 character.
}
export function publicJobLine(value: string): string {
  const paths = new Set([homedir(), process.env.HOME, process.env.HUD_HOME]);
  for (const path of paths) {
    if (path && path !== '/') value = value.replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + /[^\s"'<>`]*/u.source, 'gu'), '<home path>');
  }
  value = value.replace(/(?:\/(?:home|Users|root)(?=\/)|~(?=\/)|\$\{?HOME\}?(?=\/)|[A-Z]:\\Users(?=\\))[^\s"'<>`]+/giu, '<home path>');
  return normalizeReportMeta({ summary: value }).summary ?? '';
}

export type JobFacts = {
  job: string; project?: string; role?: string; harness?: string; model?: string; used_place?: string;
  ticket?: string; objective?: Job['objective']; package?: string; route?: { tier?: string; mode?: string; placement?: 'even'; preset?: string }; mode?: string;
  question_count?: number; parent_job?: string; summary?: string; usage?: JobUsage; land?: JobLand;
  state?: string; created_at?: string; started_at?: string; settled_at?: string; ended_at?: string;
  archived_at?: string; reaped_at?: string; dispatch_exit_code?: number;
};

/** The same facts back a still-retained job and its later archive line. */
export function projectJobFacts(home: string, dir: string, id: string, job: Partial<Job>, status: Partial<JobStatus>, hasJob = true): JobFacts {
  const { tier, mode, placement, preset } = job.route ?? {};
  let question_count: number | undefined;
  try { question_count = getJobIndexCache(home).readQa(dir).allQuestionFiles.length; } catch { /* Unknown. */ }
  const terminal = ['idle_grace', 'done', 'closed', 'failed', 'stopped'].includes(status.state ?? '');
  const summary = terminal ? readReportMeta(dir)?.summary : undefined;
  const harness = job.cli?.agent ?? status.agent ?? (job.bro ? 'bro' : job.jev ? 'jev' : status.harness ?? (hasJob ? 'pi' : undefined));
  return {
    job: id, project: text(job.project_root) ?? text(job.worktree?.main_root) ?? text(job.cwd), role: text(job.role) ?? text(status.role),
    harness, model: text(job.model) ?? text(status.model), used_place: text(job.used_place),
    ticket: text(job.ticket), objective: objectiveLink(job.objective), package: text(job.package), parent_job: text(job.parent_job),
    route: tier || mode ? { tier: text(tier), mode: text(mode), ...(placement === 'even' ? { placement, preset: text(preset) } : {}) } : undefined,
    mode: job.headless || ['headless', 'sonic'].includes(status.slot ?? '') ? 'headless'
      : job.headless === false || status.slot === 'primary' ? 'tab' : undefined,
    question_count, summary: summary ? publicJobLine(summary) || undefined : undefined,
    usage: terminal ? readJobUsage(dir, status) : undefined,
    state: text(status.state), created_at: text(job.created_at), started_at: text(status.started_at), settled_at: text(status.settled_at),
    ended_at: text(status.ended_at), reaped_at: text(job.reaped_at), dispatch_exit_code: Number.isInteger(job.dispatch_exit_code) ? job.dispatch_exit_code! : undefined,
  };
}
function cachedOutcome(home: string, id: string, settlement?: number) {
  if (settlement === undefined) return;
  const key = createHash('sha256').update(`thin-job:${id}:outcome`).digest('hex');
  const path = join(home, 'display', 'model-cache', 'decision-labels', key + '.json');
  try {
    const st = fs.lstatSync(path);
    if (!st.isFile() || st.size > 32768) return;
    const row = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (row.revision !== String(settlement) || !Array.isArray(row.answers)) return;
    for (const answer of row.answers) {
      if (answer?.name === 'outcome' && answer.kind === 'choice' && ['done', 'partial', 'failed', 'blocked'].includes(answer.choice))
        return text(answer.choice);
    }
  } catch { /* Optional panel cache. Never request a label. */ }
}

const WORKING_STATES = new Set(['working', 'waiting_helper', 'waiting_orchestrator', 'blocked']);
export function isWorkingState(state: unknown): state is string {
  return typeof state === 'string' && WORKING_STATES.has(state);
}

function readCachedJob(dir: string, cache?: JobIndexCache) {
  const file = join(dir, jobFiles.job);
  const idx = cache ?? getJobIndexCache(dirname(dirname(dir)));
  const res = idx.readJson<Job>(file);
  const raw = res.status === 'ok' ? res.value : res.status === 'truncated' ? readJsonFile(file) : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return { file, idx, job: raw as Job };
}

/** Record once why a working job was stopped or lost its pane. */
export function recordStopOrigin(dir: string, actor: StopOrigin['actor'], priorState: unknown, at = new Date().toISOString(), cache?: JobIndexCache): boolean {
  if (!isWorkingState(priorState)) return false;
  try {
    const found = readCachedJob(dir, cache);
    if (!found || found.job.stop_origin) return false;
    const next: Job = { ...found.job, stop_origin: { actor, prior_state: priorState, at } };
    found.idx.writeJsonAtomic(found.file, next as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
    return true;
  } catch { return false; }
}

/** Record once whether the orchestrator or owner answered a question. */
export function recordQuestionAnswer(dir: string, qid: string, actor: AnswerActor, cache?: JobIndexCache): boolean {
  if (!/^q\d+$/.test(qid)) return false;
  try {
    const found = readCachedJob(dir, cache);
    if (!found || found.job.answered_by?.[qid]) return false;
    const next: Job = { ...found.job, answered_by: { ...found.job.answered_by, [qid]: actor } };
    found.idx.writeJsonAtomic(found.file, next as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
    return true;
  } catch { return false; }
}

/** Record once that a question timed out and its default applied. */
export function recordQuestionTimeout(dir: string, qid: string, cache?: JobIndexCache): boolean {
  if (!/^q\d+$/.test(qid)) return false;
  try {
    const found = readCachedJob(dir, cache);
    if (!found || found.job.timed_out_questions?.includes(qid)) return false;
    const next: Job = { ...found.job, timed_out_questions: [...(found.job.timed_out_questions ?? []), qid] };
    found.idx.writeJsonAtomic(found.file, next as unknown as Record<string, unknown>, { indent: 2, mkdir: false });
    return true;
  } catch { return false; }
}

function archiveDispatcher(value: unknown) {
  const dispatcher = record(value);
  const harness = text(dispatcher.harness)?.trim(), id = text(dispatcher.id)?.trim() || text(dispatcher.session_id)?.trim();
  if (harness && id) return { harness, id };
}

function archiveStopOrigin(value: unknown): StopOrigin | undefined {
  const origin = record(value);
  const actor = origin.actor, prior_state = text(origin.prior_state), at = text(origin.at);
  if ((actor === 'mcp' || actor === 'panel' || actor === 'pane_vanished') && prior_state && at)
    return { actor, prior_state, at };
}

const QA_READ_LIMIT = 65536;
const QUESTION_TIMEOUT_MS = 1200_000;
const normWs = (value: string) => value.trim().replace(/\s+/g, ' ');
function readQaText(dir: string, name: string): string | undefined {
  try {
    const { bytes, truncated } = readFileBounded(join(dir, 'qa', name), QA_READ_LIMIT);
    if (!truncated) return bytes.toString('utf8');
  } catch { /* Missing or unreadable QA text. */ }
}
function questionDefault(content: string): string | undefined {
  const match = content.replace(/\r\n/g, '\n').match(/^Default if unanswered:[ \t]*(.+?)(?=\n\n|\n(?:Context|Answer):|$)/ms);
  const value = match ? normWs(match[1]!) : '';
  return value || undefined;
}

function archiveQuestions(home: string, dir: string, job: Partial<Job>, status: Partial<JobStatus>) {
  const mtime = (name: string) => {
    try {
      const stat = fs.lstatSync(join(dir, 'qa', name), { throwIfNoEntry: false });
      if (stat?.isFile()) return { iso: stat.mtime.toISOString(), ms: stat.mtimeMs };
    } catch { /* Missing or unreadable timing evidence. */ }
  };
  const actors = record(job.answered_by);
  const timedOutIds = new Set(Array.isArray(job.timed_out_questions) ? job.timed_out_questions.filter((q): q is string => typeof q === 'string') : []);
  const settledAt = epoch(status.settled_at) ?? epoch(status.ended_at);
  const cleanSettle = ['done', 'closed', 'idle_grace'].includes(status.state ?? '');
  try {
    const questions = getJobIndexCache(home).readQa(dir).allQuestionFiles.flatMap(name => {
      const id = name.slice(0, -3), asked = mtime(name);
      if (!asked) return [];
      const answerName = `${id}.answer.md`, answered = mtime(answerName);
      const actor = answered ? actors[id] : undefined;
      const answered_by = actor === 'orchestrator' || actor === 'owner' ? actor : undefined;
      const timedOut = timedOutIds.has(id) ||
        (!answered && cleanSettle && settledAt !== undefined && settledAt - asked.ms >= QUESTION_TIMEOUT_MS);
      let used_default: boolean | undefined;
      if (timedOut) {
        used_default = true;
      } else {
        const qText = readQaText(dir, name);
        const def = qText !== undefined ? questionDefault(qText) : undefined;
        if (def !== undefined) {
          if (answered) {
            const aText = readQaText(dir, answerName);
            if (aText !== undefined) used_default = normWs(aText) === def;
          } else {
            used_default = false;
          }
        }
      }
      return [{ id, asked_at: asked.iso, answered_at: answered?.iso, answered_by, used_default }];
    });
    if (questions.length) return questions;
  } catch { /* Unknown question history. */ }
}

const logged = new Set<string>();
export function archiveJob(home: string, dir: string, id: string, receipt: Job | null,
  status: Partial<JobStatus>, now: number, log: (message: string) => void): void {
  try {
    // Claim first: if removal fails, a later scan must not append the same job again.
    try { fs.closeSync(fs.openSync(join(dir, jobFiles.archived), 'wx', 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; throw err; }
    const job: Partial<Job> = receipt ?? {};
    const createOptions = record(job.create_options);
    const ended = epoch(status.ended_at), reaped = epoch(job.reaped_at);
    const checks = jobChecks(dir, job);
    const sessions = Array.isArray(job.sessions) ? job.sessions.flatMap(s => {
      const native = s?.harness === 'pi' && text(s.id) ? { harness: 'pi', id: s.id } : cliSession(s?.harness, s?.id);
      return native ? [{ ...native, path: text(s.path) }] : [];
    }) : [];
    const row = {
      v: 1, ...projectJobFacts(home, dir, id, job, status, !!receipt), archived_at: new Date(now).toISOString(),
      thinking: text(job.thinking) ?? text(status.thinking), preset: text(job.preset) ?? text(job.route?.preset),
      model_source: text(job.model_source), thinking_source: text(job.thinking_source),
      imp_preset: text(job.imp_preset) ?? ((job.overflow_from ?? job.role) === 'imp' ? text(job.route?.preset) : undefined),
      requested_on: text(createOptions.on), requested_model: text(createOptions.model),
      had_worktree: receipt ? Boolean(job.worktree) : undefined,
      worktree_removed_at: text(job.worktree_removed_at),
      worktree_kept_reason: job.worktree_kept_reason ? reason(job.worktree_kept_reason) : undefined,
      stop_origin: archiveStopOrigin(job.stop_origin),
      attempts: Array.isArray(job.attempts) ? job.attempts.filter(a => typeof a?.place === 'string').map(a => ({
        index: Number.isInteger(a.index) ? a.index : undefined, place: a.place, reason: reason(a.reason),
      })) : undefined,
      dispatch_code: text(job.dispatch_code), exit_reason: reason(status.exit_reason), read_at: text(job.read_at),
      checks: checks && { passed: checks.passed, total: checks.total, stale: checks.stale },
      repair_of: text(job.repair_of), retry_of: text(job.retry_of), sessions: sessions.length ? sessions : undefined,
      dispatcher: archiveDispatcher(job.dispatcher),
      output_written: typeof status.output_written === 'boolean' ? status.output_written : undefined,
      questions: archiveQuestions(home, dir, job, status),
      experiment: typeof job.experiment === 'string' ? job.experiment : undefined,
      arm: typeof job.arm === 'string' ? job.arm : undefined,
      citations: jobCitations(job.citations),
      pool_pick: job.pool_pick && { entries: job.pool_pick.entries, reason: job.pool_pick.reason, source: job.pool_pick.source, ms: job.pool_pick.ms },
      land: archiveJobLand(home, id),
      outcome: cachedOutcome(home, id, epoch(status.settled_at) ?? ended),
    };
    const archive = join(home, 'archive');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    const month = new Date(ended ?? reaped ?? now).toISOString().slice(0, 7);
    fs.appendFileSync(join(archive, month + '.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    if (!logged.has(code)) { logged.add(code); log(`archive ${id} failed: ${code}`); }
  }
}
