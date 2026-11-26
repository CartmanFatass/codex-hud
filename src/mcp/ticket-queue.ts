import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { herdrId } from '../roles/herdr-run.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { roleRegistry } from '../roles/roster.js';
import { ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { procStat } from '../utils/proc.js';
import { loadGraph } from '../workflows/graph.js';
import { runVisible } from '../workflows/scope.js';
import { freezeGraph, runDir } from '../workflows/store.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { validLandConfig } from './land.js';
import { checkFeatureTickets, ticketReadiness } from './local-tickets.js';
import { dispatchBase, resolveWorkspace } from './dispatch/proc.js';
import { BUNDLED_ROOT } from './paths.js';
import { jobCache } from './store/job-store.js';
import { ensureJobWatcher } from './watch-pid.js';
import { cancelTicketQueue, queueIds, readTicketQueue, ticketQueueNotice, ticketQueueView, writeTicketQueue, type TicketQueue } from './ticket-queue-state.js';

let template: string | undefined;

/** A pre-input launch failure did no work: a resumed queue drops that job and dispatches its ticket again. */
function launchFailed(home: string, job: string | undefined) {
  if (!job) return false;
  try { return JSON.parse(fs.readFileSync(join(home, 'jobs', job, 'STATUS.json'), 'utf8'))?.exit_reason === 'dispatch_failed'; }
  catch { return false; }
}
/** A ticket closed since the queue failed (landed through another job, or set aside) is no longer the queue's to follow. */
function ticketClosed(path: string) {
  try {
    const status = ticketFileEvidence(readFileBounded(path, 64 * 1024).bytes.toString('utf8')).status ?? '';
    return /^(?:done|wontfix|ready-for-human)$/i.test(status);
  } catch { return false; }
}
export async function startTicketQueue(home: string, cwd: string, pane: string | null, task: boolean,
  args: Record<string, unknown>, dispatcher?: TicketQueue['dispatcher']) {
  const { feature, max_parallel, cancel, escalation_rule, handback_to, lead_preset } = args;
  if (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature)) throw Error('invalid_arguments: feature');
  if (max_parallel !== undefined && (typeof max_parallel !== 'number' || !Number.isSafeInteger(max_parallel) || max_parallel < 1))
    throw Error('invalid_arguments: max_parallel');
  if (cancel !== undefined && typeof cancel !== 'boolean') throw Error('invalid_arguments: cancel');
  if (escalation_rule !== undefined && (typeof escalation_rule !== 'string' || !escalation_rule.trim() || escalation_rule.length > 500))
    throw Error('invalid_arguments: escalation_rule');
  if (handback_to !== undefined && handback_to !== 'lead' && handback_to !== 'main')
    throw Error('invalid_arguments: handback_to');
  if (lead_preset !== undefined && (typeof lead_preset !== 'string' || !lead_preset.trim()))
    throw Error('invalid_arguments: lead_preset');
  if (pane !== null && !herdrId(pane)) throw Error('hud_tickets run requires a valid caller pane');
  const root = sharedRoot(cwd);
  const resolvedWorkspace = pane ? await resolveWorkspace(pane) : undefined;
  const startHead = await dispatchBase(root);
  return withAbstractLock('ticket-start', `${home}\0${root}\0${feature}`, () => {
    const queues = queueIds(home).map(id => readTicketQueue(home, id)).filter(q => q !== null)
      .filter(q => q.root === root && q.feature === feature);
    const prior = queues.find(q => q.state === 'working');
    if (prior) {
      if (!runVisible(prior, pane, root)) throw Error(`Ticket queue ${prior.flow} is owned by another pane`);
      if (cancel) cancelTicketQueue(home, prior);
      wakeWorkflow(home, prior);
      return prior;
    }
    if (cancel) return null;
    if (!registeredProject(home, root).registered) throw Error('hud_tickets run requires a registered project');
    validLandConfig(home, root);
    const ticketGaps = checkFeatureTickets(root, feature);
    if (ticketGaps.length) {
      throw Error(`ticket_check_failed: ${ticketGaps.map(g => `${g.ticket}: ${g.gaps.join(', ')}`).join('; ')}`);
    }
    fs.mkdirSync(join(home, 'flows'), { mode: 0o700, recursive: true });
    const { queued } = ticketReadiness(root, jobCache, feature);
    const latest = queues.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const resumed = latest && (latest.state === 'failed' || latest.state === 'paused') ? latest : undefined;
    const limit = max_parallel ?? resumed?.max_parallel ?? capForRole(loadConcurrencySettings(), 'imp');
    const effectiveHandbackTo = handback_to ?? resumed?.handback_to;
    const effectiveRule = escalation_rule?.trim() ?? resumed?.escalation_rule;
    const effectivePreset = lead_preset?.trim() ?? resumed?.lead_preset;
    const workspace = resolvedWorkspace ?? resumed?.workspace;
    template ??= fs.readFileSync(join(BUNDLED_ROOT, 'workflows/ticket-queue.toml'), 'utf8');
    const roles = roleRegistry(home, root, process.env, undefined, undefined, BUNDLED_ROOT).roles();
    const graph = loadGraph(template, 'toml', {
      roles, bindings: { feature, max_parallel: limit || undefined },
    });
    const acceptStep = graph.steps.accept;
    if (acceptStep?.kind === 'handback') {
      if (effectiveHandbackTo) acceptStep.to = effectiveHandbackTo;
      if (effectiveRule) acceptStep.escalation_rule = effectiveRule;
      if (effectivePreset) acceptStep.preset = effectivePreset;
    }
    const flow = `q${randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const origin = pane ? procStat(process.pid) : null;
    const q: TicketQueue = { flow, root, cwd: root, project_root: root, feature, pane: pane ?? '',
      ...(workspace && { workspace }),
      ...(startHead && startHead !== 'HEAD' && { start_head: resumed?.start_head ?? startHead }),
      task,
      ...(origin && { origin_mcp: { pid: process.pid, start: origin.start } }),
      max_parallel: limit, created_at: now, updated_at: now,
      template: 'ticket-queue', host: 'detached', cost: graph.cost, cost_reasons: graph.cost_reasons,
      ...(effectiveHandbackTo && { handback_to: effectiveHandbackTo }),
      ...(effectiveRule && { escalation_rule: effectiveRule }),
      ...(effectivePreset && { lead_preset: effectivePreset }),
      ...(resumed?.todo?.length && { todo: resumed.todo }),
      ...(resumed?.decisions?.length && { decisions: resumed.decisions }),
      ...(resumed?.repair_rounds && { repair_rounds: resumed.repair_rounds }),
      epoch: 0, settled: 0, streak: 0, failures: 0, notices: {},
      steps: Object.fromEntries(Object.keys(graph.steps).map(id => [id, { state: 'waiting' as const }])),
      dispatcher: resumed ? resumed.dispatcher : dispatcher,
      state: 'working', tickets: resumed?.tickets.filter(item => item.landed || (!launchFailed(home, item.job) && !ticketClosed(item.path)))
        .map(item => ({ ...item, dispatch_queue: item.dispatch_queue ?? resumed.flow })) ?? [] };
    if (queued.length) q.queued = queued;
    fs.mkdirSync(runDir(home, flow), { mode: 0o700, recursive: true });
    freezeGraph(home, flow, graph);
    writeTicketQueue(home, q, true);
    wakeWorkflow(home, q);
    return q;
  });
}
/** Answering the question that stopped a queue is the main session's judgement, so that queue resumes. */
export async function resumeQueueAfterAnswer(home: string, jobId: string, request: string, pane: string | null, cwd = process.cwd()) {
  const q = queueIds(home).map(id => readTicketQueue(home, id)).filter(q => q !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).find(q => q.tickets.some(item => item.job === jobId));
  const matchesQuestion = (q?.handback?.kind === 'question' && q.handback.job === jobId && q.handback.question === request) ||
    (q?.handback?.kind === 'escalate' && q.handback.job === jobId && q.handback.question === request) ||
    q?.reason?.includes(`(${jobId}): worker question ${request} `);
  if (!q || (q.state !== 'failed' && q.state !== 'paused') || !runVisible(q, pane, cwd) || !matchesQuestion) return undefined;
  try { return (await startTicketQueue(home, q.root, pane ?? (q.pane || null), false, { feature: q.feature, max_parallel: q.max_parallel }))?.flow; }
  catch { return undefined; }
}
export function ticketQueueTask(home: string, q: TicketQueue, cancel = false) {
  if (cancel) cancelTicketQueue(home, q);
  if (q.state === 'working') {
    wakeWorkflow(home, q);
    ensureJobWatcher(home);
  }
  const text = q.state === 'working'
    ? `${q.flow} (ticket queue ${q.feature}) — ${ticketQueueView(q).reason ?? 'working'}` : ticketQueueNotice(q);
  return { taskId: q.flow, status: q.state, statusMessage: text,
    createdAt: q.created_at, lastUpdatedAt: q.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(q.state !== 'working' && { result: { content: [{ type: 'text', text }] } }) };
}