export type Harness = 'claude' | 'codex' | 'pi';
export type SourceId = string;

export interface SessionRef {
  harness: Harness;
  sourceId: SourceId;
  sessionId: string;
  threadId: string | null;
}
