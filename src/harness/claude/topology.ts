import fs from 'node:fs';
import path from 'node:path';
import type { NativeTopologyResult, ReaderBudget } from '../../core/interfaces/harness-adapter.js';
import type { ReaderCheckpoint } from '../../core/types/observation.js';
import type { SessionRef } from '../../core/types/identity.js';
import { sameSessionRef, sessionRefKey } from '../../core/identity.js';
import { ClaudeTranscriptFiles } from './binding.js';
import { createClaudeReader, type ClaudeReaderResult, type ClaudeSessionReader } from './reader.js';

const MAX_NATIVE_CALLS = 10000;
const MAX_DIRECTORY_ENTRIES = 20000;
const MAX_META_FILES = 10000;
const MAX_META_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 128 * 1024;
const MAX_HEADER_RECORDS = 64;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = (file: string): string | null => {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return null;
  }
};
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
interface Candidate {
  ref: SessionRef;
  meta: string;
  file: string;
  metaStamp: string;
  bytes: Buffer;
  position: number;
  callId?: string;
  reader?: ClaudeSessionReader;
  headerBytes: number;
  headerRecords: number;
}
interface Parent {
  ref: SessionRef;
  file: string | null;
  fileId?: ReaderCheckpoint['fileId'];
  fileStamp?: string;
  sourceGeneration?: number;
  offset: number;
  fullHistory: boolean;
  observed: boolean;
  awaitingRead: boolean;
  callLimit: boolean;
  atEof: boolean;
  calls: Set<string>;
  dirty: boolean;
  token: number;
  readerEpoch: number;
  directory: string | null;
  directoryStamp: string | null;
  known: Map<string, string | null>;
  poll: number;
  entries?: string[];
  listing?: fs.Dir;
  listed: number;
  listingLimit: boolean;
  cursor: number;
  pending?: Candidate;
  children: Map<string, SessionRef>;
  owners: Map<string, string>;
  conflicts: Set<string>;
  gaps: Set<string>;
}

/** Joins observed parent calls to bounded metadata/header reads. Never infers a parent from a directory name. */
export class ClaudeNativeTopology {
  private parents = new Map<string, Parent>();
  constructor(private readonly files: ClaudeTranscriptFiles) {}

  private parent(target: SessionRef): Parent {
    const ref = this.files.validate(target);
    const key = sessionRefKey(ref);
    let value = this.parents.get(key);
    if (!value) {
      value = {
        ref,
        file: null,
        offset: 0,
        fullHistory: false,
        observed: false,
        awaitingRead: true,
        callLimit: false,
        atEof: false,
        calls: new Set(),
        dirty: true,
        token: 0,
        readerEpoch: 0,
        directory: null,
        directoryStamp: null,
        known: new Map(),
        poll: 0,
        cursor: 0,
        listed: 0,
        listingLimit: false,
        children: new Map(),
        owners: new Map(),
        conflicts: new Set(),
        gaps: new Set(),
      };
      this.parents.set(key, value);
    }
    return value;
  }

  private closeListing(parent: Parent): void {
    try {
      parent.listing?.closeSync();
    } catch {}
    parent.listing = undefined;
  }

  private related(parent: Parent): Parent[] {
    return [...this.parents.values()].filter(
      (other) => other !== parent && other.ref.sessionId === parent.ref.sessionId
    );
  }

  private clearCalls(parent: Parent): void {
    for (const other of this.related(parent))
      if ([...parent.calls].some((call) => other.calls.has(call))) this.invalidate(other);
    parent.calls.clear();
    parent.callLimit = false;
  }

  private invalidate(parent: Parent): void {
    this.closeListing(parent);
    parent.dirty = true;
    parent.token++;
    parent.entries = undefined;
    parent.pending = undefined;
    parent.children.clear();
  }

  begin(ref: SessionRef, checkpoint?: ReaderCheckpoint): number {
    const parent = this.parent(ref);
    if (!parent.observed) parent.fullHistory = !checkpoint || checkpoint.offset === 0;
    else if (!checkpoint || checkpoint.offset === 0) {
      this.clearCalls(parent);
      parent.fullHistory = true;
      parent.observed = false;
      parent.atEof = false;
      this.invalidate(parent);
    } else if (
      !parent.fileId ||
      parent.fileId.dev !== checkpoint.fileId.dev ||
      parent.fileId.inode !== checkpoint.fileId.inode ||
      parent.sourceGeneration !== checkpoint.sourceGeneration ||
      checkpoint.offset > parent.offset
    ) {
      this.clearCalls(parent);
      parent.fullHistory = false;
      parent.atEof = false;
      this.invalidate(parent);
    }
    return ++parent.readerEpoch;
  }

