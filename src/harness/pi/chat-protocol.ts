/** Pi v0.73.1 RPC framing for one already-owned process. No process or identity authority. */
export type PiChatProtocolEvent =
  | { type: 'accepted'; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'boundary' }
  | { type: 'error'; code: string; turnId?: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class PiChatProtocol {
  readonly name = 'pi-rpc-v0.73.1';
  private pending?: string;
  private readonly used = new Set<string>();
  private buffer = Buffer.alloc(0);
  private failed = false;
  encode(text: string, turnId: string): Buffer {
    if (this.failed || this.pending) throw new Error('pi_chat_protocol_unavailable');
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      Buffer.byteLength(text) > 32_768 ||
      typeof turnId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(turnId) ||
      this.used.has(turnId) ||
      this.used.size >= 4096
    )
      throw new Error('pi_chat_protocol_invalid_input');
    const bytes = Buffer.from(
      JSON.stringify({ id: turnId, type: 'prompt', message: text, streamingBehavior: 'steer' }) + '\n'
    );
    // JSON escaping may expand a raw-text-valid input. Refuse before reserving an ID.
    if (bytes.length > 65536) throw new Error('pi_chat_protocol_input_limit');
    this.pending = turnId;
    this.used.add(turnId);
    return bytes;
  }
  consume(chunk: Buffer): PiChatProtocolEvent[] {
    if (this.failed) return [];
    if (chunk.length > 1024 * 1024) return this.fail('chunk_limit');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: PiChatProtocolEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 1024 * 1024) return out.concat(this.fail('frame_limit'));
      let record: unknown;
      try {
        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      } catch {
        return out.concat(this.fail('invalid_frame'));
      }
      if (!object(record) || typeof record.type !== 'string') return out.concat(this.fail('invalid_record'));
      if (record.type === 'extension_ui_request') return out.concat(this.fail('unsupported_ui_request'));
      if (record.type === 'response') {
        const id = this.pending;
        if (!id || record.id !== id || record.command !== 'prompt' || typeof record.success !== 'boolean')
          return out.concat(this.fail('uncorrelated_response'));
        this.pending = undefined;
        if (record.success) out.push({ type: 'accepted', turnId: id });
        else out.push({ type: 'error', code: 'rejected', turnId: id });
      } else if (record.type === 'message_update') {
        const e = record.assistantMessageEvent;
        if (!object(e) || typeof e.type !== 'string') return out.concat(this.fail('invalid_message_event'));
        if (e.type === 'text_delta') {
          if (typeof e.delta !== 'string' || Buffer.byteLength(e.delta) > 65_536)
            return out.concat(this.fail('invalid_text_delta'));
          out.push({ type: 'delta', text: e.delta });
        }
      } else if (record.type === 'agent_end') out.push({ type: 'boundary' });
    }
    if (this.buffer.length > 1024 * 1024) return out.concat(this.fail('frame_limit'));
    return out;
  }
  private fail(code: string): PiChatProtocolEvent[] {
    this.failed = true;
    const turnId = this.pending;
    this.pending = undefined;
    this.buffer = Buffer.alloc(0);
    return [{ type: 'error', code, ...(turnId ? { turnId } : {}) }];
  }
}
