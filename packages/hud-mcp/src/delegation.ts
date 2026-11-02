import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DelegateConfig } from './config.js';
import type { Registration } from './registry.js';
import type { ProcessReaderPort } from './process.js';
import type { CallResolution } from './resolvers.js';
import { HandshakeService } from './handshake.js';
import { authorizeRootCall, scopeSnapshot } from '../../../src/ledger/call-context.js';
import { acceptIntent, currentAuthority } from '../../../src/ledger/intents.js';
import type { Ledger } from '../../../src/ledger/ledger.js';
import { readContext, readLink, readRun } from '../../../src/ledger/records.js';
import type { IntentAuthority } from '../../../src/ledger/types.js';
import type { Link } from '../../../src/core/types/lifecycle.js';
import type { Claim } from '../../../src/core/types/identity.js';
import type { Run } from '../../../src/core/types/execution.js';
import { taskDigest } from '../../../src/core/lifecycle.js';
import { prepareCodexLaunch, launchPreparedRun, type CapabilityVerifier } from '../../../src/core/launch/index.js';
import { readProcess } from '../../../src/core/run/process.js';
import { PrivateLedgerGate } from '../../../src/ledger/local-manager.js';
import { LedgerBusyError } from '../../../src/ledger/transaction.js';
import { digest } from '../../../src/core/canonical.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type McpAuthority = Extract<IntentAuthority, { kind: 'mcp' }>;
export interface DelegationOptions {
  ledger: Ledger;
  home: string;
  config: DelegateConfig;
  registration?: Registration;
  reader?: ProcessReaderPort;
  capability: CapabilityVerifier;
  hudRunPath: string;
  env?: NodeJS.ProcessEnv;
  codexConfig?: import('../../../src/core/types/capabilities.js').CodexConfig;
  executableIdentity?: import('../../../src/core/launch/fingerprint.js').ExecutableIdentity;
  /** Trusted dependency for owned-process tests. Never selected by tool/config input. */
  launch?: typeof launchPreparedRun;
}

