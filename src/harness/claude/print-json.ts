/** Claude print stream observation, not the on-disk transcript or hook input. */
export interface ClaudePrintObservation {
  sessionId: string | null;
  result: 'unknown' | 'success' | 'error';
  events: number;
  unknownEvents: number;
  malformed: number;
  transport: 'open' | 'closed' | 'interrupted';
  complete: boolean;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const known = new Set([
  'system',
  'assistant',
  'user',
  'stream_event',
  'tool_progress',
  'tool_use_summary',
  'rate_limit_event',
  'result',
]);
/** Bounded JSONL subset, with no content, cost, tool, or credential retention. */
export class ClaudePrintJsonReader {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private closed = false;
  private state: ClaudePrintObservation = {
    sessionId: null,
    result: 'unknown',
    events: 0,
    unknownEvents: 0,
    malformed: 0,
    transport: 'open',
    complete: false,
  };
  constructor(private readonly expectedSessionId?: string) {
    if (expectedSessionId !== undefined && !id(expectedSessionId)) throw new Error('invalid_expected_session');
  }
  snapshot(): ClaudePrintObservation {
    return structuredClone(this.state);
  }
  push(chunk: Uint8Array): void {
    if (this.closed) throw new Error('claude_print_stream_closed');
    this.bytes += chunk.byteLength;
    if (this.bytes > 4 * 1024 * 1024) {
      this.state.malformed++;
      this.state.transport = 'interrupted';
      this.closed = true;
      this.pending = Buffer.alloc(0);
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
      this.state.transport = 'interrupted';
      this.closed = true;
      this.pending = Buffer.alloc(0);
    }
  }
  finish(exit: { code: number | null; signal?: string | null }): ClaudePrintObservation {
    if (this.state.transport !== 'open') return this.snapshot();
    if (this.pending.length) this.line(this.pending);
    this.pending = Buffer.alloc(0);
    this.closed = true;
    this.state.transport = exit.code === 0 && !exit.signal ? 'closed' : 'interrupted';
    this.state.complete =
      this.state.transport === 'closed' &&
      this.state.result === 'success' &&
      this.state.sessionId !== null &&
      this.state.malformed === 0 &&
      this.state.unknownEvents === 0;
    return this.snapshot();
  }
  private line(bytes: Uint8Array): void {
    let m: unknown;
    try {
      if (bytes.byteLength > 64 * 1024) throw new Error();
      m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(m) || typeof m.type !== 'string') throw new Error();
    } catch {
      this.state.malformed++;
      return;
    }
    const event = m as Record<string, unknown>;
    this.state.events++;
    // This slice only accepts a single final result; any later frame is unsupported.
    if (this.state.result !== 'unknown') {
      this.state.malformed++;
      return;
    }
    if (!known.has(String(event.type))) {
      this.state.unknownEvents++;
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (
        !id(event.session_id) ||
        (this.expectedSessionId && event.session_id !== this.expectedSessionId) ||
        (this.state.sessionId && event.session_id !== this.state.sessionId)
      ) {
        this.state.malformed++;
        return;
      }
      this.state.sessionId = event.session_id;
    }
    if (event.type === 'result') {
      if (
        this.state.result !== 'unknown' ||
        !id(event.session_id) ||
        (this.expectedSessionId && event.session_id !== this.expectedSessionId) ||
        (this.state.sessionId && event.session_id !== this.state.sessionId) ||
        typeof event.is_error !== 'boolean' ||
        typeof event.subtype !== 'string'
      ) {
        this.state.malformed++;
        return;
      }
      this.state.sessionId = event.session_id;
      if (event.subtype === 'success' && event.is_error === false && typeof event.result === 'string')
        this.state.result = 'success';
      else if (event.is_error === true || event.subtype.startsWith('error_')) this.state.result = 'error';
      else this.state.malformed++;
    }
  }
}
