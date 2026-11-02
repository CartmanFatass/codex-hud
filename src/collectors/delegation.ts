import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodexAdapter } from '../harness/codex/index.js';
import { ClaudeAdapter } from '../harness/claude/index.js';
import { openLinkLedgerReader } from '../core/link-ledger-read.js';
import { openObservationStore, type ObservationStore } from '../core/observation-store.js';
import { LinkTickCollector, type LinkCollectionPort } from '../core/link/tick.js';
import { displayNodeKey } from '../core/observation.js';
import { loadLimits } from '../core/link/limits.js';
import type { CollectedLinkSession } from '../core/link/types.js';
import type { ReaderBudget, SessionReader } from '../core/interfaces/harness-adapter.js';
import type { SessionEvidence } from '../core/interfaces/session-evidence.js';
import type { LaunchProfile } from '../core/types/capabilities.js';
import type { SessionRef } from '../core/types/identity.js';
import type { ObservationView, ReaderCheckpoint } from '../core/types/observation.js';
import type { DelegationViewModel } from '../core/link/view-model.js';

function signature(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return null;
  }
}
function identity(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}
interface Source {
  adapter: CodexAdapter | ClaudeAdapter;
  root: string;
  store: ObservationStore | null;
  storeIdentity: string | null;
  storeSignature: string;
  storeDirty: boolean;
}
interface Reading {
  file?: string | null;
  checkpoint?: ReaderCheckpoint;
  ref: SessionRef;
  reader?: SessionReader;
  envelope?: CollectedLinkSession;
  raw?: SessionEvidence;
  signature: string | null;
  dirty: boolean;
  caughtUp: boolean;
  topologyToken: number;
  lastGrantedKind?: 'session' | 'native_topology';
  resetSignature?: string | null;
  resetPending?: boolean;
}
function evidenceFromView(ref: SessionRef, observation: ObservationView): SessionEvidence {
  const unknown = {
    value: null,
    quality: 'unknown' as const,
    source: 'committed:metric_unavailable',
    asOf: observation.statusProjection.observedAt,
  };
  return {
    ref,
    observation,
    cwd: observation.workspace?.cwd ?? null,
    cwdSource: 'unknown',
    cwdAsOf: observation.workspace?.cwdAsOf ?? null,
    startedAt: null,
    version: null,
    model: unknown,
    context: unknown,
    reports: [],
    native: [],
    linkEvidence: [],
    caps: {},
  };
}

