import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { herdrId } from '../roles/herdr-run.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { roleRegistry } from '../roles/roster.js';
import { readObjectives } from '../collectors/objectives.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { waitUntilFs } from '../utils/fs-wait.js';
import { procStat } from '../utils/proc.js';
import { loadGraph } from '../workflows/graph.js';
import { runVisible } from '../workflows/scope.js';
import { freezeGraph, noticeEvents, runDir, runLock } from '../workflows/store.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { ESCALATION_RULE, isOpenTicketRun, ticketClosed } from '../unattended/state.js';
import { validLandConfig } from './land.js';
import { activeLand, landAttempt, readLand, type LandFlow } from './land-state.js';
import { checkFeatureTickets, checkTicketPaths, declaredReadyTickets, registeredTicketRepo, ticketObjectiveOwner, ticketReadiness } from './local-tickets.js';
import { dispatchBase, resolveWorkspace } from './dispatch/proc.js';
import { BUNDLED_ROOT, jobFiles } from './paths.js';
import { jobCache } from './store/job-store.js';
import { ensureJobWatcher } from './watch-pid.js';
import {
  blockerHandbackItem, cancelTicketQueue, clearItemHold, isTicketQueueId, MAX_REPAIR_ROUNDS, prepareTicketQueueRepair, queueIds, readTicketQueue, recordDecision,
  syncBlockerHandback, ticketQueueNotice, ticketQueueView, writeTicketQueue, type RunDecision, type TicketQueue, type TicketQueueItem,
} from './ticket-queue-state.js';

let template: string | undefined;

/** Verify every role needed by the declared workset, not just the tickets dispatchable now. */
export function requireTicketQueueRoles(
  home: string,
  root: string,
  workset: { feature: string; handbackTo?: 'main' | 'lead' } | { objectives: readonly string[] },
  env = process.env,
) {
  const featureRun = 'feature' in workset;
  let tickets = declaredReadyTickets(root, featureRun ? workset.feature : undefined);
  if (!featureRun) {
    const objectives = readObjectives(root)?.objectives ?? [];
    const selected = new Set(objectives.filter(o => o.state === 'active' && workset.objectives.includes(o.id)).map(o => o.id));
    tickets = tickets.filter(t => selected.has(ticketObjectiveOwner(objectives, t.ticket, t.objective) ?? ''));
  }
  const needed = new Set(['imp', 'reviewer']);
  if (!featureRun || workset.handbackTo !== 'main') needed.add('lead');
  const targets = new Map<string, Set<string>>([[root, needed]]);
  for (const ticket of tickets) {
    const repo = ticket.repo === undefined ? root : registeredTicketRepo(home, ticket.repo);
    if (!repo) continue; // Not ready; do not require a worker role for this item.
    if (!targets.has(repo)) targets.set(repo, new Set());
    targets.get(repo)!.add(ticket.role);
  }
  const enabled = requireRoles(home, root, needed, env, featureRun);
  for (const [repo, roles] of targets) if (repo !== root) requireRoles(home, repo, roles, env, false);
  return enabled;
}

function requireRoles(home: string, root: string, needed: Set<string>, env: NodeJS.ProcessEnv, featureRun: boolean) {
  const registry = roleRegistry(home, root, env, undefined, undefined, BUNDLED_ROOT);
  const enabled = registry.roles();
  const withOff = registry.roles(true);
  const hidden: string[] = [];
  const off: string[] = [];
  const invalid: string[] = [];
  for (const name of needed) {
    if (enabled.has(name)) continue;
    if (withOff.get(name)?.optionalEnabled === false) {
      off.push(name);
      continue;
    }
    const inv = registry.invalidRole(name);
    if (inv) {
      invalid.push(`${name} (${inv.path}: ${inv.reason})`);
      continue;
    }
    hidden.push(name);
  }
  const problems: string[] = [];
  if (hidden.length) {
    const list = hidden.join(', ');
    const mainHint = featureRun && hidden.length === 1 && hidden[0] === 'lead'
      ? ' (or pass handback_to: "main")' : '';
    problems.push(`Required role(s) not enabled in this project: ${list}. Run \`hud setup\` to enable ${list} in .hud/project.json${mainHint}.`);
  }
  if (off.length) {
    problems.push(`Optional role(s) turned off: ${off.join(', ')}. Enable in Control → Roles or $HUD_HOME/role-switches.json.`);
  }
  if (invalid.length) {
    problems.push(`Invalid role configuration: ${invalid.join('; ')}. Fix the file or run \`hud setup\`.`);
  }
  if (problems.length) throw Error(problems.join(' '));
  return enabled;
}

