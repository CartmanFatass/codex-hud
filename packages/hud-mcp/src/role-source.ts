/** Role-only source composition. Does not load registration, a ledger or an execution host. */
import { randomUUID } from 'node:crypto';
import { makeSourceId } from '../../../src/core/identity.js';
import { liveProbe, type CallerProbe } from '../../../src/roles/caller.js';
import { NativeCallerResolver } from '../../../src/roles/caller-resolve.js';
import { Refusal, outcomeCode } from './errors.js';
import { PiEvidenceChannel } from './pi-channel.js';
import type { PiHostEvidence } from './pi-host.js';
import { LinuxProcessReader, type ProcessReaderPort } from './process.js';
import type { CallResolution, CurrentCallSourcePort } from './resolvers.js';

type Resolved = Extract<CallResolution, { ok: true }>;
export class RoleCallSource implements CurrentCallSourcePort {
  private readonly native: NativeCallerResolver;
  private readonly checks = new WeakMap<Resolved, () => void>();
  private host: Promise<PiHostEvidence> | null = null;
  constructor(
    probe: CallerProbe = liveProbe(process.env),
    private readonly pi: PiEvidenceChannel | null = null,
    private readonly reader: ProcessReaderPort = new LinuxProcessReader()
  ) {
    this.native = new NativeCallerResolver(probe);
  }
  async resolve(meta: unknown, toolName: string): Promise<CallResolution> {
    try {
      let resolved: Resolved;
      let check: () => void;
      if (this.pi) {
        this.host ??= this.pi.bindHost(this.reader);
        const host = await this.host;
        this.pi.verifyHost(this.reader, host.rootPath);
        const frame = await this.pi.consume(meta, toolName, host.rootPath);
        this.pi.verifyHost(this.reader, host.rootPath);
        const snapshot = frame.snapshot;
        resolved = {
          ok: true,
          callId: snapshot.toolCallId,
          sessionRef: {
            harness: 'pi',
            sourceId: makeSourceId('pi', host.rootPath),
            sessionId: snapshot.sessionId,
            threadId: null,
          },
          processKey: `pi:${host.parentPid}:${host.parentStart}`,
          evidenceDigest: `${snapshot.epoch}:${snapshot.headerDigest}`,
        };
        check = () => this.pi!.verifyHost(this.reader, host.rootPath);
      } else {
        const current = this.native.resolve();
        if (!current.ok) return current;
        resolved = {
          ok: true,
          callId: randomUUID(),
          sessionRef: {
            harness: current.identity.harness,
            sourceId: current.identity.root.namespace,
            sessionId: current.identity.root.sessionId,
            threadId: null,
          },
          processKey: current.processKey,
          evidenceDigest: current.evidenceDigest,
        };
        check = () => this.native.assertCurrent(current);
      }
      this.checks.set(resolved, check);
      return resolved;
    } catch (error) {
      const code = outcomeCode(error);
      return {
        ok: false,
        code: ['identity_source_missing', 'stale_context'].includes(code)
          ? (code as 'identity_source_missing' | 'stale_context')
          : 'identity_unverified',
      };
    }
  }
  assertCurrent(source: Resolved): void {
    const check = this.checks.get(source);
    this.checks.delete(source);
    if (!check) throw new Refusal('identity_unverified');
    check();
  }
}
