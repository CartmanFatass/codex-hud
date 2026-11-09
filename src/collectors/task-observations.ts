/** Bounded passive workspace/artifact observer. No execution, session search, watchers or writes. */
import * as fs from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseDispatchStatus, type DispatchStatus } from '../roles/pi-dispatch-status.js';
import { answerRecord, designRecords, reviewRecord, revisionOf } from './work-artifacts.js';
import type { JobDisplay } from './job-display-types.js';
import type {
  DecisionRecord,
  EvidenceRef,
  ObservationCost,
  TaskSnapshot,
  WorkLane,
  LaneIdentity,
} from './workboard-types.js';
export interface ArtifactSlice {
  deadline?: number;
  maxBytes?: number;
  maxFiles?: number;
  maxEntries?: number;
}
interface FileFact {
  signature: string;
  revision: string;
  at: number;
  text: string;
  stale: boolean;
}
interface Directory {
  stamp: string;
  identity: string;
  names: string[];
  pending: string[];
  handle?: fs.Dir;
  complete: boolean;
  unavailable?: boolean;
}
interface QaPair {
  questionSignature: string;
  answerSignature: string;
  record: DecisionRecord | null;
}
interface Source {
  id: string;
  directory: string;
  identity: LaneIdentity;
  files: Map<string, FileFact>;
  names: string[];
  cursor: number;
  lane?: WorkLane;
  dirty: boolean;
  issues: Set<string>;
  invalidStatus?: boolean;
  qaPending?: boolean;
  pairs: Map<string, QaPair>;
  pairCursor: number;
  membershipPending: boolean;
  directoryAvailable: boolean;
  primaryOutput?: string;
  directoryIdentity?: string;
}
const idOf = (s: fs.Stats) => `${s.dev}:${s.ino}`;
const stamp = (s: fs.Stats) => `${idOf(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const emptyCost = (): ObservationCost => ({
  entries: 0,
  files: 0,
  bytes: 0,
  probes: 0,
  enumerations: 0,
  parses: 0,
  elapsedMs: 0,
});
const timestamp = (value: unknown): number | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export class TaskObservationCollector {
  private workspace: string | null;
  private disposed = false;
  private directories = new Map<string, Directory>();
  private sources = new Map<string, Source>();
  private pins = new Map<string, string>();
  private checked = new Map<string, fs.Stats>();
  private revision = 0;
  private turn = 0;
  private discoveryCursor = 0;
  private discoveryStamp = '';
  private candidates = new Map<string, 'ignored' | 'unavailable'>();
  private cost = emptyCost();
  private slice: Required<ArtifactSlice> = { deadline: Infinity, maxBytes: 256 * 1024, maxFiles: 8, maxEntries: 16 };
  private incomplete = true;
  private diagnostics: string[] = [];
  private lastLanes: readonly WorkLane[] = [];
  constructor(workspace: string | null) {
    this.workspace = workspace === null ? null : resolve(workspace);
  }
  setWorkspace(workspace: string | null): void {
    const next = workspace === null ? null : resolve(workspace);
    if (next === this.workspace) return;
    this.clear();
    this.workspace = next;
  }
  private clear(): void {
    for (const d of this.directories.values()) {
      try {
        d.handle?.closeSync();
      } catch {
        /* Closed. */
      }
    }
    this.directories.clear();
    this.sources.clear();
    this.pins.clear();
    this.candidates.clear();
    this.discoveryStamp = '';
    this.discoveryCursor = 0;
    this.turn = 0;
    this.lastLanes = [];
    this.revision++;
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
  private fail(reason: string): void {
    this.incomplete = true;
    if (this.diagnostics.length < 30 && !this.diagnostics.includes(reason)) this.diagnostics.push(reason);
  }
  private room(): boolean {
    return this.cost.probes < 64 && performance.now() < this.slice.deadline;
  }
  /** Pin every ancestor, not just realpath at open time: an ancestor replaced by another real directory is unsafe too. */
  private safe(path: string, pin = true): fs.Stats {
    const existing = this.checked.get(path);
    if (existing) return existing;
    if (!this.room()) throw new Error('deferred');
    const parent = dirname(path);
    if (parent !== path) this.safe(parent);
    if (!this.room()) throw new Error('deferred');
    this.cost.probes++;
    const s = fs.lstatSync(path);
    if (s.isSymbolicLink()) throw new Error('unsafe_path');
    const old = this.pins.get(path);
    if (pin && old && old !== idOf(s)) throw new Error('replaced_ancestor');
    if (pin && s.isDirectory()) {
      if (!this.pins.has(path) && this.pins.size >= 2048) throw new Error('metadata_capacity');
      this.pins.set(path, idOf(s));
    }
    this.checked.set(path, s);
    return s;
  }
  /** Membership is committed only at EOF; an unfinished scan never means deletion. */
  private members(path: string): string[] | null {
    let d = this.directories.get(path);
    try {
      const s = this.safe(path);
      if (!s.isDirectory() || !(s.mode & 0o444)) throw new Error('unreadable_directory');
      if (d) d.unavailable = false;
      const signature = stamp(s);
      if (d?.stamp !== signature) {
        try {
          d?.handle?.closeSync();
        } catch {
          /* Closed. */
        }
        d = { stamp: signature, identity: idOf(s), names: d?.names ?? [], pending: [], complete: false };
        this.directories.set(path, d);
      }
      if (!d.complete) {
        if (this.cost.entries >= this.slice.maxEntries || !this.room()) {
          this.fail('discovery_pending');
          return d.names;
        }
        if (!d.handle) {
          d.handle = fs.opendirSync(path);
          this.cost.enumerations++;
        }
        while (this.cost.entries < this.slice.maxEntries && this.room()) {
          const entry = d.handle.readSync();
          if (!entry) {
            d.handle.closeSync();
            d.handle = undefined;
            // A concurrent membership change restarts next opportunity, not a mixed commit.
            this.cost.probes++;
            if (stamp(fs.lstatSync(path)) !== d.stamp) {
              this.fail('directory_changed');
              return d.names;
            }
            d.names = d.pending.sort();
            d.pending = [];
            d.complete = true;
            break;
          }
          this.cost.entries++;
          if (d.pending.length < 2048) d.pending.push(entry.name);
          else this.fail('directory_capacity');
        }
        if (!d.complete) this.fail('discovery_pending');
      }
      return d.names;
    } catch (e) {
      if ((e as Error).message === 'deferred') {
        // Routine warm rotation is not a failed read. Unknown or known-failed membership
        // remains pending; a cached successful inventory may be reused without reparsing.
        if (!d?.complete) this.fail('metadata_pending');
        if (d?.unavailable) return null;
        return d?.names ?? [];
      }
      if (d) d.unavailable = true;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.directories.delete(path);
        return [];
      }
      this.fail((e as Error).message);
      return null;
    }
  }
  private admit(directory: string, identity: LaneIdentity, id: string): void {
    if (this.sources.has(id)) return;
    if (this.sources.size >= 200) {
      this.fail('lane_capacity');
      return;
    }
    this.sources.set(id, {
      id,
      directory,
      identity,
      files: new Map(),
      names: [],
      cursor: 0,
      dirty: true,
      issues: new Set(),
      pairs: new Map(),
      pairCursor: 0,
      membershipPending: true,
      directoryAvailable: false,
    });
  }
  private read(source: Source, name: string): void {
    if (this.cost.files >= this.slice.maxFiles || !this.room()) {
      this.fail('files_pending');
      return;
    }
    const path = join(source.directory, name),
      previous = source.files.get(name);
    let fd: number | undefined;
    try {
      const s = this.safe(path, false);
      const signature = stamp(s);
      if (!s.isFile() || !(s.mode & 0o444)) throw new Error('unsafe_file');
      const cap = name.endsWith('STATUS.json')
        ? 64 * 1024
        : name.endsWith('.answer.md')
          ? 16 * 1024
          : name.startsWith('qa/')
            ? 64 * 1024
            : 32 * 1024;
      if (s.size > cap) throw new Error('oversized_file');
      if (previous?.signature === signature && !previous.stale) {
        source.issues.delete(name);
        return;
      }
      if (s.size > this.slice.maxBytes - this.cost.bytes) {
        this.fail('bytes_pending');
        return;
      }
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = fs.fstatSync(fd);
      if (stamp(opened) !== signature || !opened.isFile()) throw new Error('changed_during_open');
      const buffer = Buffer.alloc(s.size);
      this.cost.files++;
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      this.cost.bytes += count;
      // Recheck ancestors after the body read, without trusting this turn's metadata cache.
      this.checked.clear();
      if (count !== s.size || stamp(fs.fstatSync(fd)) !== signature || stamp(this.safe(path, false)) !== signature)
        throw new Error('changed_during_read');
      source.issues.delete(name);
      const text = buffer.toString('utf8'),
        revision = revisionOf(text);
      if (previous?.revision === revision) {
        source.files.set(name, { ...previous, signature, stale: false });
        if (previous.stale) source.dirty = true;
        return;
      }
      source.files.set(name, { signature, revision, text, at: s.mtimeMs, stale: false });
      source.dirty = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        source.issues.delete(name);
        if (source.files.delete(name)) source.dirty = true;
      } else {
        source.issues.add(name);
        this.fail((e as Error).message);
        if (previous && !previous.stale) {
          source.files.set(name, { ...previous, stale: true });
          source.dirty = true;
        }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  /** Only changed/pending pairs need joint dependency validation. Accepted pairs survive
   * another pair's deferral; both candidate and validation cursors persist across slices. */
  private qaRecords(source: Source): DecisionRecord[] {
    const questions = [...source.files.keys()].filter((name) => /^qa\/q[1-9][0-9]{0,3}\.md$/.test(name));
    const pending = new Set<string>();
    for (const name of source.pairs.keys()) if (!source.files.has(name)) source.pairs.delete(name);
    for (const name of questions) {
      const q = source.files.get(name)!,
        answerName = name.replace('.md', '.answer.md'),
        a = source.files.get(answerName),
        pair = source.pairs.get(name);
      if (!a && !source.names.includes(answerName)) {
        source.pairs.delete(name);
        continue;
      }
      if (
        !pair ||
        q.stale ||
        a?.stale ||
        pair.questionSignature !== q.signature ||
        pair.answerSignature !== a?.signature
      )
        pending.add(name);
    }
    let attempts = 0;
    for (let n = 0; n < questions.length && attempts < 16 && this.room(); n++) {
      const name = questions[source.pairCursor++ % questions.length];
      if (!pending.has(name)) continue;
      attempts++;
      const q = source.files.get(name)!,
        answerName = name.replace('.md', '.answer.md'),
        a = source.files.get(answerName);
      if (!a || q.stale || a.stale) continue;
      try {
        const qs = this.safe(join(source.directory, name), false),
          as = this.safe(join(source.directory, answerName), false);
        if (
          !qs.isFile() ||
          !as.isFile() ||
          !(qs.mode & 0o444) ||
          !(as.mode & 0o444) ||
          stamp(qs) !== q.signature ||
          stamp(as) !== a.signature
        )
          continue;
        const evidence = (relativePath: string, file: FileFact): EvidenceRef => ({
          sourceId: source.id,
          relativePath,
          revision: file.revision,
          at: file.at,
          timeBasis: 'file-mtime',
        });
        source.pairs.set(name, {
          questionSignature: q.signature,
          answerSignature: a.signature,
          record: answerRecord(source.id, name, q.text, a.text, evidence(name, q), evidence(answerName, a)),
        });
        pending.delete(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') source.pairs.delete(name);
      }
    }
    source.qaPending = pending.size > 0;
    if (source.qaPending) {
      source.dirty = true;
      this.fail('qa_pair_pending');
    }
    return questions.flatMap((name) => {
      const record = source.pairs.get(name)?.record;
      return record ? [{ ...record, stale: pending.has(name) }] : [];
    });
  }
  private project(source: Source): void {
    if (!source.dirty && source.lane) return;
    source.dirty = false;
    if (!source.directoryAvailable) {
      if (source.lane) {
        source.lane = {
          ...source.lane,
          workers: [],
          decisions: source.lane.decisions.map((decision) => ({ ...decision, stale: true })),
        };
        this.revision++;
      }
      return;
    }
    source.qaPending = false;
    this.cost.parses++;
    const get = (name: string) => source.files.get(name);
    const evidence = (name: string): EvidenceRef => {
      const f = get(name)!;
      return { sourceId: source.id, relativePath: name, revision: f.revision, at: f.at, timeBasis: 'file-mtime' };
    };
    const statusFile = get('STATUS.json');
    let status: DispatchStatus | null = null,
      role: string | null = null,
      startedAt: number | null = null;
    if (statusFile && !statusFile.stale) {
      try {
        const raw = JSON.parse(statusFile.text);
        const output = typeof raw.output_path === 'string' ? raw.output_path : '';
        const local = relative(source.directory, output);
        if (output && isAbsolute(output) && local && !local.includes(sep) && !local.startsWith('..'))
          source.primaryOutput = local;
        if (
          output &&
          isAbsolute(output) &&
          local &&
          !local.includes(sep) &&
          !local.startsWith('..') &&
          (!raw.output_written || (get(local) && !get(local)!.stale)) &&
          ['implementer', 'sonic', 'reviewer', 'architect'].includes(raw.role)
        ) {
          status = parseDispatchStatus(raw, source.directory, 'primary', raw.role, output);
          role = raw.role;
          if (status) startedAt = timestamp(raw.started_at);
        }
      } catch {
        /* Unknown is not a worker failure. */
      }
    }
    source.invalidStatus = !!statusFile && !status;
    if (source.invalidStatus) this.fail('primary_status_unavailable');
    const brief = get('brief.md');
    const label = basename(source.directory);
    const title =
      brief?.text
        .match(/^#{1,6}\s+(.+)$/m)?.[1]
        ?.trim()
        .slice(0, 400) || label;
    const decisions: DecisionRecord[] = this.qaRecords(source);
    for (const [name, file] of source.files) {
      let records: DecisionRecord[] = [];
      if (/^qa\/q[1-9][0-9]{0,3}\.md$/.test(name)) continue;
      else {
        const round = name.match(/^review-([1-9][0-9]{0,5})\.md$/);
        if (
          round ||
          (status &&
            role === 'reviewer' &&
            name ===
              (() => {
                try {
                  return basename(JSON.parse(statusFile!.text).output_path);
                } catch {
                  return '';
                }
              })())
        ) {
          const record = reviewRecord(source.id, round ? Number(round[1]) : 0, file.text, evidence(name));
          if (record) records = [record];
        } else if (/^(?:design|notes|architect-[1-9][0-9]{0,5})\.md$/.test(name))
          records = designRecords(source.id, file.text, evidence(name));
      }
      decisions.push(
        ...records.map((r) => ({ ...r, stale: r.stale || r.evidence.some((e) => get(e.relativePath)?.stale === true) }))
      );
    }
    decisions.sort((a, b) => (a.round ?? Infinity) - (b.round ?? Infinity) || a.id.localeCompare(b.id));
    let phase: string | null = null;
    if (status) {
      if (status.helper_pending?.kind === 'review' && status.helper_pending.n)
        phase = `review r${status.helper_pending.n}`;
      else if (status.state === 'working')
        phase = role === 'architect' ? 'design' : role === 'reviewer' ? 'review' : 'build';
      else if (['idle_grace', 'closed'].includes(status.state) && status.output_written && status.settled_at)
        phase = 'awaiting-acceptance';
    }
    // Legal review facts support a review phase, never a merge or inferred acceptance.
    if (!phase && decisions.some((d) => d.kind === 'review' && !d.stale)) phase = 'review';
    if (!phase && decisions.some((d) => d.kind === 'recommendation' && !d.stale)) phase = 'design';
    const workers = status
      ? [
          {
            id: `${source.id}:primary:${status.session_id}`,
            laneId: source.id,
            harness: 'pi',
            role: role === 'implementer' ? 'imp' : role === 'architect' ? 'oracle' : role,
            task: title,
            model: status.model,
            effort: status.thinking,
            state: status.state,
            startedAt,
            settledAt: timestamp(status.settled_at),
            phase,
            homeNeedsHuman: false,
            humanEndedAt: null,
            stale: false,
            evidence: [evidence('STATUS.json')],
          },
        ]
      : statusFile
        ? (source.lane?.workers.map((worker) => ({ ...worker, stale: true })) ?? [])
        : [];
    source.lane = {
      id: source.id,
      identity: source.identity,
      label,
      title,
      startedAt,
      phase,
      workers,
      decisions,
      evidence: brief ? [evidence('brief.md')] : [],
    };
    this.revision++;
  }
  refresh(invocations: readonly JobDisplay[] = [], home?: string, slice: ArtifactSlice = {}): TaskSnapshot {
    const start = performance.now();
    this.cost = emptyCost();
    this.checked.clear();
    this.diagnostics = [];
    this.incomplete = false;
    this.slice = {
      maxFiles: Math.min(8, slice.maxFiles ?? 8),
      maxBytes: Math.min(256 * 1024, slice.maxBytes ?? 256 * 1024),
      maxEntries: Math.min(32, slice.maxEntries ?? 16),
      deadline: Math.min(start + 10, slice.deadline ?? Infinity),
    };
    if (this.disposed) return this.snapshot();
    const admitted = new Set<string>();
    if (this.workspace) {
      const base = join(this.workspace, 'tmp', 'tasks'),
        names = this.members(base);
      if (names) {
        const stamp = this.directories.get(base)?.stamp ?? '';
        if (stamp !== this.discoveryStamp) {
          this.candidates.clear();
          this.discoveryStamp = stamp;
        }
        for (const name of names) admitted.add(`task:${JSON.stringify([this.workspace, name])}`);
        // Reserve metadata room for already admitted sources. A persistent discovery cursor
        // also prevents an unsafe/non-directory prefix from starving later candidates.
        let attempts = 0;
        for (let n = 0; n < names.length && attempts < 16 && this.cost.probes < 32 && this.room(); n++) {
          if (this.sources.size >= 200) {
            if ([...admitted].some((id) => !this.sources.has(id) && this.candidates.get(id) !== 'ignored'))
              this.fail('lane_capacity');
            break;
          }
          const name = names[this.discoveryCursor++ % names.length],
            directory = join(base, name),
            id = `task:${JSON.stringify([this.workspace, name])}`;
          if (this.sources.has(id)) continue;
          attempts++;
          try {
            if (this.safe(directory).isDirectory()) {
              this.admit(directory, { kind: 'task-directory', workspace: this.workspace, directory }, id);
              this.candidates.delete(id);
            } else this.candidates.set(id, 'ignored');
          } catch (error) {
            this.candidates.set(id, 'unavailable');
            this.fail((error as Error).message);
          }
        }
        if ([...admitted].some((id) => !this.sources.has(id) && this.candidates.get(id) !== 'ignored'))
          this.fail('discovery_pending');
        for (const id of this.candidates.keys()) if (!admitted.has(id)) this.candidates.delete(id);
      } else this.fail('workspace_unavailable');
      const directory = this.directories.get(base);
      if (directory?.complete || names?.length === 0)
        for (const [id, s] of this.sources)
          if (s.identity.kind === 'task-directory' && !admitted.has(id)) {
            this.sources.delete(id);
            this.revision++;
          }
    } else this.diagnostics.push('workspace_not_bound');
    if (home)
      for (const job of invocations)
        if (job.kind === 'role') {
          const id = `invocation:${JSON.stringify([home, job.root, job.jobId])}`;
          admitted.add(id);
          this.admit(join(home, 'jobs', job.jobId), { kind: 'invocation', home, root: job.root, jobId: job.jobId }, id);
        }
    for (const [id, s] of this.sources)
      if (s.identity.kind === 'invocation' && !admitted.has(id)) {
        this.sources.delete(id);
        this.revision++;
      }
    const sources = [...this.sources.values()];
    // One source turn per pass, with persistent round-robin scheduling beyond a slice.
    for (let n = 0; n < sources.length && this.room(); n++) {
      const source = sources[this.turn++ % sources.length];
      const names = this.members(source.directory);
      if (names === null) {
        source.membershipPending = true;
        source.issues.add('directory/');
        if (source.directoryAvailable) {
          source.directoryAvailable = false;
          source.dirty = true;
        }
        this.project(source);
        continue;
      }
      if (!source.directoryAvailable) {
        source.directoryAvailable = true;
        // Availability is a projection dependency even when every body/signature is unchanged.
        // Revalidate retained facts incrementally before restoring their current eligibility.
        source.dirty = true;
        for (const [name, file] of source.files) {
          source.files.set(name, { ...file, stale: true });
          source.issues.add(name);
        }
      }
      source.issues.delete('directory/');
      const roots = names.filter((n) =>
        /^(?:brief|design|notes|report|architect-[1-9][0-9]{0,5}|review-[1-9][0-9]{0,5})\.md$|^STATUS\.json$/.test(n)
      );
      const output = source.primaryOutput;
      if (output && names.includes(output) && !roots.includes(output)) roots.push(output);
      const qa = names.includes('qa') ? this.members(join(source.directory, 'qa')) : [];
      if (qa === null) {
        source.issues.add('qa/');
        for (const [name, file] of source.files)
          if (name.startsWith('qa/') && !file.stale) {
            source.files.set(name, { ...file, stale: true });
            source.dirty = true;
          }
      } else source.issues.delete('qa/');
      const questions = (qa ?? [])
        .filter((n) => /^q[1-9][0-9]{0,3}(?:\.answer)?\.md$/.test(n))
        .slice(0, 200)
        .map((n) => `qa/${n}`);
      const slots = names.includes('.dispatch') ? this.members(join(source.directory, '.dispatch')) : [];
      const helpers = (slots ?? [])
        .filter((n) => /^(?:sonic|review|architect)-[1-9][0-9]{0,5}$/.test(n))
        .slice(0, 64)
        .map((n) => `.dispatch/${n}/STATUS.json`);
      source.names = [...roots, ...questions, ...helpers];
      source.membershipPending =
        !this.directories.get(source.directory)?.complete ||
        (names.includes('qa') && !this.directories.get(join(source.directory, 'qa'))?.complete) ||
        (names.includes('.dispatch') && !this.directories.get(join(source.directory, '.dispatch'))?.complete) ||
        qa === null ||
        slots === null;
      if (
        this.directories.get(source.directory)?.complete &&
        qa !== null &&
        (!names.includes('qa') || this.directories.get(join(source.directory, 'qa'))?.complete)
      ) {
        for (const name of source.files.keys())
          if (!source.names.includes(name)) {
            source.files.delete(name);
            source.issues.delete(name);
            source.dirty = true;
          }
      }
      let probes = 0;
      while (
        source.names.length &&
        probes++ < Math.min(16, source.names.length) &&
        this.room() &&
        this.cost.files < this.slice.maxFiles
      )
        this.read(source, source.names[source.cursor++ % source.names.length]);
      this.project(source);
      if (source.names.some((name) => !source.files.has(name))) this.fail('files_pending');
    }
    if (sources.some((s) => !s.lane)) this.fail('observation_pending');
    // Excerpts, not full unbounded history. Stop admission before resident local text exceeds 2 MiB.
    let textBytes = 0,
      metadata = 0;
    for (const s of this.sources.values())
      for (const [name, f] of s.files) {
        textBytes += Buffer.byteLength(f.text);
        metadata++;
        if (textBytes > 2 * 1024 * 1024 || metadata > 2048) {
          s.files.delete(name);
          s.dirty = true;
          this.fail('artifact_capacity');
        }
      }
    this.cost.elapsedMs = performance.now() - start;
    return this.snapshot();
  }
  private snapshot(): TaskSnapshot {
    // Pending catch-up belongs to the source, not its current turn. Warm signature rotation
    // alone is not unfinished collection; unknown membership and unread admitted files are.
    if (
      [...this.sources.values()].some(
        (source) => source.membershipPending || source.names.some((name) => !source.files.has(name))
      )
    )
      this.fail('observation_pending');
    if ([...this.candidates.values()].includes('unavailable')) this.fail('workspace_unavailable');
    if ([...this.sources.values()].some((source) => source.issues.size || source.invalidStatus || source.qaPending))
      this.fail('source_unavailable');
    const lanes = [...this.sources.values()].flatMap((s) => (s.lane ? [s.lane] : []));
    if (lanes.length !== this.lastLanes.length || lanes.some((l, i) => l !== this.lastLanes[i])) this.lastLanes = lanes;
    return {
      revision: this.revision,
      lanes: this.lastLanes,
      coverage: { incomplete: this.incomplete, diagnostics: this.diagnostics, workspace: this.workspace },
      cost: { ...this.cost },
    };
  }
}
