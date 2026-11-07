import { randomUUID } from 'node:crypto';
import type {
  AdapterCreate,
  AdapterEvent,
  ManagedAdapterFactory,
  ManagedAdapterSession,
  NativeRef,
  NativeRequest,
  NativeResponse,
} from './types.js';
import { nativeLocatorMatches, ownerKey, type NativeOwner, type RelationStore } from './relations.js';
export interface HostExtension {
  invoke(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Actual retained native handles only; not task state or an inferred idle verdict. */
  hasRetainedHandles?(): boolean;
}
export interface HostProfile {
  id: string;
  factory: ManagedAdapterFactory;
}
export interface HostMessage {
  seq: number;
  connectionId: string;
  nativeRef: NativeRef | null;
  event?: AdapterEvent;
  request?: Omit<NativeRequest, 'signal'>;
}
interface Connection {
  id: string;
  callId: string;
  profileId: string;
  workspace: string;
  createdAt: number;
  session?: ManagedAdapterSession;
  nativeRef: NativeRef | null;
  persistenceError?: string;
  /** Observed transport/process end only, not a native task verdict. */
  transportEnd?: Extract<AdapterEvent, { type: 'disconnected' | 'process_exit' }>;
}
interface Pending {
  connectionId: string;
  request: NativeRequest;
  resolve(response: NativeResponse): void;
  reject(error: Error): void;
  cleanup(): void;
}
export interface HostTarget {
  connectionId?: string;
  nativeRef?: NativeRef;
}
/** One authenticated native owner, one detached process. All callback handles are ephemeral. */
export class NativeSessionHost {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
  private readonly messages: HostMessage[] = [];
  private bytes = 0;
  private seq = 0;
  private lastDroppedSeq = 0;
  private readonly listeners = new Set<(message: HostMessage) => void>();
  constructor(
    readonly owner: NativeOwner,
    private readonly profiles: HostProfile[],
    private readonly relations: RelationStore,
    private readonly extensions: Record<string, HostExtension> = {}
  ) {}
  registerExtension(prefix: string, service: HostExtension): void {
    this.extensions[prefix] = service;
  }
  hasRetainedHandles(): boolean {
    return (
      this.connections.size > 0 ||
      this.pending.size > 0 ||
      Object.values(this.extensions).some((extension) => extension.hasRetainedHandles?.() === true)
    );
  }
  subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(connection: Connection, body: Pick<HostMessage, 'event' | 'request'>): void {
    const message: HostMessage = {
      seq: ++this.seq,
      connectionId: connection.id,
      nativeRef: connection.nativeRef,
      ...body,
    };
    const size = Buffer.byteLength(JSON.stringify(message));
    // Display buffering only. Full history is read from the native backend.
    if (size <= 1_048_576) {
      this.messages.push(message);
      this.bytes += size;
    } else this.lastDroppedSeq = message.seq;
    while (this.messages.length > 512 || this.bytes > 4_194_304) {
      const dropped = this.messages.shift()!;
      this.bytes -= Buffer.byteLength(JSON.stringify(dropped));
      this.lastDroppedSeq = Math.max(this.lastDroppedSeq, dropped.seq);
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* Notification failure cannot close the backend. */
      }
    }
  }
  private bind(connection: Connection, ref: NativeRef): void {
    connection.nativeRef = ref;
    try {
      this.relations.record({
        owner: this.owner,
        callId: connection.callId,
        child: ref,
        workspace: connection.workspace,
        profileId: connection.profileId,
        createdAt: connection.createdAt,
      });
      delete connection.persistenceError;
    } catch (error) {
      connection.persistenceError = error instanceof Error ? error.message : String(error);
    }
  }
  private target(target: HostTarget, requireSession = true): Connection {
    const matching = target.nativeRef
      ? [...this.connections.values()].filter(
          (c) => c.nativeRef && nativeLocatorMatches(c.nativeRef, target.nativeRef!)
        )
      : [];
    const found = target.connectionId
      ? this.connections.get(target.connectionId)
      : (matching.find((c) => !c.transportEnd && (c.session || !requireSession)) ?? matching[0]);
    if (!found || (target.nativeRef && (!found.nativeRef || !nativeLocatorMatches(found.nativeRef, target.nativeRef))))
      throw new Error('native_connection_not_found');
    if (requireSession && !found.session) throw new Error('native_connection_not_ready');
    return found;
  }
  async create(input: { profileId: string; callId: string } & AdapterCreate): Promise<unknown> {
    const profile = this.profiles.find((p) => p.id === input.profileId);
    if (!profile) throw new Error('native_profile_not_found');
    if (input.origin.kind !== 'new') {
      const relation = this.relations.resolveOwned(this.owner, input.origin.source, input.profileId);
      if (relation.child.harness !== profile.factory.harness) throw new Error('native_relation_not_owned');
      if (input.workspace !== relation.workspace) throw new Error('native_relation_workspace_mismatch');
      // The native ID alone is not authority for another session file or backend profile.
      // Replace optional model locators with the exact stored official source before dispatch.
      input = {
        ...input,
        profileId: relation.profileId,
        workspace: relation.workspace,
        origin: { kind: input.origin.kind, source: relation.child },
      };
      const live = [...this.connections.values()].find(
        (c) =>
          c.session &&
          !c.transportEnd &&
          c.profileId === relation.profileId &&
          c.nativeRef &&
          nativeLocatorMatches(c.nativeRef, relation.child)
      );
      if (live && input.origin.kind === 'resume') return this.describe(live);
    }
    const connection: Connection = {
      id: randomUUID(),
      callId: input.callId,
      profileId: input.profileId,
      workspace: input.workspace,
      createdAt: Date.now(),
      nativeRef: null,
    };
    this.connections.set(connection.id, connection);
    try {
      connection.session = await profile.factory.create(input, {
        event: (event) => {
          if (event.type === 'binding') this.bind(connection, event.nativeRef);
          if (event.type === 'disconnected' || event.type === 'process_exit') connection.transportEnd = event;
          this.publish(connection, { event });
        },
        request: (request) =>
          new Promise<NativeResponse>((resolve, reject) => {
            const key = `${connection.id}:${request.requestId}`;
            if (request.signal?.aborted) {
              reject(new Error('native_request_withdrawn'));
              return;
            }
            if (this.pending.has(key)) {
              reject(new Error('duplicate_native_request'));
              return;
            }
            const abort = () => {
              this.pending.delete(key);
              reject(new Error('native_request_withdrawn'));
            };
            this.pending.set(key, {
              connectionId: connection.id,
              request,
              resolve,
              reject,
              cleanup: () => request.signal?.removeEventListener('abort', abort),
            });
            request.signal?.addEventListener('abort', abort, { once: true });
            const { signal: _signal, ...publicRequest } = request;
            this.publish(connection, { request: publicRequest });
          }),
      });
      const ref = connection.session.snapshot().nativeRef;
      if (ref) this.bind(connection, ref);
      return this.describe(connection);
    } catch (error) {
      if (!connection.session) this.connections.delete(connection.id);
      throw error;
    }
  }
  private describe(connection: Connection): unknown {
    return {
      connectionId: connection.id,
      throughSeq: this.seq,
      profileId: connection.profileId,
      ...connection.session?.snapshot(),
      nativeRef: connection.nativeRef,
      ...(connection.transportEnd ? { transportEnd: connection.transportEnd } : {}),
      ...(connection.persistenceError ? { relationWriteError: connection.persistenceError } : {}),
    };
  }
  list(): unknown {
    return {
      connections: [...this.connections.values()].map((c) => this.describe(c)),
      relations: this.relations.list(this.owner),
    };
  }
  async status(target: HostTarget): Promise<unknown> {
    const c = this.target(target);
    return { connection: this.describe(c), native: await c.session!.read() };
  }
  async read(target: HostTarget, options?: Record<string, unknown>): Promise<unknown> {
    return this.target(target).session!.read(options);
  }
  async send(
    target: HostTarget,
    input: { callId: string; text: string; options?: Record<string, unknown> }
  ): Promise<unknown> {
    return this.target(target).session!.send(input);
  }
  requests(target?: HostTarget): unknown {
    const id = target?.connectionId || target?.nativeRef ? this.target(target, false).id : undefined;
    return [...this.pending.values()]
      .filter((p) => !id || p.connectionId === id)
      .map((p) => {
        const { signal: _signal, ...request } = p.request;
        return { connectionId: p.connectionId, ...request };
      });
  }
  respond(target: HostTarget, requestId: string, result: unknown): unknown {
    // A native startup callback can precede factory.create's returned session handle.
    // Ownership and exact request identity suffice to route its response.
    const c = this.target(target, false);
    const key = `${c.id}:${requestId}`;
    const p = this.pending.get(key);
    if (!p || p.request.signal?.aborted) throw new Error('native_request_not_pending');
    if (p.request.responseUnsupportedReason) throw new Error(p.request.responseUnsupportedReason);
    this.pending.delete(key);
    p.cleanup();
    p.resolve({ result });
    return { forwarded: true, requestId, nativeAcknowledged: false };
  }
  async cancel(target: HostTarget, nativeTurnId?: string): Promise<unknown> {
    return this.target(target).session!.cancel({ nativeTurnId });
  }
  async close(target: HostTarget): Promise<unknown> {
    const c = this.target(target);
    const result = await c.session!.close();
    this.connections.delete(c.id);
    for (const [key, p] of this.pending)
      if (p.connectionId === c.id) {
        this.pending.delete(key);
        p.cleanup();
        p.reject(new Error('native_connection_closed'));
      }
    return result;
  }
  async wait(target: HostTarget, afterSeq = 0, waitMs = 30000, signal?: AbortSignal): Promise<unknown> {
    const id = target.connectionId || target.nativeRef ? this.target(target, false).id : undefined;
    const page = () => ({
      events: this.messages.filter((m) => m.seq > afterSeq && (!id || m.connectionId === id)),
      throughSeq: this.seq,
      truncated: afterSeq < this.lastDroppedSeq,
      requests: this.requests(target),
    });
    const first = page();
    if (first.events.length || first.truncated || !waitMs || signal?.aborted) return first;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const off = this.subscribe((message) => {
        if (!id || message.connectionId === id) done();
      });
      timer = setTimeout(done, Math.max(0, Math.min(waitMs, 120000)));
      signal?.addEventListener('abort', done, { once: true });
    });
    return page();
  }
  async invoke(
    owner: NativeOwner,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (ownerKey(owner) !== ownerKey(this.owner)) throw new Error('native_owner_mismatch');
    const target = args as HostTarget;
    switch (method) {
      case 'create':
        return this.create(args as unknown as Parameters<NativeSessionHost['create']>[0]);
      case 'list':
        return this.list();
      case 'status':
        return this.status(target);
      case 'read':
        return this.read(target, args.options as Record<string, unknown> | undefined);
      case 'send':
        return this.send(target, args as unknown as Parameters<NativeSessionHost['send']>[1]);
      case 'wait':
        return this.wait(target, args.afterSeq as number | undefined, args.waitMs as number | undefined, signal);
      case 'requests':
        return this.requests(target);
      case 'respond':
        return this.respond(target, args.requestId as string, args.result);
      case 'cancel':
        return this.cancel(target, args.nativeTurnId as string | undefined);
      case 'close':
        return this.close(target);
      default: {
        const extension = Object.entries(this.extensions).find(([prefix]) => method.startsWith(prefix))?.[1];
        if (extension) return extension.invoke(method, args, signal);
        throw new Error('unknown_native_method');
      }
    }
  }
}
