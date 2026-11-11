/** Native display identity for the retained, explicit delegation-summary provider.
 * The historical standalone footer/controller is retired; ordinary package ownership
 * lives in p10k-footer.ts. These types convey no managed capability or authority.
 */
export interface PiFooterIdentity {
  sessionId: string;
  sessionFile: string | null;
  sessionDir: string;
  leafId: string | null;
}
export type PiFooterSummaryProvider = (identity: Readonly<PiFooterIdentity>) => unknown;
export { createPiDelegationSummaryProvider } from '../../core/delegation-summary-pi.js';
