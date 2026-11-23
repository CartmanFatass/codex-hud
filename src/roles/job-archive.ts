/** Retention ledger. Project individual facts; never serialize whole receipts. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { getJobIndexCache } from './job-index-cache.js';
import { jobChecks } from './job-checks.js';
import { cliSession } from './job-sessions.js';
import { archiveJobLand, type JobLand } from './job-land.js';
import { epoch, readJobUsage, text, type JobUsage } from './job-usage.js';
import { normalizeReportMeta, readReportMeta } from './report-meta.js';
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
  ticket?: string; package?: string; route?: { tier?: string; mode?: string }; mode?: string;
  question_count?: number; parent_job?: string; summary?: string; usage?: JobUsage; land?: JobLand;
  state?: string; created_at?: string; started_at?: string; settled_at?: string; ended_at?: string;
  archived_at?: string; reaped_at?: string; dispatch_exit_code?: number;
};

/** The same facts back a still-retained job and its later archive line. */
export function projectJobFacts(home: string, dir: string, id: string, job: Partial<Job>, status: Partial<JobStatus>, hasJob = true): JobFacts {
  const { tier, mode } = job.route ?? {};
  let question_count: number | undefined;
  try { question_count = getJobIndexCache(home).readQa(dir).allQuestionFiles.length; } catch { /* Unknown. */ }
  const terminal = ['idle_grace', 'done', 'closed', 'failed', 'stopped'].includes(status.state ?? '');
  const summary = terminal ? readReportMeta(dir)?.summary : undefined;
  const harness = job.cli?.agent ?? status.agent ?? (job.bro ? 'bro' : job.jev ? 'jev' : status.harness ?? (hasJob ? 'pi' : undefined));
  return {
    job: id, project: text(job.project_root) ?? text(job.worktree?.main_root) ?? text(job.cwd), role: text(job.role) ?? text(status.role),
    harness, model: text(job.model) ?? text(status.model), used_place: text(job.used_place),
    ticket: text(job.ticket), package: text(job.package), parent_job: text(job.parent_job),
    route: tier || mode ? { tier: text(tier), mode: text(mode) } : undefined,
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

const logged = new Set<string>();
export function archiveJob(home: string, dir: string, id: string, receipt: Job | null,
  status: Partial<JobStatus>, now: number, log: (message: string) => void): void {
  try {
    // Claim first: if removal fails, a later scan must not append the same job again.
    try { fs.closeSync(fs.openSync(join(dir, jobFiles.archived), 'wx', 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; throw err; }
    const job: Partial<Job> = receipt ?? {};
    const ended = epoch(status.ended_at), reaped = epoch(job.reaped_at);
    const checks = jobChecks(dir, job);
    const sessions = Array.isArray(job.sessions) ? job.sessions.flatMap(s => {
      const native = s?.harness === 'pi' && text(s.id) ? { harness: 'pi', id: s.id } : cliSession(s?.harness, s?.id);
      return native ? [{ ...native, path: text(s.path) }] : [];
    }) : [];
    const row = {
      v: 1, ...projectJobFacts(home, dir, id, job, status, !!receipt), archived_at: new Date(now).toISOString(),
      thinking: text(job.thinking) ?? text(status.thinking), preset: text(job.preset),
      attempts: Array.isArray(job.attempts) ? job.attempts.filter(a => typeof a?.place === 'string').map(a => ({
        index: Number.isInteger(a.index) ? a.index : undefined, place: a.place, reason: reason(a.reason),
      })) : undefined,
      dispatch_code: text(job.dispatch_code), exit_reason: reason(status.exit_reason), read_at: text(job.read_at),
      checks: checks && { passed: checks.passed, total: checks.total, stale: checks.stale },
      repair_of: text(job.repair_of), retry_of: text(job.retry_of), sessions: sessions.length ? sessions : undefined,
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
