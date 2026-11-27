import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { targetKey } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, ticketJobState } from '../collectors/ticket-rollup.js';
import { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { localProjectRoots } from '../roles/projects.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { activeLand, landAttempt, readLand, type LandFlow } from './land-state.js';

const LAND_REPAIR_KEY = /^land:(f([a-f0-9]{16})(?:-[1-9]\d*)?):[1-9]\d*$/;

function landRepairOwner(home: string, job: Job): { ownerId: string; flow: LandFlow } | null {
  if (typeof job.request_key !== 'string') return null;
  const match = LAND_REPAIR_KEY.exec(job.request_key);
  if (!match) return null;
  const flowId = match[1];
  const ownerId = `j${match[2]}`;
  if (ownerId === job.job) return null;
  const flow = readLand(home, flowId);
  if (!flow || flow.job !== ownerId) return null;
  if (job.land_turn !== job.request_key && !flow.repairs?.some(r => r.job === job.job)) return null;
  return { ownerId, flow };
}

export function readFlakesConfig(mainRoot: string): { feature: string } | null {
  try {
    const raw = readJsonBounded(join(mainRoot, '.hud', 'project.json'), 256 * 1024) as { flakes?: { feature?: unknown } } | null;
    const feature = raw?.flakes?.feature;
    return typeof feature === 'string' && /^[a-z0-9-]+$/.test(feature) ? { feature } : null;
  } catch {
    return null;
  }
}

export { isRunningListTicket } from '../tickets/flake-cases.js';

const localMainRoot = (cwd: string) => localProjectRoots(cwd).mainRoot;
function flakeProjectId(mainRoot: string): string {
  return createHash('sha256').update(localMainRoot(mainRoot)).digest('hex').slice(0, 16);
}

export function flakeDispatchKey(mainRoot: string, ticket: string, attempt: number): string {
  return `flakes:${flakeProjectId(mainRoot)}:${ticket}:${attempt}`;
}

export function isAutoLandFlakeJob(
  job: Partial<Pick<Job, 'auto_land' | 'ticket_queue' | 'workflow' | 'batch_flow' | 'land_turn'>> | null | undefined,
): boolean {
  return job?.auto_land === true && !job.ticket_queue && !job.workflow && !job.batch_flow && !job.land_turn;
}

/** Shared admission snapshot for running-list tickets of the configured flake feature. */
export function runningListAdmission(home: string, mainRoot: string, feature: string, cache = new JobIndexCache(home), checkActive = true) {
  const matchesProject = projectJobFilter(mainRoot, localMainRoot);
  const prefix = `${feature}/`;
  const keyPrefix = `flakes:${flakeProjectId(mainRoot)}:`;
  const claimedTickets = new Set<string>();
  const priorAttempts = new Map<string, number>();
  const maxKeyAttempts = new Map<string, number>();
  const landByOwner = new Map<string, LandFlow | null>();
  const priorLandFor = (ownerId: string): LandFlow | null => {
    if (!landByOwner.has(ownerId)) landByOwner.set(ownerId, landAttempt(home, ownerId).prior);
    return landByOwner.get(ownerId) ?? null;
  };
  let activeJobId: string | undefined;
  for (const id of cache.listJobIds()) {
    const receipt = cache.readJob<Job>(id);
    if (receipt.status !== 'ok' || !matchesProject(receipt.value)) continue;
    const job = receipt.value;
    const ticket = job.ticket && targetKey(job.ticket);
    let key = ticket && ticket.startsWith(prefix) ? ticket : undefined;
    let keyAttempt = 0;
    if (typeof job.request_key === 'string' && job.request_key.startsWith(keyPrefix)) {
      const m = /^(.+):(\d+)$/.exec(job.request_key.slice(keyPrefix.length));
      if (m) {
        const rkTicket = targetKey(m[1]);
        if (rkTicket.startsWith(prefix)) {
          key ??= rkTicket;
          keyAttempt = Number(m[2]);
        }
      }
    }
    if (!key) continue;
    const status = cache.readStatus(id);
    const state = ticketJobState(job, status.status === 'ok' ? status.value : {});
    const repairOwner = landRepairOwner(home, job);
    const prior = repairOwner ? (priorLandFor(repairOwner.ownerId) ?? repairOwner.flow) : priorLandFor(id);
    const landRunning = Boolean(prior && activeLand(prior));
    const partialLand = prior?.state === 'completed' && Boolean(prior.landed_sha && prior.unfinished_acceptance?.length);
    if (!landRunning && (state === 'failed' || state === 'stopped' || (partialLand && SETTLED_JOB_STATES.has(state)))) {
      if (!repairOwner) {
        priorAttempts.set(key, (priorAttempts.get(key) ?? 0) + 1);
        if (keyAttempt > (maxKeyAttempts.get(key) ?? 0)) maxKeyAttempts.set(key, keyAttempt);
      }
    } else {
      claimedTickets.add(key);
    }
    if (checkActive && !activeJobId) {
      if (landRunning) {
        activeJobId = id;
      } else if (prior?.state === 'completed' && SETTLED_JOB_STATES.has(state)) {
        // Already landed; do not block the next flake list while the worker remains in idle_grace.
      } else if (!job.reaped_at && (!SETTLED_JOB_STATES.has(state) || state === 'idle_grace')) {
        activeJobId = id;
      }
    }
  }
  return {
    claimedTickets,
    activeJobId,
    eligible: (ticket: string) => !activeJobId && !claimedTickets.has(targetKey(ticket)),
    nextAttempt: (ticket: string) => {
      const key = targetKey(ticket);
      return Math.max(priorAttempts.get(key) ?? 0, maxKeyAttempts.get(key) ?? 0) + 1;
    },
  };
}
