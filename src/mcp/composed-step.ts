import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { failedAttempt } from '../collectors/thin-jobs.js';
import { CHECK_TIMEOUT_MS } from '../roles/job-checks.js';
import { readFileBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isProcAlive } from '../utils/proc.js';
import { driveWorkflow } from '../workflows/driver.js';
import { hashComposedGraph, readComposed, readComposedGraph, workflowGrants, type CheckResult, type ComposedCursor, type ComposedRun } from '../workflows/composed-state.js';
import type { Tick } from '../workflows/engine.js';
import type { Step } from '../workflows/graph.js';
import { directRecipient } from '../workflows/scope.js';
import { runDir, runLock, saveHeader } from '../workflows/store.js';
import { wakeWorkflow } from '../workflows/wake.js';
import type { Args } from './dispatch/context.js';
import { batchHasRoom, dispatchJob, dispatchLandRepair, releaseLandTurn } from './dispatch/orchestrator.js';
import type { Job } from './job-contracts.js';
import { startLand } from './land.js';
import { activeLand, landAttempt, readLand } from './land-state.js';
import { jobFiles } from './paths.js';
import { directory, findJob, hudHome, jobs, readRow } from './store/job-store.js';
import { closeLeadJob, DEFAULT_ESCALATION_RULE, parseLeadReport, WORKFLOW_WORKER_RULE, WORKFLOW_WORKER_RULE_NO_ASK } from './workflow-lead.js';

const fail = (reason: string): Tick => ({ state: 'failed', reason });
const wait = (recheckMs?: number): Tick => ({ state: 'running', changed: false, recheckMs });
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const receipt = (run: ComposedRun, key: string) => jobs().find(job => job.workflow === run.flow && job.request_key === key);
const pane = (run: ComposedRun) => directRecipient(run) ? run.pane || undefined : undefined;
const working = (run: ComposedRun) => readComposed(hudHome, run.flow)?.state === 'working';
const indexPath = (run: ComposedRun, step: string) => join(runDir(hudHome, run.flow), `${step}.index.json`);
const reportPath = (job: string) => join(directory(job), jobFiles.report);
const checkPath = (run: ComposedRun, step: string) => join(runDir(hudHome, run.flow), `${step}.check.json`);
function update(run: ComposedRun, key: string, f: (cursor: ComposedCursor, latest: ComposedRun) => void) {
  return runLock(hudHome, run.flow, () => {
    const latest = readComposed(hudHome, run.flow)!;
    f(latest.steps[key], latest); saveHeader(hudHome, latest);
  });
}
function effect(run: ComposedRun, fn: () => Promise<number>): Tick {
  run.input_admitted = true;
  return { state: 'running', changed: true, effect: fn };
}

/** A job output means a settled report, not a successful launch. */
function observeJob(job: Job): Tick {
  const { row, status } = readRow(job, false, null);
  if (failedAttempt(row) || row.state === 'stopped' || job.dispatch_exit_code && !status)
    return fail(row.reason || job.stderr_tail || row.state || 'dispatch failed');
  if (['idle_grace', 'closed', 'done'].includes(row.state ?? ''))
    return row.report_present && status?.output_written !== false ? { state: 'done' } : fail('settled without a report');
  if (!status && job.launcher && !isProcAlive(job.launcher.pid, job.launcher.start)) return fail('dispatch interrupted without worker status');
  if (job.role === 'council' && !fs.existsSync(`${runDir(hudHome, job.job)}.json`)) return fail('council admission interrupted');
  return wait(!status ? 1_000 : undefined);
}
function references(run: ComposedRun, from: string[]) {
  const ids = new Set<string>(), paths: string[] = [];
  for (const id of from) {
    const c = run.steps[id];
    if (c.state !== 'done') continue;
    if (c.items) {
      const members = c.items.flatMap(i => i.state === 'done' && i.job ? [i.job] : []);
      if (ids.size + members.length <= 16) for (const member of members) ids.add(member);
      else paths.push(indexPath(run, id));
    } else if (c.check) paths.push(checkPath(run, id));
    else if (c.job && ids.size < 16) ids.add(c.job);
    else if (c.job) paths.push(reportPath(c.job));
    else if (c.land) paths.push(`${runDir(hudHome, c.land)}.json`);
  }
  return { ids: [...ids], paths };
}

