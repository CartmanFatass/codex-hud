import * as fs from 'node:fs';
import * as path from 'node:path';
import { LegacyRecapScopes } from '../../src/core/materials/legacy-scopes.js';
/** Explicit synthetic authorization for the existing transport/lifecycle fixtures. */
import {
  SmallModel as ProductionModel,
  type ModelRequest,
  type SmallModelOptions,
} from '../../src/collectors/small-model.js';
import { materialRequest, purposeFor } from '../../src/core/materials/request.js';
import {
  buildMaterials,
  isEnvelope,
  fingerprint,
  type MaterialAuthority,
  type ResolvedRecipient,
} from '../../src/core/materials/index.js';
import { bindResolvedRecipient, type MaterialRoute } from '../../src/core/materials/recipient.js';
const sourceId = fingerprint('b17-explicit-synthetic-source');
const purposes = [
  'brief',
  'recap',
  'progress',
  'digest',
  'label',
  'title',
  'cause',
  'changes',
  'approval',
  'probe',
  'jev_task',
  'routing',
] as const;
export class SyntheticModel extends ProductionModel {
  private readonly syntheticAuthority: MaterialAuthority;
  constructor(options: SmallModelOptions = {}) {
    const target = { current: null as ResolvedRecipient | null };
    super({
      ...options,
      resolveRecipient: (route: MaterialRoute) => {
        const resolved = route.model
          ? { recipientId: fingerprint(['synthetic-target', route.backend, route.endpoint]), model: route.model }
          : null;
        target.current = bindResolvedRecipient(route, resolved);
        return resolved;
      },
    });
    this.syntheticAuthority = {
      scope: (source) => (source === sourceId ? { revision: 1, local: true, allows: () => true } : null),
      policy: (source) => ({
        schemaVersion: 1,
        sourceId: source,
        revision: 1,
        grants: purposes.map((purpose) => ({
          purpose,
          recipientId: target.current?.recipientId,
          decision: 'allow',
          grantedAt: 0,
        })),
      }),
    };
  }
  override inspectLegacyMaterials(
    _subjects: unknown,
    purpose: import('../../src/core/materials/index.js').OutboundPurpose
  ): boolean {
    authorizedSyntheticPreview({ feature: purpose === 'label' ? 'labels' : purpose, system: '', prompt: '' });
    return true;
  }
  override submit(request: ModelRequest) {
    // Production callers still require provenance. This fixture explicitly supplies it for synthetic-only tests.
    const old = request.materials;
    const candidate = old?.purpose ?? purposeFor(request.feature);
    const purpose = purposes.includes(candidate) ? candidate : 'brief';
    const field = {
      brief: 'report',
      recap: 'message',
      progress: 'report',
      digest: 'result',
      label: 'task',
      title: 'message',
      cause: 'error',
      changes: 'diff',
      approval: 'command',
      probe: 'probe',
      jev_task: 'message',
      routing: 'signal',
    }[purpose];
    return super.submit(
      materialRequest(request.feature, {
        purpose,
        authority: this.syntheticAuthority,
        subjects: [
          {
            ref: { harness: 'codex', sourceId, sessionId: 'synthetic-session', threadId: null },
            origin: 'native',
            kind: 'public_text',
            field,
            recordFingerprint: fingerprint(['synthetic-record', purpose]),
            read: () => 'explicitly authorized synthetic fixture',
          },
        ],
        inherited: old?.inherited,
        compose: (envelope) => (old ? old.compose(envelope) : { ...request }),
      })
    );
  }
}

/** Feature-only fakes consume plans through the production material selector before replying. */
export function authorizedSyntheticPreview(request: ModelRequest): ModelRequest {
  const purpose = request.materials?.purpose ?? purposeFor(request.feature);
  const recipient = { recipientId: fingerprint('b17-feature-fake-recipient'), model: 'synthetic-model' };
  const authority: MaterialAuthority = {
    scope: () => ({ revision: 1, local: true, allows: () => true }),
    policy: () => ({
      schemaVersion: 1,
      sourceId,
      revision: 1,
      grants: [{ purpose, recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
    }),
  };
  const fields = {
    brief: 'report',
    recap: 'message',
    progress: 'report',
    digest: 'result',
    label: 'task',
    title: 'message',
    cause: 'error',
    changes: 'diff',
    approval: 'command',
    probe: 'probe',
    jev_task: 'message',
    routing: 'signal',
  };
  const envelope = buildMaterials({
    purpose,
    authority,
    resolvedRecipient: recipient,
    subjects: [
      {
        ref: { harness: 'codex', sourceId, sessionId: 'synthetic-feature', threadId: null },
        origin: 'native',
        kind: 'public_text',
        field: fields[purpose],
        recordFingerprint: fingerprint('synthetic-feature-record'),
        read: () => 'Explicit feature fixture material',
      },
    ],
    limits: { maxBytes: 1000 },
  });
  if (!isEnvelope(envelope)) throw new Error('synthetic feature fixture authorization failed');
  if (request.materials?.legacyOptional?.length) {
    // The fixture's synthetic scope explicitly authorizes its declared optional parent too.
    const parent = request.materials.legacyOptional[0];
    const parentEnvelope = buildMaterials({
      purpose,
      authority,
      resolvedRecipient: recipient,
      subjects: [
        {
          ref: { harness: 'codex', sourceId, sessionId: parent.sessionId, threadId: null },
          origin: 'native',
          kind: 'public_text',
          field: fields[purpose],
          recordFingerprint: fingerprint('synthetic-parent-record'),
          read: () => 'Explicit parent fixture material',
        },
      ],
      limits: { maxBytes: 1000 },
    });
    if (!isEnvelope(parentEnvelope)) throw new Error('synthetic parent fixture authorization failed');
    return request.materials.compose(parentEnvelope);
  }
  return request.materials?.compose(envelope) ?? request;
}

export const syntheticRecapScopes = new LegacyRecapScopes();

/** General replies moved; the original budget/claim files retain their paths. */
export function syntheticRuntimeFile(dir: string, name: string): string {
  if (name !== 'cache.json') return path.join(dir, name);
  const target = path.join(dir, 'materials-v1', 'replies');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return path.join(target, name);
}
