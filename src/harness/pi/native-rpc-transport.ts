import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** The public JSONL protocol, not the bundled package's CLI or private RpcClient fields. */
export type PiRpcRecord = { type: string; [key: string]: unknown };
export interface PiRpcOptions {
  cliPath?: string;
  cwd?: string;
  args?: readonly string[];
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
}
export type PiTransportEvent =
  | { type: 'record'; record: PiRpcRecord }
  | { type: 'disconnected'; reason: string }
  | { type: 'process_exit'; code: number | null; signal: string | null };
export interface PiRpcClient {
  start(): Promise<void>;
  request(type: string, fields?: Record<string, unknown>): Promise<PiRpcRecord>;
  respond(id: string, fields: Record<string, unknown>): Promise<void>;
  onEvent(listener: (event: PiTransportEvent) => void): () => void;
  close(): Promise<unknown>;
}

/** Native rejection and command-wait timeout do not close the process or retry input. */
export class PiRpcError extends Error {
  constructor(
    message: string,
    readonly response?: PiRpcRecord
  ) {
    super(message);
  }
}

export class NativePiRpcClient implements PiRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    string,
    {
      resolve(value: PiRpcRecord): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: PiTransportEvent) => void>();
  private disconnected = false;
  private closing = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<unknown>;

  constructor(private readonly options: PiRpcOptions) {}
  onEvent(listener: (event: PiTransportEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: PiTransportEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private disconnect(reason: string) {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PiRpcError(reason));
    }
    this.pending.clear();
    this.emit({ type: 'disconnected', reason });
  }
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const args = ['--mode', 'rpc', ...(this.options.args ?? [])];
      if (this.options.provider) args.push('--provider', this.options.provider);
      if (this.options.model) args.push('--model', this.options.model);
      const child = (this.child = spawn(this.options.cliPath ?? 'pi', args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: 'pipe',
        shell: false,
      }));
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      child.once('spawn', resolve);
      child.once('error', (error) => {
        reject(error);
        this.disconnect(`pi_spawn_error: ${error.message}`);
      });
      child.stdin.on('error', (error) => this.disconnect(`pi_stdin_error: ${error.message}`));
      child.stdout.on('error', (error) => this.disconnect(`pi_stdout_error: ${error.message}`));
      child.stderr.on('error', (error) =>
        this.emit({ type: 'record', record: { type: 'stderr_error', message: error.message } })
      );
      // Always consume output, including after a local command wait expires. No stderr kill threshold.
      child.stderr.on('data', (chunk: Buffer) =>
        this.emit({ type: 'record', record: { type: 'stderr', text: chunk.toString('utf8') } })
      );
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as PiRpcRecord;
            if (!record || typeof record !== 'object' || typeof record.type !== 'string')
              throw new Error('Expected RPC object');
            if (record.type === 'response' && typeof record.id === 'string' && this.pending.has(record.id)) {
              const pending = this.pending.get(record.id)!;
              this.pending.delete(record.id);
              clearTimeout(pending.timer);
              pending.resolve(record);
            } else {
              this.emit({ type: 'record', record });
            }
          } catch (error) {
            this.emit({ type: 'record', record: { type: 'protocol_error', message: String(error), line } });
          }
        }
      });
      child.stdout.once('end', () => {
        buffer += decoder.end();
        if (buffer.trim())
          this.emit({
            type: 'record',
            record: { type: 'protocol_error', message: 'Truncated JSONL frame', line: buffer },
          });
        this.disconnect('pi_stdout_eof');
      });
      child.once('exit', (code, signal) => {
        this.emit({ type: 'process_exit', code, signal });
        this.disconnect('pi_process_exit');
      });
    });
    return this.startPromise;
  }
  private write(record: PiRpcRecord): Promise<void> {
    if (!this.child || this.disconnected || this.closing)
      return Promise.reject(new PiRpcError('pi_connection_unavailable'));
    return new Promise((resolve, reject) => {
      this.child!.stdin.write(JSON.stringify(record) + '\n', (error) => (error ? reject(error) : resolve()));
    });
  }
  request(type: string, fields: Record<string, unknown> = {}): Promise<PiRpcRecord> {
    if (!this.child || this.disconnected || this.closing)
      return Promise.reject(new PiRpcError('pi_connection_unavailable'));
    const id = `hud-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(`pi_rpc_wait_timeout: ${type}`));
      }, this.options.commandTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ ...fields, type, id }).catch((error: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  respond(id: string, fields: Record<string, unknown>): Promise<void> {
    return this.write({ ...fields, type: 'extension_ui_response', id });
  }
  close(): Promise<unknown> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    // Explicit close sends EOF. Pi owns its shutdown semantics; no abort, signals or kill ladder.
    this.closePromise = new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) return resolve({ stdinEnded: true });
      this.child.stdin.end((error?: Error | null) => (error ? reject(error) : resolve({ stdinEnded: true })));
    });
    return this.closePromise;
  }
}