type DispatchOptions = { isolation?: string; member?: true; preset?: string; members?: string[]; synthesizer?: string };
async function create(run: ComposedRun, request: string, role: string, task: string, from: string[], options: DispatchOptions = {}) {
  const refs = references(run, from);
  const args: Args = { role, cwd: run.cwd, request_key: request, task: refs.paths.length ? `${task}\n\nWorkflow results: ${refs.paths.join(', ')}` : task,
    ...(refs.ids.length && { from_jobs: refs.ids }), ...(role !== 'council' ? { isolation: options.isolation ?? 'none', prewalk: false }
      : { members: options.members, synthesizer: options.synthesizer }) };
  const canAdmit = () => working(run);
  const result = await dispatchJob(args, pane(run), { dispatcher: run.dispatcher, workspace: run.workspace,
    workflow: { id: run.flow, cheap: run.cost === 'cheap', grant: run.grant, canAdmit, preset: options.preset },
    ...(options.member && { member: { flow: run.flow, canAdmit } }) });
  const job = 'job' in result && typeof result.job === 'string' ? result.job : undefined;
  const code = 'code' in result ? result.code : undefined;
  const error = (!job || ('ok' in result && result.ok === false)) && (('error' in result && result.error) || ('reason' in result && result.reason) || code);
  return { job, code, error: error ? reason(error) : undefined };
}

function tickJob(run: ComposedRun, key: string, cursor: ComposedCursor, role: string, task: string, from: string[], options: DispatchOptions = {}): Tick {
  const request = `workflow:${run.flow}:${key}:${cursor.attempt ?? 0}`;
  const job = cursor.job ? findJob(cursor.job) : cursor.admitted ? receipt(run, request) : undefined;
  if (job) {
    const changed = cursor.job !== job.job; cursor.job = job.job;
    return { ...observeJob(job), ...(changed && { changed }) };
  }
  if (cursor.admitted) return fail(cursor.reason || 'dispatch interrupted without a job receipt');
  if (run.state !== 'working') return wait();
  cursor.admitted = true;
  return effect(run, async () => {
    let result: Awaited<ReturnType<typeof create>>;
    try { result = await create(run, request, role, task, from, options); }
    catch (error) { result = { job: undefined, code: undefined, error: reason(error) }; }
    await update(run, key, c => {
      if (result.code === 'queue_stopped') delete c.admitted;
      else { c.job = result.job; c.reason = result.error; }
    });
    return 0;
  });
}

function tickBatch(run: ComposedRun, key: string, step: Extract<Step, { kind: 'batch' }>, cursor: ComposedCursor): Tick {
  let changed = !cursor.items;
  const items = cursor.items ??= step.items!.map(() => ({ state: 'waiting', attempt: 0 }));
  const request = (i: number) => `workflow:${run.flow}:${key}:${i}:${items[i].attempt}`;
  for (const [i, item] of items.entries()) {
    if (item.state !== 'running') continue;
    const job = item.job ? findJob(item.job) : receipt(run, request(i));
    const tick = job ? observeJob(job) : fail(item.reason || 'dispatch interrupted without a job receipt');
    if (job && item.job !== job.job) { item.job = job.job; changed = true; }
    if (tick.state === 'done' || tick.state === 'failed') { item.state = tick.state; item.reason = tick.reason; changed = true; }
  }
  if (changed) writeJsonPrivate(indexPath(run, key), items.map((item, i) => ({ item: i + 1, ...item, ...(item.state === 'done' && item.job && { report_path: reportPath(item.job) }) })));
  // The first item is always a pilot; a failure pauses before admitting the tail.
  if (items[0].state === 'failed') return fail(`pilot: ${items[0].reason}`);
  const running = items.filter(i => i.state === 'running').length;
  const next = items.findIndex(i => i.state === 'waiting');
  if (!running && next < 0) return items.some(i => i.state === 'failed') ? fail('batch items failed; see step index') : { state: 'done' };
  if (run.state !== 'working' || (items[0].state !== 'done' && next !== 0) || next < 0 || running >= step.max_parallel!)
    return { ...wait(running ? 1_000 : undefined), changed };
  if (!batchHasRoom(step.role)) return { ...wait(1_000), changed };
  items[next].state = 'running';
  return effect(run, async () => {
    const task = `${step.items![next].task}\n\n${step.ask === true ? WORKFLOW_WORKER_RULE : WORKFLOW_WORKER_RULE_NO_ASK}`;
    let result: Awaited<ReturnType<typeof create>>;
    try { result = await create(run, request(next), step.role, task, step.from, { member: true, isolation: ['imp', 'frontend-imp'].includes(step.role) ? 'worktree' : 'none' }); }
    catch (error) { result = { job: undefined, code: undefined, error: reason(error) }; }
    await update(run, key, c => {
      const item = c.items![next];
      if (result.code === 'batch_wait' || result.code === 'queue_stopped') item.state = 'waiting';
      else { item.job = result.job; item.reason = result.error; }
    });
    return result.code === 'batch_wait' ? 1_000 : 0;
  });
}

