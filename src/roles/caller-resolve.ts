/** Per-admission native caller resolution. No cwd lookup, tool arguments, or env bearer. */
import { createHash } from 'node:crypto';
import { callerAncestry, currentNativeCaller, type CallerIdentity, type CallerProbe } from './caller.js';

export type CallerRefusal = 'identity_source_missing' | 'identity_unverified' | 'stale_context';
export type CallerResolution =
  | { ok: true; identity: CallerIdentity; processKey: string; evidenceDigest: string }
  | { ok: false; code: CallerRefusal };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class NativeCallerResolver {
  private readonly ancestry: string | null;
  constructor(private readonly probe: CallerProbe) {
    // Pin physical ownership, not logical session identity. A recycled PID cannot inherit this transport.
    this.ancestry = callerAncestry(probe)?.stamp ?? null;
  }
  resolve(): CallerResolution {
    const before = callerAncestry(this.probe);
    if (!before || !this.ancestry) return { ok: false, code: 'identity_source_missing' };
    if (before.stamp !== this.ancestry) return { ok: false, code: 'stale_context' };
    const identity = currentNativeCaller(this.probe);
    const after = callerAncestry(this.probe);
    if (!after || after.stamp !== before.stamp) return { ok: false, code: 'stale_context' };
    if (!identity) return { ok: false, code: 'identity_unverified' };
    return {
      ok: true,
      identity,
      processKey: digest([before.harness, before.stamp]),
      evidenceDigest: digest(identity),
    };
  }
  /** Synchronous final fence after the MCP await, immediately before facade dispatch. */
  assertCurrent(captured: Extract<CallerResolution, { ok: true }>): void {
    const now = this.resolve();
    if (!now.ok || now.processKey !== captured.processKey || now.evidenceDigest !== captured.evidenceDigest)
      throw Object.assign(new Error('stale_context'), { code: 'stale_context' });
  }
}
