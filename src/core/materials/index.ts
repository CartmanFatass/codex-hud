/** B17: the only boundary at which public observations become model material. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { outboundDecision, parseOutboundPolicy } from '../export.js';
import { sessionRefKey, validateSessionRef } from '../identity.js';
import type { MaterialEnvelope, MaterialProvenance, OutboundPurpose } from '../types/export.js';
import type { Coverage } from '../types/observation.js';
import type { SessionRef } from '../types/identity.js';

export type { MaterialEnvelope, MaterialProvenance, OutboundPurpose } from '../types/export.js';
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ResolvedRecipient {
  recipientId: string;
  model: string;
}
/** Metadata from the trusted public adapter, never inferred from a parent or a file name. */
export interface MaterialSubject {
  ref: SessionRef;
  origin: 'native' | 'delegated';
  field: string;
  kind: 'public_text' | 'derived' | 'reasoning' | 'unknown' | 'raw_log';
  /** Evaluated only after identity, scope and outbound authorization. */
  read: () => string;
  recordFingerprint: string;
  coverage?: Coverage;
  /** A derived subject must retain its minted provenance token. */
  derived?: MaterialEnvelope;
}
export interface MaterialScope {
  revision: number;
  local: boolean;
  /** Exact ref/origin/field/purpose selection; no implicit source-wide grant. */
  allows: (subject: MaterialProvenance, purpose: OutboundPurpose) => boolean;
}
export interface MaterialAuthority {
  policy: (sourceId: string) => unknown;
  scope: (sourceId: string) => MaterialScope | null;
}
export interface BuildMaterialsInput {
  subjects: readonly MaterialSubject[];
  purpose: OutboundPurpose;
  resolvedRecipient: ResolvedRecipient | null;
  limits: { maxBytes: number; maxFragments?: number };
  authority: MaterialAuthority;
  /** Independent fragments only. Coupled/opaque inputs must retain every subject. */
  allowPartial?: boolean;
}
export type MaterialDecision = MaterialEnvelope | { denied: true; reason: 'requires_authorization' | 'no_material' };
const legacyEnvelopes = new WeakSet<MaterialEnvelope>();
const legacyAuthorities = new WeakSet<MaterialAuthority>();
const scopeRevisions = new WeakMap<MaterialEnvelope, Record<string, number>>();
export function markLegacy(envelope: MaterialEnvelope | null, authority: MaterialAuthority): void {
  if (envelope) legacyEnvelopes.add(envelope);
  legacyAuthorities.add(authority);
}
export const isLegacyEnvelope = (envelope: MaterialEnvelope): boolean => legacyEnvelopes.has(envelope);
const minted = new WeakSet<MaterialEnvelope>();
const original = new WeakMap<MaterialEnvelope, string>();
const fields: Record<OutboundPurpose, readonly string[]> = {
  brief: ['name', 'role', 'task', 'intent', 'report', 'action', 'result', 'note', 'status', 'brief'],
  recap: ['message', 'plan', 'goal', 'approval', 'name', 'status', 'recap', 'brief'],
  progress: ['name', 'role', 'task', 'charge', 'intent', 'report', 'action', 'status', 'progress'],
  digest: ['result', 'digest'],
  label: ['task', 'charge', 'label'],
  title: ['message', 'goal', 'title'],
  cause: ['error', 'command', 'task', 'cause'],
  changes: ['diff', 'changes'],
  approval: ['command', 'approval'],
  probe: ['probe'],
  jev_task: ['message', 'result'],
  routing: ['brief', 'signal'],
};
const derivedFields = new Set([
  'note',
  'brief',
  'recap',
  'progress',
  'digest',
  'label',
  'title',
  'cause',
  'changes',
  'approval',
]);
const fieldCaps: Record<string, number> = {
  name: 80,
  role: 80,
  task: 400,
  charge: 400,
  intent: 300,
  report: 600,
  action: 200,
  result: 8000,
  message: 4000,
  error: 2000,
  command: 2000,
  diff: 6000,
};
const denied = (): MaterialDecision => ({ denied: true, reason: 'requires_authorization' });
export function isEnvelope(value: MaterialDecision): value is MaterialEnvelope {
  return !('denied' in value);
}
function provenance(
  subject: MaterialSubject,
  purpose: OutboundPurpose,
  authority: MaterialAuthority
): MaterialProvenance[] | null {
  try {
    validateSessionRef(subject.ref);
    if (!['native', 'delegated'].includes(subject.origin) || !fields[purpose]?.includes(subject.field)) return null;
    if (subject.kind === 'derived') {
      const envelope = subject.derived;
      if (envelope && legacyEnvelopes.has(envelope) && !legacyAuthorities.has(authority)) return null;
      if (!envelope || !minted.has(envelope) || original.get(envelope) !== fingerprint(envelope)) return null;
      // The display owner must itself be an original contributor, never a relabelled parent.
      if (
        !envelope.fragments.some((f) => f.provenance.some((p) => sessionRefKey(p.ref) === sessionRefKey(subject.ref)))
      )
        return null;
      return envelope.fragments.flatMap((fragment) => fragment.provenance);
    }
    if (derivedFields.has(subject.field) && !legacyAuthorities.has(authority)) return null;
    if (subject.kind !== 'public_text' || !/^[a-f0-9]{64}$/.test(subject.recordFingerprint)) return null;
    return [
      {
        sourceId: subject.ref.sourceId,
        ref: { ...subject.ref },
        origin: subject.origin,
        field: subject.field,
        recordFingerprint: subject.recordFingerprint,
      },
    ];
  } catch {
    return null;
  }
}

