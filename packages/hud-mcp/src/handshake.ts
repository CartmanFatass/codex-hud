import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../../src/core/canonical.js';
import { makeProcessKey, makeSourceId, sameSessionRef } from '../../../src/core/identity.js';
import { sameProcessStamp } from '../../../src/core/supervision.js';
import type { Evidence } from '../../../src/core/types/execution.js';
import type { Ledger } from '../../../src/ledger/ledger.js';
import {
  commitChildReport,
  commitHandshake,
  readHandshakeSnapshot,
  type ChildAuthority,
  type ChildWriteBudget,
  type ChildReportInput,
  type HandshakeResult,
  type HandshakeSnapshot,
} from '../../../src/ledger/handshake.js';
import { actualSourceRoot, inferHarness, type ProcessReaderPort } from './process.js';
import type { Registration } from './registry.js';

export interface HandshakeServiceOptions {
  ledger: Ledger;
  registration: Registration;
  reader: ProcessReaderPort;
  /** Verified private HUD_HOME supplied by the server, never model arguments. */
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}
export class HandshakeService {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  constructor(private readonly options: HandshakeServiceOptions) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }
  /** SessionRef comes only from this call's independent resolver, never from the claim or arguments. */
  private proveLaunch(snapshot: HandshakeSnapshot, authority: ChildAuthority): Evidence | null {
    const { run, meta, context } = snapshot;
    const { registration, reader } = this.options;
    if (
      registration.caller.callerId !== context.callerId ||
      !registration.source ||
      !authority.evidence.sessionRef ||
      !context.sessionRef ||
      !sameSessionRef(context.sessionRef, authority.evidence.sessionRef)
    )
      throw new Error('identity_unverified');
    if (!meta?.harness) return null;
    if (
      meta.run_id !== run.runId ||
      meta.link_id !== run.linkId ||
      meta.source_id !== run.sourceId ||
      meta.binding_generation !== run.expectedGeneration ||
      meta.launch_digest !== run.launchDigest ||
      meta.launch_call_id !== run.launchCallId ||
      meta.launch_correlation_id !== run.launchCorrelationId ||
      !sameProcessStamp(meta.supervisor, run.supervisor)
    )
      throw new Error('claim_anchor_mismatch');
    const stamp = meta.harness;
    const domain = reader.domain();
    // Consult 5 G08: a Run stamp compares only with the Run form. A missing form is
    // unavailable, never the caller JSON domain and never a persisted ProcessKey.
    if (domain.runPidDomain === null) throw new Error('run_domain_unavailable');
    const self = reader.get(registration.caller.pid);
    const harness = reader.get(stamp.pid);
    const root = actualSourceRoot(harness, run.harness);
    if (
      stamp.boot_id !== domain.bootId ||
      stamp.pid_domain !== domain.runPidDomain ||
      stamp.pid !== registration.harnessPid ||
      stamp.proc_start !== registration.harnessProcStart ||
      harness.procStart !== stamp.proc_start ||
      inferHarness(harness) !== run.harness ||
      !root ||
      root !== registration.source.rootPath ||
      makeSourceId(run.harness, root) !== run.sourceId ||
      registration.source.sourceId !== run.sourceId ||
      self.procStart !== registration.caller.procStart ||
      self.ppid !== registration.caller.ppid ||
      self.pidNamespace !== harness.pidNamespace ||
      context.kind !== 'dedicated' ||
      context.processKey !== makeProcessKey(run.harness, run.sourceId, domain.pidDomain, stamp.pid, stamp.proc_start)
    )
      throw new Error('claim_anchor_mismatch');
    let cursor = self;
    let reached = false;
    const chain: { pid: number; procStart: string; ppid: number }[] = [];
    for (let depth = 0; depth < 16; depth++) {
      chain.push({ pid: cursor.pid, procStart: cursor.procStart, ppid: cursor.ppid });
      if (cursor.pid === stamp.pid) {
        reached = cursor.procStart === stamp.proc_start;
        break;
      }
      if (cursor.ppid <= 1 || cursor.ppid === cursor.pid) break;
      cursor = reader.get(cursor.ppid);
      if (cursor.pidNamespace !== harness.pidNamespace) throw new Error('claim_anchor_mismatch');
    }
    if (!reached || chain[1]?.procStart !== registration.caller.parentProcStart)
      throw new Error('claim_anchor_mismatch');
    // Recheck each observed edge and start after source/ancestry collection to reject PID reuse or reparenting.
    for (const edge of chain) {
      const current = reader.get(edge.pid);
      if (current.procStart !== edge.procStart || current.ppid !== edge.ppid) throw new Error('claim_anchor_mismatch');
    }
    const at = this.now();
    const payload = {
      sourceId: run.sourceId,
      bindingGeneration: run.expectedGeneration,
      supervisor: run.supervisor,
      harness: stamp,
      processKey: context.processKey,
      sessionRef: context.sessionRef,
      contextId: context.contextId,
      generation: context.generation,
      selectionEvidenceId: context.selectionEvidenceId,
      bindingEvidenceId: context.bindingEvidenceId,
    };
    return {
      evidenceId: randomUUID(),
      runId: run.runId,
      linkId: run.linkId,
      kind: 'launch_receipt',
      producer: 'reconciler',
      fingerprint: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
      payload: JSON.parse(canonicalJson(payload)),
      observedAt: at,
      validatedAt: at,
      validation: 'accepted',
    };
  }
  async whoami(
    args: { claim?: string },
    authority: ChildAuthority,
    budget?: ChildWriteBudget
  ): Promise<HandshakeResult> {
    const claim = this.env.HUD_CLAIM || args.claim;
    if (!claim) throw new Error('claim_missing');
    if (this.env.HUD_CLAIM && args.claim && this.env.HUD_CLAIM !== args.claim) throw new Error('claim_conflict');
    const claimHash = createHash('sha256').update(claim).digest('hex');
    const snapshot = await readHandshakeSnapshot(this.options.ledger, claimHash, authority);
    if (
      (this.env.HUD_RUN && this.env.HUD_RUN !== snapshot.run.runId) ||
      (this.env.HUD_LINK && this.env.HUD_LINK !== snapshot.link.linkId)
    )
      throw new Error('claim_anchor_mismatch');
    const proof = this.proveLaunch(snapshot, authority);
    if (!proof)
      return {
        ok: true,
        state: 'pending',
        linkId: snapshot.link.linkId,
        runId: snapshot.run.runId,
        reason: 'independent_evidence_missing',
      };
    return commitHandshake(this.options.ledger, snapshot, authority, claimHash, proof, proof.validatedAt!, budget);
  }
  async report(args: ChildReportInput, authority: ChildAuthority, budget?: ChildWriteBudget) {
    if (this.env.HUD_RUN && this.env.HUD_RUN !== args.runId) throw new Error('stale_binding');
    return commitChildReport(this.options.ledger, args, authority, this.now(), budget, this.options.home);
  }
}
