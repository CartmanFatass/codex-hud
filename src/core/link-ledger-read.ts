import type { RegistrationState } from './wake/projection.js';
import type { LedgerReadSnapshot } from './ledger-read.js';
import type { SessionRef } from './types/identity.js';

export interface ClaimFingerprintCheck {
  ledgerId: string;
  asOfSeq: number;
  runId: string;
  bindingGeneration: number;
  recordId: string;
  result: 'verified' | 'mismatch' | 'unverifiable';
}

export type LinkLedgerRead =
  | {
      state: 'available';
      snapshot: LedgerReadSnapshot;
      claimChecks: ClaimFingerprintCheck[];
      conflictTargets: ReadonlyMap<string, SessionRef>;
      reason: null;
      wakeStates?: ReadonlyMap<string, RegistrationState | null>;
      wakeAttempts?: ReadonlyMap<string, number | null>;
    }
  | { state: 'degraded'; snapshot: null; reason: string };
