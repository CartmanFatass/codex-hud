/** Collect rerun-pass land gate flakes into the project's running-list ticket and dispatch one imp job when ready. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { scanScratch } from '../cli/tickets.js';
import { targetKey, ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { readDone, readTurn, receiptForTurn } from '../roles/cli-turn.js';
import { herdrId } from '../roles/herdr-run.js';
import { checkBinding, readCheckReceipt, sameChecks } from '../roles/job-checks.js';
import { filterTimedOutQuestions, getJobIndexCache } from '../roles/job-index-cache.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { sharedRoot } from '../roles/projects.js';
import { cachedReportSignature, readReportMeta } from '../roles/report-meta.js';
import { runTicketEdit } from '../tickets/archive.js';
import { type FlakeCase } from '../tickets/flake-cases.js';
import {
  legacyTicketPaths, readJsonTicketFeature, storedTicket, ticketFeaturePath,
  type FlakeCaseRecord, type TicketFeatureDoc, type TicketRecord,
} from '../tickets/store.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readDirSafe, readFileBounded, readJsonBounded, readJsonFile, writeJsonPrivate } from '../utils/atomic-fs.js';
import { sonicChildren } from '../worker/sonic-jobs.js';
import { dispatchTicketJob } from './dispatch/orchestrator.js';
import { flakeDispatchKey, isAutoLandFlakeJob, isRunningListTicket, readFlakesConfig, runningListAdmission } from './flake-admission.js';
import { indexFlakeBlockJob, withFlakeBlockIndexLock } from './flake-block-index.js';
import type { Job, JobStatus } from './job-contracts.js';
import {
  activeLand, isFlowId, landAttempt, landFile, updateLandFlakeCollection,
  type LandFlakeCollection, type LandFlow,
} from './land-state.js';
import { startLand, validLandConfig } from './land.js';
import { ticketBlockersByKey } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { piReportSettlement } from './pi-read-settlement.js';
import { extractAssumedLines, extractReportNotes } from './report-notes.js';
import { ensureJobWatcher } from './watch-pid.js';

export { parseFlakeCases, type FlakeCase } from '../tickets/flake-cases.js';
export { flakeDispatchKey, isAutoLandFlakeJob } from './flake-admission.js';

export interface GateFlake {
  name: string;
  file?: string;
  flow: string;
  log?: string;
  unidentified?: boolean;
  step?: string;
}

export interface CollectFlakesOptions {
  landedTickets?: readonly string[];
  retryDispatch?: boolean;
  pendingTicket?: string;
  dispatch?: (input: {
    role: 'imp';
    cwd: string;
    isolation: 'worktree';
    ticket: string;
    brief_file: string;
    request_key: string;
  }, pane: string | undefined) => Promise<{
    job?: string;
    ok?: boolean;
    state?: string;
    display_state?: string;
    reason?: string;
    error?: string;
    code?: string;
  } | Record<string, unknown>>;
}

export interface CollectFlakesPending {
  stage: 'edit' | 'dispatch';
  error: string;
  ticket?: string;
}

export interface CollectFlakesResult {
  ticket?: string;
  path?: string;
  created?: boolean;
  promoted?: boolean;
  dispatchedJob?: string;
  pending?: CollectFlakesPending;
}

const MAX_TICKET_BYTES = 256 * 1024;
const MAX_FLOW_BYTES = 128 * 1024;
const DISPATCH_CASE_THRESHOLD = 4;
const WAITING_DISPATCH_ERROR = 'waiting for active flake job';
const BLOCKED_DISPATCH_ERROR = 'ticket is blocked';
const UNAVAILABLE_DISPATCH_ERROR = 'ticket readiness unavailable';
const FEATURE_CHANGED_DISPATCH_ERROR = 'waiting for configured flakes feature';
const FLAKE_WORKER_RULE =
  'Auto-land rule: when you settle with a report and a commit, HUD lands this flake fix automatically. ' +
  'Write any scope assumption on an `Assumed:` line marked with `scope`, and use `Blockers:` only for an owner decision needed before this can land (otherwise write `Blockers: none`).';

const nn = (n: number) => String(n).padStart(2, '0');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const norm = (text: string) => oneLine(text).toLowerCase();

export function formatLogPath(log: string | undefined): string | undefined {
  if (!log) return undefined;
  const trimmed = oneLine(log);
  if (!trimmed) return undefined;
  const homeDir = homedir();
  const resolvedHome = resolve(homeDir);
  const resolvedLog = resolve(trimmed);
  if (resolvedLog.startsWith(resolvedHome + sep)) {
    return `~/${relative(resolvedHome, resolvedLog).split(sep).join('/')}`;
  }
  return trimmed;
}

export function formatFlakeLine(flake: GateFlake): string {
  const name = oneLine(flake.name);
  const file = flake.file ? oneLine(flake.file) : undefined;
  const flow = oneLine(flake.flow);
  const log = formatLogPath(flake.log);
  const subject = flake.unidentified
    ? (file ? `unidentified failure (\`${name}\`, ${file})` : `unidentified failure (\`${name}\`)`)
    : (file ? `\`${name}\` (${file})` : `\`${name}\``);
  return log
    ? `- ${subject} — flow \`${flow}\`, log \`${log}\``
    : `- ${subject} — flow \`${flow}\``;
}

function sameTest(a: Pick<FlakeCase, 'name' | 'file' | 'unidentified'>, b: Pick<FlakeCase, 'name' | 'file' | 'unidentified'>): boolean {
  if (a.unidentified || b.unidentified) return false;
  if (norm(a.name) !== norm(b.name)) return false;
  if (a.file && b.file) return norm(a.file) === norm(b.file);
  return true;
}

function sameRecordedEntry(existing: FlakeCase, incoming: GateFlake): boolean {
  if (!existing.flow || norm(existing.flow) !== norm(incoming.flow)) return false;
  if (Boolean(existing.unidentified) !== Boolean(incoming.unidentified)) return false;
  if (norm(existing.name) !== norm(incoming.name)) return false;
  if ((existing.file ? norm(existing.file) : '') !== (incoming.file ? norm(incoming.file) : '')) return false;
  const inLog = formatLogPath(incoming.log);
  if (existing.log && inLog && norm(existing.log) !== norm(inLog)) return false;
  return true;
}

function shouldTriggerDispatch(allCases: readonly FlakeCase[]): boolean {
  if (allCases.length >= DISPATCH_CASE_THRESHOLD) return true;
  for (let i = 0; i < allCases.length; i++) {
    for (let j = i + 1; j < allCases.length; j++) {
      if (sameTest(allCases[i], allCases[j])) return true;
    }
  }
  return false;
}

function listFeatureTickets(scratchDir: string, feature: string): { number: number; path: string }[] {
  const issues = join(scratchDir, feature, 'issues');
  const st = fs.lstatSync(issues, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];
  return fs.readdirSync(issues, { withFileTypes: true }).flatMap(entry => {
    const match = /^(\d+)-.+\.md$/.exec(entry.name);
    return match && entry.isFile() ? [{ number: Number(match[1]), path: join(issues, entry.name) }] : [];
  });
}

interface FeatureTicketEntry {
  number: number;
  path: string;
}

function parseTicketRef(ticket: string): { feature: string; number: number; key: string } | null {
  const key = targetKey(ticket);
  const match = /^([a-z0-9-]+)\/(\d+)$/.exec(key);
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { feature: match[1], number, key } : null;
}

type TicketDispatchState =
  | { state: 'ready'; ticket: string; path: string }
  | { state: 'blocked' | 'unavailable' | 'unpromoted' | 'resolved'; ticket: string };

function inspectRunningListEntry(
  feature: string,
  item: FeatureTicketEntry,
  claimedTickets: ReadonlySet<string>,
  getBlockers?: () => ReadonlyMap<string, readonly string[]>,
): TicketDispatchState {
  const canonical = `${feature}/${nn(item.number)}`;
  const key = targetKey(canonical);
  if (claimedTickets.has(key)) return { state: 'resolved', ticket: canonical };
  try {
    const { bytes, truncated } = readFileBounded(item.path, MAX_TICKET_BYTES);
    if (truncated) return { state: 'unavailable', ticket: canonical };
    const text = bytes.toString('utf8');
    const evidence = ticketFileEvidence(text);
    if (evidence.landed !== undefined || /^claimed$/i.test(evidence.status ?? '')) {
      return { state: 'resolved', ticket: canonical };
    }
    if (!isRunningListTicket(text)) return { state: 'unavailable', ticket: canonical };
    if (/^(needs-triage|needs-info)$/i.test(evidence.status ?? '')) return { state: 'unpromoted', ticket: canonical };
    if (!/^ready-for-agent$/i.test(evidence.status ?? '')) return { state: 'unavailable', ticket: canonical };
    if (getBlockers) {
      const blockers = getBlockers().get(key);
      if (!blockers) return { state: 'unavailable', ticket: canonical };
      if (blockers.length > 0) return { state: 'blocked', ticket: canonical };
    }
    return { state: 'ready', ticket: canonical, path: item.path };
  } catch {
    return { state: 'unavailable', ticket: canonical };
  }
}

const FLAKE_LIST_WHAT = 'Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).';
const FLAKE_LIST_ACCEPTANCE = [
  'Each listed case passes 20 consecutive runs under parallel load',
  'No assertion or product bound weakened',
] as const;

function toFlakeCaseRecord(flake: GateFlake, recorded_at: string): FlakeCaseRecord {
  const step = oneLine(flake.step || (flake.unidentified ? flake.name : 'gate')) || 'gate';
  const test = flake.file ? oneLine(flake.file) : undefined;
  const case_name = flake.unidentified ? undefined : (oneLine(flake.name) || undefined);
  const flow = oneLine(flake.flow) || undefined;
  const log = formatLogPath(flake.log);
  return {
    step,
    ...(test ? { test } : {}),
    ...(case_name ? { case_name } : {}),
    ...(flow ? { flow } : {}),
    ...(log ? { log } : {}),
    recorded_at,
  };
}

function recordToFlakeCase(record: FlakeCaseRecord): FlakeCase {
  return {
    name: record.case_name ?? record.step,
    ...(record.test ? { file: record.test } : {}),
    ...(record.flow ? { flow: record.flow } : {}),
    ...(record.log ? { log: record.log } : {}),
    ...(!record.case_name ? { unidentified: true } : {}),
  };
}

function inspectRunningListRecord(
  feature: string,
  record: TicketRecord,
  path: string,
  claimedTickets: ReadonlySet<string>,
  getBlockers?: () => ReadonlyMap<string, readonly string[]>,
): TicketDispatchState {
  const canonical = `${feature}/${nn(record.number)}`;
  const key = targetKey(canonical);
  if (claimedTickets.has(key)) return { state: 'resolved', ticket: canonical };
  const completedLanding = Boolean(
    record.landing && (record.acceptance.every(item => item.done) || record.status === 'ready-for-human'),
  );
  if (record.status === 'done' || record.status === 'wontfix' || record.status === 'claimed' || completedLanding || record.accepted) {
    return { state: 'resolved', ticket: canonical };
  }
  if (record.kind !== 'flake-list') return { state: 'unavailable', ticket: canonical };
  if (record.status === 'needs-triage' || record.status === 'needs-info') return { state: 'unpromoted', ticket: canonical };
  if (record.status !== 'ready-for-agent') return { state: 'unavailable', ticket: canonical };
  if (getBlockers) {
    const blockers = getBlockers().get(key);
    if (!blockers) return { state: 'unavailable', ticket: canonical };
    if (blockers.length > 0) return { state: 'blocked', ticket: canonical };
  }
  return { state: 'ready', ticket: canonical, path };
}

function inspectRunningListTicket(
  mainRoot: string,
  ticket: string,
  claimedTickets: ReadonlySet<string>,
  getBlockers?: () => ReadonlyMap<string, readonly string[]>,
): TicketDispatchState {
  const ref = parseTicketRef(ticket);
  if (ref) {
    if (claimedTickets.has(ref.key)) return { state: 'resolved', ticket };
    try {
      const stored = storedTicket(mainRoot, ref.key);
      if (stored) {
        if (stored.record) {
          return inspectRunningListRecord(
            stored.doc.feature,
            stored.record,
            ticketFeaturePath(mainRoot, stored.doc.feature),
            claimedTickets,
            getBlockers,
          );
        }
        return { state: 'unavailable', ticket };
      }
      const item = listFeatureTickets(join(mainRoot, '.scratch'), ref.feature).find(t => t.number === ref.number);
      if (item) return inspectRunningListEntry(ref.feature, item, claimedTickets, getBlockers);
    } catch { /* The ticket store or directory could not be read. */ }
  }
  return { state: 'unavailable', ticket };
}

