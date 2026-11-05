import { createServer, createConnection, type Socket } from 'node:net';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionRef } from '../types/identity.js';
import { randomUUID } from 'node:crypto';
import { isRunTerminal } from '../execution.js';
import { sameProcessStamp } from '../supervision.js';
import { readProcess } from './process.js';
import { RunArtifacts } from './artifacts.js';
import { createRunFactPort } from './ledger-port.js';
import type { RunFactPort } from './port.js';
import type { ProcessStamp } from '../types/supervision.js';

export interface RunChatTarget {
  linkId: string;
  runId: string;
  sourceId: string;
  bindingGeneration: number;
}
export interface ResolvedRunChatTarget extends RunChatTarget {
  sessionRef: SessionRef;
  supervisor: ProcessStamp;
  harnessProcess: ProcessStamp;
}
export type ChatProtocolEvent =
  | { type: 'accepted'; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'boundary' }
  | { type: 'error'; code: string; turnId?: string };
/** Trusted launch composition only. Neither endpoint clients nor JSON launch input can provide code. */
export interface ChatProtocol {
  readonly name: string;
  encode(text: string, turnId: string): Buffer;
  consume(chunk: Buffer): ChatProtocolEvent[];
}
const sameTarget = (a: RunChatTarget, b: RunChatTarget) =>
  a.linkId === b.linkId &&
  a.runId === b.runId &&
  a.sourceId === b.sourceId &&
  a.bindingGeneration === b.bindingGeneration;