/** Fixed order: identity/public allowlist → read/material scope → recipient grants → text/hash. */
export function buildMaterials(input: BuildMaterialsInput): MaterialDecision {
  const recipient = input.resolvedRecipient;
  if (
    !recipient?.recipientId ||
    !recipient.model ||
    !fields[input.purpose] ||
    !Number.isSafeInteger(input.limits.maxBytes) ||
    input.limits.maxBytes <= 0
  )
    return denied();
  const revisions: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  const accepted: Array<{ subject: MaterialSubject; provenance: MaterialProvenance[] }> = [];
  let excluded = 0;
  for (const subject of input.subjects) {
    const origins = provenance(subject, input.purpose, input.authority);
    let allowed = !!origins?.length;
    for (const origin of origins ?? []) {
      try {
        const scope = input.authority.scope(origin.sourceId);
        // Derived records are rechecked under their ORIGINAL fields, for the new purpose.
        if (!scope?.local || !Number.isSafeInteger(scope.revision) || !scope.allows(origin, input.purpose)) {
          allowed = false;
          break;
        }
        const policy = parseOutboundPolicy(input.authority.policy(origin.sourceId));
        if (
          outboundDecision(policy, {
            sourceId: origin.sourceId,
            purpose: input.purpose,
            recipientId: recipient.recipientId,
          }) !== 'allow'
        ) {
          allowed = false;
          break;
        }
        revisions[origin.sourceId] = policy!.revision;
        scopes[origin.sourceId] = scope.revision;
      } catch {
        allowed = false;
        break;
      }
    }
    if (allowed) accepted.push({ subject, provenance: origins! });
    else excluded++;
  }
  if (!accepted.length || (excluded && !input.allowPartial)) return denied();
  const fragments: MaterialEnvelope['fragments'] = [];
  let bytes = 0;
  const coverages: Coverage[] = [];
  for (const candidate of accepted) {
    let text: string;
    try {
      text = candidate.subject.read();
    } catch {
      return denied();
    }
    // Sealed payloads and private blobs are never forwarded, even under a public field label.
    if (typeof text !== 'string' || !text.trim() || text.includes('gAAAAA')) {
      excluded++;
      continue;
    }
    if (
      Array.from(text).length >
      (['brief', 'progress'].includes(input.purpose) && ['task', 'charge'].includes(candidate.subject.field)
        ? 300
        : (fieldCaps[candidate.subject.field] ?? 65536))
    )
      return denied();
    bytes += Buffer.byteLength(text);
    if (bytes > input.limits.maxBytes || fragments.length >= (input.limits.maxFragments ?? 200)) return denied();
    const coverage = candidate.subject.derived?.coverage ??
      candidate.subject.coverage ?? {
        state: 'partial' as const,
        skipped: {},
        gaps: ['adapter_coverage_unreported'],
        loaded: true,
      };
    if (
      !['complete', 'partial', 'catching_up'].includes(coverage.state) ||
      coverage.loaded !== true ||
      !Array.isArray(coverage.gaps) ||
      !coverage.gaps.every((gap) => typeof gap === 'string') ||
      !coverage.skipped ||
      Object.values(coverage.skipped).some((count) => !Number.isSafeInteger(count) || count < 0)
    )
      return denied();
    coverages.push(coverage);
    fragments.push({ text, provenance: candidate.provenance });
  }
  if (!fragments.length || (excluded && !input.allowPartial)) return { denied: true, reason: 'no_material' };
  const sources = [...new Set(fragments.flatMap((f) => f.provenance.map((p) => p.sourceId)))].sort();
  const coverage: Coverage = {
    state:
      excluded || coverages.some((c) => c.state === 'partial')
        ? 'partial'
        : coverages.some((c) => c.state === 'catching_up')
          ? 'catching_up'
          : 'complete',
    skipped: excluded ? { unauthorized: excluded } : {},
    gaps: [...new Set(coverages.flatMap((c) => c.gaps))],
    loaded: true,
  };
  for (const inherited of new Set(coverages)) {
    for (const [kind, count] of Object.entries(inherited.skipped))
      coverage.skipped[kind] = (coverage.skipped[kind] ?? 0) + count;
  }
  const activeRevisions = Object.fromEntries(sources.map((source) => [source, revisions[source]]));
  const activeScopes = Object.fromEntries(sources.map((source) => [source, scopes[source]]));
  const envelope: MaterialEnvelope = {
    fragments,
    sources,
    purpose: input.purpose,
    recipientId: recipient.recipientId,
    policyRevision: activeRevisions,
    fingerprint: fingerprint(fragments),
    coverage,
    cacheDomain: fingerprint([
      'materials-v1',
      sources,
      input.purpose,
      recipient,
      activeScopes,
      activeRevisions,
      coverage,
      fragments.flatMap((f) => f.provenance),
    ]),
  };
  scopeRevisions.set(envelope, activeScopes);
  minted.add(envelope);
  original.set(envelope, fingerprint(envelope));
  return envelope;
}

