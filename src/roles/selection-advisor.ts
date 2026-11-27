import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSettings } from '../settings.js';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { closedReport, resumeDeadline } from '../mcp/worker-resume.js';
import { formatSelectionMessage, normalizeQuestion, type SelectionSource } from './select-send.js';
import { MAX_ADVISOR_FOLLOWUPS, readSelectionAdvisor, updateSelectionAdvisor, withSelectionAdvisorLock, type SelectionExcerpt } from './selection-excerpts.js';
import { getJobIndexCache } from './job-index-cache.js';

export function advisorPhase(home: string, row: SelectionExcerpt, nowMs: number): 'waiting' | 'ready' | 'ended' | 'unavailable' {
  if (row.advisor?.ended) return 'ended';
  const cache = getJobIndexCache(home);
  const job = cache.readJob<Job>(row.target), status = cache.readStatus<JobStatus>(row.target);
  if (job.status !== 'ok' || job.value.selection_advisor !== row.id) return 'unavailable';
  if (status.status !== 'ok') return 'waiting';
  const state = status.value.state;
  if (state === 'working' || state === 'idle_grace') return 'waiting';
  const turn = row.advisor?.followups.at(-1) ?? row;
  return turn.answer && closedReport(job.value, status.value) && (resumeDeadline(job.value, status.value) ?? 0) > nowMs
    ? 'ready' : 'unavailable';
}

export async function startSelectionAdvisor(home: string, input: { excerpt: string; source: SelectionSource; question: string }, env: NodeJS.ProcessEnv):
  Promise<{ advisor?: SelectionExcerpt; error?: string }> {
  const cwd = input.source.projectRoot;
  if (!cwd || !input.source.pane || (await import('../mcp/store/job-store.js')).hudHome !== resolve(home)) return {};
  const id = randomUUID();
  const advisor = { ...input, id, question: normalizeQuestion(input.question) };
  const role = loadSettings(env).selectionAdvisorRole;
  const { dispatchJob } = await import('../mcp/dispatch/orchestrator.js');
  const result = await dispatchJob({ role, cwd, mode: 'headless', prewalk: false, request_key: `selection-advisor:${id}`,
    task: formatSelectionMessage(advisor) }, undefined, { advisor });
  if ('ok' in result && result.ok === false) {
    const error = ('reason' in result && result.reason) || ('error' in result && result.error) || ('code' in result && result.code);
    return { error: typeof error === 'string' ? error : undefined };
  }
  return { advisor: 'job' in result && result.job ? readSelectionAdvisor(home, id) : undefined };
}

export function continueSelectionAdvisor(home: string, id: string, draft: string): Promise<boolean> {
  return withSelectionAdvisorLock(home, id, async () => {
    const row = readSelectionAdvisor(home, id);
    const question = normalizeQuestion(draft);
    if (!row?.advisor || !question || row.advisor.followups.length >= MAX_ADVISOR_FOLLOWUPS || advisorPhase(home, row, Date.now()) !== 'ready') return false;
    if ((await import('../mcp/store/job-store.js')).hudHome !== resolve(home)) return false;
    const { sendJob } = await import('../mcp/dispatch/orchestrator.js');
    const added = await updateSelectionAdvisor(home, id, row.target, (_, advisor) => {
      advisor.followups.push({ question });
      return true;
    });
    if (!added) return false;
    const result = await sendJob(row.target, `Follow-up question: ${question}`, randomUUID(), false, { advisor: id });
    if ('ok' in result && result.ok) return true;
    // On a refused continuation leave the draft in the window, not as a sent question.
    await updateSelectionAdvisor(home, id, row.target, (_, advisor) => {
      if (advisor.followups.at(-1)?.answer) return false;
      advisor.followups.pop();
      return true;
    });
    return false;
  });
}

export function endSelectionAdvisor(home: string, id: string): Promise<boolean> {
  return withSelectionAdvisorLock(home, id, async () => {
    const row = readSelectionAdvisor(home, id);
    if (!row?.advisor) return false;
    if (row.advisor.ended) return true;
    const { hudHome, findJob } = await import('../mcp/store/job-store.js');
    if (hudHome !== resolve(home)) return false;
    const job = findJob(row.target);
    if (job) {
      if (job.selection_advisor !== id) return false;
      const { closeJob } = await import('../mcp/mcp/operations.js');
      if ((await closeJob(job, true)).exit_code !== 0) return false;
    }
    return updateSelectionAdvisor(home, id, row.target, (_, advisor) => { advisor.ended = true; return true; });
  });
}
