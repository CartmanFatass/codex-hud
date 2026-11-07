/** One owned stdio MCP connection. No automatic retries, even on uncertain writes. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { PiContextSnapshot } from './delegation-context.js';
import { PI_EXTENSION_CONTEXT_PROFILE } from './delegation-context.js';

export interface PiMcpResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}
export interface PiEvidenceFrame {
  seq: number;
  ticket: string;
  snapshot: PiContextSnapshot;
}
export interface PiHostHello {
  kind: 'host';
  profile: string;
  /** Optional native diagnostic, not an admission gate. */
  version?: string;
  pid: number;
  entrypoint: string;
  sourceRoot: string;
  argv: string[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export class PiDelegationChannel {
  readonly child: ChildProcess;
  private sequence = 0;
  private rpcId = 0;
  private closed = false;
  private input: Writable;
  private evidence: Writable;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private closedPromise: Promise<void>;
  readonly ready: Promise<void>;

  constructor(options: { entry: string; env: NodeJS.ProcessEnv; cwd: string; sourceRoot: string }) {
    const env: NodeJS.ProcessEnv = { ...options.env, HUD_PI_DELEGATION_FD: '3' };
    // Product composition never inherits lab registry or run-port substitutions.
    delete env.HUD_MCP_REGISTRY_DIR;
    delete env.HUD_RUN_PORT_MODULE;
    this.child = spawn(process.execPath, [options.entry], {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.input = this.child.stdin!;
    this.evidence = this.child.stdio[3] as Writable;
    this.closedPromise = new Promise((resolve) =>
      this.child.once('close', () => {
        this.fail();
        resolve();
      })
    );
    this.child.once('exit', () => {
      // Descendants must not retain our lifecycle through inherited output fds.
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
    });
    this.child.once('error', () => this.fail());
    this.input.on('error', () => this.fail());
    this.evidence.on('error', () => this.fail());
    // Drain diagnostics without exposing paths, arguments or inherited credentials to tools.
    this.child.stderr!.resume();
    void this.read(this.child.stdout!);
    const hello: PiHostHello = {
      kind: 'host',
      profile: PI_EXTENSION_CONTEXT_PROFILE,
      pid: process.pid,
      entrypoint: process.argv[1],
      sourceRoot: options.sourceRoot,
      argv: [...process.argv],
    };
    // Keep ownership reachable even if bootstrap serialization/write fails.
    this.ready = Promise.resolve()
      .then(() => {
        this.send(this.evidence, hello);
        return this.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hud-pi-extension', version: '1' },
        });
      })
      .then((result) => {
        if (!object(result) || !object(result.serverInfo) || result.serverInfo.name !== 'hud-mcp')
          throw Error('invalid_mcp_server');
        this.send(this.input, { jsonrpc: '2.0', method: 'notifications/initialized' });
      })
      .catch((error) => {
        this.fail();
        throw error;
      });
    void this.ready.catch(() => {});
  }
  isClosed(): boolean {
    return this.closed;
  }
  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(Error('pi_channel_closed_outcome_unknown'));
    }
    this.pending.clear();
    this.input.destroy();
    this.evidence.destroy();
    this.child.kill('SIGTERM');
    const child = this.child;
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
  async close(): Promise<void> {
    this.fail();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.closedPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('pi_cleanup_uncertain')), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private send(stream: Writable, value: unknown): void {
    if (this.closed || stream.destroyed) throw Error('pi_channel_closed');
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > 262144) throw Error('pi_request_too_large');
    // A false return is backpressure, not permission to resend. Bounded pending map limits buffering.
    stream.write(line);
  }
  private async read(stream: Readable): Promise<void> {
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, chunk as Buffer]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          if (end > 1024 * 1024) throw Error('pi_response_too_large');
          const value: unknown = JSON.parse(pending.subarray(0, end).toString('utf8'));
          pending = pending.subarray(end + 1);
          if (!object(value) || value.jsonrpc !== '2.0' || typeof value.id !== 'number')
            throw Error('invalid_mcp_response');
          const item = this.pending.get(value.id);
          if (!item) throw Error('unexpected_mcp_response');
          this.pending.delete(value.id);
          item.cleanup();
          if (value.error) item.reject(Error('mcp_request_failed'));
          else item.resolve(value.result);
        }
        if (pending.length > 1024 * 1024) throw Error('pi_response_too_large');
      }
    } catch {
      /* Never replay an unknown outcome. */
    } finally {
      this.fail();
    }
  }
  private request(method: string, params: unknown, signal?: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    if (this.closed || signal?.aborted) return Promise.reject(Error('pi_channel_unavailable'));
    if (this.pending.size >= 32) return Promise.reject(Error('pi_channel_busy'));
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail();
      const timer = setTimeout(abort, 135000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try {
        beforeSend?.();
        this.send(this.input, { jsonrpc: '2.0', id, method, params });
      } catch {
        this.fail();
      }
    });
  }
  async call(snapshot: PiContextSnapshot, args: Record<string, unknown>, signal?: AbortSignal): Promise<PiMcpResult> {
    // Bridge has awaited readiness and rechecked context. Do not yield before both writes.
    const frame: PiEvidenceFrame = { seq: this.sequence + 1, ticket: randomUUID(), snapshot };
    const result = await this.request(
      'tools/call',
      {
        name: snapshot.toolName,
        arguments: args,
        _meta: { 'hud/pi': { seq: frame.seq, ticket: frame.ticket, callId: snapshot.toolCallId } },
      },
      signal,
      () => {
        // Allocate sequence only after request admission, never on busy/abort.
        this.sequence = frame.seq;
        this.send(this.evidence, frame);
      }
    );
    if (!object(result) || !Array.isArray(result.content)) throw Error('invalid_mcp_result');
    return result as unknown as PiMcpResult;
  }
}
