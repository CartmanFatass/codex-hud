/** Observation-only Codex exec JSONL, NOT rollout files or app-server JSON-RPC. */
export const CODEX_EXEC_SCHEMA = 'openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d';
export interface ExecObservation {
  schema: string;
  threadId: string | null;
  turn: 'unknown' | 'running' | 'completed' | 'failed';
  transport: 'open' | 'closed' | 'interrupted';
  itemEvents: number;
  lastItem: { id: string; type: string; event: string } | null;
  usage: { input: number; cachedInput: number; output: number } | null;
  unknownEvents: number;
  malformed: number;
  streamError: boolean;
  complete: boolean;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
/** One invocation, bounded bytes/record; callers must supply actual transport termination separately. */
export class CodexExecJsonReader {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private closed = false;
  private finished = false;
  private state: ExecObservation = {
    schema: CODEX_EXEC_SCHEMA,
    threadId: null,
    turn: 'unknown',
    transport: 'open',
    itemEvents: 0,
    lastItem: null,
    usage: null,
    unknownEvents: 0,
    malformed: 0,
    streamError: false,
    complete: false,
  };
  constructor(private readonly expectedThreadId?: string) {
    if (expectedThreadId !== undefined && !identifier(expectedThreadId)) throw new Error('invalid_expected_thread');
  }
  snapshot(): ExecObservation {
    return structuredClone(this.state);
  }
  push(chunk: Uint8Array): void {
    if (this.closed) throw new Error('exec_stream_closed');
    this.bytes += chunk.byteLength;
    if (this.bytes > 4 * 1024 * 1024) {
      this.state.malformed++;
      this.closed = true;
      this.state.transport = 'interrupted';
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(10)) >= 0) {
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      this.line(line);
    }
    if (this.pending.length > 64 * 1024) {
      this.state.malformed++;
      this.pending = Buffer.alloc(0);
      this.closed = true;
      this.state.transport = 'interrupted';
    }
  }
  finish(exit: { code: number | null; signal?: string | null }): ExecObservation {
    if (this.finished) return this.snapshot();
    this.finished = true;
    if (!this.closed && this.pending.length) this.line(this.pending);
    this.pending = Buffer.alloc(0);
    this.state.transport =
      this.state.transport === 'interrupted' || exit.code !== 0 || Boolean(exit.signal) ? 'interrupted' : 'closed';
    this.closed = true;
    this.state.complete =
      this.state.transport === 'closed' &&
      this.state.turn === 'completed' &&
      this.state.threadId !== null &&
      this.state.malformed === 0 &&
      !this.state.streamError &&
      this.state.unknownEvents === 0;
    return this.snapshot();
  }
  private line(bytes: Uint8Array): void {
    let event: unknown;
    try {
      if (bytes.byteLength > 64 * 1024) throw new Error();
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(event) || typeof event.type !== 'string') throw new Error();
    } catch {
      this.state.malformed++;
      return;
    }
    const e = event as Record<string, unknown>;
    const invalid = () => {
      this.state.malformed++;
    };
    switch (e.type) {
      case 'thread.started':
        if (
          !identifier(e.thread_id) ||
          this.state.threadId !== null ||
          (this.expectedThreadId !== undefined && e.thread_id !== this.expectedThreadId)
        )
          return invalid();
        this.state.threadId = e.thread_id;
        return;
      case 'turn.started':
        if (!this.state.threadId || this.state.turn !== 'unknown') return invalid();
        this.state.turn = 'running';
        return;
      case 'turn.completed': {
        const u = e.usage;
        if (
          this.state.turn !== 'running' ||
          !object(u) ||
          !count(u.input_tokens) ||
          !count(u.cached_input_tokens) ||
          !count(u.output_tokens)
        )
          return invalid();
        this.state.usage = { input: u.input_tokens, cachedInput: u.cached_input_tokens, output: u.output_tokens };
        this.state.turn = 'completed';
        return;
      }
      case 'turn.failed':
        if (this.state.turn !== 'running' || !object(e.error) || typeof e.error.message !== 'string') return invalid();
        this.state.turn = 'failed';
        return;
      case 'error':
        if (typeof e.message !== 'string') return invalid();
        this.state.streamError = true;
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (this.state.turn !== 'running' || !object(e.item) || !identifier(e.item.id) || !identifier(e.item.type))
          return invalid();
        this.state.itemEvents++;
        this.state.lastItem = { id: e.item.id, type: e.item.type, event: String(e.type) };
        return;
      default:
        this.state.unknownEvents++;
    }
  }
}