function findReadyRunningListTicket(
  mainRoot: string,
  feature: string,
  claimedTickets: ReadonlySet<string>,
  getBlockers: () => ReadonlyMap<string, readonly string[]>,
): { ticket: string; path: string } | null {
  try {
    const doc = readJsonTicketFeature(mainRoot, feature);
    if (doc) {
      const path = ticketFeaturePath(mainRoot, feature);
      for (const record of doc.tickets) {
        const inspected = inspectRunningListRecord(feature, record, path, claimedTickets, getBlockers);
        if (inspected.state === 'ready') return { ticket: inspected.ticket, path: inspected.path };
      }
      return null;
    }
  } catch {
    return null;
  }
  const scratch = join(mainRoot, '.scratch');
  const tickets = listFeatureTickets(scratch, feature).sort((a, b) => a.number - b.number);
  for (const item of tickets) {
    const inspected = inspectRunningListEntry(feature, item, claimedTickets, getBlockers);
    if (inspected.state === 'ready') return { ticket: inspected.ticket, path: inspected.path };
  }
  return null;
}

function dispatchAdmissionError(res: unknown): string | null {
  if (!res || typeof res !== 'object') return 'dispatch returned no result';
  const r = res as Record<string, unknown>;
  const job = typeof r.job === 'string' && r.job ? r.job : undefined;
  const failed = r.ok === false || r.state === 'failed' || r.state === 'stopped' ||
    r.display_state === 'failed' || r.display_state === 'stopped';
  if (!job || failed) {
    const why = (typeof r.reason === 'string' && r.reason) ||
      (typeof r.error === 'string' && r.error) ||
      (typeof r.code === 'string' && r.code) ||
      (failed && job ? `job ${job} is ${String(r.state ?? r.display_state ?? 'failed')}` : 'dispatch refused');
    return oneLine(why).slice(0, 300);
  }
  return null;
}

