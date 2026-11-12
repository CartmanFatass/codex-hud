import type { OwnerKey, SessionRef } from '../core/types/identity.js';
import type { ProcessStamp } from '../core/types/supervision.js';

export interface WakeRegistration {
  adapter: 'claude_background_wait_v1' | 'codex_queue_v1' | 'pi_extension_v1' | 'none';
  adapterVersion: 1;
  ownerKey: OwnerKey;
  contextGeneration: number;
  parentRef: SessionRef;
  parentStamp: ProcessStamp | null;
  target: { codexHome: string; threadId: string } | { socketPath: string } | Record<string, never>;
  reason?: string;
}
export type WakeDelivery = { registrationSeq: number; throughSeq: number } & (
  | { result: 'wait_return' }
  | { result: 'accepted'; attempt: 1 | 2 }
  | { result: 'rejected'; attempt: 1 | 2; reason: string }
  | { result: 'unknown'; attempt: 1; exhausted?: never }
  | { result: 'unknown'; attempt: 2; exhausted: true }
);