/** A pre-input launch failure did no work: a resumed queue drops that job and dispatches its ticket again. */
function launchFailed(home: string, job: string | undefined) {
  if (!job) return false;
  try { return JSON.parse(fs.readFileSync(join(home, 'jobs', job, 'STATUS.json'), 'utf8'))?.exit_reason === 'dispatch_failed'; }
  catch { return false; }
}
function recordCompletedLand(item: TicketQueueItem, land: LandFlow, now: string) {
  if (item.held && !land.ticket_queue) item.held_land = land.flow;
  item.land = land.flow;
  item.landed = true;
  item.landed_at = item.changed_at = land.landed_at ?? land.updated_at ?? now;
  item.base_moves = land.base_moves;
  delete item.held;
}

function jobCreatedAtMs(home: string, job: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(join(home, 'jobs', job, jobFiles.job), 'utf8'))?.created_at;
    if (typeof raw !== 'string') return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}
/** Cancel a working or paused ticket-queue run without signalling any process, keeping holds and evidence intact. */
export async function cancelTicketQueueRun(
  home: string,
  id: string,
  opts?: { unattendedOnly?: boolean; pane?: string | null; root?: string; waitMs?: number },
): Promise<{ queue: TicketQueue; changed: boolean } | null> {
  if (!isTicketQueueId(id)) return null;
  const q = readTicketQueue(home, id);
  if (!q || (opts?.unattendedOnly && !q.unattended)) return null;
  if (opts?.root !== undefined && !runVisible({ ...q, project_root: q.project_root ?? q.root }, opts.pane ?? null, opts.root)) {
    throw Error(`Ticket queue ${q.flow} is owned by another pane`);
  }
  if (q.state === 'working') {
    cancelTicketQueue(home, q);
    wakeWorkflow(home, q);
    if (opts?.waitMs) {
      await waitUntilFs({
        timeoutMs: opts.waitMs,
        coalesceMs: 25,
        targets: () => [{ dir: join(home, 'flows'), filter: file => !file || file === `${q.flow}.json` }],
        check: () => {
          const cur = readTicketQueue(home, q.flow);
          return !cur || cur.state !== 'working' ? { done: true, value: cur } : { done: false };
        },
      }).catch(() => undefined);
    }
    return { queue: readTicketQueue(home, q.flow) ?? q, changed: true };
  }
  if (q.state === 'paused') {
    let changed = false;
    const updated = await runLock(home, q.flow, () => {
      const cur = readTicketQueue(home, q.flow);
      if (!cur) return null;
      if (cur.state === 'paused') {
        cur.state = 'cancelled';
        cur.reason = cur.reason ? `cancelled (was paused: ${cur.reason})` : 'cancelled: no more dispatches or lands started';
        cur.queued = undefined;
        writeTicketQueue(home, cur);
        changed = true;
      } else if (cur.state === 'working') {
        cancelTicketQueue(home, cur);
        wakeWorkflow(home, cur);
        changed = true;
      }
      return cur;
    });
    return updated ? { queue: updated, changed } : null;
  }
  return { queue: q, changed: false };
}

// Admission always takes the feature/Objective lock before a per-run lock.
function withTicketAdmission<T>(home: string, root: string, feature: string, objective: string | undefined, run: () => T | Promise<T>) {
  return withAbstractLock('ticket-start', `${home}\0${root}\0${objective ? `unattended:${objective}` : feature}`, run);
}

function admissionQueues(home: string, root: string, feature: string, objective?: string) {
  return queueIds(home).map(id => readTicketQueue(home, id)).filter(q => q !== null)
    .filter(q => q.root === root && (objective ? q.unattended?.objective === objective : !q.unattended && q.feature === feature));
}

function endedWithFinishVerdict(q: TicketQueue): boolean {
  return q.state === 'completed' && /^finish(?::|\s|$)/i.test(q.verdict?.trim() ?? '');
}

/** Inherit repair rounds from the latest prior run unless it ended with a finish verdict (fresh milestone). */
export function inheritedRepairRounds(previous: TicketQueue | undefined): number {
  if (!previous || endedWithFinishVerdict(previous)) return 0;
  const base = previous.repair_rounds ?? 0;
  if (base >= MAX_REPAIR_ROUNDS) return base;
  const lastAccept = previous.decisions?.filter(d => d.step === 'accept' && d.kind === 'accept').at(-1);
  const acceptState = previous.steps?.accept?.state;
  const unadmittedRepair = (acceptState === 'failed' || acceptState === 'asking')
    && lastAccept?.decision === 'repair'
    && !lastAccept.close_error
    && previous.handback?.job === lastAccept.job;
  return unadmittedRepair ? base + 1 : base;
}

