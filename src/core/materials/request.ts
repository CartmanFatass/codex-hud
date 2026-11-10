/** Request plans keep material authorization ahead of feature formatting and cache-key hashing. */
import type { ModelRequest, JobModelRequest } from '../../collectors/small-model.js';
import type { MaterialAuthority, MaterialEnvelope, MaterialSubject, OutboundPurpose } from './index.js';
import type { SessionRef } from '../types/identity.js';
import type { JobMaterialAuthority, JobMaterialEnvelope, JobMaterialSubject, JobReadBudget } from './job.js';

/** Disjoint request variant: never mixes native subjects with a facade job. */
export interface JobMaterialPlan {
  kind: 'job';
  purpose: 'job_card';
  subject: JobMaterialSubject;
  authority: JobMaterialAuthority;
  budget?: JobReadBudget;
  compose: (envelope: JobMaterialEnvelope) => ModelRequest;
}
export function jobMaterialRequest(plan: JobMaterialPlan): JobModelRequest {
  return { feature: 'job_card', system: '', prompt: '', jobMaterials: plan };
}

export interface LegacySubject {
  sessionId: string;
  parentSessionId?: string;
  rolloutPath?: string;
  /** B10 must supply the actual ref/origin for universal/delegated subjects. */
  ref?: SessionRef;
  origin?: 'native' | 'delegated';
  universal?: boolean;
  /** Metadata attestation stays live until formatting/delivery; never evaluates text. */
  current?: () => boolean;
  /** Parent-owned public pre-create charge; child identity remains an independent guard. */
  chargeFor?: {
    sessionId: string;
    ref?: SessionRef;
    origin?: 'native' | 'delegated';
    universal?: boolean;
    parentSessionId?: string;
  };
}
export interface MaterialPlan {
  purpose: OutboundPurpose;
  subjects?: readonly MaterialSubject[];
  authority?: MaterialAuthority;
  legacy?: readonly LegacySubject[];
  legacyOptional?: readonly LegacySubject[];
  legacyPurposes?: readonly OutboundPurpose[];
  /** Fixed synthetic probe only; no caller supplied session text. */
  probe?: true;
  inherited?: MaterialEnvelope;
  compose: (envelope: MaterialEnvelope) => ModelRequest;
  maxBytes?: number;
  allowPartial?: boolean;
}
export const purposeFor = (feature: string): OutboundPurpose =>
  (feature === 'labels' ? 'label' : feature) as OutboundPurpose;

/** The request carries no text until SmallModel authorizes and invokes compose. */
export function materialRequest(feature: string, plan: MaterialPlan): ModelRequest {
  return { feature, system: '', prompt: '', materials: plan };
}
export function legacyRequest(
  feature: string,
  subjects: readonly LegacySubject[],
  compose: () => ModelRequest,
  inherited?: MaterialEnvelope
): ModelRequest {
  return materialRequest(feature, { purpose: purposeFor(feature), legacy: subjects, compose, inherited });
}
interface LegacyTreeNode {
  id: string;
  rolloutPath?: string;
  children: readonly LegacyTreeNode[];
}
export function legacyTreeSubjects(
  tree: { rootId: string; nodes: readonly LegacyTreeNode[] },
  rootPath?: string
): LegacySubject[] {
  const rootId = tree.rootId;
  const subjects: LegacySubject[] = rootPath
    ? [{ sessionId: rootId, rolloutPath: rootPath, current: () => tree.rootId === rootId }]
    : [];
  const visit = (nodes: typeof tree.nodes, parentSessionId: string) => {
    for (const node of nodes) {
      const identity = node as typeof node & {
        ref?: SessionRef;
        origin?: 'native' | 'delegated';
        sourceId?: string;
        harness?: string;
      };
      // Unknown universal metadata cannot silently inherit the legacy root's grant.
      const ref =
        identity.ref ??
        (identity.sourceId || identity.harness
          ? ({
              harness: identity.harness,
              sourceId: identity.sourceId,
              sessionId: node.id,
              threadId: null,
            } as SessionRef)
          : undefined);
      const metadata = () =>
        JSON.stringify([
          node.id,
          node.rolloutPath,
          identity.ref,
          identity.origin,
          identity.sourceId,
          identity.harness,
          Object.hasOwn(identity, 'ref'),
          Object.hasOwn(identity, 'sourceId'),
          Object.hasOwn(identity, 'harness'),
        ]);
      const snapshot = metadata();
      const edgeCurrent = () => {
        let found = false;
        const check = (nodes: readonly LegacyTreeNode[], parent: string) => {
          for (const candidate of nodes) {
            if (candidate === node && parent === parentSessionId) found = true;
            check(candidate.children, candidate.id);
          }
        };
        check(tree.nodes, tree.rootId);
        return found && metadata() === snapshot;
      };
      subjects.push({
        sessionId: node.id,
        parentSessionId,
        rolloutPath: node.rolloutPath,
        ref: ref ? { ...ref } : undefined,
        universal:
          Object.hasOwn(identity, 'ref') || Object.hasOwn(identity, 'sourceId') || Object.hasOwn(identity, 'harness'),
        origin: identity.origin,
        current: edgeCurrent,
      });
      visit(node.children, node.id);
    }
  };
  visit(tree.nodes, tree.rootId);
  return subjects;
}

const recordIds = new WeakMap<object, number>();
let nextRecordId = 0;
/** Local scheduling may observe record identity and clocks, never the model text within a record. */
export function recordStamp(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let id = recordIds.get(value);
  if (id === undefined) {
    id = ++nextRecordId;
    recordIds.set(value, id);
  }
  return id;
}
