import { canonicalJson } from '../canonical.js';
import type { LedgerReadRun } from '../ledger-read.js';
import type { CollectedLinkHost, LinkHostProjection } from './types.js';

export function projectLinkHost(
  run: LedgerReadRun | null,
  hosts: readonly CollectedLinkHost[],
  nowMs: number,
  attributionStopped = false
): LinkHostProjection {
  const locator = run?.locator ?? null;
  const unknown: LinkHostProjection = {
    locator,
    state: 'unknown',
    occupantMatches: null,
    checkedAt: null,
    currentState: null,
  };
  if (!run || !locator || locator.runId !== run.runId || locator.bindingGeneration !== run.expectedGeneration)
    return unknown;
  const checks = hosts.filter(
    (host) =>
      host.runId === run.runId &&
      host.bindingGeneration === run.expectedGeneration &&
      canonicalJson(host.locator) === canonicalJson(locator) &&
      Number.isFinite(host.check.checkedAt) &&
      host.check.checkedAt >= 0 &&
      host.check.checkedAt <= nowMs
  );
  // Contradictory or duplicate probe inputs never select whichever happened to arrive last.
  if (checks.length !== 1) return unknown;
  const host = checks[0];
  return {
    locator,
    state: host.check.state,
    occupantMatches: host.check.occupantMatches,
    checkedAt: host.check.checkedAt,
    currentState:
      !attributionStopped && host.check.state === 'valid' && host.check.occupantMatches === true ? host.state : null,
  };
}