export function flakesFromLandFlow(flow: Pick<LandFlow, 'flow' | 'reruns'>): GateFlake[] {
  const out: GateFlake[] = [];
  for (const r of flow.reruns ?? []) {
    if (typeof r === 'string') continue;
    const passed = r.rerun_ok === true || !r.output_path;
    if (!passed) continue;
    if (r.cases?.length) {
      for (const item of r.cases) {
        const named = Boolean(item.name);
        out.push({
          name: item.name ?? r.step,
          ...(item.file ? { file: item.file } : {}),
          flow: flow.flow,
          step: r.step,
          ...(r.output_path ? { log: r.output_path } : {}),
          ...(!named ? { unidentified: true } : {}),
        });
      }
    } else {
      out.push({
        name: r.step,
        flow: flow.flow,
        step: r.step,
        ...(r.output_path ? { log: r.output_path } : {}),
        unidentified: true,
      });
    }
  }
  return out;
}

export async function collectGateFlakes(
  home: string,
  mainRoot: string,
  flakes: readonly GateFlake[],
  pane: string | null,
  options?: CollectFlakesOptions,
): Promise<CollectFlakesResult> {
  const config = readFlakesConfig(mainRoot);
  if (!config) return {};
  const { feature } = config;
  const landedFlake = (options?.landedTickets ?? []).some(t => targetKey(t).startsWith(`${feature.toLowerCase()}/`));
  if (!flakes.length && !landedFlake && !options?.retryDispatch) return {};

  let result: CollectFlakesResult = {};
  let alreadyRecorded = false;

  if (flakes.length) {
    try {
      const editRes = await runTicketEdit(mainRoot, home, 0, async (write) => {
        const scratch = join(mainRoot, '.scratch');
        scanScratch(scratch, true);
        const { claimedTickets } = runningListAdmission(home, mainRoot, feature);
        const existingDoc = readJsonTicketFeature(mainRoot, feature);
        if (!existingDoc && legacyTicketPaths(mainRoot, feature).length > 0) {
          throw Error(`Feature "${feature}" still uses legacy Markdown tickets; run "hud tickets migrate" first`);
        }
        if (existingDoc?.mirror) {
          throw Error('refusing local ticket edits: GitHub mirror; edit issues with gh, then call hud_tickets with op: sync');
        }
        const doc: TicketFeatureDoc = existingDoc ?? { version: 1, feature, tickets: [] };
        const path = ticketFeaturePath(mainRoot, feature);
        const maxNum = doc.tickets.reduce((max, t) => Math.max(max, t.number), 0);
        const desc = [...doc.tickets].sort((a, b) => b.number - a.number);

        const seenEntries: { entry: FlakeCase; ticket: string; path: string }[] = [];
        let newestRunning: TicketRecord | undefined;
        for (const item of desc) {
          if (item.kind !== 'flake-list') continue;
          if (!newestRunning) newestRunning = item;
          const ticket = `${feature}/${nn(item.number)}`;
          for (const c of item.cases ?? []) {
            seenEntries.push({ entry: recordToFlakeCase(c), ticket, path });
          }
        }

        let openTarget: TicketRecord | undefined;
        if (newestRunning) {
          const key = targetKey(`${feature}/${nn(newestRunning.number)}`);
          if ((newestRunning.status === 'needs-triage' || newestRunning.status === 'needs-info') &&
              !newestRunning.landing && !newestRunning.accepted && !claimedTickets.has(key)) {
            openTarget = newestRunning;
          }
        }

        const targetCases = (openTarget?.cases ?? []).map(recordToFlakeCase);
        const toAdd: GateFlake[] = [];
        let matchedTarget: { ticket: string; path: string } | undefined;
        for (const flake of flakes) {
          const match = seenEntries.find(e => sameRecordedEntry(e.entry, flake));
          if (match) {
            matchedTarget ??= { ticket: match.ticket, path: match.path };
            continue;
          }
          toAdd.push(flake);
          seenEntries.push({ entry: { ...flake, log: formatLogPath(flake.log) }, ticket: '', path: '' });
        }
        if (!toAdd.length) {
          return {
            alreadyRecorded: true,
            res: matchedTarget
              ? { ticket: matchedTarget.ticket, path: matchedTarget.path, created: false, promoted: false }
              : openTarget
                ? { ticket: `${feature}/${nn(openTarget.number)}`, path, created: false, promoted: false }
                : newestRunning
                  ? { ticket: `${feature}/${nn(newestRunning.number)}`, path, created: false, promoted: false }
                  : {},
          };
        }

        const at = new Date().toISOString();
        const newRecords = toAdd.map(f => toFlakeCaseRecord(f, at));
        const allCases: FlakeCase[] = [...targetCases, ...newRecords.map(recordToFlakeCase)];
        const promoted = shouldTriggerDispatch(allCases);

        if (openTarget) {
          const ticket = `${feature}/${nn(openTarget.number)}`;
          openTarget.cases = [...(openTarget.cases ?? []), ...newRecords];
          if (promoted) openTarget.status = 'ready-for-agent';
          openTarget.updated_at = at;
          await write([doc]);
          return { alreadyRecorded: false, res: { ticket, path, created: false, promoted } };
        }

        const nextNum = maxNum + 1;
        const ticket = `${feature}/${nn(nextNum)}`;
        const title = maxNum > 0
          ? `Gate flakes collected after ${feature}/${nn(maxNum)}`
          : 'Gate flakes running list';
        doc.tickets.push({
          number: nextNum,
          title,
          kind: 'flake-list',
          status: promoted ? 'ready-for-agent' : 'needs-triage',
          owner_try: false,
          live_try: 'none',
          approved_removals: [],
          blocked_by: [],
          what: FLAKE_LIST_WHAT,
          cases: newRecords,
          acceptance: FLAKE_LIST_ACCEPTANCE.map((text, i) => ({ id: i + 1, text, done: false })),
          comments: [],
          created_at: at,
          updated_at: at,
        });
        await write([doc]);
        return { alreadyRecorded: false, res: { ticket, path, created: true, promoted } };
      });
      alreadyRecorded = editRes.alreadyRecorded;
      result = editRes.res;
    } catch (err) {
      const error = oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300) || 'ticket edit refused';
      return { pending: { stage: 'edit', error } };
    }
  }

  const mustDispatchTicket = result.promoted
    ? result.ticket
    : options?.retryDispatch
      ? options.pendingTicket
      : alreadyRecorded
        ? result.ticket
        : undefined;

  if (result.promoted || landedFlake || options?.retryDispatch || alreadyRecorded) {
    const targetRef = mustDispatchTicket ? parseTicketRef(mustDispatchTicket) : null;
    if (mustDispatchTicket && targetRef?.feature !== feature) {
      const targetClaimed = targetRef
        ? runningListAdmission(home, mainRoot, targetRef.feature, undefined, false).claimedTickets
        : EMPTY_CLAIMED;
      const inspected = inspectRunningListTicket(mainRoot, mustDispatchTicket, targetClaimed);
      if (inspected.state !== 'resolved') {
        result.pending = { stage: 'dispatch', error: FEATURE_CHANGED_DISPATCH_ERROR, ticket: inspected.ticket };
        return result;
      }
      if (!landedFlake || options?.retryDispatch) return result;
    }

    const dispatchOutcome = await withAbstractLock('land-flakes-dispatch', `${home}\0${sharedRoot(mainRoot)}\0${feature}`, async () => {
      const { claimedTickets, nextAttempt, eligible } = runningListAdmission(home, mainRoot, feature);
      let blockerMap: ReadonlyMap<string, readonly string[]> | undefined;
      const getBlockers = () => (blockerMap ??= ticketBlockersByKey(mainRoot));
      const inspected = mustDispatchTicket && targetRef?.feature === feature
        ? inspectRunningListTicket(mainRoot, mustDispatchTicket, claimedTickets, getBlockers)
        : undefined;
      if (inspected && inspected.state !== 'ready') {
        // Replaying a recorded edit on an unpromoted list never required dispatch.
        const noDispatchNeeded = inspected.state === 'resolved' ||
          (inspected.state === 'unpromoted' && alreadyRecorded && !options?.retryDispatch);
        if (!noDispatchNeeded) {
          const error = inspected.state === 'blocked' ? BLOCKED_DISPATCH_ERROR : UNAVAILABLE_DISPATCH_ERROR;
          return { pending: { stage: 'dispatch' as const, error, ticket: inspected.ticket } };
        }
        if (!landedFlake || options?.retryDispatch) return {};
      }
      const candidate = inspected?.state === 'ready'
        ? inspected
        : findReadyRunningListTicket(mainRoot, feature, claimedTickets, getBlockers);
      if (!candidate) return {};
      if (!eligible(candidate.ticket)) {
        return inspected?.state === 'ready' || options?.retryDispatch
          ? { pending: { stage: 'dispatch' as const, error: WAITING_DISPATCH_ERROR, ticket: candidate.ticket } }
          : {};
      }
      const validPane = pane && herdrId(pane) ? pane : undefined;
      const input = {
        role: 'imp' as const,
        cwd: mainRoot,
        isolation: 'worktree' as const,
        ticket: candidate.ticket,
        brief_file: candidate.path,
        request_key: flakeDispatchKey(mainRoot, candidate.ticket, nextAttempt(candidate.ticket)),
      };
      try {
        const res = options?.dispatch
          ? await options.dispatch(input, validPane)
          : await dispatchTicketJob(
              { role: input.role, cwd: input.cwd, ticket: input.ticket, brief_file: input.brief_file, request_key: input.request_key },
              validPane,
              { autoLand: true, runNote: FLAKE_WORKER_RULE },
            );
        const error = dispatchAdmissionError(res);
        if (error) return { pending: { stage: 'dispatch' as const, error, ticket: candidate.ticket } };
        if (!options?.dispatch) ensureJobWatcher(home);
        return { job: (res as { job: string }).job, ticket: candidate.ticket };
      } catch (err) {
        const error = oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300) || 'dispatch threw';
        return { pending: { stage: 'dispatch' as const, error, ticket: candidate.ticket } };
      }
    });
    if (dispatchOutcome.job) {
      result.dispatchedJob = dispatchOutcome.job;
      result.ticket ??= dispatchOutcome.ticket;
    } else if (dispatchOutcome.pending) {
      result.pending = dispatchOutcome.pending;
    }
  }

  return result;
}