  observe(result: ClaudeReaderResult, epoch: number): void {
    const cp = result.checkpoint;
    const parent = this.parent(cp.ref);
    if (epoch !== parent.readerEpoch) return;
    const physicalReset =
      parent.fileId &&
      (parent.fileId.dev !== cp.fileId.dev ||
        parent.fileId.inode !== cp.fileId.inode ||
        (parent.sourceGeneration !== cp.sourceGeneration && cp.resetReason !== 'compaction'));
    if (physicalReset) {
      this.clearCalls(parent);
      parent.fullHistory = true;
    }
    const before = parent.calls.size;
    for (const call of result.nativeSlice?.agentCalls ?? [])
      if (
        sameSessionRef(call.ref, cp.ref) &&
        call.fileId.dev === cp.fileId.dev &&
        call.fileId.inode === cp.fileId.inode &&
        call.offset <= cp.offset &&
        (call.sourceGeneration === cp.sourceGeneration ||
          (cp.resetReason === 'compaction' && call.sourceGeneration < cp.sourceGeneration))
      ) {
        if (parent.calls.size >= MAX_NATIVE_CALLS && !parent.calls.has(call.callId)) {
          if (!parent.callLimit) this.invalidate(parent);
          parent.callLimit = true;
          parent.fullHistory = false;
          continue;
        }
        if (!parent.calls.has(call.callId))
          for (const other of this.related(parent)) if (other.calls.has(call.callId)) this.invalidate(other);
        parent.calls.add(call.callId);
      }
    const atEof = result.observation.coverage.state !== 'catching_up' && !result.continuation;
    if (physicalReset || before !== parent.calls.size || atEof !== parent.atEof || !parent.observed)
      this.invalidate(parent);
    parent.observed = true;
    parent.awaitingRead = false;
    parent.atEof = atEof;
    parent.fileId = { ...cp.fileId };
    parent.sourceGeneration = cp.sourceGeneration;
    parent.offset = cp.offset;
    const stat = cp.claude.fileStat;
    parent.fileStamp = stat
      ? `${cp.fileId.dev}:${cp.fileId.inode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      : undefined;
  }

  state(ref: SessionRef, checkChanges = true, deadline = performance.now() + 2) {
    const parent = this.parent(ref);
    if (checkChanges && performance.now() < deadline) {
      try {
        const file = this.files.resolve(ref, deadline);
        if (!file && parent.file) {
          parent.file = null;
          this.invalidateSession(ref);
        }
        if (file && file !== parent.file) {
          parent.file = file;
          this.invalidate(parent);
        }
        if (file) {
          const stat = fs.statSync(file);
          if (
            parent.fileId &&
            (parent.fileId.dev !== stat.dev || parent.fileId.inode !== stat.ino || stat.size < parent.offset)
          )
            this.invalidateSession(ref);
          if (parent.fileStamp && stamp(file) !== parent.fileStamp && !parent.awaitingRead) {
            parent.atEof = false;
            parent.awaitingRead = true;
            this.invalidate(parent);
          }
          const directory = ref.threadId
            ? path.dirname(file)
            : path.join(path.dirname(file), ref.sessionId, 'subagents');
          const current = stamp(directory);
          if (directory !== parent.directory || current !== parent.directoryStamp) {
            parent.directory = directory;
            parent.directoryStamp = current;
            this.invalidate(parent);
          }
        }
        const entries = [...parent.known];
        for (let n = 0; n < Math.min(32, entries.length) && performance.now() < deadline; n++) {
          const [file, previous] = entries[parent.poll++ % entries.length];
          if (stamp(file) !== previous) {
            this.invalidate(parent);
            break;
          }
        }
      } catch {
        parent.file = null;
        parent.atEof = false;
        this.invalidate(parent);
      }
    }
    return { file: parent.file, topologyDirty: parent.dirty, topologyToken: parent.token };
  }

  invalidateSession(ref: SessionRef): void {
    const parent = this.parent(ref);
    this.clearCalls(parent);
    parent.fullHistory = false;
    parent.observed = false;
    parent.awaitingRead = true;
    parent.atEof = false;
    this.invalidate(parent);
  }

  async collect(ref: SessionRef, budget: ReaderBudget): Promise<NativeTopologyResult> {
    if (
      !Number.isSafeInteger(budget.maxBytes) ||
      budget.maxBytes < 0 ||
      !Number.isSafeInteger(budget.maxRecords) ||
      budget.maxRecords < 0 ||
      !Number.isFinite(budget.budgetMs) ||
      budget.budgetMs < 0
    )
      throw new Error('invalid_reader_budget');
    const parent = this.parent(ref);
    let bytesRead = 0,
      recordsRead = 0;
    const deadline = performance.now() + Math.min(20, budget.budgetMs);
    const byteLimit = Math.min(4 * 1024 * 1024, budget.maxBytes);
    const recordLimit = Math.min(2000, budget.maxRecords);
    const hasBudget = () => bytesRead < byteLimit && recordsRead < recordLimit && performance.now() < deadline;
    if (!hasBudget()) return this.result(parent, 0, 0);
    this.state(ref, true, deadline);
    if (!parent.directory || !parent.file || !hasBudget() || !parent.observed || parent.awaitingRead)
      return this.result(parent, 0, 0);
    if (!parent.calls.size) {
      this.closeListing(parent);
      parent.gaps.clear();
      parent.owners.clear();
      parent.known.clear();
      parent.listingLimit = false;
      parent.children.clear();
      parent.dirty = false;
      return this.result(parent, 0, 0);
    }
    if (!parent.entries && parent.dirty) {
      parent.cursor = 0;
      parent.children.clear();
      parent.owners.clear();
      parent.conflicts.clear();
      parent.gaps.clear();
      parent.known.clear();
      parent.listingLimit = false;
      try {
        const real = fs.realpathSync(parent.directory);
        if (!inside(this.files.root, real) || real !== parent.directory)
          throw new Error('claude_topology_outside_source');
        parent.entries = [];
        parent.listed = 0;
        parent.listingLimit = false;
        parent.listing = fs.opendirSync(parent.directory);
      } catch (error) {
        parent.entries = [];
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') parent.gaps.add('native_metadata_unavailable');
      }
    }
    while (parent.listing && hasBudget()) {
      let entry: fs.Dirent | null;
      try {
        entry = parent.listing.readSync();
      } catch {
        this.closeListing(parent);
        parent.gaps.add('native_metadata_unavailable');
        parent.listingLimit = true;
        break;
      }
      if (!entry) {
        this.closeListing(parent);
        parent.entries!.sort();
        break;
      }
      parent.listed++;
      if (/^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(entry.name)) parent.entries!.push(entry.name);
      if (parent.listed >= MAX_DIRECTORY_ENTRIES || parent.entries!.length >= MAX_META_FILES) {
        parent.listingLimit = true;
        parent.gaps.add('native_metadata_limit');
        this.closeListing(parent);
        parent.entries!.sort();
      }
    }
    if (parent.listing) return this.result(parent, bytesRead, recordsRead);
    while (parent.entries && parent.cursor < parent.entries.length && hasBudget()) {
      if (!parent.pending) {
        const name = parent.entries[parent.cursor];
        const child: SessionRef = { ...parent.ref, threadId: name.slice(6, -10) };
        const meta = path.join(parent.directory, name);
        const file = path.join(parent.directory, `agent-${child.threadId}.jsonl`);
        // Failed candidates are watched too, so a repaired or newly created file can recover.
        parent.known.set(meta, stamp(meta));
        parent.known.set(file, stamp(file));
        try {
          const directory = fs.realpathSync(parent.directory);
          const real = fs.realpathSync(meta);
          const stat = fs.statSync(real);
          if (!inside(directory, real) || !stat.isFile() || stat.size > MAX_META_BYTES)
            throw new Error('invalid_native_metadata');
          parent.pending = {
            ref: child,
            meta: real,
            file,
            metaStamp: stamp(real)!,
            bytes: Buffer.alloc(stat.size),
            position: 0,
            headerBytes: 0,
            headerRecords: 0,
          };
        } catch {
          parent.gaps.add('native_metadata_unavailable');
          parent.cursor++;
          continue;
        }
      }
      const item = parent.pending;
      if (!item.reader) {
        if (stamp(item.meta) !== item.metaStamp) {
          this.invalidate(parent);
          break;
        }
        const remaining = item.bytes.length - item.position;
        if (remaining) {
          let fd: number | undefined;
          try {
            fd = fs.openSync(item.meta, 'r');
            const stat = fs.fstatSync(fd);
            if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== item.metaStamp)
              throw new Error('native_metadata_changed');
            const n = fs.readSync(
              fd,
              item.bytes,
              item.position,
              Math.min(remaining, byteLimit - bytesRead),
              item.position
            );
            bytesRead += n;
            item.position += n;
            if (!n) throw new Error('short_native_metadata');
          } catch {
            parent.gaps.add('native_metadata_unavailable');
            parent.pending = undefined;
            parent.cursor++;
            continue;
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
          if (item.position < item.bytes.length || !hasBudget()) break;
        }
        recordsRead++;
        try {
          const meta: unknown = JSON.parse(item.bytes.toString('utf8'));
          if (
            !object(meta) ||
            typeof meta.toolUseId !== 'string' ||
            !meta.toolUseId ||
            meta.toolUseId.length > 256 ||
            (meta.agentId !== undefined && meta.agentId !== item.ref.threadId) ||
            (meta.sessionId !== undefined && meta.sessionId !== item.ref.sessionId)
          )
            throw new Error('invalid_native_metadata');
          item.callId = meta.toolUseId;
          if (sameSessionRef(item.ref, parent.ref)) throw new Error('native_self_edge');
          if (this.related(parent).some((other) => other.calls.has(item.callId!))) {
            parent.gaps.add('ambiguous_native_parent');
            parent.pending = undefined;
            parent.cursor++;
            continue;
          }
          if (!parent.calls.has(item.callId)) {
            parent.pending = undefined;
            parent.cursor++;
            continue;
          }
          const owner = parent.owners.get(item.callId);
          if (owner && owner !== item.ref.threadId) {
            parent.conflicts.add(item.callId);
            parent.children.delete(owner);
            parent.gaps.add('ambiguous_native_call');
          }
          parent.owners.set(item.callId, item.ref.threadId!);
          if (parent.conflicts.has(item.callId)) {
            parent.pending = undefined;
            parent.cursor++;
            continue;
          }
          const resolveFile = (until?: number) => {
            const real = this.files.remember(item.ref, item.file, false, false, until);
            if (!inside(fs.realpathSync(parent.directory!), real)) throw new Error('native_child_outside_parent');
            return real;
          };
          item.reader = createClaudeReader({ ref: item.ref, resolveFile, serverNames: [] });
        } catch {
          parent.gaps.add('invalid_native_metadata');
          parent.pending = undefined;
          parent.cursor++;
          continue;
        }
      }
      if (!hasBudget()) break;
      const token = parent.token;
      const epoch = parent.readerEpoch;
      try {
        const result = await item.reader.read({
          maxBytes: Math.min(byteLimit - bytesRead, MAX_HEADER_BYTES - item.headerBytes),
          maxRecords: Math.min(recordLimit - recordsRead, MAX_HEADER_RECORDS - item.headerRecords),
          budgetMs: Math.max(0, deadline - performance.now()),
          deadlineMs: deadline,
        });
        bytesRead += result.stats!.bytesRead;
        recordsRead += result.stats!.recordsRead;
        if (token !== parent.token || epoch !== parent.readerEpoch || parent.pending !== item)
          return this.result(parent, bytesRead, recordsRead);
        if (!parent.file || stamp(parent.file) !== parent.fileStamp) {
          parent.awaitingRead = true;
          parent.atEof = false;
          this.invalidate(parent);
          return this.result(parent, bytesRead, recordsRead);
        }
        if (stamp(item.file) !== parent.known.get(item.file)) throw new Error('native_child_changed');
        item.headerBytes += result.stats!.bytesRead;
        item.headerRecords += result.stats!.recordsRead;
        if (result.checkpoint.parserState.gaps.includes('identity_mismatch'))
          throw new Error('native_child_identity_mismatch');
        if (result.nativeSlice?.identityVerified) parent.children.set(item.ref.threadId!, { ...item.ref });
        else if (
          result.observation.coverage.state === 'catching_up' &&
          !result.continuation &&
          item.headerBytes < MAX_HEADER_BYTES &&
          item.headerRecords < MAX_HEADER_RECORDS
        )
          break;
        else throw new Error('native_child_identity_unverified');
      } catch {
        if (token !== parent.token || epoch !== parent.readerEpoch || parent.pending !== item)
          return this.result(parent, bytesRead, recordsRead);
        parent.gaps.add('native_child_identity_unverified');
      }
      parent.pending = undefined;
      parent.cursor++;
    }
    if (parent.entries && parent.cursor === parent.entries.length && !parent.pending) parent.dirty = false;
    return this.result(parent, bytesRead, recordsRead);
  }

  private result(parent: Parent, bytesRead: number, recordsRead: number): NativeTopologyResult {
    const loaded =
      !parent.dirty &&
      !parent.awaitingRead &&
      !parent.callLimit &&
      !parent.listingLimit &&
      parent.observed &&
      parent.atEof &&
      parent.fullHistory;
    const gaps = [...parent.gaps];
    if (!parent.fullHistory) gaps.push('native_parent_history_unconfirmed');
    if (parent.callLimit) gaps.push('native_parent_call_limit');
    if (!parent.dirty && [...parent.calls].some((call) => !parent.owners.has(call))) gaps.push('native_call_unmatched');
    return {
      children: [...parent.children.values()].map((ref) => ({ ...ref })),
      loaded,
      bytesRead,
      recordsRead,
      coverage: {
        state: parent.dirty || !parent.observed || !parent.atEof ? 'catching_up' : gaps.length ? 'partial' : 'complete',
        skipped: {},
        gaps,
        loaded,
        ...(!loaded ? { reason: 'native_topology' } : {}),
      },
    };
  }
  close(): void {
    for (const parent of this.parents.values()) this.closeListing(parent);
    this.parents.clear();
  }
}
