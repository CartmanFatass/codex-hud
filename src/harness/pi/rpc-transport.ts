import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { PiRpcObserver, type PiRpcObservation } from './rpc-observation.js';
export interface PiRpcTransportOptions {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  sourceCommit: string;
  timeoutMs?: number;
}
export interface PiRpcBoundary {
  kind: 'settled' | 'aborted' | 'legacy_run_end' | 'no_run' | 'rejected' | 'stopped';
  acceptance: 'unknown' | 'accepted' | 'rejected';
  promptWriteFlushed: boolean;
  observation: PiRpcObservation;
  reason: string | null;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** One explicitly owned RPC child and one prompt. No approval, retry, managed identity or session persistence. */
export class PiRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly observer: PiRpcObserver;
  private readonly timer: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private reapTimer?: NodeJS.Timeout;
  private readonly deadline: number;
  private sent = false;
  private stopped = false;
  private reason: string | null = null;
  private acceptance: PiRpcBoundary['acceptance'] = 'unknown';
  private flushed = false;
  private buffer = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private boundaryResolved = false;
  private resolveBoundary!: (result: PiRpcBoundary) => void;
  private readonly boundary: Promise<PiRpcBoundary>;
  private resolveClosed!: (result: { reaped: boolean; code: number | null; signal: string | null }) => void;
  readonly closed: Promise<{ reaped: boolean; code: number | null; signal: string | null }>;
  constructor(options: PiRpcTransportOptions) {
    const timeout = options.timeoutMs ?? 30_000;
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.cwd) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 300_000
    )
      throw new Error('invalid_pi_rpc_transport_options');
    const now = performance.now();
    this.deadline = now + timeout;
    this.observer = new PiRpcObserver(options.sourceCommit, now, timeout, 'prompt-1');
    this.boundary = new Promise((resolve) => {
      this.resolveBoundary = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const env = { ...options.env };
    for (const key of Object.keys(env))
      if (key.startsWith('HUD_') || key === 'PI_SESSION_ID' || key === 'PI_SESSION_FILE') delete env[key];
    this.child = spawn(options.executable, ['--mode', 'rpc', '--no-session'], {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: 'pipe',
    });
    this.timer = setTimeout(() => {
      this.observer.tick(this.deadline);
      this.stop('deadline');
    }, timeout);
    this.child.on('error', () => this.stop('spawn_error'));
    this.child.stdin.on('error', () => this.stop('stdin_error'));
    this.child.stdout.on('error', () => this.stop('stdout_error'));
    this.child.stderr.on('error', () => this.stop('stderr_error'));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 64 * 1024) this.stop('stderr_limit');
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.once('close', (code, signal) => {
      clearTimeout(this.timer);
      clearTimeout(this.killTimer);
      clearTimeout(this.reapTimer);
      if (!this.reason) this.reason = this.buffer.length ? 'truncated_jsonl' : 'child_close';
      this.stopped = true;
      this.observer.close();
      this.resolve('stopped');
      this.resolveClosed({ reaped: true, code, signal });
    });
  }
  snapshot() {
    return {
      observation: this.observer.snapshot(),
      acceptance: this.acceptance,
      promptWriteFlushed: this.flushed,
      stopped: this.stopped,
      reason: this.reason,
    };
  }
  prompt(message: string): Promise<PiRpcBoundary> {
    if (this.sent || this.stopped) throw new Error('pi_rpc_prompt_unavailable');
    if (typeof message !== 'string') throw new Error('invalid_pi_rpc_prompt');
    const line = JSON.stringify({ id: 'prompt-1', type: 'prompt', message }) + '\n';
    if (Buffer.byteLength(line) > 64 * 1024) throw new Error('pi_rpc_prompt_limit');
    this.sent = true;
    // Single bounded write: its callback is the local backpressure/flush receipt, not consumption proof.
    this.child.stdin.write(line, (error) => {
      if (error) {
        this.stop('stdin_error');
        return;
      }
      this.flushed = true;
      this.checkBoundary();
    });
    return this.boundary;
  }
  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > 4 * 1024 * 1024) {
      this.stop('stdout_limit');
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while (!this.stopped && (newline = this.buffer.indexOf(10)) >= 0) {
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (bytes.length > 64 * 1024) {
        this.stop('line_limit');
        return;
      }
      let record: unknown;
      try {
        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        this.stop('invalid_jsonl');
        return;
      }
      if (!object(record) || typeof record.type !== 'string') {
        this.stop('invalid_record');
        return;
      }
      if (!this.sent) {
        this.stop('unsolicited_event');
        return;
      }
      if (record.type === 'extension_ui_request') {
        this.stop('unsupported_ui_request');
        return;
      }
      if (record.type === 'response') {
        if (
          record.id !== 'prompt-1' ||
          record.command !== 'prompt' ||
          typeof record.success !== 'boolean' ||
          this.acceptance !== 'unknown'
        ) {
          this.stop('uncorrelated_response');
          return;
        }
        this.acceptance = record.success ? 'accepted' : 'rejected';
      }
      const observed = this.observer.observe(record, performance.now());
      if (observed.malformed || observed.stopped) {
        this.stop(observed.stopped ?? 'invalid_event');
        return;
      }
      this.checkBoundary();
    }
    if (this.buffer.length > 64 * 1024) this.stop('line_limit');
  }
  private checkBoundary(): void {
    if (this.stopped || !this.flushed || this.acceptance === 'unknown') return;
    if (this.acceptance === 'rejected') {
      this.resolve('rejected');
      return;
    }
    const s = this.observer.snapshot();
    if (s.profile === 'settled-v1') {
      if (s.state === 'settled' && s.quiescence === 'reported') this.resolve('settled');
      if (s.state === 'aborted' && s.quiescence === 'reported') this.resolve('aborted');
      if (s.state === 'no_run') this.resolve('no_run');
    } else if (s.profile === 'v0.73.1' && s.state === 'run_ended') this.resolve('legacy_run_end');
  }
  private resolve(kind: PiRpcBoundary['kind']): void {
    if (this.boundaryResolved) return;
    this.boundaryResolved = true;
    this.resolveBoundary({
      kind,
      acceptance: this.acceptance,
      promptWriteFlushed: this.flushed,
      observation: this.observer.snapshot(),
      reason: this.reason,
    });
  }
  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    clearTimeout(this.timer);
    this.observer.close();
    this.resolve('stopped');
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 250);
    this.reapTimer = setTimeout(() => this.resolveClosed({ reaped: false, code: null, signal: null }), 1500);
  }
  shutdown() {
    this.stop('shutdown');
    return this.closed;
  }
}