function landedTicketsForFlow(home: string, flow: LandFlow): string[] {
  if (flow.state !== 'completed' || flow.unfinished_acceptance?.length) return [];
  try {
    const receipt = readJsonFile(join(home, 'jobs', flow.job, jobFiles.job)) as Job;
    return typeof receipt.ticket === 'string' && receipt.ticket ? [receipt.ticket] : [];
  } catch {
    return [];
  }
}

export async function collectAndRecordLandFlakes(
  home: string,
  mainRoot: string,
  flow: LandFlow,
  options?: { landedTickets?: readonly string[]; pane?: string | null; dispatch?: CollectFlakesOptions['dispatch'] },
): Promise<CollectFlakesResult> {
  const config = readFlakesConfig(mainRoot);
  if (!config) return {};
  const flakes = flakesFromLandFlow(flow);
  const landedTickets = options?.landedTickets ?? landedTicketsForFlow(home, flow);
  const landedFlake = landedTickets.some(t => targetKey(t).startsWith(`${config.feature.toLowerCase()}/`));
  const prev = flow.flake_collection;
  const wasPending = prev?.state === 'pending';
  if (!flakes.length && !landedFlake && !wasPending) return {};

  const retryDispatch = wasPending && prev?.stage === 'dispatch';
  const effectivePane = options?.pane !== undefined ? options.pane : flow.pane;
  const res = await collectGateFlakes(
    home,
    mainRoot,
    retryDispatch ? [] : flakes,
    effectivePane,
    {
      landedTickets,
      retryDispatch,
      ...(retryDispatch && prev?.ticket ? { pendingTicket: prev.ticket } : {}),
      dispatch: options?.dispatch,
    },
  );

  const attempts = (prev?.attempts ?? 0) + 1;
  const updated_at = new Date().toISOString();
  if (res.pending) {
    const ticket = res.pending.ticket ?? res.ticket ?? prev?.ticket;
    const unchanged = prev?.state === 'pending' &&
      prev.stage === res.pending.stage &&
      prev.error === res.pending.error &&
      prev.ticket === ticket;
    if (!unchanged) {
      const collection: LandFlakeCollection = {
        state: 'pending',
        stage: res.pending.stage,
        error: res.pending.error,
        ...(ticket ? { ticket } : {}),
        attempts,
        updated_at,
      };
      await updateLandFlakeCollection(home, flow.flow, collection);
    }
  } else if (res.ticket || res.dispatchedJob || wasPending) {
    const ticket = res.ticket ?? prev?.ticket;
    const collection: LandFlakeCollection = {
      state: 'done',
      ...(ticket ? { ticket } : {}),
      ...(res.dispatchedJob ? { job: res.dispatchedJob } : {}),
      attempts,
      updated_at,
    };
    await updateLandFlakeCollection(home, flow.flow, collection);
  }
  return res;
}