/** No text is reread and no cache is consulted during the send/write-back check. */
export function revalidateMaterials(
  envelope: MaterialEnvelope,
  authority: MaterialAuthority,
  recipient: ResolvedRecipient | null
): boolean {
  if (
    !minted.has(envelope) ||
    original.get(envelope) !== fingerprint(envelope) ||
    recipient?.recipientId !== envelope.recipientId
  )
    return false;
  try {
    return envelope.fragments.every((fragment) =>
      fragment.provenance.every((p) => {
        const scope = authority.scope(p.sourceId);
        const policy = parseOutboundPolicy(authority.policy(p.sourceId));
        return (
          !!scope?.local &&
          scope.revision === scopeRevisions.get(envelope)?.[p.sourceId] &&
          scope.allows(p, envelope.purpose) &&
          !!policy &&
          policy.revision === envelope.policyRevision[p.sourceId] &&
          outboundDecision(policy, {
            sourceId: p.sourceId,
            purpose: envelope.purpose,
            recipientId: recipient.recipientId,
          }) === 'allow'
        );
      })
    );
  } catch {
    return false;
  }
}

/** File policy adapter. Missing, corrupt or oversized files remain denial, never defaults. */
export function fileAuthority(hudHome: string, scope: MaterialAuthority['scope']): MaterialAuthority {
  return {
    scope,
    policy(sourceId) {
      if (!/^[a-f0-9]{64}$/.test(sourceId)) return null;
      try {
        const file = path.join(hudHome, 'sources', sourceId, 'outbound.json');
        if (fs.statSync(file).size > 65536) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}
