import type { CollectedLinkSession } from './types.js';

const objectStart = Symbol('object'),
  arrayStart = Symbol('array'),
  end = Symbol('end');
type Token = string | number | boolean | null | symbol;

/** Collision-free version of JSON equality for plain projection inputs. Retain
 * primitive tokens, not mutable caller objects or a newly serialized string.
 */
export class JsonVersion {
  private tokens: Token[] = [];
  private version = 0;
  update(value: unknown): number {
    let cursor = 0;
    let changed: Token[] | null = null;
    const emit = (token: Token) => {
      if (!changed && this.tokens[cursor] !== token) changed = this.tokens.slice(0, cursor);
      changed?.push(token);
      cursor++;
    };
    const visit = (input: any): void => {
      if (input && typeof input.toJSON === 'function') input = input.toJSON();
      if (input === null || input === undefined || typeof input === 'function' || typeof input === 'symbol') emit(null);
      else if (typeof input === 'number') emit(Number.isFinite(input) ? input : null);
      else if (typeof input === 'string' || typeof input === 'boolean') emit(input);
      else if (typeof input === 'bigint') throw new TypeError('BigInt is not a JSON projection input');
      else if (Array.isArray(input)) {
        emit(arrayStart);
        for (let i = 0; i < input.length; i++) visit(input[i]);
        emit(end);
      } else {
        emit(objectStart);
        for (const key of Object.keys(input)) {
          const child = input[key];
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
          emit(key);
          visit(child);
        }
        emit(end);
      }
    };
    visit(value);
    if (changed || cursor !== this.tokens.length) {
      this.tokens = changed ?? this.tokens.slice(0, cursor);
      this.version++;
    }
    return this.version;
  }
}

/** Keep exactly the fields covered by the original B10A JSON memo key. */
export function sessionMemoInput(s: CollectedLinkSession) {
  return [
    s.evidence.ref,
    s.committedOnly,
    s.lastCommitted?.statusProjection.observationStamp,
    s.sourceGeneration,
    s.loaded,
    s.linkEvidenceCurrent,
    s.evidence.observation.evidenceStamp,
    s.evidence.observation.statusProjection.observationStamp,
    s.committedRate,
    s.committedAction,
    s.committedProgress,
    s.evidence.observation.coverage,
    s.topology
      ? [
          s.topology.sourceGeneration,
          s.topology.children,
          s.topology.loaded,
          s.topology.coverage,
          s.topology.nativeMetadata,
        ]
      : null,
  ];
}

export class LinkProjectionMemo {
  private sessions = new JsonVersion();
  private inputs = new JsonVersion();
  private previousSessions: readonly CollectedLinkSession[] | null = null;
  private sessionVersion = 0;
  key(
    ledger: unknown,
    sessions: readonly CollectedLinkSession[],
    hosts: unknown,
    roots: unknown,
    budget: unknown,
    selectionMap: unknown,
    immutableSnapshots = false
  ): number {
    if (!immutableSnapshots || sessions !== this.previousSessions)
      this.sessionVersion = this.sessions.update(sessions.map(sessionMemoInput));
    this.previousSessions = immutableSnapshots ? sessions : null;
    return this.inputs.update([ledger, this.sessionVersion, hosts, roots, budget, selectionMap]);
  }
}
