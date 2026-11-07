import type { HostMessage } from './host.js';
import type { NativeRef } from './types.js';

/** Pointers only. Native output/request bodies are read from the authenticated host. */
export interface NativeWakeDetails {
  connectionId: string;
  nativeRef: NativeRef | null;
  eventSeq: number;
  kind: 'result' | 'request';
  requestId?: string;
}
export function nativeWakeDetails(message: HostMessage): NativeWakeDetails | undefined {
  if (!message.request && message.event?.type !== 'native_result') return undefined;
  return {
    connectionId: message.connectionId,
    nativeRef: message.nativeRef,
    eventSeq: message.seq,
    kind: message.request ? 'request' : 'result',
    ...(message.request ? { requestId: message.request.requestId } : {}),
  };
}
export function nativeWakeMessage(details: NativeWakeDetails): string {
  const id = details.nativeRef
    ? details.nativeRef.harness === 'codex'
      ? details.nativeRef.threadId
      : details.nativeRef.sessionId
    : 'binding-pending';
  const text = `[hud] native ${details.kind} connection=${encodeURIComponent(details.connectionId)} session=${encodeURIComponent(id)}${details.requestId ? ` request=${encodeURIComponent(details.requestId)}` : ''} eventSeq=${details.eventSeq}. Read with managed_wait or managed_requests using your own cursor.`;
  // Do not truncate identifiers into a different target.
  return Buffer.byteLength(text) <= 512
    ? text
    : '[hud] Native result/request available. Read managed_wait or managed_requests using your own cursor.';
}
