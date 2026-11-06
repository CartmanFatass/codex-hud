/** One in-process continuity veto. Never a permission grant, persisted token or provider attestation. */
import { openCompletedReport, type CompletedReportMetadata, type CompletedReportTarget } from '../delegated-report-read.js';
import { captureSource, DigestFailure, type SourceSnapshot } from './source-config.js';
import type { DigestInput, DigestOptions } from './delegated-digest.js';

declare const lifetimeBrand: unique symbol;
/** Runtime identity is held only in the private WeakMap; cloning/serialization cannot mint a lifetime. */
export interface DigestPlanLifetime { readonly [lifetimeBrand]: true }
interface Binding {
  home: string; runId: string; reportId: string; env: NodeJS.ProcessEnv;
  ledgerId: string; recipientId: string; metadata: string;
}
interface State {
  binding: Binding | null;
  target: CompletedReportTarget | null;
  source: SourceSnapshot | null;
  claimed: boolean;
  invalid: boolean;
  listeners: Set<() => void>;
}
const states = new WeakMap<DigestPlanLifetime, State>();

/** The sole pure projection for both ordinary and prepared plans. No extra public identity fields. */
function projectPlan(m: CompletedReportMetadata, prepared: SourceSnapshot | undefined, reason: string) {
  return {
    format: 'hud-delegated-digest-plan' as const, schemaVersion: 1 as const,
    ledgerId: m.ledgerId, linkId: m.linkId, runId: m.runId, reportId: m.reportId, ref: { ...m.ref },
    origin: 'delegated' as const, purpose: 'digest' as const, field: 'result' as const,
    material: { kind: 'completed_report_summary', status: 'completed', bytes: m.summaryBytes,
      acceptedSeq: m.acceptedSeq, acceptedAt: m.acceptedAt, coverage: 'one_report_summary' },
    configuration: { model: `sources/${m.ref.sourceId}/model.json`, outbound: `sources/${m.ref.sourceId}/outbound.json` },
    ...(prepared?.recipient && prepared.config.connection.backend === 'api' ? {
      recipientId: prepared.recipient.recipientId, endpoint: prepared.endpoint, account: prepared.config.connection.account,
      model: prepared.recipient.model, language: prepared.config.delegatedDigest.language,
    } : {}),
    readiness: { ready: reason === 'ready', reason },
  };
}
export type DigestPlan = ReturnType<typeof projectPlan>;

function invalidate(state: State): void {
  if (state.invalid) return;
  state.invalid = true;
  const target = state.target;
  const listeners = [...state.listeners];
  state.listeners.clear();
  state.binding = null;
  state.target = null;
  state.source = null;
  try { target?.close(); } finally {
    for (const notify of listeners) { try { notify(); } catch { /* terminal even if a subscriber fails */ } }
  }
}
function current(state: State): boolean {
  if (state.invalid || !state.binding || !state.target || !state.source) return false;
  try {
    if (!state.target.current() || !state.source.current() ||
        state.source.readiness(state.target.metadata.ref) !== 'ready') throw new Error();
    return true;
  } catch {
    try { invalidate(state); } catch { /* fail closed, private references already released */ }
    return false;
  }
}
export async function prepareDelegatedDigestPlan(
  input: DigestInput, options: Pick<DigestOptions, 'onQuery'> = {}
): Promise<{ plan: DigestPlan; lifetime: DigestPlanLifetime | null }> {
  // Capture scalars and the original live env object before any awaited preparation.
  const fixed = { home: input.home, runId: input.runId, reportId: input.reportId, env: input.env };
  const target = await openCompletedReport(fixed.home, fixed.runId, fixed.reportId, options);
  const state: State = { binding: null, target, source: null, claimed: false, invalid: false, listeners: new Set() };
  let retained = false;
  try {
    let prepared: SourceSnapshot | undefined;
    let reason: string;
    try {
      prepared = captureSource(fixed.home, target.metadata.ref.sourceId, fixed.env,
        () => !state.invalid && target.current());
      reason = prepared.readiness(target.metadata.ref);
    } catch (error) { reason = error instanceof DigestFailure ? error.reason : 'source_configuration_invalid'; }
    if (!target.current()) throw new DigestFailure('target_changed');
    const plan = projectPlan(target.metadata, prepared, reason);
    if (reason !== 'ready' || !prepared?.recipient) return { plan, lifetime: null };
    state.source = prepared;
    state.binding = { ...fixed, ledgerId: target.metadata.ledgerId,
      recipientId: prepared.recipient.recipientId, metadata: JSON.stringify(target.metadata) };
    if (!current(state)) throw new DigestFailure('authorization_changed');
    const lifetime = Object.freeze(Object.create(null)) as DigestPlanLifetime;
    states.set(lifetime, state);
    retained = true;
    return { plan, lifetime };
  } finally { if (!retained) invalidate(state); }
}
export function revalidateDelegatedDigestPlan(lifetime: DigestPlanLifetime): boolean {
  const state = states.get(lifetime);
  return state ? current(state) : false;
}
export function disposeDelegatedDigestPlan(lifetime: DigestPlanLifetime): void {
  const state = states.get(lifetime);
  if (!state) return;
  states.delete(lifetime);
  try { invalidate(state); } catch { /* terminal and idempotent */ }
}

/** Internal run-only claim: supplies a veto/stop subscription, never private authority or material. */
export function claimDelegatedDigestPlan(
  lifetime: DigestPlanLifetime,
  input: DigestInput & { expectedLedger: string; expectedRecipient: string },
  onInvalidated: () => void
): { current(metadata: CompletedReportMetadata): boolean; release(success: boolean): void } {
  const state = states.get(lifetime);
  if (!state || state.claimed || !current(state)) throw new DigestFailure('plan_lifetime_invalid');
  const binding = state.binding!;
  if (input.home !== binding.home || input.runId !== binding.runId || input.reportId !== binding.reportId ||
      input.env !== binding.env || input.expectedLedger !== binding.ledgerId || input.expectedRecipient !== binding.recipientId) {
    disposeDelegatedDigestPlan(lifetime);
    throw new DigestFailure('plan_lifetime_invalid');
  }
  state.claimed = true;
  state.listeners.add(onInvalidated);
  let released = false;
  return {
    current(metadata) {
      if (released || !current(state)) return false;
      if (JSON.stringify(metadata) !== state.binding?.metadata) {
        disposeDelegatedDigestPlan(lifetime);
        return false;
      }
      return true;
    },
    release(success) {
      if (released) return;
      released = true;
      state.listeners.delete(onInvalidated);
      if (!success) disposeDelegatedDigestPlan(lifetime);
    },
  };
}
