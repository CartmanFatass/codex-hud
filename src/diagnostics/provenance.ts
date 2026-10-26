/** Exact allowlist for diagnostic evidence. Arbitrary source strings never cross it. */
import type { HudData, SubagentTree, SubagentTreeNode } from '../types.js';
import type { TokenRateSnapshot } from '../collectors/token-rate.js';
import { telemetryFailure, telemetryFeature } from '../collectors/model-telemetry.js';

export const numericFact = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function isoFact(value: unknown): string | null {
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN;
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : null;
}
function enumFact<T extends string>(value: unknown, values: readonly T[]): T | 'unknown' {
  return values.includes(value as T) ? value as T : 'unknown';
}
function boolFact(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null; }
export function findDiagnosticAgent(tree: SubagentTree | undefined, selectedId: string | undefined): SubagentTreeNode | undefined {
  if (!tree || !selectedId || tree.rootId === selectedId) return undefined;
  const pending = [...tree.nodes];
  const seen = new Set<SubagentTreeNode>();
  while (pending.length && seen.size < 10_000) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    if (node.id === selectedId) return node;
    seen.add(node);
    pending.push(...node.children);
  }
  return undefined;
}
export function rateEvidence(rate: TokenRateSnapshot | undefined, turnAt: Date | undefined, working: boolean, now: number) {
  const sampledAt = isoFact(rate?.sampledAt);
  const sampleMs = numericFact(rate?.sampleMs);
  const tokensPerSecond = numericFact(rate?.tokensPerSecond);
  if (!sampledAt || !sampleMs || tokensPerSecond === null) return null;
  const at = Date.parse(sampledAt);
  return { source: 'rollout-token-count-and-turn-events' as const, estimated: true as const, sampledAt, sampleMs, tokensPerSecond,
    relation: at > now ? 'future' as const : turnAt && at < turnAt.getTime() ? 'previous-turn' as const
      : working && now - at < 10_000 ? 'current-recent' as const : 'last-measurement' as const };
}
export interface DiagnosticEvidenceInput { data?: HudData; tree?: SubagentTree; selectedId?: string; nowMs: number }
export function diagnosticEvidence({ data, tree = data?.subagentTree, selectedId, nowMs }: DiagnosticEvidenceInput) {
  const agent = findDiagnosticAgent(tree, selectedId);
  const bridge = data?.bridgeHealth;
  const failure = data?.modelHealth?.lastFailure;
  return {
    observedAt: isoFact(nowMs),
    collection: { source: 'hud-collection' as const, bound: boolFact(data?.health?.sessionBound),
      bindingMethod: 'unavailable' as const, stale: boolFact(data?.stale), lastReadAt: isoFact(data?.health?.lastReadAt),
      lastError: data?.health?.lastError ? {
        source: enumFact(data.health.lastError.source, ['session', 'rollout', 'tree', 'status', 'git', 'worktrees']),
        classification: 'collection-failed' as const, at: isoFact(data.health.lastError.at),
      } : null },
    main: { source: data?.activity ? 'rollout-events' as const : 'unavailable' as const,
      state: enumFact(data?.activity?.state, ['working', 'idle', 'interrupted', 'error']),
      stateAt: isoFact(data?.activity?.updatedAt), turnStartedAt: isoFact(data?.activity?.turnStartedAt),
      tokenReportAt: isoFact(data?.tokenUsageAt),
      rate: rateEvidence(data?.outputRate, data?.activity?.turnStartedAt, data?.activity?.state === 'working', nowMs) },
    selected: !selectedId || selectedId === tree?.rootId ? null : {
      found: !!agent, source: agent ? 'agent-tree-and-rollout-scan' as const : 'unavailable' as const,
      observedAt: isoFact(tree?.updatedAt),
      state: enumFact(agent?.status, ['starting', 'running', 'completed', 'error', 'unknown']),
      stateAt: isoFact(agent?.statusAt), lastEventAt: isoFact(agent?.lastEventAt), turnStartedAt: isoFact(agent?.turnStartedAt),
      rate: rateEvidence(agent?.outputRate, agent?.turnStartedAt, agent?.status === 'running', nowMs),
    },
    bridge: { source: bridge?.mode === 'native' ? 'herdr-native-readback' as const
      : bridge?.mode === 'report' ? 'herdr-report-transport' as const : 'unavailable' as const,
      transport: enumFact(bridge?.state, ['connected', 'pending', 'disconnected', 'unresponsive', 'unavailable']),
      nativeState: enumFact(bridge?.nativeState, ['idle', 'working', 'blocked', 'done', 'unknown']),
      conflicting: boolFact(bridge?.stateMismatch), probeFailed: boolFact(bridge?.probeFailed),
      notificationGap: boolFact(bridge?.notificationGap), lastReadbackAt: isoFact(bridge?.lastSuccessAtMs) },
    model: { source: data?.modelHealth ? 'small-model-lifecycle' as const : 'unavailable' as const,
      queued: numericFact(data?.modelHealth?.queued),
      running: data?.modelHealth?.running ? { feature: telemetryFeature(data.modelHealth.running.feature),
        startedAt: isoFact(data.modelHealth.running.startedAt) } : null,
      lastSuccessAt: isoFact(data?.modelHealth?.lastSuccessAt),
      lastFailure: failure ? { classification: telemetryFailure(failure.classification ?? failure.reason),
        at: isoFact(failure.at), feature: telemetryFeature(failure.feature) } : null },
  };
}
