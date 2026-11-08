// Executor surface for a Jev job. R2 calls this; it does not launch a CLI harness.

export type JevJobTag = 'ask' | 'browse' | 'judge';
export type JevAskTarget = 'chatgpt-pro' | 'aistudio';
export type JevDecisionId = 'typesafe' | 'openai';

export interface JevSession {
  namespace: string;
  sessionId: string;
}

/** Already resolved from `$HUD_HOME/routing.toml`. This runtime does not choose a role. */
export interface JevDecisionProfile {
  id?: string;
  provider?: JevDecisionId;
  model?: string | null;
}

export type JevJobInput =
  | { tag: 'ask'; target: JevAskTarget; label: string; prompt: string; confirmResend?: boolean }
  | { tag: 'browse'; goal: string; url: string }
  | { tag: 'judge'; url: string; statements: Array<{ name: string; statement: string }> };

export interface JevCreateRequest {
  requestKey: string;
  session: JevSession;
  /** Resolved `jev_decisions` profile. Omitted: TypeSafe when that credential is present. */
  jevDecisions?: JevDecisionProfile;
  input: JevJobInput;
}

export interface JevReadOptions {
  waitMs?: number;
  afterSeq?: number;
  signal?: AbortSignal;
}

export interface JevFollowUp {
  key: string;
  text: string;
}

export type JevJobState = 'queued' | 'running' | 'completed' | 'failed' | 'closed' | 'interrupted';

export interface JevJob {
  executor: 'jev';
  id: string;
  requestKey: string;
  fingerprint: string;
  session: JevSession;
  tag: JevJobTag;
  /** Profile id from the request, when the caller passed one. */
  decisionProfile: string | null;
  /** Provider actually used. Never includes a credential. */
  provider: { id: JevDecisionId; model: string } | null;
  state: JevJobState;
  closed: boolean;
  seq: number;
  result: unknown;
  error?: { code: string; message: string; variable?: string };
  /** Set when a read ended because the caller disconnected. The job itself is unchanged. */
  observationEnded?: boolean;
  followUp?: { supported: false; code: 'unsupported' };
}

export interface JevExecutor {
  createJob(request: JevCreateRequest): Promise<JevJob>;
  readJob(jobId: string, options?: JevReadOptions): Promise<JevJob>;
  sendFollowUp(jobId: string, followUp: JevFollowUp): Promise<JevJob>;
  closeJob(jobId: string): Promise<JevJob>;
}
