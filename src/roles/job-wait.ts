/** Read-only job observation and local waits. Keep this graph free of execution adapters. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { agentStatus, isRecord, runHerdr, waitArgs, type HerdrOutcome } from './herdr-run.js';
import { readDispatchSession } from './pi-dispatch.js';
import { observeDispatch, waitDispatch, type DispatchObservation } from './pi-dispatch-status.js';
import {
  fail,
  JOB_ID,
  jobDirectory,
  loadReceipt,
  requireHerdr,
  type ExecutorIds,
  type JobReceipt,
  type Result,
} from './job-receipt.js';

export const DEFAULT_WAIT_MS = 1_800_000;
export interface ObservationContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run?: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<HerdrOutcome>;
  readonly herdrBudgetMs?: number;
}
export function dispatchView(
  home: string,
  receipt: JobReceipt
): DispatchObservation & { executor: ExecutorIds; launch: string } {
  const directory = jobDirectory(home, receipt.job);
  const view = observeDispatch(directory, receipt.pi_dispatch!, receipt.state === 'closed');
  const session = readDispatchSession(directory);
  const executor =
    receipt.executor.kind === 'herdr' && session
      ? { ...receipt.executor, tab_id: session.TAB, pane_id: session.LEFT, agent: session.PRIMARY, workspace_id: null }
      : receipt.executor;
  // SESSION and the initial working snapshot do not prove the first prompt was submitted.
  if (receipt.pi_dispatch!.launch === 'sent' && view.state === 'open' && !receipt.pi_dispatch!.continuation)
    view.state = 'launch_unknown';
  return { ...view, executor, launch: receipt.pi_dispatch!.launch };
}
export async function readDispatch(
  ctx: ObservationContext,
  receipt: JobReceipt,
  waitMs: number,
  armed = waitMs > 0
): Promise<Result> {
  const observe = async (remainingMs: number, checkHerdr = true) => {
    // Waiters hold no mutation lock: reload to see concurrent close/continuation.
    const current = loadReceipt(ctx.home, receipt.job);
    if (!current?.pi_dispatch) return { ok: false as const, code: 'receipt_unreadable', event: 'BLOCKED' as const };
    const view = dispatchView(ctx.home, current);
    let herdr: string | null = null;
    if (checkHerdr && !view.event && remainingMs > 0 && view.executor.kind === 'herdr' && view.executor.agent) {
      const budget = Math.max(1, Math.min(1000, remainingMs, ctx.herdrBudgetMs ?? 1000));
      const got = ctx.run
        ? await ctx.run(['agent', 'get', view.executor.agent], ctx.env)
        : await runHerdr(['agent', 'get', view.executor.agent], ctx.env, { budgetMs: budget });
      herdr = got.ok ? agentStatus(got.stdout) : 'unknown';
      if (herdr === 'blocked') view.event = 'BLOCKED';
    }
    return {
      ok: true as const,
      job: current.job,
      role: current.role,
      phase: current.phase,
      prompted: current.prompted,
      binding: current.binding,
      preset: current.preset,
      ...view,
      herdr,
    };
  };
  return armed ? waitDispatch(observe, waitMs, { directory: jobDirectory(ctx.home, receipt.job) }) : observe(0);
}
const QUESTION = /^q([1-9][0-9]{0,3})\.md$/;
export function questions(directory: string): { id: string; path: string }[] {
  const qa = join(directory, 'qa');
  let names: string[];
  try {
    names = fs.readdirSync(qa);
  } catch {
    return [];
  }
  const pending: { id: string; path: string }[] = [];
  for (const name of names.sort()) {
    const match = QUESTION.exec(name);
    if (!match) continue;
    const path = join(qa, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const id = `q${match[1]}`;
    const answer = join(qa, `${id}.answer.md`);
    let answered = false;
    try {
      answered = fs.lstatSync(answer).isFile();
    } catch {
      answered = false;
    }
    if (!answered) pending.push({ id, path });
  }
  return pending;
}
export function observation(home: string, receipt: JobReceipt, status: string | null): Result {
  const directory = jobDirectory(home, receipt.job);
  const report = join(directory, 'report.md');
  let reportReady = false;
  try {
    reportReady = fs.lstatSync(report).isFile();
  } catch {
    reportReady = false;
  }
  return {
    ok: true,
    job: receipt.job,
    role: receipt.role,
    phase: receipt.phase,
    state: receipt.state,
    status: receipt.state === 'launch_unknown' ? 'launch_unknown' : receipt.state === 'closed' ? 'closed' : status,
    prompted: receipt.prompted,
    acceptance: null,
    pending: questions(directory),
    report: reportReady ? report : null,
    report_path: report,
    binding: receipt.binding,
    executor: receipt.executor,
    preset: receipt.preset,
  };
}
/** herdr reports failures on one JSON stderr line; exit 1 alone is ambiguous. */
function herdrErrorCode(stderr: string): string | null {
  if (Buffer.byteLength(stderr) > 4096) return null;
  const line = stderr.trim();
  if (/[\r\n]/.test(line)) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || !isRecord(value.error)) return null;
    const code = value.error.code;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
/** Local CLI wait deliberately has no session owner check; it only reads HUD_HOME. */
export async function waitForJob(
  home: string,
  env: NodeJS.ProcessEnv,
  job: string,
  timeoutMs: number | null
): Promise<Result> {
  if (!JOB_ID.test(job)) return fail('invalid_arguments', { field: 'job' });
  const receipt = loadReceipt(home, job);
  if (!receipt) return fail('not_found', { field: 'job' });
  if (receipt.executor.kind === 'jev') return fail('unsupported', { job, reason: 'use_hud_read' });
  if (receipt.pi_dispatch) {
    const result = await readDispatch({ home, env }, receipt, timeoutMs ?? DEFAULT_WAIT_MS, true);
    if (result.ok && result.state === 'launch_unknown') return { ...result, ok: false, code: 'launch_unknown' };
    // Keep hud_read's existing deadline spelling; the local CLI has a distinct exit contract.
    return result.ok && result.event === 'timeout' ? { ...result, event: 'TIMEOUT' } : result;
  }
  requireHerdr(receipt);
  if (receipt.state === 'launch_unknown' || receipt.state === 'launching')
    return fail('launch_unknown', { job, acceptance: null });
  if (receipt.state === 'closed') return { ok: true, job, status: 'closed', acceptance: null };
  const cap = timeoutMs ?? DEFAULT_WAIT_MS;
  const waited = await runHerdr(waitArgs(receipt.executor.agent, cap), env);
  if (!waited.ok) {
    const herdrCode = herdrErrorCode(waited.stderr);
    if (waited.reason === 'timeout' || (waited.reason === 'failed' && herdrCode === 'timeout')) {
      const current = loadReceipt(home, job) ?? receipt;
      const got = await runHerdr(
        ['agent', 'get', current.executor.kind === 'herdr' ? current.executor.agent : receipt.executor.agent],
        env,
        { budgetMs: 1000 }
      );
      return {
        ...observation(home, current, got.ok ? agentStatus(got.stdout) : 'unknown'),
        event: 'TIMEOUT',
        ...(herdrCode ? { herdr_code: herdrCode } : {}),
      };
    }
    return fail('wait_failed', {
      job,
      status: 'unknown',
      acceptance: null,
      ...(herdrCode ? { herdr_code: herdrCode } : {}),
    });
  }
  return { ok: true, job, status: agentStatus(waited.stdout) ?? 'unknown', acceptance: null };
}
