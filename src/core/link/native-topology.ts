import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RolloutParser } from '../../collectors/rollout.js';
import { sessionParentId } from '../../utils/session-parent.js';
import { initialParserState } from '../observation.js';
import { agentDisplayName, agentPickerLabel, identityFromMeta } from '../../collectors/subagent-tree.js';
import type { NativeMetadata } from './types.js';
import type { NativeTopologyResult, ReaderBudget } from '../interfaces/harness-adapter.js';
import type { SessionRef } from '../types/identity.js';
import type { ReaderParserState } from '../types/observation.js';
interface FileStamp {
  key: string;
  identity: string;
  size: number;
}
const stamp = (file: string): FileStamp | null => {
  try {
    const s = fs.statSync(file);
    return {
      key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`,
      identity: `${s.dev}:${s.ino}`,
      size: s.size,
    };
  } catch {
    return null;
  }
};
interface Header {
  file: string;
  stamp: FileStamp | null;
  id: string | null;
  parent: string | null;
  native?: NativeMetadata;
  parser?: RolloutParser;
  state: ReaderParserState;
}

/** A source-local resumable catalog. Every header uses the production parser. Metadata
 * polling has its own retained cursor and a bounded slice of the same caller deadline.
 */
export class MeteredCodexTopology {
  private directories = new Map<string, FileStamp | null>();
  private stack: { file: string; dir: fs.Dir }[] = [];
  private headers = new Map<string, Header>();
  private byId = new Map<string, Set<string>>();
  private byParent = new Map<string, Set<string>>();
  private pending: Header[] = [];
  private complete = false;
  private gaps = new Set<string>();
  private revision = 0;
  private seen = new Set<string>();
  private enumerating = false;
  private pruning: Iterator<[string, Header]> | null = null;
  private pollKeys: { file: string; directory: boolean }[] = [];
  private pollCursor = 0;
  private lastPollChecks = 0;
  private missingSearches = new Set<string>();
  constructor(private readonly root: string) {}
  private clearIdentity(header: Header): void {
    if (header.id) {
      const files = this.byId.get(header.id);
      files?.delete(header.file);
      if (!files?.size) this.byId.delete(header.id);
    }
    if (header.parent) {
      const files = this.byParent.get(header.parent);
      files?.delete(header.file);
      if (!files?.size) this.byParent.delete(header.parent);
    }
    header.id = null;
    header.parent = null;
    header.native = undefined;
  }
  private identify(header: Header, id: string, parent: string | null): void {
    this.clearIdentity(header);
    header.id = id;
    header.parent = parent;
    const files = this.byId.get(id) ?? new Set<string>();
    files.add(header.file);
    this.byId.set(id, files);
    if (parent) {
      const children = this.byParent.get(parent) ?? new Set<string>();
      children.add(header.file);
      this.byParent.set(parent, children);
    }
  }
  private invalidate(header: Header): void {
    this.clearIdentity(header);
    header.parser = undefined;
    header.state = initialParserState();
    header.stamp = null;
    if (!this.pending.includes(header)) this.pending.push(header);
    this.complete = false;
    this.revision++;
  }
  /** Called when a body reader actually observes a new reading lineage. */
  invalidateSession(ref: SessionRef): void {
    for (const file of [...(this.byId.get(ref.sessionId) ?? [])]) {
      const h = this.headers.get(file);
      if (h) this.invalidate(h);
    }
  }
  private start(): void {
    this.closeDirectories();
    this.complete = false;
    this.enumerating = true;
    this.seen.clear();
    this.directories.clear();
    this.pruning = null;
    for (const name of ['sessions', 'archived_sessions']) {
      const file = path.join(this.root, name);
      this.directories.set(file, stamp(file));
      try {
        this.stack.push({ file, dir: fs.opendirSync(file) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.gaps.add('native_directory_unavailable');
      }
    }
    this.revision++;
  }
  /** No I/O: the bounded metadata poll below is the only full-catalog invalidation path. */
  changed(): boolean {
    return !this.complete;
  }
  token(): number {
    return this.revision;
  }
  file(ref: SessionRef): string | null {
    const files = this.byId.get(ref.sessionId);
    return files?.size === 1 ? (files.values().next().value ?? null) : null;
  }
  metadataChecks(): number {
    return this.lastPollChecks;
  }
  pollMetadata(deadline: number, maxEntries = 32, ref?: SessionRef): void {
    this.lastPollChecks = 0;
    if (!this.complete || !this.pollKeys.length) return;
    const stop = Math.min(deadline, performance.now() + 2);
    const known = ref ? this.file(ref) : null;
    if (known && performance.now() < stop) {
      const dir = path.dirname(known);
      this.lastPollChecks++;
      if (stamp(dir)?.key !== this.directories.get(dir)?.key) {
        this.start();
        return;
      }
    }
    while (this.lastPollChecks < maxEntries && performance.now() < stop) {
      const item = this.pollKeys[this.pollCursor++ % this.pollKeys.length];
      this.lastPollChecks++;
      const current = stamp(item.file);
      if (item.directory) {
        if (current?.key !== this.directories.get(item.file)?.key) {
          this.start();
          return;
        }
        continue;
      }
      const h = this.headers.get(item.file);
      if (!h || current?.key === h.stamp?.key) continue;
      // The same append-only model as the production reader: growing the body does
      // not change an already validated header. Actual reader resets invalidate it.
      if (h.id && current && h.stamp && current.identity === h.stamp.identity && current.size > h.stamp.size) {
        h.stamp = current;
        continue;
      }
      this.invalidate(h);
      return;
    }
  }
  async collect(
    ref: SessionRef,
    budget: ReaderBudget
  ): Promise<NativeTopologyResult & { nativeMetadata?: Readonly<Record<string, NativeMetadata>> }> {
    const started = performance.now(),
      deadline = started + budget.budgetMs;
    if (!this.directories.size) this.start();
    this.pollMetadata(deadline, 32, ref);
    if (this.complete && !this.file(ref) && !this.missingSearches.has(ref.sessionId)) {
      this.missingSearches.add(ref.sessionId);
      this.start();
    }
    let bytesRead = 0,
      recordsRead = 0,
      entries = 0;
    while (
      !this.complete &&
      bytesRead < budget.maxBytes &&
      recordsRead < budget.maxRecords &&
      entries < 2000 &&
      performance.now() < deadline
    ) {
      const h = this.pending[0];
      if (h) {
        if (!h.parser) {
          h.parser = new RolloutParser(0);
          h.parser.setRolloutPath(h.file);
        }
        let found = false;
        try {
          const real = fs.realpathSync(h.file);
          if (real !== h.file || !real.startsWith(`${this.root}${path.sep}`))
            throw new Error('native_path_outside_source');
          const before = stamp(h.file);
          await h.parser.parse({
            budget: {
              maxBytes: Math.min(4 * 1024 * 1024, budget.maxBytes - bytesRead),
              maxRecords: 1,
              budgetMs: Math.max(1, Math.min(20, Math.floor(deadline - performance.now()))),
            },
            state: h.state,
            onRecord: (entry) => {
              found = true;
              const payload = entry.payload as any;
              if (entry.type === 'session_meta' && typeof payload?.id === 'string' && payload.id.length > 0) {
                this.identify(h, payload.id, sessionParentId(payload) ?? null);
                const identity = identityFromMeta(payload);
                h.native = {
                  title: agentDisplayName(identity) ?? null,
                  kind: null,
                  pickerLabel:
                    identity.agentPath || identity.nickname || identity.role ? agentPickerLabel(identity, false) : null,
                };
              } else {
                this.clearIdentity(h);
                this.gaps.add('native_header_unavailable');
              }
            },
          });
          const stats = h.parser.getReadStats();
          if (stats) {
            bytesRead += stats.bytesRead;
            recordsRead += stats.recordsRead;
            h.state = stats.state;
            for (const gap of stats.state.gaps) this.gaps.add(gap);
          }
          const after = stamp(h.file);
          if (
            !before ||
            !after ||
            (before.key !== after.key && !(before.identity === after.identity && after.size > before.size))
          ) {
            this.invalidate(h);
            continue;
          }
          if (found || stats?.remainingBytes === 0 || stats?.state.gaps.length) {
            if (!found) {
              this.clearIdentity(h);
              this.gaps.add('native_header_unavailable');
            }
            h.stamp = after;
            h.parser = undefined;
            this.pending.shift();
            this.revision++;
          } else break;
        } catch {
          bytesRead = budget.maxBytes;
          this.gaps.add('native_header_unavailable');
          this.clearIdentity(h);
          h.stamp = stamp(h.file);
          h.parser = undefined;
          this.pending.shift();
          this.revision++;
        }
        continue;
      }
      const current = this.stack.at(-1);
      if (!current) {
        if (this.enumerating) {
          this.pruning ??= this.headers.entries();
          const next = this.pruning.next();
          entries++;
          if (!next.done) {
            const [file, header] = next.value;
            if (!this.seen.has(file)) {
              this.clearIdentity(header);
              this.headers.delete(file);
            }
            continue;
          }
          this.enumerating = false;
          this.pruning = null;
        }
        this.complete = true;
        this.revision++;
        this.pollKeys = [
          ...[...this.directories.keys()].map((file) => ({ file, directory: true })),
          ...[...this.headers.keys()].map((file) => ({ file, directory: false })),
        ];
        this.pollCursor = 0;
        break;
      }
      let entry: fs.Dirent | null;
      try {
        entry = current.dir.readSync();
      } catch {
        this.gaps.add('native_directory_unavailable');
        entry = null;
      }
      entries++;
      if (!entry) {
        try {
          current.dir.closeSync();
        } catch {}
        this.stack.pop();
        continue;
      }
      const file = path.join(current.file, entry.name);
      if (entry.isDirectory()) {
        if (this.directories.size >= 4096) {
          this.gaps.add('native_catalog_limit');
          continue;
        }
        this.directories.set(file, stamp(file));
        try {
          this.stack.push({ file, dir: fs.opendirSync(file) });
        } catch {
          this.gaps.add('native_directory_unavailable');
        }
      } else if (entry.isSymbolicLink()) this.gaps.add('native_symlink_skipped');
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        this.seen.add(file);
        if (this.headers.size >= 20000 && !this.headers.has(file)) {
          this.gaps.add('native_catalog_limit');
          continue;
        }
        const previous = this.headers.get(file);
        const currentStamp = stamp(file);
        if (previous && previous.stamp?.key === currentStamp?.key) continue;
        if (
          previous &&
          previous.id &&
          previous.stamp &&
          currentStamp &&
          previous.stamp.identity === currentStamp.identity &&
          currentStamp.size > previous.stamp.size
        ) {
          previous.stamp = currentStamp;
          continue;
        }
        if (previous) this.clearIdentity(previous);
        const next: Header = { file, stamp: null, id: null, parent: null, state: initialParserState() };
        this.headers.set(file, next);
        this.pending.push(next);
      }
    }
    const children: SessionRef[] = [];
    const nativeMetadata: Record<string, NativeMetadata> = Object.create(null);
    const candidates = this.byParent.get(ref.sessionId) ?? new Set<string>();
    let inspected = 0;
    for (const file of candidates) {
      if (inspected++ >= 200) break;
      const h = this.headers.get(file);
      if (h?.id && this.byId.get(h.id)?.size === 1) {
        children.push({ ...ref, sessionId: h.id, threadId: null });
        nativeMetadata[h.id] = h.native ?? { title: null, kind: null };
      }
    }
    const omitted = Math.max(0, candidates.size - Math.min(inspected, 200));
    return {
      children,
      nativeMetadata,
      loaded: this.complete,
      coverage: {
        state: !this.complete ? 'catching_up' : this.gaps.size || omitted ? 'partial' : 'complete',
        skipped: omitted ? { native_nodes: omitted } : {},
        gaps: [...this.gaps],
        loaded: this.complete,
        ...(!this.complete ? { reason: 'native_topology' } : omitted ? { reason: 'nodes' } : {}),
      },
      bytesRead,
      recordsRead,
    };
  }
  private closeDirectories(): void {
    for (const entry of this.stack)
      try {
        entry.dir.closeSync();
      } catch {}
    this.stack = [];
  }
  close(): void {
    this.closeDirectories();
  }
}
