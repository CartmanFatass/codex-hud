import { serialize, deserialize } from 'node:v8';
import { validateDisplaySchema } from './worker-schema.js';
import { WORKER_PAYLOAD_LIMIT } from './worker-protocol.js';
import type { DelegationViewModel } from './view-model.js';

/** Validate the display graph, including aliases; no live collector/checkpoint capabilities enter IPC. */
function plain(value: unknown, source: boolean): void {
  const seen = new Set<object>(),
    active = new Set<object>();
  let entries = 0,
    estimate = 0;
  const visit = (item: unknown, depth: number) => {
    if (++entries > 100000 || depth > 64) throw new Error('worker_dto_graph_limit');
    if (item === null || item === undefined || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('worker_dto_number');
      return;
    }
    if (typeof item === 'string') {
      estimate += item.length * 2;
      if (estimate > 8 * WORKER_PAYLOAD_LIMIT) throw new Error('worker_payload_limit');
      return;
    }
    if (typeof item !== 'object') throw new Error('worker_dto_capability');
    if (active.has(item)) throw new Error('worker_dto_cycle');
    if (seen.has(item)) return;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new Error('worker_dto_prototype');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('worker_dto_symbol');
    seen.add(item);
    active.add(item);
    if (Object.hasOwn(item, 'parserState') && Object.hasOwn(item, 'readerVersion') && Object.hasOwn(item, 'fileId'))
      throw new Error('worker_dto_checkpoint');
    // v8 deserialization cannot produce accessors. The source still checks descriptors before any property read.
    const keys = source ? Object.getOwnPropertyNames(item) : Object.keys(item);
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = source ? Object.getOwnPropertyDescriptor(item, key)! : null;
      if (descriptor && (!('value' in descriptor) || !descriptor.enumerable)) throw new Error('worker_dto_accessor');
      estimate += key.length * 2 + 8;
      if (estimate > 8 * WORKER_PAYLOAD_LIMIT) throw new Error('worker_payload_limit');
      visit(descriptor ? descriptor.value : (item as Record<string, unknown>)[key], depth + 1);
    }
    active.delete(item);
  };
  visit(value, 0);
}
export function validateView(value: unknown, source = true): asserts value is DelegationViewModel | null {
  plain(value, source);
  validateDisplaySchema(value);
}
/** Same-Node transient codec, never a durable format; exact standalone backing buffer, transferred once. */
export function encodeView(view: DelegationViewModel | null): ArrayBuffer {
  validateView(view);
  const encoded = serialize(view);
  if (encoded.byteLength > WORKER_PAYLOAD_LIMIT - 8192) throw new Error('worker_payload_limit');
  const transfer = new Uint8Array(encoded.byteLength);
  transfer.set(encoded);
  return transfer.buffer;
}
export function decodeView(payload: ArrayBuffer): DelegationViewModel | null {
  if (!(payload instanceof ArrayBuffer) || payload.byteLength > WORKER_PAYLOAD_LIMIT - 8192)
    throw new Error('worker_payload_limit');
  const view: unknown = deserialize(Buffer.from(payload));
  validateView(view, false);
  return view;
}