class SessionCollection implements LinkCollectionPort {
  private readings = new Map<string, Reading>();
  private sourceChecks = new Map<string, { dirty: boolean; token: number }>();
  readonly minimumBytes = new Map<string, number>();
  private pendingCommits = new Set<string>();
  private commitCursor: string | undefined;
  private deadline = Infinity;
  constructor(readonly sources: Map<string, Source>) {}
  begin(deadline: number): void {
    this.deadline = deadline;
    this.charges = { bytesRead: 0, recordsRead: 0 };
    this.sourceChecks.clear();
    for (const source of this.sources.values()) {
      if (!source.store) continue;
      const file = source.store.databasePath;
      const stamp = `${signature(file)}:${signature(file + '-wal')}`;
      source.storeDirty = stamp !== source.storeSignature;
      source.storeSignature = stamp;
    }
    for (const [key, reading] of this.readings) {
      const source = this.sources.get(reading.ref.sourceId);
      if (!reading.envelope) continue;
      if (!source?.store || identity(source.store.databasePath) !== source.storeIdentity) {
        if (reading.envelope.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
      }
      if (source?.storeDirty) this.pendingCommits.add(key);
    }
    const entries = [...this.readings];
    const prior = entries.findIndex(([key]) => key === this.commitCursor);
    const ordered = [...entries.slice(prior + 1), ...entries.slice(0, prior + 1)];
    for (const [key, reading] of ordered) {
      if (performance.now() >= deadline) break;
      if (!this.pendingCommits.has(key)) continue;
      const source = this.sources.get(reading.ref.sourceId);
      if (source && this.committed(source, reading)) this.pendingCommits.delete(key);
      this.commitCursor = key;
    }
  }
  sessions(): readonly CollectedLinkSession[] {
    return [...this.readings.values()].flatMap((reading) => {
      if (!reading.envelope) return [];
      const envelope = reading.envelope;
      let topology = envelope.topology;
      const source = this.sources.get(reading.ref.sourceId);
      if (topology && source?.adapter instanceof CodexAdapter) {
        const state = source.adapter.collectionState(reading.ref, false);
        if (state.topologyDirty || state.topologyToken !== reading.topologyToken)
          topology = {
            ...topology,
            loaded: false,
            coverage: { ...topology.coverage, state: 'catching_up', loaded: false, reason: 'native_topology' },
          };
      }
      return [
        {
          ...envelope,
          bytesRead: 0,
          recordsRead: 0,
          ...(topology ? { topology: { ...topology, bytesRead: 0, recordsRead: 0 } } : {}),
        },
      ];
    });
  }
  private reading(ref: SessionRef): Reading {
    const key = displayNodeKey({ kind: 'session', ref });
    let reading = this.readings.get(key);
    if (!reading) {
      reading = { ref, signature: null, dirty: true, caughtUp: false, topologyToken: -1 };
      this.readings.set(key, reading);
    }
    return reading;
  }
  private committed(source: Source, reading: Reading): boolean {
    if (!source.store) return false;
    if (identity(source.store.databasePath) !== source.storeIdentity) {
      if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false };
      return false;
    }
    try {
      const commit = source.store.readProjection(reading.ref);
      if (!commit) {
        if (reading.envelope?.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
        return true;
      }
      // Preserve the exact committed summary/stamp. B9 checks it against the real current run.
      const prior = reading.envelope;
      if (reading.raw && prior?.sourceGeneration !== commit.sourceGeneration) return true;
      reading.envelope = {
        evidence: { ...(reading.raw ?? evidenceFromView(reading.ref, commit.summary)), observation: commit.summary },
        sourceGeneration: commit.sourceGeneration,
        linkEvidenceCurrent: reading.raw ? (prior?.linkEvidenceCurrent ?? false) : false,
        loaded: true,
        bytesRead: 0,
        recordsRead: 0,
        ...(prior?.topology ? { topology: prior.topology } : {}),
      };
      return true;
    } catch {
      if (reading.envelope)
        reading.envelope = {
          ...reading.envelope,
          loaded: false,
        }; /* Preserve the original rejected stamp as lastObservation. */
      return false;
    }
  }
  pending(ref: SessionRef): 'session' | 'native_topology' | null {
    if (performance.now() >= this.deadline) return null;
    const source = this.sources.get(ref.sourceId);
    if (!source || source.adapter.id !== ref.harness) return null;
    const reading = this.reading(ref);
    if (source.adapter instanceof CodexAdapter) {
      const first = !this.sourceChecks.has(ref.sourceId);
      const state = source.adapter.collectionState(ref, first, this.deadline);
      if (first) this.sourceChecks.set(ref.sourceId, { dirty: state.topologyDirty, token: state.topologyToken });
      if (!state.file && reading.envelope && (reading.reader || !state.topologyDirty)) {
        reading.resetPending = true;
        reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      }
      if (state.file) {
        const current = signature(state.file);
        if (current !== reading.signature) reading.dirty = true;
        if (reading.signature && current !== reading.signature) {
          const old = reading.signature.split(':'),
            next = current?.split(':');
          if (
            reading.resetSignature !== current &&
            (!next || old[0] !== next[0] || old[1] !== next[1] || Number(next[2]) <= Number(old[2]))
          ) {
            source.adapter.invalidateTopology(ref);
            reading.topologyToken = -1;
            reading.resetSignature = current;
            reading.resetPending = true;
            if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
            return 'native_topology';
          }
        }
      }
      const check = this.sourceChecks.get(ref.sourceId)!;
      if (!state.file || check.dirty || reading.topologyToken !== check.token) {
        if (state.file && reading.reader && (reading.dirty || !reading.caughtUp)) {
          return reading.lastGrantedKind === 'session' ? 'native_topology' : 'session';
        }
        return 'native_topology';
      }
    }
    return !reading.envelope || !reading.envelope.loaded || reading.dirty || !reading.caughtUp ? 'session' : null;
  }
  lineageCurrent(ref: SessionRef): boolean {
    return !this.reading(ref).resetPending;
  }
  async collect(
    ref: SessionRef,
    kind: 'session' | 'native_topology',
    budget: ReaderBudget
  ): Promise<CollectedLinkSession | null> {
    const source = this.sources.get(ref.sourceId);
    if (!source) return null;
    const reading = this.reading(ref);
    reading.lastGrantedKind = kind;
    if (kind === 'native_topology') {
      const topology = source.adapter.collectTopology
        ? await source.adapter.collectTopology(ref, budget)
        : {
            children: [],
            loaded: false,
            bytesRead: 0,
            recordsRead: 0,
            coverage: {
              state: 'partial' as const,
              skipped: {},
              gaps: ['native_topology_unavailable'],
              loaded: false,
              reason: 'native_topology_unavailable',
            },
          };
      if (!reading.resetPending) this.committed(source, reading);
      if (source.adapter instanceof CodexAdapter)
        reading.topologyToken = source.adapter.collectionState(ref, false).topologyToken;
      // Topology before any reader lineage is kept pending; never invent sourceGeneration=1.
      if (!reading.envelope) {
        reading.dirty = true;
        this.pendingTopology.set(displayNodeKey({ kind: 'session', ref }), topology);
        this.charges = { bytesRead: topology.bytesRead, recordsRead: topology.recordsRead };
        return null;
      }
      if (source.adapter instanceof CodexAdapter && !source.adapter.collectionState(ref, false).file)
        reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      this.pendingTopology.delete(displayNodeKey({ kind: 'session', ref }));
      reading.envelope = {
        ...reading.envelope,
        bytesRead: 0,
        recordsRead: 0,
        topology: { ...topology, ref, sourceGeneration: reading.envelope.sourceGeneration },
      };
      return reading.envelope;
    }
    try {
      if (source.adapter instanceof CodexAdapter) {
        const file = source.adapter.collectionState(ref, false).file;
        if (reading.file !== file) {
          reading.reader = undefined;
          reading.file = file;
        }
      }
      reading.reader ??= source.adapter.open(ref, reading.checkpoint);
      const readSignature = source.adapter instanceof CodexAdapter ? signature(reading.file!) : null;
      const previousGeneration = reading.checkpoint?.sourceGeneration;
      const result = await reading.reader.read(budget);
      if (!result.evidence || !result.stats) return null;
      const reset = previousGeneration !== undefined && previousGeneration !== result.checkpoint.sourceGeneration;
      if (reset && source.adapter instanceof CodexAdapter) {
        source.adapter.invalidateTopology(ref);
        reading.topologyToken = -1;
        this.pendingTopology.delete(displayNodeKey({ kind: 'session', ref }));
      }
      reading.resetPending = false;
      reading.resetSignature = undefined;
      reading.raw = result.evidence;
      reading.checkpoint = result.checkpoint;
      const topologyKey = displayNodeKey({ kind: 'session', ref });
      const topology = this.pendingTopology.get(topologyKey);
      this.pendingTopology.delete(topologyKey);
      reading.envelope = {
        evidence: result.evidence,
        sourceGeneration: result.checkpoint.sourceGeneration,
        linkEvidenceCurrent: !result.checkpoint.resetReason,
        loaded: result.observation.coverage.state !== 'catching_up' && !result.continuation,
        bytesRead: result.stats.bytesRead,
        recordsRead: result.stats.recordsRead,
        ...(topology
          ? {
              topology: {
                ...topology,
                ref,
                sourceGeneration: result.checkpoint.sourceGeneration,
                bytesRead: 0,
                recordsRead: 0,
              },
            }
          : !reset && reading.envelope?.topology
            ? {
                topology: {
                  ...reading.envelope.topology,
                  sourceGeneration: result.checkpoint.sourceGeneration,
                  bytesRead: 0,
                  recordsRead: 0,
                },
              }
            : {}),
      };
      reading.caughtUp = result.observation.coverage.state !== 'catching_up' && !result.continuation;
      reading.dirty = !reading.caughtUp;
      if (source.adapter instanceof CodexAdapter) {
        const state = source.adapter.collectionState(ref, false);
        reading.signature = readSignature;
      }
      const key = displayNodeKey({ kind: 'session', ref });
      if (result.continuation?.kind === 'record_needs_larger_slice')
        this.minimumBytes.set(key, result.continuation.minimumBytes);
      else this.minimumBytes.delete(key);
      const charged = { bytesRead: result.stats.bytesRead, recordsRead: result.stats.recordsRead };
      this.committed(source, reading);
      reading.envelope = { ...reading.envelope, ...charged };
      return reading.envelope;
    } catch {
      // No completed statistics are available on a thrown read: reserve its full grant conservatively.
      this.charges = { bytesRead: budget.maxBytes, recordsRead: budget.maxRecords };
      reading.dirty = true;
      if (reading.envelope) reading.envelope = { ...reading.envelope, loaded: false, linkEvidenceCurrent: false };
      return reading.envelope ?? null;
    }
  }
  private pendingTopology = new Map<string, Awaited<ReturnType<NonNullable<CodexAdapter['collectTopology']>>>>();
  charges = { bytesRead: 0, recordsRead: 0 };
  takeUnattributedIO() {
    const charged = this.charges;
    this.charges = { bytesRead: 0, recordsRead: 0 };
    return charged;
  }
  invalidateSource(sourceId: string): void {
    for (const [key, reading] of this.readings)
      if (reading.ref.sourceId === sourceId) {
        if (reading.envelope?.evidence.observation.statusProjection.observationStamp)
          reading.envelope = { ...reading.envelope, loaded: false };
        this.pendingCommits.add(key);
      }
  }
  close(): void {
    for (const source of this.sources.values()) {
      source.store?.close();
      if (source.adapter instanceof CodexAdapter) source.adapter.closeCollection();
    }
  }
}

export class HudDelegationCollector {
  private watcher: fs.FSWatcher | null = null;
  private sourceWatchers: fs.FSWatcher[] = [];
  private ledgerIdentity: string | null;
  private collecting = false;
  private preparing = false;
  private refreshPending = false;
  private closed = false;
  private constructor(
    readonly home: string,
    readonly collector: LinkTickCollector,
    private readonly port: SessionCollection,
    private readonly ambientRef: (id: string) => SessionRef | null
  ) {
    this.ledgerIdentity = identity(path.join(home, 'ledger.sqlite'));
    try {
      this.watcher = fs.watch(home, (_event, file) => {
        if (!file || ['ledger.sqlite', 'ledger.sqlite-wal', 'sources'].includes(String(file))) {
          this.refreshPending = true;
          if (!this.collecting) void this.prepare();
        }
      });
      this.watcher.unref();
    } catch {}
    this.watchSources();
  }
  private watchSources(): void {
    for (const watcher of this.sourceWatchers) watcher.close();
    this.sourceWatchers = [];
    const dirs = [
      path.join(this.home, 'sources'),
      ...[...this.port.sources.keys()].map((id) => path.join(this.home, 'sources', id)),
    ];
    for (const dir of dirs)
      try {
        const watcher = fs.watch(dir, () => {
          this.refreshPending = true;
          if (!this.collecting) void this.prepare();
        });
        watcher.unref();
        this.sourceWatchers.push(watcher);
      } catch {}
  }
  /** Startup and identity-change preparation only; never called from tick. */
  async prepare(): Promise<void> {
    if (this.closed || this.preparing || this.collecting) return;
    const next = identity(path.join(this.home, 'ledger.sqlite'));
    this.refreshPending = false;
    this.preparing = true;
    try {
      if (next !== this.ledgerIdentity) {
        const reader = await openLinkLedgerReader(path.join(this.home, 'ledger.sqlite'));
        if (this.closed) {
          reader.close();
          return;
        }
        this.collector.replaceReader(reader);
        this.ledgerIdentity = next;
      }
      let changed = false;
      for (const [sourceId, source] of this.port.sources) {
        const file = path.join(this.home, 'sources', sourceId, 'observation.sqlite');
        const nextIdentity = identity(file);
        if (nextIdentity === source.storeIdentity) continue;
        this.port.invalidateSource(sourceId);
        source.store?.close();
        source.store = null;
        try {
          source.store = await openObservationStore({ hudHome: this.home, sourceId, readOnly: true });
          source.storeIdentity = nextIdentity;
        } catch {
          if (nextIdentity === null) source.storeIdentity = null;
          else this.refreshPending = true;
        }
        if (this.closed) {
          source.store?.close();
          source.store = null;
          return;
        }
        source.storeSignature = '';
        changed = true;
      }
      if (changed) this.watchSources();
    } finally {
      this.preparing = false;
    }
  }

