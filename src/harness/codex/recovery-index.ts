import type { RecoveryIndexOverlay, RecoveryOverlayCursor } from '../../core/checkpoint.js';
import type { RecoveryReadGrant } from '../../core/types/checkpoint.js';

/** Pending deletions are private to one incomplete native record. */
export class RecoveryClearPhase {
  private readonly keys = new Set<string>();
  private readonly shadow: Map<string, boolean>;
  private complete = false;
  constructor(
    private readonly cursor: RecoveryOverlayCursor,
    shadow: Map<string, boolean>
  ) {
    this.shadow = shadow;
  }
  advance(grant: RecoveryReadGrant): 'complete' | 'continued' | 'stale' {
    if (this.complete) {
      const verified = this.cursor.next(grant);
      if (verified.kind === 'stale') return 'stale';
      if (verified.kind === 'continued') return 'continued';
      if (verified.kind !== 'done') throw new Error('recovery_clear_cursor_invalid');
      return 'complete';
    }
    for (;;) {
      const item = this.cursor.next(grant);
      if (item.kind === 'stale') return 'stale';
      if (item.kind === 'continued') return 'continued';
      if (item.kind === 'done') break;
      const present = this.shadow.get(item.key);
      this.shadow.delete(item.key);
      if (present !== false) this.keys.add(item.key);
    }
    for (const [key, present] of this.shadow) if (present) this.keys.add(key);
    this.shadow.clear();
    this.complete = true;
    return 'complete';
  }
  apply<T>(map: RecoveryMap<T>): void {
    if (!this.complete) throw new Error('recovery_clear_incomplete');
    map.applyKnownClear(this.keys);
  }
}

export class RecoveryClearPending extends Error {
  constructor() {
    super('recovery_clear_pending');
  }
}

/** Owned by one reader; a phase is never part of a published checkpoint. */
export class RecoveryClearCoordinator {
  private phase?: RecoveryClearPhase;
  private key?: string;
  private grant?: RecoveryReadGrant;
  private ordinal = 0;
  private phaseOrdinal?: number;
  get pending(): boolean {
    return this.phase !== undefined;
  }
  begin(key: string, grant: RecoveryReadGrant): void {
    if (this.key !== key) {
      this.phase = undefined;
      this.phaseOrdinal = undefined;
    }
    this.key = key;
    this.grant = grant;
    this.ordinal = 0;
  }
  clear(map: RecoveryMap<true>): void {
    if (!this.grant) throw new Error('recovery_clear_grant_missing');
    const ordinal = ++this.ordinal;
    if (this.phase && this.phaseOrdinal !== ordinal) throw new Error('recovery_clear_ordinal_mismatch');
    this.phase ??= map.beginClear();
    this.phaseOrdinal = ordinal;
    const result = this.phase.advance(this.grant);
    if (result === 'stale') {
      this.discard();
      throw new Error('recovery_snapshot_stale');
    }
    if (result === 'continued') throw new RecoveryClearPending();
    this.phase.apply(map);
  }
  discard(): void {
    this.phase = undefined;
    this.phaseOrdinal = undefined;
    this.key = undefined;
    this.grant = undefined;
  }
}

const indexFailures = new WeakSet<object>();
function indexAccess<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function')) indexFailures.add(error);
    throw error;
  }
}
export function isRecoveryIndexFailure(error: unknown): boolean {
  return !!error && (typeof error === 'object' || typeof error === 'function') && indexFailures.has(error);
}

/** Exact keyed state. A read fork touches only keys used by the new slice. */
export class RecoveryMap<T> extends Map<string, T> {
  private changes = new Map<string, T | undefined>();
  constructor(
    protected index: RecoveryIndexOverlay,
    private namespace: string,
    private count: number,
    protected encode: (value: T) => string,
    protected decode: (value: string) => T,
    private base?: RecoveryMap<T>,
    protected copy: (value: T) => T = (value) => value
  ) {
    super();
  }