export async function resolveRunChatTarget(
  port: RunFactPort,
  selected: Omit<RunChatTarget, 'bindingGeneration'>
): Promise<ResolvedRunChatTarget> {
  const s = await port.read(selected.runId),
    r = s.run,
    m = s.meta,
    b = s.currentChildBinding;
  if (
    r.linkId !== selected.linkId ||
    r.sourceId !== selected.sourceId ||
    r.runId !== selected.runId ||
    !b ||
    !b.isCurrent ||
    b.revokedAt !== null ||
    b.runId !== r.runId ||
    b.bindingGeneration !== r.expectedGeneration ||
    b.sessionRef.sourceId !== r.sourceId ||
    b.sessionRef.harness !== r.harness ||
    !isDeepStrictEqual(b.sessionRef, s.status.link.childRef) ||
    !m ||
    m.run_id !== r.runId ||
    m.binding_generation !== r.expectedGeneration ||
    m.link_id !== r.linkId ||
    m.source_id !== r.sourceId ||
    !s.retirement?.authorityValid ||
    !s.slotHeld ||
    s.retirement?.currentRunId !== r.runId ||
    !s.status.link.currentOwner ||
    ['closed', 'failed', 'revoked', 'handed_over'].includes(s.status.link.state) ||
    s.status.runHandshake.state !== 'bound' ||
    s.controlConflict ||
    r.state !== 'running' ||
    isRunTerminal(r) ||
    r.cancelRequestedAt !== null ||
    !r.supervisor ||
    !m.harness ||
    !sameProcessStamp(r.supervisor, m.supervisor) ||
    !sameProcessStamp(readProcess(r.supervisor.pid)?.stamp ?? null, r.supervisor) ||
    ['Z', 'X'].includes(readProcess(r.supervisor.pid)?.state ?? 'X') ||
    ['Z', 'X'].includes(readProcess(m.harness.pid)?.state ?? 'X') ||
    !sameProcessStamp(readProcess(m.harness.pid)?.stamp ?? null, m.harness)
  )
    throw new Error('run_chat_unavailable');
  return {
    linkId: r.linkId,
    runId: r.runId,
    sourceId: r.sourceId,
    bindingGeneration: r.expectedGeneration,
    sessionRef: b.sessionRef,
    supervisor: r.supervisor,
    harnessProcess: m.harness,
  };
}
function pinFor(home: string, target: RunChatTarget) {
  const pin = RunArtifacts.open(home, target.runId).pinDirectory();
  return { ...pin, socketPath: join(pin.path, 'chat.sock') };
}
function send(socket: Socket, value: unknown) {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > 131072 || socket.writableLength > 262144) {
    socket.destroy();
    return;
  }
  socket.write(frame);
}
function frames(socket: Socket, receive: (value: unknown) => void) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    if (buffer.length + chunk.length > 131072) {
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    let i: number;
    while ((i = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, i);
      buffer = buffer.subarray(i + 1);
      try {
        receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Bounded diagnostics only; never expose OS error messages, paths or request text. */
export function chatEndpointFailure(error: unknown): string {
  const code = record(error) ? error.code : undefined;
  return typeof code === 'string' &&
    ['EPERM', 'EACCES', 'EADDRINUSE', 'ENAMETOOLONG', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(code)
    ? code
    : error instanceof Error && error.message === 'chat_pipe_unavailable'
      ? 'chat_pipe_unavailable'
      : 'chat_endpoint_unavailable';
}

/** Owned by the existing supervisor. No replay, persistence, spawn, resume or process kill. */
export class RunChatChannel {
  private server = createServer((socket) => this.connect(socket));
  private client: Socket | null = null;
  private sockets = new Set<Socket>();
  private pending: { id: string; socket: Socket; timer: NodeJS.Timeout } | null = null;
  private failed = false;
  private identity: ResolvedRunChatTarget | null = null;
  private readonly connectionId = randomUUID();
  private eventTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private path: string | null = null;
  private directory: ReturnType<typeof pinFor> | null = null;
  private stamp: { dev: number; ino: number } | null = null;
  private write: ((bytes: Buffer) => Promise<void>) | null = null;
  constructor(
    private readonly protocol: ChatProtocol,
    private readonly port: RunFactPort,
    private readonly home: string,
    private readonly target: RunChatTarget,
    private readonly supervisor: ProcessStamp
  ) {}
  private async valid() {
    this.directory?.check();
    const target = await resolveRunChatTarget(this.port, this.target);
    this.directory?.check();
    if (
      !sameTarget(target, this.target) ||
      !sameProcessStamp(target.supervisor, this.supervisor) ||
      this.failed ||
      (this.identity && !isDeepStrictEqual(this.identity, target))
    )
      throw new Error('run_chat_unavailable');
    this.identity ??= target;
    return target;
  }
  async listen(write: (bytes: Buffer) => Promise<void>) {
    this.write = write;
    this.directory = pinFor(this.home, this.target);
    this.path = this.directory.socketPath;
    // Never replace another supervisor's endpoint or an old endpoint after a crash.
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path!, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.directory.check();
    this.stamp = lstatSync(this.path);
    this.server.on('error', () => this.fail());
  }
  private connect(socket: Socket) {
    if (this.sockets.size >= 4 || this.failed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let authenticated = false;
    let handling: symbol | null = null;
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.client === socket) this.client = null;
    });
    frames(socket, (v) => {
      if (handling) {
        socket.destroy();
        return;
      }
      const admission = Symbol();
      handling = admission;
      let requestId: string | undefined;
      // A protocol response may clear pending before the pipe callback settles.
      // Once I/O was attempted, a later failure cannot prove non-submission.
      let writeAttempted = false;
      void (async () => {
        if (!record(v)) throw new Error('invalid_chat_frame');
        if (!authenticated) {
          if (
            v.type !== 'attach' ||
            !record(v.target) ||
            !sameTarget(v.target as unknown as RunChatTarget, this.target) ||
            this.client
          )
            throw new Error('run_chat_unavailable');
          await this.valid();
          if (socket.destroyed || this.client) throw new Error('run_chat_unavailable');
          this.client = socket;
          authenticated = true;
          socket.setTimeout(0);
          send(socket, {
            type: 'ready',
            target: this.target,
            identity: this.identity,
            connectionId: this.connectionId,
            protocol: this.protocol.name,
          });
          return;
        }
        if (
          v.type !== 'send' ||
          typeof v.id !== 'string' ||
          !/^[-\w]{1,128}$/.test(v.id) ||
          typeof v.text !== 'string' ||
          !v.text.trim() ||
          Buffer.byteLength(v.text) > 32768 ||
          this.pending
        )
          throw new Error('invalid_chat_send');
        requestId = v.id;
        await this.valid();
        if (socket.destroyed || this.client !== socket) throw new Error('run_chat_unavailable');
        const bytes = this.protocol.encode(v.text, v.id);
        if (bytes.length > 65536) throw new Error('chat_input_limit');
        const timer = setTimeout(() => this.fail(), 30000);
        this.pending = { id: v.id, socket, timer };
        writeAttempted = true;
        const submitted = this.write!(bytes);
        // Admission is complete once I/O starts. A correlated ACK can arrive before
        // the write callback; the next explicit send must not see a stale lock.
        // The pending command still prevents admission before that ACK.
        if (handling === admission) handling = null;
        await submitted; // This acknowledges pipe submission only, not consumption.
        if (!socket.destroyed && this.pending?.id === v.id) send(socket, { type: 'submitted', id: v.id });
      })()
        .catch(() => {
          if (writeAttempted || this.pending?.socket === socket) this.fail();
          else {
            send(socket, requestId ? { type: 'not_submitted', id: requestId } : { type: 'unavailable' });
            socket.setTimeout(1000, () => socket.destroy());
            socket.end();
          }
        })
        .finally(() => {
          if (handling === admission) handling = null;
        });
    });
  }
  consume(chunk: Buffer) {
    if (this.failed) return;
    try {
      const events = this.protocol.consume(chunk);
      if (events.length > 4096) throw new Error('chat_event_limit');
      this.queuedBytes += chunk.length;
      if (this.queuedBytes > 1048576) throw new Error('chat_queue_limit');
      this.eventTail = this.eventTail
        .then(async () => {
          try {
            if (this.client || this.pending) await this.valid();
            if (this.failed) return;
            for (const e of events) {
              if (e.type === 'error') {
                if (e.code === 'rejected' && this.pending && e.turnId === this.pending.id) {
                  const p = this.pending;
                  clearTimeout(p.timer);
                  this.pending = null;
                  send(p.socket, { type: 'rejected', id: p.id });
                  continue;
                }
                this.fail();
                return;
              }
              if (e.type === 'accepted') {
                if (!this.pending || this.pending.id !== e.turnId) {
                  this.fail();
                  return;
                }
                const p = this.pending;
                clearTimeout(p.timer);
                this.pending = null;
                send(p.socket, { type: 'accepted', id: e.turnId });
              } else if (e.type === 'delta' && this.client) send(this.client, { type: 'text', text: e.text });
              // Id-less boundaries never acknowledge a submitted prompt.
            }
          } finally {
            this.queuedBytes -= chunk.length;
          }
        })
        .catch(() => this.fail());
    } catch {
      this.fail();
    }
  }
  private fail() {
    this.failed = true;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    for (const s of this.sockets) {
      send(s, { type: 'outcome_unknown' });
      s.destroy();
    }
  }
  close() {
    this.fail();
    this.server.close();
    if (this.path && this.stamp) {
      try {
        const s = lstatSync(this.path);
        if (s.dev === this.stamp.dev && s.ino === this.stamp.ino) unlinkSync(this.path);
      } catch {}
    }
    this.directory?.close();
    this.directory = null;
  }
}

export interface RunChatSession {
  readonly id: string;
  readonly label: string;
  snapshot(): { status: 'starting' | 'ready' | 'busy' | 'stopped' | 'uncertain'; detail?: string };
  subscribe(listener: (event: { type: 'text'; text: string } | { type: 'status' }) => void): () => void;
  send(text: string): Promise<void>;
  close(): Promise<void>;
}
/** Explicit local-user action; never discovers or launches another agent. */
export async function openSelectedRunChat(
  home: string,
  selected: Omit<RunChatTarget, 'bindingGeneration'>
): Promise<RunChatSession> {
  const port = await createRunFactPort(home);
  try {
    return await connectRunChat(home, await resolveRunChatTarget(port, selected), port, () => port.close());
  } catch (error) {
    await port.close();
    throw error;
  }
}
export async function connectRunChat(
  home: string,
  target: RunChatTarget,
  port: RunFactPort,
  onClose: () => Promise<void> = async () => {}
): Promise<RunChatSession> {
  const identity = await resolveRunChatTarget(port, target);
  if (!sameTarget(identity, target)) throw new Error('run_chat_unavailable');
  const directory = pinFor(home, target);
  const path = directory.socketPath;
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error('run_chat_unavailable');
    directory.check();
  } catch (error) {
    directory.close();
    throw error;
  }
  const socket = createConnection(path);
  let status: 'starting' | 'ready' | 'busy' | 'stopped' | 'uncertain' = 'starting';
  const listeners = new Set<(e: { type: 'text'; text: string } | { type: 'status' }) => void>();
  let pending: { id: string; resolve: () => void; reject: (e: Error) => void } | null = null,
    closed = false;
  const emit = (e: { type: 'text'; text: string } | { type: 'status' }) => {
    for (const fn of listeners) fn(e);
  };
  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  const ready = new Promise<void>((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  const timer = setTimeout(() => socket.destroy(new Error('run_chat_unavailable')), 5000);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    status = pending ? 'uncertain' : 'stopped';
    pending?.reject(new Error('outcome_unknown'));
    pending = null;
    readyReject(new Error('run_chat_unavailable'));
    emit({ type: 'status' });
    directory.close();
    void onClose().catch(() => {});
  };
  socket.on('error', finish);
  socket.on('close', finish);
  frames(socket, (v) => {
    if (!record(v)) return socket.destroy();
    if (
      v.type === 'ready' &&
      status === 'starting' &&
      record(v.target) &&
      sameTarget(v.target as unknown as RunChatTarget, target) &&
      isDeepStrictEqual(v.identity, identity) &&
      typeof v.connectionId === 'string' &&
      typeof v.protocol === 'string'
    ) {
      clearTimeout(timer);
      status = 'ready';
      readyResolve();
    } else if (v.type === 'accepted' && pending && v.id === pending.id) {
      const p = pending;
      pending = null;
      status = 'ready';
      p.resolve();
    } else if (v.type === 'not_submitted' && pending && v.id === pending.id) {
      const p = pending;
      pending = null;
      status = 'stopped';
      p.reject(new Error('chat_not_submitted'));
      socket.destroy();
    } else if (v.type === 'rejected' && pending && v.id === pending.id) {
      const p = pending;
      pending = null;
      status = 'ready';
      p.reject(new Error('chat_server_rejected'));
    } else if (v.type === 'text' && typeof v.text === 'string') emit({ type: 'text', text: v.text });
    else if (v.type !== 'submitted') {
      socket.destroy();
      return;
    }
    emit({ type: 'status' });
  });
  socket.once('connect', () => send(socket, { type: 'attach', target }));
  try {
    await ready;
    directory.check();
  } catch (error) {
    socket.destroy();
    finish();
    throw error;
  }
  return {
    id: JSON.stringify(identity),
    label: `Run ${target.runId}`,
    snapshot: () => ({ status }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(text) {
      if (status !== 'ready' || !text.trim() || Buffer.byteLength(text) > 32768)
        throw new Error('run_chat_unavailable');
      directory.check();
      status = 'busy';
      emit({ type: 'status' });
      let deadline: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          const unknown = !!pending;
          socket.destroy();
          finish();
          reject(new Error(unknown ? 'outcome_unknown' : 'run_chat_unavailable'));
        }, 30000);
      });
      try {
        await Promise.race([
          timeout,
          (async () => {
            if (!isDeepStrictEqual(await resolveRunChatTarget(port, target), identity) || closed)
              throw new Error('run_chat_unavailable');
            directory.check();
            await new Promise<void>((resolve, reject) => {
              const id = randomUUID();
              pending = { id, resolve, reject };
              send(socket, { type: 'send', id, text });
            });
          })(),
        ]);
      } catch (error) {
        if (!(error instanceof Error && error.message === 'chat_server_rejected')) socket.destroy();
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    },
    async close() {
      socket.destroy();
      finish();
    },
  };
}
