/** Write-only retention ledger. Project individual facts; never serialize whole receipts. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { jobChecks } from './job-checks.js';

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
function reason(value: unknown) {
  if (typeof value !== 'string') return;
  const bytes = Buffer.alloc(200);
  return bytes.toString('utf8', 0, bytes.write(value)); // write stops at a complete UTF-8 character.
}
function epoch(value: unknown) {
  const ms = Date.parse(text(value) ?? '');
  return Number.isFinite(ms) ? ms : undefined;
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
export function archiveJob(home: string, dir: string, id: string, receipt: Record<string, unknown> | null,
  status: Record<string, unknown>, now: number, log: (message: string) => void): void {
  try {
    // Claim first: if removal fails, a later scan must not append the same job again.
    try { fs.closeSync(fs.openSync(join(dir, '.archived'), 'wx', 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; throw err; }
    const job = receipt ?? {};
    const cli = job.cli as { agent?: unknown } | undefined;
    const ended = epoch(status.ended_at), reaped = epoch(job.reaped_at);
    const checks = jobChecks(dir, job);
    const row = {
      v: 1, job: id, archived_at: new Date(now).toISOString(), project: text(job.project_root),
      role: text(job.role) ?? text(status.role), harness: cli ? text(cli.agent) : job.bro ? 'bro' : job.jev ? 'jev' : receipt ? 'pi' : undefined,
      model: text(job.model) ?? text(status.model), thinking: text(job.thinking) ?? text(status.thinking),
      preset: text(job.preset), used_place: text(job.used_place),
      attempts: Array.isArray(job.attempts) ? job.attempts.filter(a => typeof a?.place === 'string').map(a => ({
        index: Number.isInteger(a.index) ? a.index : undefined, place: a.place, reason: reason(a.reason),
      })) : undefined,
      dispatch_exit_code: Number.isInteger(job.dispatch_exit_code) ? job.dispatch_exit_code : undefined,
      dispatch_code: text(job.dispatch_code), state: text(status.state), exit_reason: reason(status.exit_reason),
      created_at: text(job.created_at), started_at: text(status.started_at), settled_at: text(status.settled_at),
      ended_at: text(status.ended_at), read_at: text(job.read_at), reaped_at: text(job.reaped_at),
      checks: checks && { passed: checks.passed, total: checks.total, stale: checks.stale },
      repair_of: text(job.repair_of), parent_job: text(job.parent_job), package: text(job.package),
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
