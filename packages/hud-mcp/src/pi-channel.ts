import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { PiEvidenceFrame, PiHostHello } from '../../../src/harness/pi/delegation-channel.js';
import { PI_EXTENSION_CONTEXT_PROFILE, inspectPiSnapshot } from '../../../src/harness/pi/delegation-context.js';
import { object } from './io.js';
import { Refusal } from './errors.js';
import { PiHostEvidence } from './pi-host.js';
import type { ProcessReaderPort } from './process.js';

/** fd3 is inherited privately from the direct Pi parent; model _meta is only a lookup ticket.
 * This authenticates the supported host callback, not arbitrary hostile same-UID code.
 */
export class PiEvidenceChannel {
  private sequence = 0;
  private epoch: string | null = null;
  private identity: string | null = null;
  private frames = new Map<string, PiEvidenceFrame>();
  private consumed = new Set<string>();
  private waiters = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private lifetime = new AbortController();
  private hello: PiHostHello | null = null;
  private host: PiHostEvidence | null = null;
  private helloReady: Promise<void>;
  private helloResolve!: () => void;
  private helloReject!: (error: Error) => void;
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  constructor(private readonly input: Readable) {
    this.helloReady = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    void this.helloReady.catch(() => {});
    void this.read();
  }
  async bindHost(reader: ProcessReaderPort, root: string): Promise<PiHostEvidence> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.helloReady,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Refusal('identity_source_missing')), 5000);
        }),
      ]);
      this.assertLive();
      if (this.host || !this.hello) throw new Refusal('identity_unverified');
      this.host = PiHostEvidence.capture(reader, this.hello);
      if (this.host.rootPath !== root) throw new Refusal('identity_unverified');
      this.hello = null;
      return this.host;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  verifyHost(reader: ProcessReaderPort, root: string): void {
    this.assertLive();
    if (!this.host || this.host.rootPath !== root) throw new Refusal('identity_unverified');
    this.host.assertCurrent(reader);
  }
  static inherited(): PiEvidenceChannel {
    if (process.env.HUD_PI_DELEGATION_FD !== '3') throw new Refusal('identity_source_missing');
    for (const fd of [0, 1, 3]) {
      const stat = fstatSync(fd);
      if ((!stat.isFIFO() && !stat.isSocket()) || stat.uid !== process.getuid?.())
        throw new Refusal('identity_unverified');
    }
    // Node's extra spawn pipe is a Unix socket. A fs ReadStream can leave a
    // blocking thread-pool read alive after destroy(), deadlocking startup refusal.
    return new PiEvidenceChannel(new Socket({ fd: 3, readable: true, writable: false }));
  }
  close(): void {
    if (this.signal.aborted) return;
    this.lifetime.abort();
    this.helloReject(new Refusal('stale_context'));
    this.frames.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Refusal('stale_context'));
    }
    this.waiters.clear();
    this.input.destroy();
  }
  assertLive(): void {
    if (this.signal.aborted) throw new Refusal('stale_context');
  }
  private admit(value: unknown): void {
    this.assertLive();
    if (object(value) && value.kind === 'host') {
      if (
        this.hello ||
        this.host ||
        this.sequence !== 0 ||
        value.profile !== PI_EXTENSION_CONTEXT_PROFILE ||
        typeof value.entrypoint !== 'string' ||
        typeof value.sourceRoot !== 'string'
      )
        throw new Refusal('identity_unverified');
      this.hello = value as unknown as PiHostHello;
      this.helloResolve();
      return;
    }
    if (
      !object(value) ||
      !Number.isSafeInteger(value.seq) ||
      value.seq !== this.sequence + 1 ||
      typeof value.ticket !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.ticket) ||
      !object(value.snapshot) ||
      value.snapshot.profile !== PI_EXTENSION_CONTEXT_PROFILE ||
      typeof value.snapshot.epoch !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.snapshot.epoch) ||
      this.frames.has(value.ticket) ||
      this.consumed.has(value.ticket) ||
      this.frames.size >= 32 ||
      this.consumed.size >= 65536
    )
      throw new Refusal('identity_unverified');
    if (this.epoch !== null && value.snapshot.epoch !== this.epoch) throw new Refusal('stale_context');
    this.epoch = value.snapshot.epoch;
    this.sequence = value.seq as number;
    this.frames.set(value.ticket, value as unknown as PiEvidenceFrame);
    const waiter = this.waiters.get(value.ticket);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(value.ticket);
      waiter.resolve();
    }
  }
  private async read(): Promise<void> {
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of this.input) {
        pending = Buffer.concat([pending, chunk as Buffer]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          if (end > 16384) throw Error('pi_evidence_overflow');
          this.admit(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end))));
          pending = pending.subarray(end + 1);
        }
        if (pending.length > 16384) throw Error('pi_evidence_overflow');
      }
    } catch {
      /* A malformed or broken private stream permanently fences this server. */
    } finally {
      this.close();
    }
  }
  async consume(meta: unknown, tool: string, root: string): Promise<PiEvidenceFrame> {
    this.assertLive();
    if (!object(meta) || !object(meta['hud/pi'])) throw new Refusal('identity_source_missing');
    const ticket = meta['hud/pi'].ticket;
    const seq = meta['hud/pi'].seq;
    if (
      typeof ticket !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(ticket) ||
      !Number.isSafeInteger(seq) ||
      this.consumed.has(ticket) ||
      this.waiters.has(ticket)
    )
      throw new Refusal('identity_unverified');
    if (!this.frames.has(ticket)) {
      if (this.waiters.size >= 32) throw new Refusal('identity_unverified');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(ticket);
          reject(new Refusal('identity_source_missing'));
        }, 1000);
        this.waiters.set(ticket, { resolve, reject, timer });
      });
    }
    this.assertLive();
    const frame = this.frames.get(ticket);
    if (
      !frame ||
      frame.seq !== seq ||
      frame.snapshot.toolName !== tool ||
      frame.snapshot.toolCallId !== meta['hud/pi'].callId
    )
      throw new Refusal('identity_unverified');
    this.frames.delete(ticket);
    this.consumed.add(ticket);
    const checked = await inspectPiSnapshot(frame.snapshot, root);
    this.assertLive();
    if (checked.snapshot.status !== 'ready') throw new Refusal('identity_source_missing');
    if (checked.snapshot.headerDigest !== frame.snapshot.headerDigest) throw new Refusal('identity_unverified');
    const identity = JSON.stringify([
      checked.snapshot.sessionId,
      checked.snapshot.sessionDir,
      checked.snapshot.sessionFile,
      checked.identity,
    ]);
    if (this.identity !== null && this.identity !== identity) {
      this.close();
      throw new Refusal('stale_context');
    }
    this.identity = identity;
    return { ...frame, snapshot: checked.snapshot };
  }
}