function runCheck(cwd: string, argv: string[]): Promise<CheckResult> {
  return new Promise(resolve => {
    const { HUD_JOB_DIR: _, ...env } = process.env;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL' });
    let bytes = Buffer.alloc(0), error: string | undefined;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]).subarray(-8192); });
    child.once('error', e => { error = reason(e); });
    child.once('close', (exit_code, signal) => resolve({ exit_code, tail: bytes.toString('utf8').trimEnd().split(/\r?\n/).slice(-40).join('\n'),
      ...((error || signal) && { error: error || `check ended with ${signal}` }) }));
  });
}

function tickCheck(run: ComposedRun, key: string, step: Extract<Step, { kind: 'check' }>, cursor: ComposedCursor): Tick {
  const jobId = run.steps[step.job].job, source = jobId && findJob(jobId);
  if (!source) return fail('check source job is unavailable');
  if (cursor.repair_pending) {
    const request = `workflow:${run.flow}:${key}:repair:${cursor.repairs}`;
    const same = source.send_outcomes?.find(x => x.key === request);
    const job = cursor.job ? findJob(cursor.job) : same?.exit_code === 0 ? source : receipt(run, request);
    if (!job) return fail(cursor.reason || 'check repair outcome unknown');
    const settled = observeJob(job);
    if (settled.state !== 'done') return { ...settled, recheckMs: settled.recheckMs ?? 1_000 };
    if (run.state !== 'working') return wait();
    releaseLandTurn(job.job, request);
    cursor.repair_pending = false; delete cursor.check; delete cursor.admitted; delete cursor.reason;
  }
  if (cursor.check?.exit_code === 0) {
    writeJsonPrivate(checkPath(run, key), cursor.check);
    return { state: 'done' };
  }
  if (cursor.admitted && !cursor.check) return fail(cursor.reason || 'check outcome unknown; not replayed automatically');
  if (cursor.check) {
    const why = cursor.check.error ?? `check exited ${cursor.check.exit_code}`;
    if (cursor.check.exit_code === null || (cursor.repairs ?? 0) >= step.repair) return fail(why);
    if (run.state !== 'working') return wait();
    cursor.repairs = (cursor.repairs ?? 0) + 1; cursor.repair_pending = true; delete cursor.job;
    const request = `workflow:${run.flow}:${key}:repair:${cursor.repairs}`;
    const task = `Repair failed workflow check ${key} (${why}). Work in the existing checkout, commit your repair and report.\n\nLast output lines:\n${cursor.check.tail}`;
    return effect(run, async () => {
      let job: string | undefined, error: string | undefined;
      try { job = await dispatchLandRepair(source.job, source.cwd, task, request, pane(run) ?? null, run.flow); }
      catch (e) { error = reason(e); }
      await update(run, key, c => { c.job = job; c.reason = error; });
      return 0;
    });
  }
  if (run.state !== 'working') return wait();
  cursor.admitted = true;
  return effect(run, async () => {
    const result = await runCheck(source.cwd, step.run!).catch(error => ({ exit_code: null, tail: '', error: reason(error) }));
    await update(run, key, c => { c.check = result; });
    return 0;
  });
}

function tickLand(run: ComposedRun, key: string, step: Extract<Step, { kind: 'land' }>, cursor: ComposedCursor): Tick {
  const jobId = run.steps[step.job].job, source = jobId && findJob(jobId);
  if (!source) return fail('land source job is unavailable');
  if (cursor.land) {
    const land = readLand(hudHome, cursor.land);
    if (!land) return fail(cursor.reason || 'sealed land outcome unknown; not replayed');
    if (land.state === 'completed') return { state: 'done' };
    if (!activeLand(land)) return fail(land.error || `land ${land.state}`);
    return wait(1_000);
  }
  if (run.state !== 'working') return wait();
  const attempt = landAttempt(hudHome, source.job);
  cursor.land = attempt.prior?.flow ?? attempt.flow;
  if (attempt.prior) return { ...wait(0), changed: true };
  cursor.admitted = true;
  return effect(run, async () => {
    try {
      const land = await startLand(hudHome, source.job, source, readRow(source, false, null).row.state, pane(run) ?? null, false, run.flow);
      await update(run, key, c => { c.land = land.flow; });
    } catch (error) { await update(run, key, c => { c.reason = reason(error); }); }
    return 0;
  });
}

