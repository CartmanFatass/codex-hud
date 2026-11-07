/** Thin official-session transport. No task, operation or approval state lives here. */
export type ManagedHarness = 'codex' | 'claude' | 'pi';
export type NativeRef =
  | { harness: 'codex'; threadId: string; sessionId?: string }
  | { harness: 'claude'; sessionId: string }
  | { harness: 'pi'; sessionId: string; sessionFile?: string };
export interface Correlation {
  nativeTurnId?: string;
  userMessageUuid?: string;
}
export type AdapterEvent =
  | { type: 'binding'; nativeRef: NativeRef }
  | { type: 'ready'; payload?: unknown }
  | {
      type: 'native_event' | 'native_result';
      kind: string;
      payload: unknown;
      callId?: string;
      correlation?: Correlation;
    }
  | { type: 'disconnected'; reason: string }
  | { type: 'process_exit'; code: number | null; signal?: string | null };
/** Native callback identifier and public payload. Resolver remains only in the host's memory. */
export interface NativeRequest {
  requestId: string;
  callId?: string;
  kind: string;
  payload: unknown;
  signal?: AbortSignal;
  responseUnsupportedReason?: string;
}
export interface NativeResponse {
  result: unknown;
}
export interface AdapterCallbacks {
  event(event: AdapterEvent): void;
  request(request: NativeRequest): Promise<NativeResponse>;
}
export interface AdapterCreate {
  workspace: string;
  origin: { kind: 'new' } | { kind: 'resume' | 'fork'; source: NativeRef };
  options?: Record<string, unknown>;
}
export interface DispatchReceipt {
  payload?: unknown;
  correlation?: Correlation;
}
export interface ManagedAdapterSession {
  snapshot(): { nativeRef: NativeRef | null; [key: string]: unknown };
  send(input: { callId: string; text: string; options?: Record<string, unknown> }): Promise<DispatchReceipt>;
  /** Public native read/history operation. The backend owns cursor and status semantics. */
  read(options?: Record<string, unknown>): Promise<unknown>;
  /** Explicit native interrupt only. No process-tree escalation or inferred completion. */
  cancel(input: { nativeTurnId?: string }): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface ManagedAdapterFactory {
  readonly harness: ManagedHarness;
  create(request: AdapterCreate, callbacks: AdapterCallbacks): Promise<ManagedAdapterSession>;
}
/** Submission ambiguity is a transport fact, never a task state or automatic retry instruction. */
export class AdapterDispatchError extends Error {
  constructor(
    readonly code: string,
    readonly certainty: 'not_sent' | 'uncertain',
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}
