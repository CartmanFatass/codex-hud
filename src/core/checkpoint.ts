import { ObservationStoreError } from './collect-lease.js';
import type { SessionRef } from './types/identity.js';
import type { ObservationCommit, ReaderCheckpoint } from './types/observation.js';

/** B16 captures both boundaries from the SAME ReaderResult, before adding its projection. */
export interface ObservationBoundary {
  ref: SessionRef;
  readerVersion: string;
  sourceGeneration: number;
  fileId: ReaderCheckpoint['fileId'];
  offset: number;
}
export interface ObservationBoundaryWitness {
  checkpointBoundary: ObservationBoundary;
  summaryBoundary: ObservationBoundary;
  checkpointDigest: string;
  summaryDigest: string;
}
export interface ObservationCandidate {
  commit: ObservationCommit;
  previousCommitSeq: number;
  boundary: ObservationBoundaryWitness;
  /** Explicit fenced reset; retired reader versions can never become current again. */
  rebuildFromReaderVersion?: string;
}

const fail = (reason = 'invalid_observation_structure'): never => {
  throw new ObservationStoreError(reason);
};

/** An exact read-through overlay. Historical keys stay in SQLite; only this slice's mutations are copied. */
export class RecoveryIndexOverlay {
  private lookup: import('./types/checkpoint.js').RecoveryIndexLookup | undefined;
  private changes = new Map<string, Map<string, string | null>>();
  private parent: RecoveryIndexOverlay | undefined;
  constructor(
    readonly recoveryVersion: string,
    handoff?: import('./types/checkpoint.js').RecoveryIndexHandoff
  ) {
    if (handoff && handoff.delta.recoveryVersion !== recoveryVersion) fail('recovery_version_mismatch');
    this.lookup = handoff?.lookup;
    if (handoff?.delta.base && !this.lookup) fail('recovery_lookup_required');
    for (const entry of handoff?.delta.entries ?? []) this.put(entry.namespace, entry.key, entry.value);
  }
  private put(namespace: string, key: string, value: string | null): void {
    let space = this.changes.get(namespace);
    if (!space) this.changes.set(namespace, (space = new Map()));
    space.set(key, value);
  }
  get(namespace: string, key: string): string | undefined {
    const space = this.changes.get(namespace);
    if (space?.has(key)) return space.get(key) ?? undefined;
    return this.parent ? this.parent.get(namespace, key) : this.lookup?.get(namespace, key);
  }
  has(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== undefined;
  }
  set(namespace: string, key: string, value: string): void {
    if (this.get(namespace, key) !== value) this.put(namespace, key, value);
  }
  delete(namespace: string, key: string): void {
    if (this.has(namespace, key)) this.put(namespace, key, null);
  }
  *entries(namespace: string): IterableIterator<[string, string]> {
    const local = this.changes.get(namespace);
    let after: string | null = null;
    if (this.parent) {
      for (const [key, value] of this.parent.entries(namespace)) if (!local?.has(key)) yield [key, value];
    } else if (this.lookup) {
      while (true) {
        const page = this.lookup.page(namespace, after, 128);
        for (const entry of page) {
          if (!local?.has(entry.key) && entry.value !== null) yield [entry.key, entry.value];
        }
        if (page.length < 128) break;
        after = page[page.length - 1].key;
      }
    }
    for (const [key, value] of local ?? []) if (value !== null) yield [key, value];
  }
  /** A slice stages only touched keys. Discard the fork on error; no undo I/O or history copy. */
  fork(): RecoveryIndexOverlay {
    const fork = new RecoveryIndexOverlay(this.recoveryVersion);
    fork.parent = this;
    return fork;
  }
  /** Adopt a successful slice without lookups; metadata writes still wait for fenced publication. */
  commit(): RecoveryIndexOverlay {
    if (!this.parent) return this;
    for (const [namespace, entries] of this.changes) {
      for (const [key, value] of entries) this.parent.put(namespace, key, value);
    }
    return this.parent;
  }
  snapshot(
    onCommitted?: (lookup: import('./types/checkpoint.js').RecoveryIndexLookup) => void
  ): import('./types/checkpoint.js').RecoveryIndexHandoff {
    if (this.parent) fail('uncommitted_recovery_slice');
    const entries = Object.freeze(
      [...this.changes].flatMap(([namespace, values]) =>
        [...values].map(([key, value]) => Object.freeze({ namespace, key, value }))
      )
    );
    const handoff: import('./types/checkpoint.js').RecoveryIndexHandoff = {
      delta: Object.freeze({ recoveryVersion: this.recoveryVersion, base: this.lookup?.reference ?? null, entries }),
    };
    Object.defineProperties(handoff, {
      lookup: { value: this.lookup },
      committed: {
        value: (lookup: import('./types/checkpoint.js').RecoveryIndexLookup) => {
          for (const entry of entries) {
            const space = this.changes.get(entry.namespace);
            if (space?.get(entry.key) === entry.value) space.delete(entry.key);
            if (space?.size === 0) this.changes.delete(entry.namespace);
          }
          this.lookup = lookup;
          onCommitted?.(lookup);
        },
      },
    });
    return Object.freeze(handoff);
  }
}
