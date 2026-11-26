import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { targetKey } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, ticketJobState } from '../collectors/ticket-rollup.js';
import { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { localProjectRoots } from '../roles/projects.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { activeLand, landAttempt } from './land-state.js';

export function readFlakesConfig(mainRoot: string): { feature: string } | null {
  try {
    const raw = readJsonBounded(join(mainRoot, '.hud', 'project.json'), 256 * 1024) as { flakes?: { feature?: unknown } } | null;
    const feature = raw?.flakes?.feature;
    return typeof feature === 'string' && /^[a-z0-9-]+$/.test(feature) ? { feature } : null;
  } catch {
    return null;
  }
}

export function isRunningListTicket(text: string): boolean {
  const body = text.split(/^## Comments[ \t]*\r?$/m, 1)[0];
  return /\brunning list\b/i.test(body) || /^(?:###[ \t]+Cases|\*\*Kind:\*\*[ \t]*flake-list)[ \t]*\r?$/m.test(body);
}

const localMainRoot = (cwd: string) => localProjectRoots(cwd).mainRoot;
function flakeProjectId(mainRoot: string): string {
  return createHash('sha256').update(localMainRoot(mainRoot)).digest('hex').slice(0, 16);
}

export function flakeDispatchKey(mainRoot: string, ticket: string, attempt: number): string {
  return `flakes:${flakeProjectId(mainRoot)}:${ticket}:${attempt}`;
}

/** Shared admission snapshot for running-list tickets of the configured flake feature. */
export function runningListAdmission(home: string, mainRoot: string, feature: string, cache = new JobIndexCache(home), checkActive = true) {
  const matchesProject = projectJobFilter(mainRoot, localMainRoot);
  const prefix = `${feature}/`;
  const keyPrefix = `flakes:${flakeProjectId(mainRoot)}:`;
  const claimedTickets = new Set<string>();
  const failedCounts = new Map<string, number>();
  const maxKeyAttempts = new Map<string, number>();
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
    if (state === 'failed' || state === 'stopped') {
      failedCounts.set(key, (failedCounts.get(key) ?? 0) + 1);
      if (keyAttempt > (maxKeyAttempts.get(key) ?? 0)) maxKeyAttempts.set(key, keyAttempt);
    } else {
      claimedTickets.add(key);
    }
    if (checkActive && !activeJobId) {
      if (!job.reaped_at && (!SETTLED_JOB_STATES.has(state) || state === 'idle_grace')) {
        activeJobId = id;
      } else {
        const prior = landAttempt(home, id).prior;
        if (prior && activeLand(prior)) activeJobId = id;
      }
    }
  }
  return {
    claimedTickets,
    activeJobId,
    eligible: (ticket: string) => !activeJobId && !claimedTickets.has(targetKey(ticket)),
    nextAttempt: (ticket: string) => {
      const key = targetKey(ticket);
      return Math.max(failedCounts.get(key) ?? 0, maxKeyAttempts.get(key) ?? 0) + 1;
    },
  };
}