const EMPTY_CLAIMED: ReadonlySet<string> = new Set();

export function hasPendingFlakeCollection(
  home: string,
  flow: Partial<Pick<LandFlow, 'wt' | 'flake_collection'>> | null | undefined,
): boolean {
  const fc = flow?.flake_collection;
  if (!fc || fc.state !== 'pending') return false;
  if (fc.stage !== 'dispatch' || !fc.ticket) return true;
  const mainRoot = flow.wt?.main_root;
  if (typeof mainRoot !== 'string' || !mainRoot) return true;
  const ref = parseTicketRef(fc.ticket);
  if (!ref) return true;
  if (inspectRunningListTicket(mainRoot, fc.ticket, EMPTY_CLAIMED).state === 'resolved') return false;
  const { claimedTickets } = runningListAdmission(home, mainRoot, ref.feature, undefined, false);
  return !claimedTickets.has(ref.key);
}

export function listPendingFlakeFlows(home: string, mainRoot: string, excludeFlow?: string): LandFlow[] {
  const dir = join(home, 'flows');
  const names = readDirSafe(dir);
  if (!names.length) return [];
  const targetRoot = sharedRoot(mainRoot);
  const pending: LandFlow[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (id === excludeFlow || !isFlowId(id)) continue;
    try {
      const f = readJsonBounded(landFile(home, id), MAX_FLOW_BYTES) as LandFlow | null;
      if (!f || activeLand(f) || f.flake_collection?.state !== 'pending') continue;
      const flowMain = f.wt?.main_root;
      if (!flowMain || (flowMain !== mainRoot && sharedRoot(flowMain) !== targetRoot)) continue;
      pending.push(f);
    } catch { /* Skip unreadable flow receipt. */ }
  }
  return pending.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.flow.localeCompare(b.flow));
}