export async function startTicketQueue(home: string, cwd: string, pane: string | null, task: boolean,
  args: Record<string, unknown>, dispatcher?: TicketQueue['dispatcher'],
  unattended?: { flow: string; objective: string; ready?: readonly { ticket: string; path: string }[] }) {
  const { feature, max_parallel, cancel, escalation_rule, handback_to, run } = args;
  if (cancel !== undefined && typeof cancel !== 'boolean') throw Error('invalid_arguments: cancel');
  if (run !== undefined && (!cancel || !isTicketQueueId(run))) throw Error('invalid_arguments: run');
  if (pane !== null && !herdrId(pane)) throw Error('hud_tickets run requires a valid caller pane');
  const root = sharedRoot(cwd);
  if (!unattended && run !== undefined) {
    const res = await cancelTicketQueueRun(home, run, { pane, root });
    return res?.changed ? res.queue : null;
  }
  const target = unattended ? unattended.objective : feature;
  if (typeof target !== 'string' || !/^[a-z0-9-]+$/.test(target)) throw Error('invalid_arguments: feature');
  if (max_parallel !== undefined && (typeof max_parallel !== 'number' || !Number.isSafeInteger(max_parallel) || max_parallel < 1))
    throw Error('invalid_arguments: max_parallel');
  if (escalation_rule !== undefined && (typeof escalation_rule !== 'string' || !escalation_rule.trim() || escalation_rule.length > 500))
    throw Error('invalid_arguments: escalation_rule');
  if (handback_to !== undefined && handback_to !== 'lead' && handback_to !== 'main')
    throw Error('invalid_arguments: handback_to');
  const resolvedWorkspace = pane ? await resolveWorkspace(pane) : undefined;
  const startHead = await dispatchBase(root);
  return withTicketAdmission(home, root, target, unattended?.objective, async () => {
    const queues = admissionQueues(home, root, target, unattended?.objective);
    const prior = queues.find(q => unattended ? isOpenTicketRun(q) : q.state === 'working');
    if (prior) {
      if (unattended) return null;
      if (!runVisible(prior, pane, root)) throw Error(`Ticket queue ${prior.flow} is owned by another pane`);
      if (cancel) cancelTicketQueue(home, prior);
      wakeWorkflow(home, prior);
      return prior;
    }
    if (cancel) {
      if (!unattended && isTicketQueueId(target)) {
        const res = await cancelTicketQueueRun(home, target, { pane, root });
        return res?.changed ? res.queue : null;
      }
      return null;
    }
    if (!registeredProject(home, root).registered) throw Error('hud_tickets run requires a registered project');
    if (unattended || declaredReadyTickets(root, target).some(t => t.repo === undefined || registeredTicketRepo(home, t.repo) === root)) {
      validLandConfig(home, root);
    }
    const latestRun = queues.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.updated_at.localeCompare(a.updated_at))[0];
    const latest = unattended ? undefined : latestRun;
    const resumed = latest && !latest.superseded_by && (latest.state === 'failed' || latest.state === 'paused') ? latest : undefined;
    const repairRounds = inheritedRepairRounds(latestRun);
    const effectiveHandbackTo = unattended ? 'lead' : handback_to ?? resumed?.handback_to;
    if (!unattended) {
      const ticketGaps = checkFeatureTickets(root, target);
      if (ticketGaps.length) {
        throw Error(`ticket_check_failed: ${ticketGaps.map(g => `${g.ticket}: ${g.gaps.join(', ')}`).join('; ')}`);
      }
    } else if (unattended.ready) {
      const bad = new Set(checkTicketPaths(root, unattended.ready).map(g => g.ticket));
      if (!unattended.ready.some(t => !bad.has(t.ticket))) return null;
    }
    const readiness = unattended ? undefined : ticketReadiness(root, jobCache, target, { home });
    const roles = requireTicketQueueRoles(home, root, unattended
      ? { objectives: [unattended.objective] } : { feature: target, handbackTo: effectiveHandbackTo });
    fs.mkdirSync(join(home, 'flows'), { mode: 0o700, recursive: true });
    const handback = resumed?.state === 'paused' && (resumed.handback?.kind === 'assumption' || resumed.handback?.kind === 'blocker')
      ? resumed.handback : undefined;
    const limit = max_parallel ?? resumed?.max_parallel ?? capForRole(loadConcurrencySettings(), 'imp');
    const effectiveRule = unattended ? ESCALATION_RULE : escalation_rule?.trim() ?? resumed?.escalation_rule;
    const workspace = resolvedWorkspace ?? resumed?.workspace;
    template ??= fs.readFileSync(join(BUNDLED_ROOT, 'workflows/ticket-queue.toml'), 'utf8');
    const graph = loadGraph(template, 'toml', {
      roles, bindings: { feature: target, max_parallel: limit || undefined },
    });
    const acceptStep = graph.steps.accept;
    if (acceptStep?.kind === 'handback') {
      if (effectiveHandbackTo) acceptStep.to = effectiveHandbackTo;
      if (effectiveRule) acceptStep.escalation_rule = effectiveRule;
    }
    const flow = unattended?.flow ?? `q${randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const origin = pane ? procStat(process.pid) : null;
    const adoptedHeldLands = new Map<string, LandFlow>();
    const q: TicketQueue = { flow, root, cwd: root, project_root: root, feature: target, pane: pane ?? '',
      ...(workspace && { workspace }),
      ...(startHead && startHead !== 'HEAD' && { start_head: resumed?.start_head ?? startHead }),
      task,
      ...(origin && { origin_mcp: { pid: process.pid, start: origin.start } }),
      max_parallel: limit, created_at: now, updated_at: now,
      template: 'ticket-queue', host: 'detached', cost: graph.cost, cost_reasons: graph.cost_reasons,
      ...(unattended && { unattended: { objective: unattended.objective } }),
      ...(effectiveHandbackTo && { handback_to: effectiveHandbackTo }),
      ...(effectiveRule && { escalation_rule: effectiveRule }),
      ...(resumed?.todo?.length && { todo: resumed.todo }),
      ...(resumed?.decisions?.length && { decisions: resumed.decisions }),
      ...(repairRounds > 0 && { repair_rounds: repairRounds }),
      epoch: 0, settled: 0, streak: 0, failures: 0, notices: {},
      steps: Object.fromEntries(Object.keys(graph.steps).map(id => [id, { state: 'waiting' as const }])),
      dispatcher: resumed ? resumed.dispatcher : dispatcher,
      state: 'working', tickets: resumed?.tickets.flatMap(item => {
        const next = { ...item, dispatch_queue: item.dispatch_queue ?? resumed.flow };
        const recorded = item.land ? readLand(home, item.land) : null;
        const attempt = item.job ? landAttempt(home, item.job).prior : null;
        const land = (attempt?.job === item.job ? attempt : null) ?? (recorded?.job === item.job ? recorded : null);
        // Carry in-flight lands and adopt lands that completed while the predecessor was paused.
        if (!item.landed && land?.state === 'completed') {
          if (item.held && !land.ticket_queue) adoptedHeldLands.set(item.ticket, land);
          recordCompletedLand(next, land, now);
        } else if (!item.landed && land && activeLand(land)) {
          next.land = land.flow;
          if (item.held) {
            if (!land.ticket_queue) next.held_land = land.flow;
            delete next.held;
          }
        } else if (!item.landed && (launchFailed(home, item.job) || ticketClosed(root, item))) {
          return [];
        }
        // Approve the report that caused the pause, not whatever the worker has published since.
        if (handback?.assumption && !item.held && handback.ticket === item.ticket && handback.job === (item.repair_job ?? item.job)) {
          next.approved_assumptions_head = handback.assumption.head;
          next.approved_assumptions_sig = handback.assumption.report_sig;
        }
        return [next];
      }) ?? [] };
    if (readiness) {
      const admitted = new Set(q.tickets.map(t => t.ticket));
      q.future = readiness.future.filter(t => !admitted.has(t.ticket));
      if (readiness.queued.length) q.queued = readiness.queued;
      if (readiness.blocked.length) q.blocked = readiness.blocked;
    }
    fs.mkdirSync(runDir(home, flow), { mode: 0o700, recursive: true });
    freezeGraph(home, flow, graph);
    // Publish the successor first; the answer path also checks receipts if the marker is missing.
    writeTicketQueue(home, q, true);
    if (!unattended) {
      for (const old of queues) {
        const transfersFailedHold = old.flow === resumed?.flow && old.state === 'failed' && old.tickets.some(item => item.held);
        if ((old.state !== 'paused' && !transfersFailedHold) || old.superseded_by) continue;
        await runLock(home, old.flow, () => {
          const predecessor = readTicketQueue(home, old.flow);
          if (!predecessor || (predecessor.state !== 'paused' && !(transfersFailedHold && predecessor.state === 'failed'))) return;
          // Keep the same verified manual land on the ending receipt, not the resolved hold.
          if (predecessor.flow === resumed?.flow) {
            for (const item of predecessor.tickets) {
              const land = adoptedHeldLands.get(item.ticket);
              if (item.held && !item.landed && land && land.job === item.job) recordCompletedLand(item, land, now);
            }
          }
          if (predecessor.state === 'paused') predecessor.state = 'superseded';
          predecessor.superseded_by = q.flow;
          predecessor.notices = {};
          writeTicketQueue(home, predecessor);
        });
      }
    }
    wakeWorkflow(home, q);
    return q;
  });
}
export type HandbackAnswerResult =
  | { ok: true; queue: TicketQueue; resumed: boolean }
  | { ok: false; code: 'flow_not_found' | 'no_pending_handback' | 'invalid_arguments' | 'invalid_choice' | 'no_repair_tickets' | 'superseded_run'; error: string };

function parseHandbackAnswer(raw: string, allowedChoices: readonly string[]): { choice: string; reason?: string } | null {
  const match = /^\s*([a-z][a-z0-9_-]*)(?:\s*(?::|\r?\n)\s*([\s\S]*))?\s*$/i.exec(raw);
  if (!match) return null;
  const choice = match[1].toLowerCase();
  const matched = allowedChoices.find(c => c.toLowerCase() === choice);
  if (!matched) return null;
  const reason = match[2]?.trim() || undefined;
  return { choice: matched, ...(reason && { reason }) };
}

function handbackStepKeys(home: string, q: TicketQueue): string[] {
  try {
    const graph = readJsonFile(join(runDir(home, q.flow), 'graph.json')) as { steps?: Record<string, unknown> };
    if (graph?.steps && typeof graph.steps === 'object') return Object.keys(graph.steps);
  } catch { /* Fall back to recorded cursors. */ }
  return Object.keys(q.steps ?? {});
}

/** Answer an item hold in a working queue or a paused run-level hand-back. */
export async function answerTicketQueueHandback(
  home: string,
  id: string,
  answer: string,
  opts: { pane: string | null; cwd?: string; requestId?: string },
): Promise<HandbackAnswerResult> {
  const queue = readTicketQueue(home, id);
  if (!queue || !runVisible({ ...queue, project_root: queue.project_root ?? queue.root }, opts.pane, opts.cwd)) {
    return { ok: false, code: 'flow_not_found', error: `Ticket queue ${id} not found` };
  }
  const settle = (): HandbackAnswerResult => {
    const cur = readTicketQueue(home, id);
    if (!cur || !runVisible({ ...cur, project_root: cur.project_root ?? cur.root }, opts.pane, opts.cwd)) {
      return { ok: false, code: 'flow_not_found', error: `Ticket queue ${id} not found` };
    }
    if (cur.state === 'working' && cur.handback?.kind === 'blocker') {
      if (!opts.requestId) {
        return { ok: false, code: 'invalid_arguments', error: `Resuming an item hold in ${id} requires request_id from the hold notice` };
      }
      const item = blockerHandbackItem(cur, opts.requestId);
      if (!item?.held?.head || !item.held.report_sig) {
        return { ok: false, code: 'no_pending_handback', error: `Ticket queue ${id} has no matching item hold` };
      }
      const parsed = parseHandbackAnswer(answer, ['resume']);
      if (!parsed) return { ok: false, code: 'invalid_choice', error: `Expected resume[: reason] for ${item.ticket}` };
      // Approve only the evidence the lead escalated. The batch verifies both again before landing.
      item.approved_assumptions_head = item.held.head;
      item.approved_assumptions_sig = item.held.report_sig;
      clearItemHold(cur, item);
      syncBlockerHandback(cur);
      recordDecision(cur, {
        step: 'tickets', kind: 'blocker', job: 'main', ticket: item.ticket, decision: 'resume',
        ...(item.job && { worker_job: item.job }),
        ...(parsed.reason && { reason: parsed.reason }), at: new Date().toISOString(),
      });
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: false };
    }
    const superseded = (successor: string): HandbackAnswerResult => ({
      ok: false, code: 'superseded_run', error: `Ticket queue ${id} was superseded by ${successor}; its hand-back is no longer answerable`,
    });
    if (cur.superseded_by) return superseded(cur.superseded_by);
    const step = cur.handback?.step;
    if (cur.state !== 'paused' || !step || !cur.handback?.choices?.length || cur.steps?.[step]?.state !== 'asking') {
      const detail = cur.state === 'paused' && cur.handback?.kind ? `paused for ${cur.handback.kind}` : `state: ${cur.state}`;
      return { ok: false, code: 'no_pending_handback', error: `Ticket queue ${id} has no pending hand-back (${detail})` };
    }
    const successor = admissionQueues(home, cur.root, cur.feature, cur.unattended?.objective)
      .find(q => q.flow !== id && (q.state === 'working' || q.created_at > cur.created_at))?.flow;
    if (successor) return superseded(successor);
    if (opts.requestId !== undefined && opts.requestId !== step) {
      return { ok: false, code: 'invalid_arguments', error: `Ticket queue ${id} pending hand-back is at step ${step}, not ${opts.requestId}` };
    }
    const parsed = parseHandbackAnswer(answer, cur.handback.choices);
    if (!parsed) {
      return {
        ok: false,
        code: 'invalid_choice',
        error: `Invalid choice for ${id} (${step}); expected one of: ${cur.handback.choices.join(', ')} (optional ": <reason>" or newline)`,
      };
    }
    // At ordinary milestone acceptance, resume is main's finish verdict, not a retry of the settled lead.
    const overridesEscalation = parsed.choice === 'resume' && cur.handback.kind === 'escalate'
      && step === 'accept' && !cur.unattended;
    if (parsed.choice === 'resume' && !overridesEscalation) {
      const at = new Date().toISOString();
      const handback = cur.handback;
      const decisionKind: RunDecision['kind'] = handback.kind === 'blocker' ? 'blocker'
        : handback.kind === 'assumption' ? 'assumption' : 'accept';
      if (handback.assumption && handback.ticket && handback.job) {
        const item = cur.tickets.find(t => !t.held && t.ticket === handback.ticket &&
          (t.job === handback.job || t.repair_job === handback.job));
        if (item) {
          item.approved_assumptions_head = handback.assumption.head;
          item.approved_assumptions_sig = handback.assumption.report_sig;
          item.changed_at = at;
        }
      }
      recordDecision(cur, {
        step, kind: decisionKind, job: 'main', decision: 'resume',
        ...(handback.ticket && { ticket: handback.ticket }),
        ...(handback.job && { worker_job: handback.job }),
        ...(parsed.reason && { reason: parsed.reason }),
        at,
      });
      cur.epoch = (cur.epoch ?? 0) + 1;
      cur.steps ??= {};
      cur.steps[step] = { state: 'running', changed_at: at };
      delete cur.handback;
      delete cur.reason;
      delete cur.remaining;
      delete cur.pid;
      delete cur.start;
      cur.streak = 0; cur.settled = 0; cur.failures = 0;
      cur.notices = {};
      cur.state = 'working';
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: true };
    }
    if (parsed.choice === 'stop') {
      // Preserve any unadmitted repair round before clearing the hand-back and recording stop.
      const repairRounds = inheritedRepairRounds(cur);
      if (repairRounds > (cur.repair_rounds ?? 0)) cur.repair_rounds = repairRounds;
      const at = new Date().toISOString();
      const handback = cur.handback;
      const decisionKind: RunDecision['kind'] = handback.kind === 'blocker' ? 'blocker'
        : handback.kind === 'assumption' ? 'assumption' : 'accept';
      recordDecision(cur, {
        step, kind: decisionKind, job: 'main', decision: 'stop',
        ...(handback.ticket && { ticket: handback.ticket }),
        ...(handback.job && { worker_job: handback.job }),
        ...(parsed.reason && { reason: parsed.reason }),
        at,
      });
      cur.epoch = (cur.epoch ?? 0) + 1;
      cur.steps ??= {};
      cur.steps[step] = { state: 'cancelled', answer: 'stop', changed_at: at };
      for (const cursor of Object.values(cur.steps)) {
        if (cursor.state === 'waiting' || cursor.state === 'ready') {
          cursor.state = 'cancelled';
          cursor.changed_at = at;
        }
      }
      delete cur.handback;
      cur.reason = parsed.reason ? `stopped: ${parsed.reason}` : 'stopped by main';
      cur.queued = undefined;
      cur.notices = {};
      cur.state = 'cancelled';
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: false };
    }
    if (parsed.choice === 'repair') {
      const repair = prepareTicketQueueRepair(cur, handbackStepKeys(home, cur),
        () => ticketReadiness(cur.root, jobCache, cur.feature, { home }), parsed.reason);
      if (repair.kind === 'no_work') {
        return {
          ok: false,
          code: 'no_repair_tickets',
          error: `No new ready repair tickets in feature ${cur.feature}; add repair ticket(s) via hud_tickets before answering repair`,
        };
      }
      const handback = cur.handback;
      const at = new Date().toISOString();
      recordDecision(cur, {
        step, kind: 'accept', job: 'main', decision: 'repair',
        ...(step === 'tickets' && handback.ticket && { ticket: handback.ticket }),
        ...(step === 'tickets' && handback.job && { worker_job: handback.job }),
        ...(parsed.reason && { reason: parsed.reason }),
        at,
      });
      cur.epoch = (cur.epoch ?? 0) + 1;
      if (repair.kind === 'cap') {
        cur.steps ??= {};
        cur.steps[step] = { state: 'asking', reason: repair.reason, changed_at: at };
        cur.reason = repair.reason;
        cur.queued = undefined;
        cur.remaining = cur.remaining ?? [];
        cur.handback = { step, choices: ['resume', 'stop'], kind: 'escalate' };
        cur.notices = { [`pause-${cur.epoch}`]: ticketQueueNotice(cur).replace(/\r?\n/g, ' | ') };
        writeTicketQueue(home, cur);
        return { ok: true, queue: cur, resumed: false };
      }
      delete cur.handback;
      delete cur.reason;
      delete cur.pid;
      delete cur.start;
      cur.streak = 0; cur.settled = 0; cur.failures = 0;
      cur.notices = {};
      cur.state = 'working';
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: true };
    }
    if (parsed.choice === 'escalate') {
      const handback = cur.handback;
      const msg = parsed.reason ? `escalated: ${parsed.reason}` : 'escalated by main';
      const at = new Date().toISOString();
      recordDecision(cur, {
        step, kind: 'accept', job: 'main', decision: 'escalate',
        ...(step === 'tickets' && handback.ticket && { ticket: handback.ticket }),
        ...(step === 'tickets' && handback.job && { worker_job: handback.job }),
        ...(parsed.reason && { reason: parsed.reason }),
        at,
      });
      cur.epoch = (cur.epoch ?? 0) + 1;
      cur.steps ??= {};
      cur.steps[step] = { state: 'asking', reason: msg, changed_at: at };
      cur.reason = msg;
      cur.queued = undefined;
      cur.remaining = cur.remaining ?? [];
      cur.handback = { step, choices: ['resume', 'stop'], kind: 'escalate' };
      cur.state = 'paused';
      cur.notices = { [`pause-${cur.epoch}`]: ticketQueueNotice(cur).replace(/\r?\n/g, ' | ') };
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: false };
    }
    const choice = overridesEscalation ? 'finish' : parsed.choice;
    if (!cur.unattended && choice === 'finish' && cur.tickets.some(t => t.held)) {
      const held = cur.tickets.find(t => t.held)!;
      return {
        ok: false,
        code: 'invalid_choice',
        error: `Cannot finish ${id} while ${held.ticket} is held — manual resolution required: worker correction, hud_land, or stop`,
      };
    }
    const handback = cur.handback;
    const reason = parsed.reason ?? (overridesEscalation ? 'escalation overridden by main' : undefined);
    const verdict = reason ? `${choice}: ${reason}` : choice;
    const at = new Date().toISOString();
    recordDecision(cur, {
      step, kind: 'accept', job: 'main', decision: parsed.choice,
      ...(step === 'tickets' && handback.ticket && { ticket: handback.ticket }),
      ...(step === 'tickets' && handback.job && { worker_job: handback.job }),
      ...(parsed.reason && { reason: parsed.reason }),
      at,
    });
    cur.epoch = (cur.epoch ?? 0) + 1;
    cur.steps ??= {};
    cur.steps[step] = { state: 'done', answer: choice, changed_at: at };
    cur.verdict = verdict;
    delete cur.handback;
    delete cur.reason;
    const allDone = Object.values(cur.steps).every(c => ['done', 'failed', 'skipped', 'cancelled'].includes(c.state));
    if (allDone) {
      cur.state = 'completed';
      cur.queued = undefined;
      cur.remaining = [];
      cur.notices = cur.task ? {} : { [`end-${cur.epoch}`]: ticketQueueNotice(cur).replace(/\r?\n/g, ' | ') };
      writeTicketQueue(home, cur);
      return { ok: true, queue: cur, resumed: false };
    }
    delete cur.pid;
    delete cur.start;
    cur.notices = {};
    cur.state = 'working';
    writeTicketQueue(home, cur);
    return { ok: true, queue: cur, resumed: true };
  };
  const result = await withTicketAdmission(home, queue.root, queue.feature, queue.unattended?.objective,
    () => runLock(home, id, settle));
  if (result.ok && result.resumed) {
    // Wait briefly if the exiting runner from the prior pause still holds the driver lock.
    try { await withAbstractLock('flow-runner', `${home}\0${id}`, () => {}, { timeoutMs: 2_000 }); }
    catch { /* Best-effort wait; watcher still recovers if busy. */ }
    wakeWorkflow(home, result.queue);
  } else if (result.ok && result.queue.state === 'paused' && Object.keys(result.queue.notices ?? {}).length) {
    ensureJobWatcher(home);
  }
  return result;
}

/** Answering the question that stopped a queue is the main session's judgement, so that queue resumes. */
export async function resumeQueueAfterAnswer(home: string, jobId: string, request: string, pane: string | null, cwd = process.cwd()) {
  const q = queueIds(home).map(id => readTicketQueue(home, id)).filter(q => q !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find(q => q.tickets.some(item => item.job === jobId || item.repair_job === jobId) || q.review_job === jobId);
  const matchesQuestion = (q?.handback?.kind === 'question' && q.handback.job === jobId && q.handback.question === request) ||
    (q?.handback?.kind === 'escalate' && q.handback.job === jobId && q.handback.question === request) ||
    q?.reason?.includes(`(${jobId}): worker question ${request} `);
  // An owner answer can resume the worker, but must not implicitly restart unattended landing.
  if (!q || q.unattended || (q.state !== 'failed' && q.state !== 'paused') || !runVisible(q, pane, cwd) || !matchesQuestion) return undefined;
  await runLock(home, q.flow, () => {
    const cur = readTicketQueue(home, q.flow);
    if (!cur || cur.unattended || (cur.state !== 'failed' && cur.state !== 'paused')) return;
    const at = new Date().toISOString();
    const item = cur.tickets.find(t => t.job === jobId || t.repair_job === jobId);
    if (item) {
      item.answered_at = at;
      item.changed_at = at;
      const alreadyRecorded = cur.decisions?.some(
        d => d.kind === 'question' && d.decision === 'answer' && d.ticket === item.ticket && d.question === request &&
          (!d.worker_job || d.worker_job === jobId),
      );
      if (!alreadyRecorded) {
        recordDecision(cur, { step: 'tickets', kind: 'question', job: 'main', decision: 'answer', ticket: item.ticket, worker_job: jobId, question: request, at });
      }
      writeTicketQueue(home, cur);
    } else if (cur.review_job === jobId) {
      cur.steps ??= {};
      cur.steps.review = { ...(cur.steps.review ?? { state: 'running' as const }), changed_at: at };
      const reviewCreatedAtMs = jobCreatedAtMs(home, jobId);
      const alreadyRecorded = cur.decisions?.some(d => {
        if (d.kind !== 'question' || d.decision !== 'answer' || d.step !== 'review' || d.question !== request) return false;
        if (d.worker_job) return d.worker_job === jobId;
        if (reviewCreatedAtMs === null) return false;
        const decisionAtMs = Date.parse(d.at);
        return Number.isFinite(decisionAtMs) && decisionAtMs >= reviewCreatedAtMs;
      });
      if (!alreadyRecorded) {
        recordDecision(cur, { step: 'review', kind: 'question', job: 'main', decision: 'answer', worker_job: jobId, question: request, at });
      }
      writeTicketQueue(home, cur);
    }
  });
  try { return (await startTicketQueue(home, q.root, pane ?? (q.pane || null), false, { feature: q.feature, max_parallel: q.max_parallel }))?.flow; }
  catch { return undefined; }
}
export function ticketQueueTask(home: string, q: TicketQueue, cancel = false) {
  if (cancel) cancelTicketQueue(home, q);
  if (q.state === 'working') {
    wakeWorkflow(home, q);
    ensureJobWatcher(home);
  }
  const pauseKey = `pause-${q.epoch ?? 0}`;
  const pauseText = q.state === 'paused' ? q.notices?.[pauseKey] : undefined;
  if (pauseText) {
    try { noticeEvents(home, { flow: q.flow, notices: { [pauseKey]: pauseText } }); }
    catch { /* Best-effort claim so a later mode switch does not duplicate the pause notice. */ }
  }
  const text = q.state === 'working'
    ? `${q.flow} (ticket queue ${q.feature}) — ${ticketQueueView(q).reason ?? 'working'}`
    : pauseText ?? ticketQueueNotice(q);
  const status = q.state === 'paused' ? 'completed' : q.state === 'stopped' || q.state === 'superseded' ? 'cancelled' : q.state;
  return { taskId: q.flow, status, statusMessage: text,
    createdAt: q.created_at, lastUpdatedAt: q.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(q.state !== 'working' && { result: { content: [{ type: 'text', text }] } }) };
}