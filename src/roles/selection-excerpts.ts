/** Private, bounded receipts for selection replies, advisors and next-turn notes, independent of the source pane. */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { isShellLaunchedWorker } from '../runtime/herdr-socket.js';
import { tryAbstractLock, withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { herdrId } from './herdr-run.js';
import { sharedRoot } from './projects.js';
import type { SelectionSource } from './select-send.js';
import { getJobIndexCache, type JobIndexCache } from './job-index-cache.js';

const MAX_RECORDS = 64;
const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_EXCERPT_REPLY = 4000;
export type ExcerptDelivery = 'queued' | 'target ended' | 'delivery unknown';
type NoteDelivery = 'pending' | 'delivered' | 'undelivered';
export interface SelectionExcerpt {
  id: string;
  excerpt: string;
  source: SelectionSource;
  question: string;
  target: string;
  launchId: string;
  role: string;
  delivery: ExcerptDelivery | NoteDelivery;
  note?: string;
  answer?: { text: string; at: string };
  advisor?: { ended?: boolean; followups: { question: string; answer?: SelectionExcerpt['answer'] }[] };
}

export const MAX_ADVISOR_FOLLOWUPS = 8;

export function jobProjectRoot(job: Partial<Job>): string | null {
  if (typeof job.project_root === 'string' && job.project_root) return job.project_root;
  if (typeof job.worktree?.main_root === 'string' && job.worktree.main_root) return job.worktree.main_root;
  return typeof job.cwd === 'string' && job.cwd ? sharedRoot(job.cwd) : null;
}

type TargetSession = { primary?: string; directExec?: string; herdrSocket?: string; launchId?: string };
// A headless queue drains by resuming after settlement; a selection must never cause a reopen.
export function excerptTargetSupported(job: Job, fields: TargetSession | undefined,
  endpoint: string | undefined): fields is TargetSession & { primary: string; launchId: string } {
  return !job.headless && job.role !== 'sonic' && job.role !== 'council' && !job.council && !job.scout_only && !job.bro && !job.jev &&
    (!job.cli || (!job.cli.mcp_scope_warning && (job.cli.agent === 'claude' || job.cli.agent === 'codex'))) &&
    herdrId(fields?.primary) && herdrId(fields?.launchId) && !isShellLaunchedWorker(fields) &&
    endpoint !== undefined && fields?.herdrSocket === endpoint;
}

export const excerptTargetEnded = (job: Partial<Job>, status?: Partial<JobStatus> | null): boolean =>
  Boolean(job.reaped_at || ['idle_grace', 'done', 'closed', 'failed', 'stopped'].includes(status?.state ?? ''));

function storeFile(home: string): string {
  // Workers resolve HUD_HOME from the real job directory; use the same lock key for an aliased home.
  let root: string;
  try { root = realpathSync(home); } catch { root = resolve(home); }
  return join(root, 'selection-excerpts.json');
}
const advisorLockKey = (file: string, id: string) => join(dirname(file), id);

export function withSelectionAdvisorLock<T>(home: string, id: string, run: () => Promise<T>): Promise<T> {
  return withAbstractLock('selection-advisor', advisorLockKey(storeFile(home), id), run);
}

function readStore(file: string): SelectionExcerpt[] {
  try { return readJsonBounded(file, MAX_BYTES) as SelectionExcerpt[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function noteUndelivered(home: string, cache: JobIndexCache, row: SelectionExcerpt): boolean {
  const job = cache.readJob<Job>(row.target), status = cache.readStatus<JobStatus>(row.target);
  const launch = cache.readSession(row.target)?.fields.launchId;
  // Idle grace can still take another native prompt without changing launches.
  return job.status === 'missing' || (job.status === 'ok' && Boolean(job.value.reaped_at)) ||
    (status.status === 'ok' && ['done', 'closed', 'failed', 'stopped'].includes(status.value.state)) ||
    Boolean(launch && launch !== row.launchId) || existsSync(join(home, 'jobs', row.target, jobFiles.stopRequested));
}

export function readSelectionExcerpts(home: string, cache: JobIndexCache, scope: { job: string } | { project: string }): SelectionExcerpt[] {
  try {
    return readStore(storeFile(home)).filter(row => 'job' in scope ? row.target === scope.job : row.source.projectRoot === scope.project)
      .map(row => {
        if (row.note !== undefined) return row.delivery === 'pending' && noteUndelivered(home, cache, row)
          ? { ...row, delivery: 'undelivered' } : row;
        if (row.answer || row.delivery === 'target ended') return row;
        const status = cache.readStatus<JobStatus>(row.target);
        if (row.advisor) return row.advisor.ended || (status.status === 'ok' && ['closed', 'failed', 'stopped'].includes(status.value.state))
          ? { ...row, delivery: 'target ended' } : row;
        const job = cache.readJob<Job>(row.target);
        const launch = cache.readSession(row.target)?.fields.launchId;
        const ended = job.status === 'ok' && excerptTargetEnded(job.value, status.status === 'ok' ? status.value : null);
        return ended || (launch && launch !== row.launchId) ? { ...row, delivery: 'target ended' } : row;
      });
  } catch { return []; } // An unavailable receipt must not hide the rest of the view.
}

export function readSelectionAdvisor(home: string, id: string): SelectionExcerpt | undefined {
  try { return readStore(storeFile(home)).find(row => row.id === id && row.advisor); }
  catch { return undefined; }
}

export function updateSelectionAdvisor(home: string, id: string, target: string,
  update: (row: SelectionExcerpt, advisor: NonNullable<SelectionExcerpt['advisor']>) => boolean): Promise<boolean> {
  const file = storeFile(home);
  return withAbstractLock('selection-excerpts', file, () => {
    const rows = readStore(file), row = rows.find(item => item.id === id && item.target === target);
    if (!row?.advisor || !update(row, row.advisor)) return false;
    writeJsonPrivate(file, rows);
    return true;
  });
}

export async function recordAdvisorAnswer(home: string, id: string, target: string, text: string): Promise<void> {
  await updateSelectionAdvisor(home, id, target, (row, advisor) => {
    const turn = advisor.followups.at(-1) ?? row;
    if (turn.answer) return false;
    turn.answer = { text: text.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, MAX_EXCERPT_REPLY), at: new Date().toISOString() };
    return true;
  });
}

type ExcerptInput = Omit<SelectionExcerpt, 'id' | 'delivery' | 'answer' | 'note'>;

function advisorSettled(cache: JobIndexCache, row: SelectionExcerpt): boolean {
  if (row.advisor?.ended) return true;
  const status = cache.readStatus<JobStatus>(row.target);
  if (status.status === 'ok') return ['done', 'closed', 'failed', 'stopped'].includes(status.value.state);
  // Initial dispatch creates the job directory before recording the card; no status yet is not a terminal state.
  return status.status === 'missing' && !cache.readJobDirMeta(row.target);
}

async function appendExcerpt(home: string, file: string, row: SelectionExcerpt): Promise<void> {
  const rows = readStore(file);
  if (rows.length < MAX_RECORDS) {
    writeJsonPrivate(file, [row, ...rows]);
    return;
  }
  const cache = getJobIndexCache(home);
  for (let i = rows.length - 1; i >= 0; i--) {
    const candidate = rows[i];
    if (candidate.delivery === 'pending' && !noteUndelivered(home, cache, candidate)) continue;
    // A follow-up holds this lock before replacing its preceding turn's terminal status.
    // Never wait for it here: a follow-up takes the store lock to record its question.
    const release = candidate.advisor && await tryAbstractLock('selection-advisor', advisorLockKey(file, candidate.id));
    if (candidate.advisor && !release) continue;
    try {
      if (candidate.advisor && !advisorSettled(cache, candidate)) continue;
      rows.splice(i, 1);
      writeJsonPrivate(file, [row, ...rows]);
      return;
    } finally { await release?.(); }
  }
  throw new Error('selection excerpt store full');
}

export async function recordSelectionExcerpt(home: string, input: ExcerptInput, id = randomUUID() as string): Promise<SelectionExcerpt> {
  const file = storeFile(home);
  const row: SelectionExcerpt = { ...input, id, delivery: input.advisor ? 'queued' : 'delivery unknown' };
  await withAbstractLock('selection-excerpts', file, () => appendExcerpt(home, file, row));
  return row;
}

export function recordSelectionNote(home: string, input: Omit<ExcerptInput, 'question' | 'advisor'> & { note: string },
  endpoint: string | undefined, signal?: AbortSignal) {
  const file = storeFile(home), cache = getJobIndexCache(home);
  return withAbstractLock('selection-excerpts', file, async () => {
    const row: SelectionExcerpt = { ...input, question: '', id: randomUUID(), delivery: 'pending' };
    if (noteUndelivered(home, cache, row)) row.delivery = 'undelivered';
    else {
      const job = cache.readJob<Job>(input.target), status = cache.readStatus<JobStatus>(input.target);
      const fields = cache.readSession(input.target)?.fields;
      if (job.status !== 'ok' || job.value.cli || jobProjectRoot(job.value) !== input.source.projectRoot ||
          status.status !== 'ok' || !['working', 'idle_grace'].includes(status.value.state) ||
          !excerptTargetSupported(job.value, fields, endpoint) || fields.launchId !== input.launchId) return null;
    }
    await appendExcerpt(home, file, row);
    return row;
  }, { signal });
}

export function pendingSelectionNotes(home: string, target: string, launchId: string): SelectionExcerpt[] {
  return readStore(storeFile(home)).filter(row => row.target === target && row.launchId === launchId && row.delivery === 'pending').reverse();
}

export function markSelectionNotesDelivered(home: string, ids: ReadonlySet<string>): Promise<void> {
  const file = storeFile(home);
  return withAbstractLock('selection-excerpts', file, () => {
    const rows = readStore(file);
    let changed = false;
    for (const row of rows) if (row.delivery === 'pending' && ids.has(row.id)) {
      row.delivery = 'delivered';
      changed = true;
    }
    if (changed) writeJsonPrivate(file, rows);
  });
}

export function setExcerptDelivery(home: string, id: string, delivery: ExcerptDelivery): Promise<void> {
  const file = storeFile(home);
  return withAbstractLock('selection-excerpts', file, () => {
    const rows = readStore(file), row = rows.find(item => item.id === id);
    if (!row) return;
    row.delivery = delivery;
    writeJsonPrivate(file, rows);
  });
}

export function replyToExcerpt(home: string, target: string, id: string, message: string): Promise<{ ok: boolean; code?: string }> {
  const text = message.trim();
  if (!text || [...text].length > MAX_EXCERPT_REPLY) throw new Error('invalid_arguments: message');
  const file = storeFile(home);
  return withAbstractLock('selection-excerpts', file, () => {
    const rows = readStore(file), row = rows.find(item => item.id === id && item.target === target);
    if (!row || row.advisor || row.note !== undefined || row.delivery === 'target ended') return { ok: false, code: 'excerpt_not_found' };
    if (!row.answer) {
      row.answer = { text, at: new Date().toISOString() };
      writeJsonPrivate(file, rows);
    }
    return { ok: true };
  });
}