export async function retryPendingFlakeCollections(
  home: string,
  mainRoot: string,
  pane: string | null,
  options?: { excludeFlow?: string; dispatch?: CollectFlakesOptions['dispatch'] },
): Promise<{ retried: number; resolved: number; pending: number }> {
  if (!readFlakesConfig(mainRoot)) return { retried: 0, resolved: 0, pending: 0 };
  if (!listPendingFlakeFlows(home, mainRoot, options?.excludeFlow).length) {
    return { retried: 0, resolved: 0, pending: 0 };
  }
  return withAbstractLock('land-flakes-retry', `${home}\0${sharedRoot(mainRoot)}`, async () => {
    const flows = listPendingFlakeFlows(home, mainRoot, options?.excludeFlow);
    let retried = 0;
    let resolved = 0;
    let pending = 0;
    for (const flow of flows) {
      retried++;
      const res = await collectAndRecordLandFlakes(home, mainRoot, flow, {
        pane: pane ?? flow.pane,
        dispatch: options?.dispatch,
      });
      if (res.pending) pending++;
      else resolved++;
    }
    return { retried, resolved, pending };
  });
}

const CLEAN_SETTLED_STATES = new Set(['idle_grace', 'done', 'closed']);
const MAX_FLAKE_REPORT_BYTES = 1024 * 1024;

