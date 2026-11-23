/** Caller identity, session ownership, and delivery cursors. */
import { PanelActionLog } from '../../collectors/panel-actions.js';
import { adoptionAttention, jobRowReportMeta, type JobRow } from '../../collectors/thin-jobs.js';
import { TryLog } from '../../collectors/try-records.js';
import { herdrId } from '../../roles/herdr-run.js';
import { adoptProjectJobs, projectJobFilter } from '../../roles/job-project.js';
import { ensureQueueWatcher, watchingMod } from '../../roles/notify.js';
import { resumedWorkerRefusal } from '../../roles/resume-guard.js';
import type { Job } from '../job-contracts.js';
import { isWorker, hudHome, findJob, jobCache, scanForCall, readRow, directory, type JobScan } from '../store/job-store.js';
import { rememberCreatedJob } from '../task-bounds.js';

export const session = {
  resumeChecked: false,
  resumeRefusal: undefined as string | undefined,
  callerHarness: undefined as 'agy' | 'claude' | 'codex' | 'pi' | undefined,
  sentConventionVersion: undefined as string | undefined,
  sentCreateHint: false,
  discovered: false, taskCapable: false, taskClient: false, agyClient: false,
  createdJobs: new Set<string>(),
  cursor: new Map<string, JobRow>(),
};

export function checkResume(agent: 'agy' | 'claude' | 'codex', id: unknown) {
  if (isWorker || session.resumeChecked || typeof id !== 'string' || !id) return;
  session.resumeChecked = true;
  session.resumeRefusal = resumedWorkerRefusal(hudHome, { agent, id });
}

export const callerPane = herdrId(process.env.HERDR_PANE_ID) ? process.env.HERDR_PANE_ID! : null;
export function rememberCallerHarness(agent: unknown): void {
  if (!session.callerHarness && (agent === 'agy' || agent === 'claude' || agent === 'codex' || agent === 'pi')) session.callerHarness = agent;
}
export function deliveryHint(watcherAlive: boolean): string {
  if (watcherAlive && watchingMod(callerPane, hudHome)) return 'Claude mod owns event wake. Keep working until notified, then collect reports with `hud_read`; batch hud_create is available.';
  if (session.taskClient) return 'Worker-turn events arrive as MCP task completions; owner panel decisions arrive without hud watch. Use `hud_read` to collect reports and check jobs without a task.';
  const fallback = 'Without live delivery, questions may be typed; use `hud_wait` for settlement or attention.';
  const live = 'Keep working until notified, then collect reports with `hud_read`.';
  switch (session.callerHarness) {
    case 'agy':
      return watcherAlive
        ? `Antigravity: the PreInvocation hook delivers events while working; herdr types them when idle. ${live}`
        : 'Antigravity: no live watch. Use `hud_wait` for settlement or attention.';
    case 'claude':
      return `Claude Code: ${watcherAlive ? '`hud watch` is live under Monitor' : 'run `hud watch` under Monitor'}; re-arm after expiry. ${live}`;
    case 'codex':
      return 'Codex: events are queued automatically; no Monitor is needed. Missing thread ID or queue failure falls back to typing.';
    case 'pi':
      return watcherAlive
        ? `pi: native HUD notices wake an idle session or arrive before the next model request, without touching drafts. ${live}`
        : `pi: the native HUD watch is not active. ${fallback}`;
    default:
      return watcherAlive ? `HUD watch is live. ${live}` : fallback;
  }
}
export const trackCreatedJob = (id: string) => rememberCreatedJob(session.createdJobs, id, (jobId) => !!findJob(jobId));

export async function adoptSessionJobs(scan: JobScan) {
  if (!callerPane) return false;
  const receipts = scan.all(), cwd = process.cwd();
  const onAdopt = (id: string) => {
    const job = findJob(id);
    if (job) scan.record(job);
  };
  if (!await adoptProjectJobs(hudHome, callerPane, cwd, receipts, process.env,
    adoptionAttention(hudHome, receipts, cwd, jobCache), jobCache, onAdopt)) return false;
  scan.invalidateSummary();
  if (!session.taskClient) void ensureQueueWatcher(callerPane, hudHome);
  return true;
}
export function ownsJob(job: Job) {
  return !job.scout_only && (callerPane ? job.herdr_pane === callerPane : session.createdJobs.has(job.job));
}
export function sessionJobs(scan: JobScan) {
  const own = scan.all().filter(ownsJob);
  return own.length ? own.filter(projectJobFilter(process.cwd())) : own;
}
export function sessionRows(markExhaustion: boolean, scan = scanForCall()): JobRow[] {
  return sessionJobs(scan)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.job.localeCompare(b.job))
    .slice(0, 200)
    .map((job) => {
      const { row } = readRow(job, markExhaustion, scan);
      const reportMeta = jobRowReportMeta(row, directory(job.job));
      return reportMeta ? { ...row, report_meta: reportMeta } : row;
    });
}
export const tries = new TryLog(hudHome), answers = new PanelActionLog(hudHome);