  override get size(): number {
    return this.count;
  }
  override has(key: string): boolean {
    if (this.changes.has(key)) return this.changes.get(key) !== undefined;
    return this.base ? this.base.has(key) : indexAccess(() => this.index.has(this.namespace, key));
  }
  override get(key: string): T | undefined {
    if (this.changes.has(key)) return this.changes.get(key);
    return this.base
      ? (() => {
          const value = this.base!.get(key);
          return value === undefined ? undefined : this.copy(value);
        })()
      : (() => {
          const raw = indexAccess(() => this.index.get(this.namespace, key));
          return raw === undefined ? undefined : indexAccess(() => this.decode(raw));
        })();
  }
  override set(key: string, value: T): this {
    if (!this.has(key)) this.count++;
    this.changes.set(key, value);
    return this;
  }
  override delete(key: string): boolean {
    if (!this.has(key)) return false;
    this.count--;
    this.changes.set(key, undefined);
    return true;
  }
  override clear(): void {
    for (const key of this.keys()) this.delete(key);
  }
  beginClear(): RecoveryClearPhase {
    const layers: RecoveryMap<T>[] = [];
    for (let map: RecoveryMap<T> | undefined = this; map; map = map.base) layers.push(map);
    const shadow = new Map<string, boolean>();
    for (const layer of layers.reverse())
      for (const [key, value] of layer.changes) shadow.set(key, value !== undefined);
    return new RecoveryClearPhase(this.index.scan(this.namespace), shadow);
  }
  applyKnownClear(keys: ReadonlySet<string>): void {
    for (const key of keys) this.changes.set(key, undefined);
    this.count = 0;
  }
  override *entries(): MapIterator<[string, T]> {
    const seen = new Set<string>();
    for (const [key, value] of this.changes) {
      seen.add(key);
      if (value !== undefined) yield [key, value];
    }
    if (this.base) {
      for (const [key, value] of this.base) if (!seen.has(key)) yield [key, value];
    } else {
      const entries = this.index.entries(this.namespace)[Symbol.iterator]();
      for (;;) {
        const item = indexAccess(() => entries.next());
        if (item.done) break;
        const [key, raw] = item.value;
        if (!seen.has(key)) yield [key, indexAccess(() => this.decode(raw))];
      }
    }
  }
  override [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }
  override *keys(): MapIterator<string> {
    for (const [key] of this) yield key;
  }
  override *values(): MapIterator<T> {
    for (const [, value] of this) yield value;
  }
  override forEach(fn: (value: T, key: string, map: Map<string, T>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) fn.call(thisArg, value, key, this);
  }
  /** A source replacement starts an empty index lineage without scanning the old one. */
  resetIndex(index: RecoveryIndexOverlay): void {
    this.index = index;
    this.base = undefined;
    this.changes.clear();
    this.count = 0;
  }
  useIndex(index: RecoveryIndexOverlay): void {
    this.index = index;
  }
  fork(index = this.index): RecoveryMap<T> {
    return new RecoveryMap(index, this.namespace, this.count, this.encode, this.decode, this, this.copy);
  }
  /** Stage only touched keys; the previous live map remains immutable on a failed slice. */
  commit(): RecoveryMap<T> {
    for (const [key, value] of this.changes) {
      if (value === undefined) this.index.deleteKnown(this.namespace, key);
      else this.index.set(this.namespace, key, this.encode(value));
    }
    return new RecoveryMap(this.index, this.namespace, this.count, this.encode, this.decode, undefined, this.copy);
  }
}

export class RecoverySet extends Set<string> {
  constructor(
    readonly map: RecoveryMap<true>,
    private coordinator?: RecoveryClearCoordinator
  ) {
    super();
  }
  override get size(): number {
    return this.map.size;
  }
  override has(key: string): boolean {
    return this.map.has(key);
  }
  override add(key: string): this {
    this.map.set(key, true);
    return this;
  }
  override delete(key: string): boolean {
    return this.map.delete(key);
  }
  override clear(): void {
    if (this.map.size === 0) return;
    if (this.coordinator) this.coordinator.clear(this.map);
    else this.map.clear();
  }
  beginClear(): RecoveryClearPhase {
    return this.map.beginClear();
  }
  override values(): SetIterator<string> {
    return this.map.keys();
  }
  override keys(): SetIterator<string> {
    return this.values();
  }
  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  override *entries(): SetIterator<[string, string]> {
    for (const key of this) yield [key, key];
  }
  override forEach(fn: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown): void {
    for (const key of this) fn.call(thisArg, key, key, this);
  }
  fork(index?: RecoveryIndexOverlay): RecoverySet {
    return new RecoverySet(this.map.fork(index), this.coordinator);
  }
  commit(): RecoverySet {
    return new RecoverySet(this.map.commit(), this.coordinator);
  }
  coordinate(coordinator?: RecoveryClearCoordinator): void {
    this.coordinator = coordinator;
  }
}