function declaredFlakeReport(dir: string, job: Job, status: Partial<JobStatus>): string | null {
  if (status.output_written !== true) return null;
  const sig = cachedReportSignature(dir);
  if (!sig) return null;
  if (job.cli) {
    const turn = readTurn(dir), done = readDone(dir);
    if (!turn) return sig;
    return receiptForTurn(turn, done) && done.report_sig === sig &&
      Date.parse(status.settled_at ?? '') >= Date.parse(turn.sent_at) ? sig : null;
  }
  if (job.resume_s !== undefined) {
    return piReportSettlement(dir, job, status as Pick<JobStatus, 'output_written' | 'settled_at'>) ? sig : null;
  }
  return sig;
}

export function shouldEvaluateAutoLandFlakeJob(
  job: Job | null | undefined,
  status: Partial<JobStatus> | null | undefined,
  priorLand: LandFlow | null | undefined,
  dir: string,
): boolean {
  if (!job || !status || priorLand || !isAutoLandFlakeJob(job)) return false;
  if (!job.worktree || job.worktree.root !== job.cwd) return false;
  if (!CLEAN_SETTLED_STATES.has(status.state ?? '')) return false;
  const blocked = job.auto_land_blocked;
  if (blocked) {
    const sig = status.output_written === true ? cachedReportSignature(dir) : null;
    if (!sig && !blocked.sig) return false;
    if (sig && blocked.sig === sig) return false;
  }
  return true;
}

export type FlakeAutoLandResult =
  | { action: 'noop' }
  | { action: 'wait' }
  | { action: 'landed'; flow: string }
  | { action: 'blocked'; reason: string; sig?: string };

