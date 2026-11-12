/** Panel-local evidence. None of these identities is an execution or material grant. */
export type LaneIdentity =
  | { kind: 'task-directory'; workspace: string; directory: string }
  | { kind: 'invocation'; home: string; root: string; jobId: string }
  | { kind: 'native'; refKey: string };
export type WorkTarget =
  | { kind: 'lane'; laneId: string }
  | { kind: 'worker'; laneId: string; workerId: string }
  | { kind: 'decision'; laneId: string; decisionId: string };
export interface EvidenceRef {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly section?: string;
  readonly revision: string;
  readonly at: number | null;
  readonly timeBasis: 'producer' | 'file-mtime' | 'unknown';
}
export interface DecisionRecord {
  readonly modelTitle?: string;
  readonly id: string;
  readonly laneId: string;
  readonly kind: 'answer' | 'review' | 'recommendation';
  readonly title: string;
  /** Explicit question/option facts for readable answers; title retains the original answer. */
  readonly question?: string;
  readonly option?: string;
  readonly departure: boolean;
  readonly oneWay: boolean;
  readonly instead?: string;
  readonly context?: string;
  readonly rationale?: string;
  readonly round?: number;
  readonly verdict?: 'accept' | 'changes-required';
  readonly stale: boolean;
  readonly evidence: readonly EvidenceRef[];
}
export interface OwnerWorker {
  readonly resources?: {
    context?: number;
    rate?: import('./token-rate.js').TokenRateSnapshot;
    spent?: import('../types.js').TokenSpent;
  };
  readonly nativeDepth?: number;
  readonly parentName?: string;
  readonly files?: readonly {
    rel: string;
    kind: 'brief' | 'report' | 'review' | 'question';
    at: number;
    paths: string[];
    qid?: string;
    title?: string;
    verdict?: string;
    state?: 'open' | 'answered' | 'departure';
  }[];
  /** Display-only model sentence; never state or execution evidence. */
  readonly modelSentence?: string;
  readonly work?: import('./work-card.js').WorkFacts;
  readonly id: string;
  readonly laneId: string;
  /** Only real tree nodes have an Inspector/native navigation mapping. */
  readonly nodeId?: string;
  readonly harness: string | null;
  readonly role: string | null;
  readonly task: string;
  readonly model: string | null;
  readonly provider?: string | null;
  readonly effort: string | null;
  readonly state: string;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly phase: string | null;
  readonly homeNeedsHuman: boolean;
  /** When the human was needed: the end of the job, or for an open question the time it was asked. */
  readonly humanEndedAt: number | null;
  /** First line of the question waiting for the owner; set only on thin jobs with an unanswered qa/qN.md. */
  readonly ask?: string;
  readonly stale: boolean;
  readonly evidence: readonly EvidenceRef[];
}
export interface WorkLane {
  readonly id: string;
  readonly identity: LaneIdentity;
  readonly label: string;
  readonly title: string;
  readonly startedAt: number | null;
  readonly phase: string | null;
  readonly workers: readonly OwnerWorker[];
  readonly decisions: readonly DecisionRecord[];
  readonly evidence: readonly EvidenceRef[];
}
export interface WorkCoverage {
  readonly incomplete: boolean;
  readonly diagnostics: readonly string[];
  readonly workspace: string | null;
}
export interface ObservationCost {
  entries: number;
  files: number;
  bytes: number;
  probes: number;
  enumerations: number;
  parses: number;
  elapsedMs: number;
}
export interface TaskSnapshot {
  readonly revision: number;
  readonly lanes: readonly WorkLane[];
  readonly coverage: WorkCoverage;
  readonly cost: Readonly<ObservationCost>;
}
export interface WorkboardSnapshot {
  readonly revision: string;
  readonly lanes: readonly WorkLane[];
  readonly workers: readonly OwnerWorker[];
  readonly decisions: readonly DecisionRecord[];
  readonly coverage: WorkCoverage;
}
export const targetKey = (target: WorkTarget): string =>
  JSON.stringify(
    target.kind === 'lane'
      ? ['lane', target.laneId]
      : target.kind === 'worker'
        ? ['worker', target.laneId, target.workerId]
        : ['decision', target.laneId, target.decisionId]
  );