/** Composition for production tools; every call receives a freshly verified source. */
export class DelegationService {
  constructor(private readonly options: DelegationOptions) {}
  async invoke(
    source: Extract<CallResolution, { ok: true }>,
    tool: string,
    args: Record<string, unknown>,
    started = performance.now()
  ): Promise<unknown> {
    if (!source.scopePremise) throw new Error('identity_unverified');
    if (!this.options.registration || !this.options.reader) throw new Error('local_entry_only');
    const handshake = new HandshakeService({
      ledger: this.options.ledger,
      registration: this.options.registration,
      reader: this.options.reader,
      env: this.options.env ?? process.env,
    });
    const deadline = started + 30;
    if (performance.now() >= deadline) throw new LedgerBusyError();
    const authority = await authorizeRootCall(
      this.options.ledger,
      {
        callerId: this.options.registration.caller.callerId,
        processKey: source.processKey,
        sessionRef: source.sessionRef,
        evidenceDigest: source.evidenceDigest,
        premise: source.scopePremise,
        at: Date.now(),
      },
      Math.min(20, Math.max(0, deadline - performance.now()))
    );
    const budget = { deadline, lockBudgetMs: Math.max(0, 20 - (performance.now() - started)) };
    if (tool === 'delegate_whoami') return handshake.whoami(args as { claim?: string }, authority, budget);
    if (tool === 'delegate_report')
      return handshake.report(args as unknown as Parameters<HandshakeService['report']>[0], authority, budget);
    if (tool === 'delegate_spawn' || tool === 'delegate_resume')
      return this.accept(
        tool === 'delegate_spawn' ? 'spawn' : 'resume',
        { ...args, __callId: source.callId },
        authority,
        deadline
      );
    return { ok: false, code: 'not_implemented', tool };
  }
  private async accept(
    operation: 'spawn' | 'resume',
    args: Record<string, unknown>,
    authority: IntentAuthority,
    deadline: number,
    gate?: PrivateLedgerGate
  ): Promise<unknown> {
    const { ledger, config, home } = this.options;
    if (args.layout !== undefined) throw new Error('visible_layout_not_in_this_build');
    const handover = operation === 'spawn' && typeof args.predecessor === 'string';
    const previous = await ledger.readSnapshot((tx) => {
      const allowed = currentAuthority(tx, authority);
      if (allowed.kind === 'mcp' && !allowed.selection.ok) throw new Error(allowed.selection.reason);
      if (operation === 'spawn' && !handover) return null;
      const link = readLink(tx, String(handover ? args.predecessor : args.linkId));
      const row = tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', link.linkId);
      if (!row) throw new Error('run_not_found');
      return { link, run: readRun(tx, String(row.run_id)) };
    });
    const backend = handover ? String(args.backend) : (previous?.link.backend ?? String(args.backend));
    const profile = config.profiles.find((p) => p.name === backend);
    if (!profile) throw new Error('backend_not_found');
    const preparation = await prepareCodexLaunch({
      profile,
      operation: handover ? 'resume' : operation,
      mode: args.mode as 'headless' | 'visible',
      cwd: handover ? String(args.cwd) : (previous?.run.launchCwd ?? String(args.cwd)),
      briefPath: handover ? String(args.brief) : (previous?.link.briefPath ?? String(args.brief)),
      role: handover ? String(args.role) : (previous?.link.role ?? String(args.role)),
      model: typeof args.model === 'string' ? args.model : undefined,
      effort: typeof args.effort === 'string' ? args.effort : undefined,
      prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
      resumeSessionId: previous?.link.childRef?.sessionId,
      env: this.options.env,
      codexConfig: this.options.codexConfig,
      executableIdentity: this.options.executableIdentity,
    });
    const at = Date.now(),
      runId = randomUUID(),
      linkId = handover ? randomUUID() : (previous?.link.linkId ?? randomUUID()),
      claimText = randomBytes(32).toString('hex'),
      ticket = randomBytes(32).toString('hex');
    let parent: import('../../../src/core/run/control.js').StartOptions['parent'];
    if (authority.kind === 'mcp') {
      const caller = this.options.registration?.caller;
      // Synthetic process fixtures inject their launch function and never execute
      // orphan supervision. Production always carries a fresh full MCP stamp.
      const actual = caller ? readProcess(caller.pid)?.stamp : null;
      if (!this.options.launch && (!actual || actual.proc_start !== caller?.procStart))
        throw new Error('identity_unverified');
      if (actual && actual.proc_start === caller?.procStart)
        parent = { process: actual, contextId: authority.contextId, generation: authority.generation };
    }
    const launch = preparation.forRun({ runId, linkId, claim: claimText, hudHome: home, parent });
    const capability = this.options.capability.verify(preparation.capabilityRequest(previous?.run.mode));
    const context =
      authority.kind === 'mcp'
        ? await ledger.readSnapshot((tx) => readContext(tx, authority.contextId, authority.generation))
        : null;
    const link: Link = (!handover ? previous?.link : null) ?? {
      linkId,
      state: handover ? 'bound' : 'pending',
      parentCaller: context!.callerId,
      parentContextId: context!.contextId,
      parentContextGeneration: context!.generation,
      parentRef: context!.sessionRef,
      childRef: handover ? previous!.link.childRef : null,
      currentOwner: handover,
      backend,
      role: String(args.role),
      label: typeof args.name === 'string' ? args.name : null,
      briefPath: preparation.brief.path,
      taskDigest: taskDigest(
        preparation.brief.path,
        preparation.brief.sha256,
        backend,
        preparation.sourceId,
        String(args.role)
      ),
      reportPath: null,
      predecessor: handover ? previous!.link.linkId : null,
      routing: null,
      createdAt: at,
      claimedAt: null,
      boundAt: handover ? at : null,
      closedAt: null,
    };
    const run: Run = {
      runId,
      linkId,
      runSeq: handover ? 1 : (previous?.run.runSeq ?? 0) + 1,
      operation: handover ? 'handover' : operation,
      targetSessionRef: previous?.link.childRef ?? null,
      sourceId: preparation.sourceId,
      harness: 'codex',
      expectedGeneration: (previous?.run.expectedGeneration ?? 0) + 1,
      mode: args.mode as 'headless' | 'visible',
      launchCwd: preparation.cwd,
      workspaceSnapshot: null,
      projectOrigin: null,
      supervisionStrategy: 'headless',
      scopeKind: 'pgid',
      scopeRef: null,
      state: 'starting',
      locator: null,
      launchTokenHash: hash(ticket),
      launchDigest: launch.launchDigest,
      launchPhase: 'reserved',
      launchCallId: authority.kind === 'local_user' ? `local:${authority.invocationId}` : String(args.__callId),
      launchCorrelationId: randomUUID(),
      launchMessageId: null,
      supervisor: null,
      heartbeatAt: null,
      heartbeatSeq: 0,
      heartbeatMonoMs: null,
      cancelRequestedAt: null,
      submissionFencedAt: null,
      createdAt: at,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      exitSource: null,
      shellStatus: null,
      shellSignal: null,
      terminalEvidenceId: null,
      orphanPolicy: profile.orphan_policy,
    };
    const claim: Claim = {
      runId,
      claimHash: hash(claimText),
      sourceId: run.sourceId,
      expectedGeneration: run.expectedGeneration,
      supervisor: null,
      state: 'issued',
      issuedAt: at,
      expiresAt: at + 1800000,
      redeemedContextId: null,
      redeemedGeneration: null,
      redeemedSessionRef: null,
      redeemedAt: null,
    };
    const params = {
      backend,
      profile: profile.name,
      sourceId: preparation.sourceId,
      role: link.role,
      model: preparation.model,
      effort: preparation.effort,
      mode: run.mode,
      layout: profile.host.layout,
      launchCwd: run.launchCwd,
      briefPath: preparation.brief.path,
      briefContentHash: preparation.brief.sha256,
      reportPath: link.reportPath,
      profileDigest: digest({ profile: preparation.profileDigest, command: preparation.commandFingerprint }),
      orphanPolicy: profile.orphan_policy,
      ...(operation === 'resume' ? { linkId, promptHash: preparation.promptHash } : {}),
      ...(handover ? { predecessor: args.predecessor } : {}),
      ...(authority.kind === 'local_user' ? { expectedRun: args.expectedRun } : {}),
    };
    // Task identity revalidation happens only for a new intent, after replay.
    const proposedLink = {
      ...link,
      taskDigest: taskDigest(preparation.brief.path, preparation.brief.sha256, backend, run.sourceId, link.role),
    };
    if (performance.now() >= deadline) throw new LedgerBusyError();
    const result = await acceptIntent(
      ledger,
      {
        requestKey: String(args.request_key),
        targetSource: {
          sourceId: preparation.sourceId,
          harness: 'codex',
          rootPath: profile.source.root,
          label: profile.source.label,
        },
        params,
        link: proposedLink,
        run,
        claim,
        authority,
        capabilityVerified: capability.ok,
        newSession: operation === 'spawn' && !handover,
        holder: run.launchTokenHash,
      },
      Math.min(20, Math.max(0, deadline - 10 - performance.now())),
      gate ? () => gate.check() : undefined
    );
    if (!result.replayed) {
      // Do not await private-pipe backpressure after commit. This closure owns
      // the sole ticket delivery; replay never schedules it again.
      void (async () => {
        try {
          await (this.options.launch ?? launchPreparedRun)(launch, ticket, { hudRunPath: this.options.hudRunPath });
        } catch {
          process.stderr.write(JSON.stringify({ diagnostic: 'dispatch_unknown', runId }) + '\n');
        }
      })();
    }
    return { ok: true, ...(result.outcome as object) };
  }
  /** Trusted B11 function entry; arguments cannot select an MCP or management actor. */
  async resumeLocal(args: {
    linkId: string;
    request_key: string;
    expectedRun: string;
    mode: 'headless' | 'visible';
    prompt?: string;
  }): Promise<unknown> {
    if (!args.request_key || !args.expectedRun || !args.mode) throw new Error('local_resume_parameters_required');
    const gate = new PrivateLedgerGate(this.options.home);
    gate.check();
    const authority: Extract<IntentAuthority, { kind: 'local_user' }> = {
      kind: 'local_user',
      uid: process.getuid!(),
      ownerUid: process.getuid!(),
      invocationId: randomUUID(),
      hudHomeOwned: true,
      ledgerOwned: true,
      privatePaths: true,
    };
    return this.accept('resume', args, authority, performance.now() + 30, gate);
  }
}