function tickHandback(run: ComposedRun, key: string, step: Extract<Step, { kind: 'handback' }>, cursor: ComposedCursor): Tick {
  const ref = references(run, step.from), refs = [...ref.ids, ...ref.paths];
  let why: string | undefined;
  if (step.to !== 'main') {
    const choiceList = step.options.join(' | ');
    const task = `Make one workflow decision for ${run.flow}/${key}: ${step.ask}\nChoices: ${choiceList}.\n${step.escalation_rule ?? DEFAULT_ESCALATION_RULE}\n` +
      'Use the referenced evidence. Do not land or change the source. Report `Decision: <choice>` and `Reason: <why>`, or `Decision: escalate` with the blocker.';
    const tick = tickJob(run, key, cursor, 'lead', task, step.from, { preset: step.preset });
    if (tick.state !== 'done' && tick.state !== 'failed') return tick;
    const lead = cursor.job && findJob(cursor.job);
    if (lead && !cursor.lead_closed) return effect(run, async () => {
      const closed = await closeLeadJob(lead).catch(error => ({ ok: false, reason: reason(error) }));
      await update(run, key, c => { c.lead_closed = true; if (!closed.ok) c.reason = `Lead close refused: ${closed.reason}`; });
      return 0;
    });
    if (tick.state === 'done' && lead && !cursor.reason) {
      const report = readFileBounded(reportPath(lead.job), 64 * 1024).bytes.toString('utf8');
      const parsed = parseLeadReport(report, [...step.options, 'escalate']);
      if (parsed.decision && parsed.decision !== 'escalate' && parsed.reason) {
        cursor.answer = parsed.decision; cursor.decision_reason = parsed.reason.slice(0, 500);
        return { state: 'done' };
      }
      why = parsed.reason || 'lead did not give a valid decision';
    } else why = cursor.reason || tick.reason;
  }
  if (run.state !== 'working') return wait();
  const request_id = `h-${key}`;
  const ask = why ? `${step.ask} (${why.slice(0, 180)})` : step.ask;
  run.handback = { request_id, step: key, ask, choices: step.options, refs };
  run.state = 'paused';
  run.notices[`handback-${key}`] = `${run.flow} hand-back ${key}: ${ask} — reply hud_respond job=${run.flow} request_id=${request_id} answer=${step.options.join('|')}`;
  return { state: 'asking' };
}

export async function driveComposed(id: string) {
  if (readComposed(hudHome, id)?.state !== 'working') return;
  await driveWorkflow(hudHome, id, {
    read: () => readComposed(hudHome, id)!, header: run => run, save: run => saveHeader(hudHome, run),
    open: run => {
      if (!run.grant && run.cost === 'costly') throw Error('owner_grant_required');
      const graph = readComposedGraph(hudHome, id);
      if (hashComposedGraph(run.cwd, graph) !== run.hash || graph.cost !== run.cost) throw Error('workflow_plan_changed');
      return graph;
    },
    tick: (run, key, step) => {
      const cursor = run.steps[key];
      switch (step.kind) {
        case 'job': return tickJob(run, key, cursor, step.role, `${step.task}\n\n${step.ask === true ? WORKFLOW_WORKER_RULE : WORKFLOW_WORKER_RULE_NO_ASK}`, step.from, step);
        case 'council': return tickJob(run, key, cursor, 'council', step.task!, step.from, step);
        case 'batch': return tickBatch(run, key, step, cursor);
        case 'check': return tickCheck(run, key, step, cursor);
        case 'handback': return tickHandback(run, key, step, cursor);
        case 'land': return tickLand(run, key, step, cursor);
      }
    },
    watches: run => [...new Set(Object.values(run.steps).filter(c => c.state === 'running').flatMap(c => [c.job, ...c.items?.filter(i => i.state === 'running').map(i => i.job) ?? []]))]
      .flatMap(job => job ? [{ dir: directory(job), filter: (file: string | null) => !file || file === jobFiles.status || file === jobFiles.job || file === jobFiles.report }] : []),
    active: run => run.state === 'working', propagateSkips: true,
    onEnd: run => { run.notices[`end-${run.epoch}`] = `${id} workflow completed`; },
    errorLine: run => `${id} workflow paused: ${run.reason}`,
  });
  const restart = await runLock(hudHome, id, async () => {
    const run = readComposed(hudHome, id);
    if (!run || run.pid !== process.pid) return;
    // An answer can arrive while the old driver is still delivering its pause
    // notice. Its wake sees a live PID; hand off after releasing the driver lock.
    delete run.pid; delete run.start; saveHeader(hudHome, run);
    if (run.state === 'completed' && run.grant && !run.input_admitted) await workflowGrants.releaseUnused(hudHome, id);
    if (run.state === 'working') return run;
  });
  if (restart) wakeWorkflow(hudHome, restart);
}