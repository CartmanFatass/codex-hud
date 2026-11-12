import { digest } from '../core/canonical.js';
/** Read-only adapter for direct official calls. Never launches/resumes a host or writes a store. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, readdirSync } from 'node:fs';
import { readRelations, nativeKey, ownerKey, type DirectRelation, type NativeOwner } from '../managed/relations.js';
import { readJevRelations, type JevRelation } from '../managed/jev-host.js';
import { NativeHostClient, type NativeHostPort } from '../managed/host-ipc.js';
import type { HostMessage } from '../managed/host.js';
import { makeSourceId } from '../core/identity.js';
import { displayNodeKey, runExecutionProjection } from '../core/observation.js';
import { loadLimits } from '../core/link/limits.js';
import type {
  DelegationNodeDetails,
  DelegationViewModel,
  NativeCallDisplay,
  JevCallDisplay,
} from '../core/link/view-model.js';
import type { LinkTreeNode } from '../core/link/types.js';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function emptyDetails(): DelegationNodeDetails {
  return {
    status: null,
    statusSource: 'unavailable',
    latestReportForRun: null,
    reportHistory: [],
    parentOffline: null,
    wake: null,
    reconcile: null,
    resumable: null,
  };
}
const coverage = () => ({
  state: 'partial' as const,
  skipped: {},
  gaps: ['native_history_not_collected'],
  loaded: false,
});
function node(ref: NativeOwner, parentKey: string | null, depth: number): LinkTreeNode {
  const identity = { kind: 'session' as const, ref };
  return {
    identity,
    key: displayNodeKey(identity),
    parentKey,
    edge: parentKey ? 'direct-call' : null,
    depth,
    crossHarnessDepth: depth,
    loaded: false,
    coverage: coverage(),
    observation: null,
    lastObservation: null,
    currentRun: null,
    execution: runExecutionProjection(null),
    conflict: null,
    links: [],
    host: null,
    parent: null,
  };
}

export class NativeCallCollector {
  private calls: NativeCallDisplay[] = [];
  private jevCalls: JevCallDisplay[] = [];
  private unavailable: string | null = null;
  private jevUnavailable = true;
  get emptyAndComplete(): boolean {
    try {
      if (readdirSync(join(this.home, 'native-relations')).length) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    return !this.unavailable && !this.jevUnavailable && !this.calls.length && !this.jevCalls.length;
  }
  constructor(
    readonly home: string,
    private readonly port: NativeHostPort = new NativeHostClient(home),
    private readonly read = readRelations,
    private readonly readJev = readJevRelations
  ) {}
  static fromEnv(env: Readonly<NodeJS.ProcessEnv> = process.env): NativeCallCollector {
    return new NativeCallCollector(env.HUD_HOME ?? join(env.HOME ?? homedir(), '.hud'));
  }
  /** Resolve only an explicit native source, never a session-id-only owner match. */
  async collectCodex(sessionId: string | undefined, root: string, all = false): Promise<void> {
    let owner: NativeOwner | undefined;
    if (!all) {
      this.jevUnavailable = true;
      if (!sessionId) {
        this.calls = [];
        this.jevCalls = [];
        return;
      }
      try {
        owner = { harness: 'codex', sourceId: makeSourceId('codex', realpathSync(root)), sessionId, threadId: null };
      } catch {
        this.calls = [];
        this.jevCalls = [];
        return;
      }
    }
    await this.collect(owner);
  }
  async collect(owner?: NativeOwner): Promise<void> {
    await Promise.all([this.collectNative(owner), this.collectJev(owner)]);
  }
  private async collectJev(owner?: NativeOwner): Promise<void> {
    let relations: JevRelation[];
    this.jevUnavailable = false;
    try {
      relations = this.readJev(this.home, owner, 64);
    } catch {
      this.jevUnavailable = true;
      this.jevCalls = this.jevCalls
        .filter((call) => !owner || ownerKey(call.relation.owner) === ownerKey(owner))
        .map((call) => ({ ...call, unavailable: 'jev_relations_unavailable' }));
      return;
    }
    const previous = new Map(
      this.jevCalls.map((call) => [`${ownerKey(call.relation.owner)}:${call.relation.instanceId}`, call])
    );
    const retained = (relation: JevRelation, unavailable: string): JevCallDisplay => ({
      ...previous.get(`${ownerKey(relation.owner)}:${relation.instanceId}`),
      relation,
      snapshot: previous.get(`${ownerKey(relation.owner)}:${relation.instanceId}`)?.snapshot ?? null,
      unavailable,
    });
    const signal = AbortSignal.timeout(40);
    const owners = new Map(relations.map((r) => [ownerKey(r.owner), r.owner]));
    const listings = new Map<string, Promise<unknown>>(
      [...owners].map(([key, parent]) => [key, this.port.invoke(parent, 'jev_list', {}, signal)])
    );
    this.jevCalls = await Promise.all(
      relations.map(async (relation) => {
        try {
          const listing = record(await listings.get(ownerKey(relation.owner)));
          const live = Array.isArray(listing.instances)
            ? listing.instances.find((value) => record(value).instanceId === relation.instanceId)
            : undefined;
          if (!live) return retained(relation, 'jev_instance_not_live');
          const observation = record(record(live).observation);
          if (
            ['run_yield', 'snapshot', 'command'].includes(observation.source as string) &&
            typeof observation.receivedAt === 'number' &&
            Number.isFinite(observation.receivedAt) &&
            Object.hasOwn(observation, 'value')
          )
            return {
              relation,
              snapshot: observation.value,
              unavailable: null,
              observationSource: observation.source as 'run_yield' | 'snapshot' | 'command',
              receivedAt: observation.receivedAt,
            };
          const snapshot = await this.port.invoke(
            relation.owner,
            'jev_snapshot',
            { instanceId: relation.instanceId },
            signal
          );
          return { relation, snapshot, unavailable: null };
        } catch (error) {
          return retained(relation, error instanceof Error ? error.message : 'jev_snapshot_unavailable');
        }
      })
    );
  }
  private async collectNative(owner?: NativeOwner): Promise<void> {
    this.unavailable = null;
    let relations: DirectRelation[];
    try {
      relations = this.read(this.home, owner, 64);
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : 'relations_unavailable';
      this.calls = this.calls
        .filter((call) => !owner || ownerKey(call.relation.owner) === ownerKey(owner))
        .map((call) => ({ ...call, unavailable: this.unavailable }));
      return;
    }
    const owners = new Map(relations.map((r) => [ownerKey(r.owner), r.owner]));
    const observations = new Map<string, { connections: unknown[]; events: HostMessage[]; error: string | null }>();
    await Promise.all(
      [...owners].map(async ([key, parent]) => {
        try {
          const signal = AbortSignal.timeout(40);
          const [listing, page] = await Promise.all([
            this.port.invoke(parent, 'list', {}, signal),
            this.port.invoke(parent, 'wait', { waitMs: 0, afterSeq: 0 }, signal),
          ]);
          observations.set(key, {
            connections: Array.isArray(record(listing).connections) ? (record(listing).connections as unknown[]) : [],
            events: Array.isArray(record(page).events) ? (record(page).events as HostMessage[]) : [],
            error: null,
          });
        } catch (error) {
          observations.set(key, {
            connections: [],
            events: [],
            error: error instanceof Error ? error.message : 'native_host_unavailable',
          });
        }
      })
    );
    const previous = new Map(
      this.calls.map((call) => [`${ownerKey(call.relation.owner)}:${nativeKey(call.relation.child)}`, call])
    );
    this.calls = relations.map((relation) => {
      const observation = observations.get(ownerKey(relation.owner))!;
      const matching = observation.connections.filter((value) => {
        const ref = record(value).nativeRef;
        return ref && nativeKey(ref as DirectRelation['child']) === nativeKey(relation.child);
      });
      const snapshot = matching.find((value) => !record(value).transportEnd) ?? matching[0] ?? null;
      const connectionId = record(snapshot).connectionId;
      const events = observation.events.filter(
        (e) =>
          typeof connectionId === 'string' &&
          e.connectionId === connectionId &&
          e.nativeRef &&
          nativeKey(e.nativeRef) === nativeKey(relation.child)
      );
      const old = previous.get(`${ownerKey(relation.owner)}:${nativeKey(relation.child)}`);
      return {
        relation,
        snapshot: snapshot ?? old?.snapshot ?? null,
        latestEvent: events.at(-1) ?? (snapshot ? null : (old?.latestEvent ?? null)),
        unavailable: observation.error ?? (snapshot ? null : 'native_connection_not_loaded'),
      };
    });
  }
  /** Kept separate from collection so afterPaint cannot overwrite direct calls with a legacy-only view. */
  merge(legacy: DelegationViewModel | null): DelegationViewModel | null {
    if (!this.calls.length && !this.jevCalls.length) return legacy;
    const view: DelegationViewModel = legacy ?? {
      tree: {
        ledger: { state: 'degraded', ledgerId: null, asOfSeq: null, reason: 'legacy_ledger_not_used' },
        nodes: [],
        relations: [],
        candidates: [],
        selectionMap: {},
        continuation: [],
        truncation: { candidates: 0, conflictRecords: 0, continuation: 0 },
        counts: {
          confirmedSessions: 0,
          delegationIntents: 0,
          jobs: 0,
          knownUnloaded: 0,
          omitted: 0,
          unknownDescendants: true,
        },
        io: { bytesRead: null, recordsRead: null, remainingBytes: 0, exceeded: false },
        coverage: coverage(),
      },
      capacity: null,
      limits: loadLimits(this.home),
      details: {},
      pendingStatus: 0,
    };
    const nodes = [...view.tree.nodes];
    const details = { ...view.details };
    let omitted = 0;
    for (const call of this.calls) {
      const relation = call.relation;
      let parent = nodes.find((n) => n.key === displayNodeKey({ kind: 'session', ref: relation.owner }));
      if (nodes.length + (parent ? 1 : 2) > 200) {
        omitted++;
        continue;
      }
      if (!parent) {
        parent = node(relation.owner, null, 0);
        nodes.push(parent);
        details[parent.key] = emptyDetails();
      }
      const child = relation.child;
      // This namespace is display-only, not an invented native source locator or control identity.
      const ref: NativeOwner = {
        harness: child.harness,
        sourceId: digest(['native-host-display', ownerKey(relation.owner), relation.profileId]),
        sessionId: child.harness === 'codex' ? child.threadId : child.sessionId,
        threadId: null,
      };
      const next = node(ref, parent.key, parent.depth + 1);
      next.key = `native-call:${ownerKey(relation.owner)}:${nativeKey(child)}`;
      next.loaded = call.snapshot !== null && !call.unavailable;
      const previous = nodes.findIndex((n) => n.key === next.key);
      if (previous < 0) nodes.push(next);
      else nodes[previous] = next;
      details[next.key] = { ...emptyDetails(), nativeCall: call };
    }
    for (const call of this.jevCalls) {
      const relation = call.relation;
      let parent = nodes.find((n) => n.key === displayNodeKey({ kind: 'session', ref: relation.owner }));
      if (nodes.length + (parent ? 1 : 2) > 200) {
        omitted++;
        continue;
      }
      if (!parent) {
        parent = node(relation.owner, null, 0);
        nodes.push(parent);
        details[parent.key] = emptyDetails();
      }
      const identity = {
        kind: 'job' as const,
        ref: { kind: 'jev' as const, provider: 'jev-ultrafast', key: relation.instanceId },
      };
      const next: LinkTreeNode = {
        ...node(relation.owner, parent.key, parent.depth + 1),
        identity,
        key: displayNodeKey(identity),
        loaded: call.snapshot !== null && !call.unavailable,
      };
      const previous = nodes.findIndex((n) => n.key === next.key);
      if (previous < 0) nodes.push(next);
      else nodes[previous] = next;
      details[next.key] = { ...emptyDetails(), jevCall: call };
    }
    return {
      ...view,
      details,
      tree: {
        ...view.tree,
        nodes,
        counts: {
          ...view.tree.counts,
          confirmedSessions: nodes.filter((n) => n.identity.kind === 'session').length,
          jobs: nodes.filter((n) => n.identity.kind === 'job').length,
          omitted: view.tree.counts.omitted + omitted,
          unknownDescendants: true,
        },
      },
      nativeCalls: { count: this.calls.length + this.jevCalls.length, unavailable: this.unavailable },
    };
  }
}
