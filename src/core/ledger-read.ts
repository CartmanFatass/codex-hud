import type { Evidence, LedgerEvent, Run, RunSlot } from './types/execution.js';
import type { ChildBinding, Claim } from './types/identity.js';
import type { Link, Report } from './types/lifecycle.js';

export type LedgerReadRun = Omit<Run, 'launchTokenHash' | 'launchDigest'>;
export type LedgerReadClaim = Omit<Claim, 'claimHash'>;

export interface LedgerReadSnapshot {
  ledgerId: string;
  asOfSeq: number;
  links: Link[];
  runs: LedgerReadRun[];
  claims: LedgerReadClaim[];
  bindings: ChildBinding[];
  reports: Report[];
  events: LedgerEvent[];
  evidence: Evidence[];
  slots: RunSlot[];
}
