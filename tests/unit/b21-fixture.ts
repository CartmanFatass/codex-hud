import { handshakeFixture, hashClaim } from './b45-handshake-fixture.js';
import { acceptIntent } from '../../src/ledger/intents.js';
import { sessionOwnerKey } from '../../src/core/identity.js';
import type { PreparedIntent, ValidatedEvidence } from '../../src/ledger/types.js';
import type { ReconcileFact } from '../../src/core/types/execution.js';
import type { WakeRegistration, RetireRequest } from '../../src/ledger/notify-events.js';
export async function notifyFixture() {
  const f = await handshakeFixture();
  const registration: WakeRegistration = {
    adapter: 'codex_queue_v1',
    adapterVersion: 1,
    ownerKey: sessionOwnerKey(f.parent.ref),
    contextGeneration: 1,
    parentRef: f.parent.ref,
    parentStamp: null,
    target: { codexHome: f.root, threadId: f.parent.ref.sessionId },
  };
  return { ...f, registration };
}
export const retire: RetireRequest = {
  cause: 'retire_after_report',
  rule: 'after_report',
  actor: { kind: 'policy' },
  deadlineAt: 1010,
  eligibility: { newerWorkChecked: true, quiescence: 'not_required', pendingInput: 'unobservable' },
  graceMs: 10000,
};
export function nextIntent(
  f: Pick<Awaited<ReturnType<typeof handshakeFixture>>, 'input' | 'parent'>,
  id: string,
  actor = f.parent
): PreparedIntent {
  const p = structuredClone(f.input);
  p.requestKey = 'key-' + id;
  p.link = {
    ...p.link,
    linkId: 'link-' + id,
    parentCaller: actor.context.callerId,
    parentContextId: actor.context.contextId,
    parentContextGeneration: actor.context.generation,
    parentRef: actor.ref,
  };
  p.run = {
    ...p.run,
    runId: 'run-' + id,
    linkId: p.link.linkId,
    launchTokenHash: hashClaim('ticket-' + id),
    launchDigest: hashClaim('launch-' + id),
    launchCallId: 'call-' + id,
    launchCorrelationId: 'correlation-' + id,
  };
  p.claim = { ...p.claim, runId: p.run.runId, claimHash: hashClaim('claim-' + id) };
  p.authority = actor.authority;
  return p;
}
export function factEvidence(
  f: Awaited<ReturnType<typeof handshakeFixture>>,
  id: string,
  fact: ReconcileFact,
  asOf: number
): ValidatedEvidence {
  const e = {
    evidenceId: id,
    runId: 'run-a',
    sourceId: f.source.sourceId,
    bindingGeneration: 1,
    supervisor: f.meta.supervisor,
    validation: 'accepted' as const,
    asOf,
    observedAt: asOf,
    fact,
  };
  return {
    record: {
      evidenceId: id,
      runId: 'run-a',
      linkId: 'link-a',
      kind:
        fact.kind === 'receipt'
          ? 'exit_receipt'
          : fact.kind === 'never_submitted'
            ? 'never_submitted'
            : 'scope_reconciled',
      producer: 'reconciler',
      fingerprint: hashClaim(id),
      payload: {},
      observedAt: asOf,
      validatedAt: asOf,
      validation: 'accepted',
    },
    facts: [e],
  };
}
export const completion = {
  kind: 'scope_reconciled',
  complete: true,
  harnessTerminated: true,
  launchersSealed: true,
  nativeExit: null,
} satisfies ReconcileFact;
export { acceptIntent };

export async function reportFor(
  f: Awaited<ReturnType<typeof handshakeFixture>>,
  status: 'completed' | 'failed' | 'blocked' | 'interrupted'
) {
  const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
  await f.startup();
  const service = new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
  await service.whoami({}, f.child.authority);
  return service.report({ runId: 'run-a', status, summary: 'Synthetic B21 task outcome' }, f.child.authority);
}
