/** Simulation-only: never imported by production, and no IO, browser, ledger, credentials or network. */
import type { JobRef } from '../../src/core/types/observation.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { projectLinkTree } from '../../src/core/link/index.js';
import { leaseReleasePolicy } from '../../src/core/supervision.js';

type State = 'queued' | 'sent' | 'uncertain' | 'needs_human' | 'answered' | 'failed';
type Terminal = 'answered' | 'failed';
interface Job {
  ref: JobRef;
  owner: string;
  browser: string;
  requestFingerprint: string;
  requestId: string;
  state: State;
  dispatches: number;
  generation: number | null;
  reconciled: boolean;
  answer?: string;
}
interface Lease {
  key: string;
  generation: number;
  owner: string;
}
const valid = (s: unknown): s is string => typeof s === 'string' && /^synthetic-[a-z0-9-]{1,80}$/.test(s);
const identity = (ref: JobRef) => displayNodeKey({ kind: 'job', ref });
function validateRef(ref: JobRef): void {
  if (
    !ref ||
    ref.kind !== 'jev' ||
    !valid(ref.provider) ||
    !valid(ref.key) ||
    (ref.account !== undefined && !valid(ref.account))
  )
    throw new Error('fake_invalid_ref');
}
/** A bounded, single-process deterministic lab; no durable or cross-process lock guarantee. */
export class FakeJevBrowser {
  private readonly jobs = new Map<string, Job>();
  private readonly requestKeys = new Map<string, string>();
  private readonly held = new Map<string, Lease>();
  private readonly generations = new Map<string, number>();
  enqueue(input: { ref: JobRef; owner: string; browser: string; requestId: string; requestFingerprint: string }): {
    replay: boolean;
    state: State;
  } {
    validateRef(input.ref);
    if (!valid(input.owner) || !valid(input.browser) || !valid(input.requestId) || !valid(input.requestFingerprint))
      throw new Error('fake_invalid_input');
    const key = identity(input.ref),
      requestKey = JSON.stringify([input.owner, input.requestId]),
      old = this.jobs.get(key);
    const previousTarget = this.requestKeys.get(requestKey);
    if (previousTarget !== undefined && previousTarget !== key) throw new Error('fake_request_conflict');
    if (old) {
      if (
        old.owner !== input.owner ||
        old.browser !== input.browser ||
        old.requestId !== input.requestId ||
        old.requestFingerprint !== input.requestFingerprint
      )
        throw new Error('fake_request_conflict');
      return { replay: true, state: old.state };
    }
    if (this.jobs.size >= 128) throw new Error('fake_job_limit');
    this.requestKeys.set(requestKey, key);
    this.jobs.set(key, {
      ...input,
      ref: structuredClone(input.ref),
      state: 'queued',
      dispatches: 0,
      generation: null,
      reconciled: false,
    });
    return { replay: false, state: 'queued' };
  }
  dispatch(owner: string, ref: JobRef, acknowledgement: 'received' | 'lost'): { generation: number; state: State } {
    const job = this.lookup(owner, ref);
    if (acknowledgement !== 'received' && acknowledgement !== 'lost') throw new Error('fake_invalid_input');
    if (job.dispatches !== 0) throw new Error('fake_no_retry');
    if (this.held.has(job.browser)) throw new Error('fake_browser_busy');
    const generation = (this.generations.get(job.browser) ?? 0) + 1;
    this.generations.set(job.browser, generation);
    this.held.set(job.browser, { key: identity(job.ref), generation, owner: job.owner });
    job.generation = generation;
    job.dispatches = 1; // consume before the modeled send
    job.state = acknowledgement === 'lost' ? 'uncertain' : 'sent';
    return { generation, state: job.state };
  }
  simulateTimeout(owner: string, ref: JobRef, generation: number): void {
    this.observe(owner, ref, generation, 'uncertain');
  }
  simulateRunnerLoss(owner: string, ref: JobRef, generation: number): void {
    this.observe(owner, ref, generation, 'uncertain');
  }
  /** Synthetic timeout, runner loss and needs-human cannot release or take over. */
  observe(owner: string, ref: JobRef, generation: number, state: 'needs_human' | 'uncertain' | Terminal): void {
    const job = this.active(owner, ref, generation);
    if (!['needs_human', 'uncertain', 'answered', 'failed'].includes(state)) throw new Error('fake_invalid_input');
    if ((job.state === 'answered' || job.state === 'failed') && job.state !== state)
      throw new Error('fake_terminal_conflict');
    job.state = state;
  }
  reconcile(owner: string, ref: JobRef, generation: number, outcome: Terminal, answer?: string): void {
    const job = this.lookup(owner, ref);
    if (outcome !== 'answered' && outcome !== 'failed') throw new Error('fake_invalid_input');
    if (job.reconciled) {
      if (job.generation !== generation || job.state !== outcome || job.answer !== answer)
        throw new Error('fake_terminal_conflict');
      return;
    }
    this.active(owner, ref, generation);
    if (job.state !== outcome) throw new Error('fake_outcome_mismatch');
    if (answer !== undefined && (outcome !== 'answered' || !valid(answer))) throw new Error('fake_invalid_answer');
    if (leaseReleasePolicy({ kind: 'browser', outcome, reconciled: true }) !== 'release')
      throw new Error('fake_release_refused');
    job.reconciled = true;
    if (answer !== undefined) job.answer = answer;
    this.held.delete(job.browser);
  }
  view(owner: string, ref: JobRef) {
    const job = this.lookup(owner, ref);
    const lock = this.held.get(job.browser);
    const nodeIdentity = { kind: 'job' as const, ref: structuredClone(job.ref) };
    const tree = projectLinkTree({
      ledger: { state: 'degraded', snapshot: null, reason: 'synthetic_fake_only' },
      roots: [nodeIdentity],
      sessions: [],
      nowMs: 0,
    });
    return {
      provenance: 'SIMULATED' as const,
      identity: nodeIdentity,
      hudNode: tree.nodes[0],
      counts: { jobs: tree.counts.jobs, sessions: tree.counts.confirmedSessions },
      fakeState: job.state,
      dispatches: job.dispatches,
      reconciled: job.reconciled,
      browserHeld: Boolean(lock),
      ...(lock ? { holderLabel: lock.owner, holderGeneration: lock.generation } : {}),
      ...(job.reconciled && job.answer ? { syntheticAnswer: job.answer } : {}),
    };
  }
  private lookup(owner: string, ref: JobRef): Job {
    validateRef(ref);
    if (!valid(owner)) throw new Error('fake_invalid_input');
    const job = this.jobs.get(identity(ref));
    if (!job || job.owner !== owner) throw new Error('fake_job_not_owned');
    return job;
  }
  private active(owner: string, ref: JobRef, generation: number): Job {
    const job = this.lookup(owner, ref),
      lease = this.held.get(job.browser);
    if (
      !Number.isSafeInteger(generation) ||
      !lease ||
      lease.generation !== generation ||
      lease.key !== identity(ref) ||
      lease.owner !== owner ||
      job.generation !== generation
    )
      throw new Error('fake_stale_or_foreign_lease');
    return job;
  }
}
