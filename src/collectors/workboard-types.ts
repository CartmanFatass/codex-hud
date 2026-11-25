/** Panel-local evidence. None of these identities is an execution or material grant. */
export type LaneIdentity =
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
export interface ProgressEntry { at: string; text: string; source?: 'checkpoint' }
export interface JobProgress {
  readonly progress: readonly ProgressEntry[];
  readonly latest_progress: ProgressEntry | null;
}
export interface WorkFlowStep {
  readonly key: 'gate' | 'merge' | 'push' | 'scout' | 'run';
  readonly state: 'pending' | 'active' | 'done' | 'failed' | 'cancelled';
}
export interface WorkFlow {
  readonly kind: 'land' | 'scout';
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly WorkFlowStep[];
  readonly step?: string;
  readonly landedSha?: string;
  readonly error?: string;
  /** A queued land's lease holder, as its ticket id (else its title), when that job is on this board. */
  readonly waitsOn?: string;
  readonly updatedAt: number | null;
}
export interface OwnerWorker extends Partial<JobProgress> {
  readonly flow?: WorkFlow;
  readonly checks?: Pick<import('../roles/job-checks.js').CheckSummary, 'state' | 'stale' | 'passed' | 'total'>;
  readonly diffStat?: import('./diff-stat.js').DiffStatSummary;
  /** Display-only metadata bound to this settled thin job's current report. */
  readonly reportMeta?: import('../roles/report-meta.js').ReportMeta;
  readonly superseded?: boolean;
  readonly failureObserved?: boolean;
  readonly quietDecision?: {
    readonly choice: string | null;
    readonly probability: number | null;
    readonly action: string;
    readonly reason?: string;
  };
  readonly resources?: {
    context?: number;
    rate?: import('./token-rate.js').TokenRateSnapshot;
    spent?: import('../types.js').TokenSpent;
  };
  readonly nativeDepth?: number;
  /** Raw local excerpt from the observed native transcript. */
  readonly transcriptStep?: { text: string; replaying: boolean };
  readonly parentJobId?: string;
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
  /** Bounded original report excerpt, attached only for the inspected job. */
  readonly report?: { readonly text: string; readonly truncated: boolean };
  /** Newest working session, selected/stat'ed once by the thin-job collector. */
  readonly sessionFile?: { readonly path: string; readonly at: number };
  readonly work?: import('./work-job.js').WorkFacts;
  readonly id: string;
  readonly laneId: string;
  /** Only real tree nodes have an Inspector/native navigation mapping. */
  readonly nodeId?: string;
  readonly harness: string | null;
  readonly role: string | null;
  readonly task: string;
  /** Stable slice/ticket identifier to retain beside the title. */
  readonly displayId?: string;
  /** Thin job's original brief heading. */
  readonly briefTitle?: string;
  /** Heading of the ticket file the job works on (`NN:` prefix off); Home's job row title, else `briefTitle`. */
  readonly ticketTitle?: string;
  readonly objective?: import('./objectives.js').ObjectiveLink;
  readonly model: string | null;
  readonly provider?: string | null;
  readonly effort: string | null;
  readonly state: string;
  readonly queuePosition?: number;
  readonly overflowFrom?: string;
  readonly route?: import('../mcp/job-contracts.js').JobRoute;
  /** The job runs headless: no herdr tab, its output is the job's `stdout.jsonl` log. */
  readonly headless?: true;
  /** A headless job's newest output lines; attached by the panel only to the job open in the Inspector. */
  readonly output?: import('./headless-output.js').HeadlessOutput;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly phase: string | null;
  readonly homeNeedsHuman: boolean;
  /** When the human was needed: the end of the job, or for an open question the time it was asked. */
  readonly humanEndedAt: number | null;
  /** First line of the question waiting for the owner; set only on thin jobs with an unanswered qa/qN.md. */
  readonly ask?: string;
  /** The current report hasn't been collected (the MCP's `report_unread`); set only while true. */
  readonly reportUnread?: true;
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