interface CallOrder {
  previous: string | null;
  next: string | null;
}
/** A persisted linked insertion order makes the current action an exact-key read. */
export class RecoveryCalls<T> extends RecoveryMap<T> {
  constructor(
    index: RecoveryIndexOverlay,
    count: number,
    encode: (value: T) => string,
    decode: (raw: string) => T,
    public tail: string | null = null,
    private order = new RecoveryMap<CallOrder>(
      index,
      'codex.running-order',
      count,
      JSON.stringify,
      (raw) => JSON.parse(raw) as CallOrder
    ),
    base?: RecoveryMap<T>,
    copy: (value: T) => T = (value) => value
  ) {
    super(index, 'codex.running', count, encode, decode, base, copy);
  }
  override set(key: string, value: T): this {
    if (!this.has(key)) {
      if (this.tail !== null) {
        const last = this.order.get(this.tail);
        if (!last) throw new Error('invalid_codex_recovery_order');
        this.order.set(this.tail, { ...last, next: key });
      }
      this.order.set(key, { previous: this.tail, next: null });
      this.tail = key;
    }
    return super.set(key, value);
  }
  override delete(key: string): boolean {
    if (!this.has(key)) return false;
    const node = this.order.get(key);
    if (!node) throw new Error('invalid_codex_recovery_order');
    if (node.previous !== null) {
      const previous = this.order.get(node.previous);
      if (!previous) throw new Error('invalid_codex_recovery_order');
      this.order.set(node.previous, { ...previous, next: node.next });
    }
    if (node.next !== null) {
      const next = this.order.get(node.next);
      if (!next) throw new Error('invalid_codex_recovery_order');
      this.order.set(node.next, { ...next, previous: node.previous });
    }
    if (this.tail === key) this.tail = node.previous;
    this.order.delete(key);
    return super.delete(key);
  }
  override resetIndex(index: RecoveryIndexOverlay): void {
    super.resetIndex(index);
    this.order.resetIndex(index);
    this.tail = null;
  }
  override useIndex(index: RecoveryIndexOverlay): void {
    super.useIndex(index);
    this.order.useIndex(index);
  }
  override fork(index = this.index): RecoveryCalls<T> {
    return new RecoveryCalls(
      index,
      this.size,
      this.encode,
      this.decode,
      this.tail,
      this.order.fork(index),
      this,
      this.copy
    );
  }
  override commit(): RecoveryCalls<T> {
    super.commit();
    return new RecoveryCalls(
      this.index,
      this.size,
      this.encode,
      this.decode,
      this.tail,
      this.order.commit(),
      undefined,
      this.copy
    );
  }
  override *entries(): MapIterator<[string, T]> {
    const keys: string[] = [];
    let key = this.tail;
    while (key !== null) {
      if (keys.length >= this.size) throw new Error('invalid_codex_recovery_order');
      keys.push(key);
      const node = this.order.get(key);
      if (!node) throw new Error('invalid_codex_recovery_order');
      key = node.previous;
    }
    if (keys.length !== this.size) throw new Error('invalid_codex_recovery_order');
    for (const id of keys.reverse()) {
      const value = this.get(id);
      if (value === undefined) throw new Error('invalid_codex_recovery_order');
      yield [id, value];
    }
  }
  latest(): T | undefined {
    return this.tail === null ? undefined : this.get(this.tail);
  }
}

/** Materialize display history only when a consumer actually asks for it. */
export function recoveryArray<T>(index: RecoveryMap<T>): T[] {
  let values: T[] | undefined;
  const load = () => (values ??= [...index.values()]);
  return new Proxy<T[]>([], {
    get(_target, key) {
      if (key === 'length') return index.size;
      if (key === Symbol.iterator) return () => index.values();
      return Reflect.get(load(), key);
    },
    has(_target, key) {
      return Reflect.has(load(), key);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, key) {
      return Reflect.getOwnPropertyDescriptor(load(), key);
    },
  });
}
export function recoveryCounts(index: RecoveryMap<number>): Record<string, number> {
  return new Proxy<Record<string, number>>(
    {},
    {
      get(_target, key) {
        return typeof key === 'string' ? index.get(key) : undefined;
      },
      has(_target, key) {
        return typeof key === 'string' && index.has(key);
      },
      ownKeys() {
        return [...index.keys()];
      },
      getOwnPropertyDescriptor(_target, key) {
        return typeof key === 'string' && index.has(key)
          ? { configurable: true, enumerable: true, writable: false, value: index.get(key) }
          : undefined;
      },
    }
  );
}
