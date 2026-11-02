import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import type { WakeRegistration } from '../../ledger/notify-events.js';

export interface WakeMessageDetails {
  linkId: string;
  runs: { runId: string; kind: string; seq: number }[];
  throughSeq: number;
  contextGeneration: number;
}
export interface WakeAdapterResult {
  result: 'accepted' | 'rejected' | 'unknown';
  reason?: string;
}
export const WAKE_OUTPUT_BYTES = 4096;
export const WAKE_REQUEST_BYTES = 65536;

export interface WakeAdapterOptions {
  /** Direct executable verified by the parent; never loaded from a ledger payload or PATH. */
  codexExecutable?: string;
  /** May shorten, but cannot extend, the production 2 s deadline. */
  timeoutMs?: number;
}

/** One transport in flight, with an explicit shutdown/reap boundary for hud-mcp. */
export class WakeAdapters {
  private active?: { abort: AbortController; done: Promise<WakeAdapterResult> };
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: WakeAdapterOptions = {}) {
    const timeout = options.timeoutMs ?? 2000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('invalid wake timeout');
    this.timeoutMs = Math.min(timeout, 2000);
  }

  send(
    registration: WakeRegistration,
    content: string,
    details: WakeMessageDetails,
    signal?: AbortSignal
  ): Promise<WakeAdapterResult> {
    if (this.closed || signal?.aborted) return Promise.resolve({ result: 'unknown', reason: 'aborted' });
    if (this.active) return Promise.resolve({ result: 'unknown', reason: 'busy' });
    if (!content || Buffer.byteLength(content) > 512 || /[\r\n\0]/.test(content))
      return Promise.resolve({ result: 'rejected', reason: 'invalid_message' });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = this.transport(registration, content, details, abort.signal).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      this.active = undefined;
    });
    this.active = { abort, done };
    return done;
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }

  private transport(
    registration: WakeRegistration,
    content: string,
    details: WakeMessageDetails,
    signal: AbortSignal
  ): Promise<WakeAdapterResult> {
    if (registration.adapter === 'codex_queue_v1') {
      const { codexHome, threadId } = registration.target as Record<string, unknown>;
      const executable = this.options.codexExecutable;
      if (
        typeof executable !== 'string' ||
        !isAbsolute(executable) ||
        typeof codexHome !== 'string' ||
        !isAbsolute(codexHome) ||
        typeof threadId !== 'string' ||
        !threadId ||
        threadId.includes('\0')
      )
        return Promise.resolve({ result: 'rejected', reason: 'unverified_target' });
      return this.codex(executable, codexHome, threadId, content, signal);
    }
    if (registration.adapter === 'pi_extension_v1') {
      const { socketPath } = registration.target as Record<string, unknown>;
      if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0'))
        return Promise.resolve({ result: 'rejected', reason: 'no_endpoint' });
      let request: string;
      try {
        request =
          JSON.stringify({
            parentSessionId: registration.parentRef.sessionId,
            content,
            details,
            command: 'read the ledger',
          }) + '\n';
      } catch {
        return Promise.resolve({ result: 'rejected', reason: 'invalid_message' });
      }
      if (Buffer.byteLength(request) > WAKE_REQUEST_BYTES)
        return Promise.resolve({ result: 'rejected', reason: 'invalid_message' });
      return this.pi(socketPath, request, signal);
    }
    return Promise.resolve({ result: 'rejected', reason: 'unsupported_adapter' });
  }

  private codex(
    executable: string,
    codexHome: string,
    threadId: string,
    content: string,
    signal: AbortSignal
  ): Promise<WakeAdapterResult> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(executable, ['queue', '--thread', threadId, '--message', content], {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        resolve({ result: 'rejected', reason: 'unavailable' });
        return;
      }
      let output = Buffer.alloc(0);
      let stopped: string | undefined;
      let settled = false;
      let exited = false;
      const stop = (reason: string) => {
        if (settled || stopped) return;
        stopped = reason;
        child.kill('SIGKILL');
        // Descendant-inherited pipes must not delay reaping our direct child.
        child.stdout.destroy();
        child.stderr.destroy();
        if (exited) finish({ result: 'unknown', reason });
      };
      const onAbort = () => stop('aborted');
      const timer = setTimeout(() => stop('timeout'), this.timeoutMs);
      const finish = (result: WakeAdapterResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(result);
      };
      const consume = (chunk: Buffer) => {
        const room = WAKE_OUTPUT_BYTES - output.length;
        output = Buffer.concat([output, chunk.subarray(0, room)]);
        if (chunk.length > room) stop('output_limit');
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', () => finish({ result: 'rejected', reason: 'unavailable' }));
      // exit proves waitpid reaped our child. Drain its output through close;
      // inherited writers cannot extend that wait beyond the same deadline.
      child.once('exit', () => {
        exited = true;
        if (stopped) finish({ result: 'unknown', reason: stopped });
      });
      child.once('close', (code) => {
        if (stopped) finish({ result: 'unknown', reason: stopped });
        else if (code === 0) finish({ result: 'accepted' });
        else {
          const text = output.toString('utf8').toLowerCase();
          const reason = text.includes('archived') ? 'archived' : text.includes('guard') ? 'guard' : 'command_failed';
          finish({ result: 'rejected', reason });
        }
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private pi(socketPath: string, request: string, signal: AbortSignal): Promise<WakeAdapterResult> {
    return new Promise((resolve) => {
      const socket = createConnection(socketPath);
      let output = Buffer.alloc(0);
      let connected = false;
      let settled = false;
      const finish = (result: WakeAdapterResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve(result);
      };
      const onAbort = () => finish({ result: 'unknown', reason: 'aborted' });
      const timer = setTimeout(() => finish({ result: 'unknown', reason: 'timeout' }), this.timeoutMs);
      socket.once('connect', () => {
        connected = true;
        socket.write(request);
      });
      socket.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > WAKE_OUTPUT_BYTES)
          return finish({ result: 'unknown', reason: 'output_limit' });
        output = Buffer.concat([output, chunk]);
        if (output.includes(10)) parse();
      });
      const parse = () => {
        try {
          const reply: unknown = JSON.parse(output.toString('utf8'));
          if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error();
          const r = reply as Record<string, unknown>;
          if (
            Object.keys(r).some((key) => key !== 'result' && key !== 'reason') ||
            !['accepted', 'rejected', 'unknown'].includes(r.result as string) ||
            (r.reason !== undefined && (typeof r.reason !== 'string' || !/^[a-z_]{1,64}$/.test(r.reason)))
          )
            throw new Error();
          finish(r as unknown as WakeAdapterResult);
        } catch {
          finish({ result: 'unknown', reason: 'invalid_response' });
        }
      };
      socket.once('end', () => {
        if (output.length) parse();
        else finish({ result: 'unknown', reason: 'no_response' });
      });
      socket.once('error', () =>
        finish(
          connected ? { result: 'unknown', reason: 'transport_error' } : { result: 'rejected', reason: 'no_endpoint' }
        )
      );
      socket.once('close', () => finish({ result: 'unknown', reason: 'no_response' }));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