  async tick(sessionId: string | undefined, deadline?: number): Promise<DelegationViewModel | null> {
    this.collecting = true;
    try {
      const ref = sessionId ? this.ambientRef(sessionId) : null;
      return await this.collector.tick({
        roots: ref ? [{ kind: 'session', ref }] : [],
        deadline,
        ...(this.preparing || identity(path.join(this.home, 'ledger.sqlite')) !== this.ledgerIdentity
          ? { ledgerUnavailableReason: 'ledger_identity_changed' }
          : {}),
      });
    } catch {
      return this.collector.current();
    } finally {
      this.collecting = false;
      if (this.refreshPending)
        setImmediate(() => {
          void this.prepare();
        }).unref();
    }
  }
  close(): void {
    this.closed = true;
    this.watcher?.close();
    for (const watcher of this.sourceWatchers) watcher.close();
    this.collector.close();
    this.port.close();
  }
  static async open(
    env: Readonly<Record<string, string | undefined>> = process.env,
    ambientHome?: string
  ): Promise<HudDelegationCollector | null> {
    const home = env.HUD_HOME;
    if (!home || !path.isAbsolute(home)) return null;
    const sources = new Map<string, Source>();
    const codex = new CodexAdapter(undefined, true),
      claude = new ClaudeAdapter();
    const profiles: LaunchProfile[] = [];
    try {
      const config = JSON.parse(fs.readFileSync(path.join(home, 'delegate.json'), 'utf8'));
      if (config.version === 1 && Array.isArray(config.profiles)) profiles.push(...config.profiles.slice(0, 128));
    } catch {}
    let ambientSource: string | null = null;
    if (ambientHome)
      profiles.push({
        name: 'hud-observer',
        harness: 'codex',
        source: { root: ambientHome, label: 'Current Codex' },
        env: {},
        mcpServerName: 'hud',
      } as LaunchProfile);
    for (const profile of profiles) {
      if (
        !profile ||
        !['codex', 'claude'].includes(profile.harness) ||
        typeof profile.source?.root !== 'string' ||
        !path.isAbsolute(profile.source.root) ||
        !profile.env ||
        typeof profile.mcpServerName !== 'string'
      )
        continue;
      const adapter = profile.harness === 'codex' ? codex : claude;
      try {
        const sourceId = await adapter.resolveSource(profile, {});
        if (profile.name === 'hud-observer') ambientSource = sourceId;
        if (sources.has(sourceId)) continue;
        let store: ObservationStore | null = null;
        try {
          store = await openObservationStore({ hudHome: home, sourceId, readOnly: true });
        } catch {}
        sources.set(sourceId, {
          adapter,
          root: fs.realpathSync(profile.source.root),
          store,
          storeIdentity: store ? identity(store.databasePath) : null,
          storeSignature: '',
          storeDirty: true,
        });
      } catch {}
    }
    const port = new SessionCollection(sources);
    const reader = await openLinkLedgerReader(path.join(home, 'ledger.sqlite'));
    const collector = new LinkTickCollector(reader, home, loadLimits(home), port);
    return new HudDelegationCollector(home, collector, port, (id) =>
      ambientSource ? { harness: 'codex', sourceId: ambientSource, sessionId: id, threadId: null } : null
    );
  }
}

/** Existing adaptive cadence also observes the universal tree, with the legacy no-ledger signal unchanged. */
export function withDelegationObservation<
  T extends { activity: 'active' | 'quiet' | 'uncertain'; fingerprint?: string },
>(observation: T, view: DelegationViewModel | null | undefined): T {
  if (!view) return observation;
  const statuses = Object.values(view.details).map((detail) => detail.status);
  const activity =
    observation.activity === 'active' || statuses.some((status) => status?.activity === 'working')
      ? 'active'
      : observation.activity === 'quiet' &&
          view.tree.ledger.state === 'available' &&
          view.pendingStatus === 0 &&
          view.tree.continuation.length === 0 &&
          statuses.every((status) => status?.activity === 'idle' || status?.isRunTerminal === true)
        ? 'quiet'
        : 'uncertain';
  return {
    ...observation,
    activity,
    fingerprint: JSON.stringify([
      observation.fingerprint,
      view.tree.ledger.ledgerId,
      view.tree.ledger.asOfSeq,
      statuses.map((status) =>
        status ? [status.stateKey, status.observationStamp?.seqDomain, status.observationStamp?.commitSeq] : null
      ),
    ]),
  };
}