export async function settleAutoLandFlakeJob(
  home: string,
  id: string,
  options?: {
    writeJob?: (jobFile: string, value: Job) => void;
    startLandFn?: typeof startLand;
  },
): Promise<FlakeAutoLandResult> {
  const dir = join(home, 'jobs', id);
  const jobFile = join(dir, jobFiles.job);
  const statusFile = join(dir, jobFiles.status);
  return withAbstractLock('flake-auto-land', `${home}\0${id}`, async () => {
    let job: Job;
    let status: Partial<JobStatus>;
    try {
      // A clean STATUS is published after Pi persists any final question timeouts.
      status = readJsonFile(statusFile) as Partial<JobStatus>;
      job = readJsonFile(jobFile) as Job;
    } catch {
      return { action: 'noop' as const };
    }
    if (!job || job.job !== id || !isAutoLandFlakeJob(job)) return { action: 'noop' as const };
    if (!job.worktree || job.worktree.root !== job.cwd) return { action: 'noop' as const };
    if (!CLEAN_SETTLED_STATES.has(status.state ?? '')) return { action: 'noop' as const };
    if (landAttempt(home, id).prior) return { action: 'noop' as const };

    const persistBlock = async (reason: string, sig?: string): Promise<FlakeAutoLandResult> => {
      const cleanReason = oneLine(reason).slice(0, 240) || 'auto-land blocked';
      await withFlakeBlockIndexLock(home, () => {
        let latest: Job;
        try { latest = readJsonFile(jobFile) as Job; }
        catch { return; } // The job disappeared before the block could be persisted.
        if (!latest || latest.job !== id || !isAutoLandFlakeJob(latest)) return;
        const sameSig = (latest.auto_land_blocked?.sig ?? undefined) === sig;
        if (latest.auto_land_blocked && sameSig && latest.auto_land_blocked.reason === cleanReason) return;
        const updated: Job = {
          ...latest,
          auto_land_blocked: { ...(sig ? { sig } : {}), reason: cleanReason, at: new Date().toISOString() },
        };
        // The job receipt is authoritative. Index first so an interrupted write
        // can't leave a persisted refusal undiscoverable by a task client.
        indexFlakeBlockJob(home, id);
        if (options?.writeJob) options.writeJob(jobFile, updated);
        else writeJsonPrivate(jobFile, updated, { mkdir: false });
      });
      return { action: 'blocked', reason: cleanReason, ...(sig ? { sig } : {}) };
    };

    let openIds: readonly string[];
    try {
      ({ openIds } = getJobIndexCache(home).readQa(dir));
    } catch {
      // Bind the handback to the same signature the watcher uses for retry admission.
      const sig = status.output_written === true ? cachedReportSignature(dir) ?? undefined : undefined;
      if (job.auto_land_blocked && job.auto_land_blocked.sig === sig) return { action: 'noop' as const };
      return persistBlock('questions could not be read', sig);
    }
    if (filterTimedOutQuestions(openIds, job.timed_out_questions).length) return { action: 'wait' as const };
    const sonic = sonicChildren(dir);
    if (sonic.open || sonic.uncollected.length) return { action: 'wait' as const };

    const sig = declaredFlakeReport(dir, job, status);
    if (!sig) {
      if (job.auto_land_blocked && !job.auto_land_blocked.sig) return { action: 'noop' as const };
      return persistBlock('settled without a declared report');
    }
    if (job.auto_land_blocked?.sig === sig) return { action: 'noop' as const };

    let reportText: string;
    try {
      const report = readFileBounded(join(dir, jobFiles.report), MAX_FLAKE_REPORT_BYTES);
      if (report.truncated) return persistBlock('report is too large to verify', sig);
      reportText = report.bytes.toString('utf8');
    } catch {
      return persistBlock('report could not be read', sig);
    }

    if (readReportMeta(dir, sig)?.skip_checks_reason) {
      return persistBlock('worker checks were skipped', sig);
    }
    if (job.checks?.length) {
      const binding = checkBinding(dir, job, status);
      if (!binding) return persistBlock('HUD check binding unavailable', sig);
      const receipt = readCheckReceipt(dir);
      const current = receipt && sameChecks(binding, receipt);
      if (current && receipt.results.some(r => r.exit_code !== 0)) {
        return persistBlock('HUD checks failed', sig);
      }
      if (!current || receipt.state !== 'done') return { action: 'wait' as const };
      if (receipt.results.length !== job.checks.length) {
        return persistBlock('HUD check results incomplete', sig);
      }
    }

    const { blockers } = extractReportNotes(reportText);
    if (blockers.length) {
      return persistBlock(`Blockers: ${blockers[0]}`, sig);
    }
    const { scopeAssumptions } = extractAssumedLines(reportText);
    if (scopeAssumptions.length) {
      return persistBlock(`scope assumption in report: ${scopeAssumptions[0]}`, sig);
    }

    const wt = job.worktree;
    let config;
    try {
      config = validLandConfig(home, wt.main_root);
    } catch (err) {
      return persistBlock(err instanceof Error ? err.message : String(err), sig);
    }

    try {
      const head = (await worktreeGit(wt.root, ['rev-parse', '--verify', 'HEAD'])).trim();
      const countText = (await worktreeGit(wt.main_root, ['rev-list', '--count', `refs/heads/${config.base}..${head}`, '--'])).trim();
      const count = Number(countText);
      if (!Number.isSafeInteger(count) || count < 1) {
        return persistBlock('settled without a commit to land', sig);
      }
    } catch (err) {
      return persistBlock(`cannot verify worker commit: ${err instanceof Error ? err.message : String(err)}`, sig);
    }

    try {
      const start = options?.startLandFn ?? startLand;
      const pane = jobCallerPane(job) ?? null;
      const flow = await start(home, id, job, status.state ?? null, pane, false, undefined, undefined, undefined, false, true);
      return { action: 'landed', flow: flow.flow };
    } catch (err) {
      return persistBlock(`cannot start land: ${err instanceof Error ? err.message : String(err)}`, sig);
    }
  });
}
