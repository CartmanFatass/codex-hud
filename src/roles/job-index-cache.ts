/**
 * Shared mtime/inode metadata cache for `$HUD_HOME/jobs/`.
 *
 * Caches only bounded structural metadata (`jobs/` listing, `job.json`, `STATUS.json`,
 * `SESSION.txt`, `supervisor.pid`, `qa/` filenames, `report.md` stat). Never caches prose
 * bodies (`brief.md`, `report.md` contents, `qa/*.md` contents, transcripts).
 */
import * as fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { writePrivateFile } from '../utils/atomic-fs.js';

export const JOB_ID_RE = /^j[0-9a-f]{16}$/;
export const DEFAULT_MAX_JSON_BYTES = 65_536;
export const DEFAULT_MAX_SESSION_BYTES = 16_384;
export const DEFAULT_MAX_CHECKS_BYTES = 196_608;
export const DEFAULT_MAX_FILE_ENTRIES = 1_024;
export const DEFAULT_MAX_QA_ENTRIES = 512;
export const MAX_CACHED_HOMES = 8;

const NS_PER_SEC = 1_000_000_000n;
const MAX_PID_BYTES = 256;
const MAX_FAMILY_LOOKUPS = 1024;
const FACT_REL_RE = /^j[0-9a-f]{16}\/(job|STATUS)\.json$/;
const QUESTION_FILE_RE = /^q(\d+)\.md$/;
const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([]);

const SESSION_KEY_MAP: Record<string, keyof SessionFields> = {
  TASK: 'task',
  LAUNCH: 'launch',
  LAUNCH_ID: 'launchId',
  DIRECT_EXEC: 'directExec',
  PID: 'pid',
  PID_START: 'pidStart',
  HERDR_SOCKET_PATH: 'herdrSocket',
  TAB: 'tab',
  TAB_NAME: 'tabName',
  LEFT: 'left',
  RIGHT: 'right',
  ORCH: 'orch',
  BASE: 'base',
  PRIMARY: 'primary',
};

export type JsonProjection = 'full' | 'facts';

export type CachedJsonResult<T = Record<string, unknown>> =
  | { status: 'ok'; value: T; stamp: string; at: number; projection: JsonProjection; hit: boolean }
  | { status: 'missing' }
  | { status: 'truncated'; stamp: string; at: number }
  | { status: 'invalid'; stamp: string; at: number; error: unknown }
  | { status: 'error'; error: NodeJS.ErrnoException | Error };

export interface QaSnapshot {
  readonly exists: boolean;
  /** Unanswered question IDs in numeric ascending order (e.g. `['q1', 'q2', 'q10']`), filenames only. */
  readonly openIds: readonly string[];
  /** All `qN.md` filenames in numeric ascending order. */
  readonly allQuestionFiles: readonly string[];
  readonly stamp: string | null;
}

export interface ReportStat {
  readonly present: boolean;
  /** Bit-for-bit equivalent to `fs.statSync(report).mtimeMs`; `null` when missing or non-regular. */
  readonly mtimeMs: number | null;
  readonly stamp: string | null;
}

export interface SessionFields {
  readonly task?: string;
  readonly launch?: string;
  readonly launchId?: string;
  readonly directExec?: string;
  readonly pid?: string;
  readonly pidStart?: string;
  readonly herdrSocket?: string;
  readonly tab?: string;
  readonly tabName?: string;
  readonly left?: string;
  readonly right?: string;
  readonly orch?: string;
  readonly base?: string;
  readonly primary?: string;
}

export interface JobDirMeta {
  readonly id: string;
  readonly dir: string;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

export interface JobIndexCacheOptions {
  maxFileEntries?: number;
  maxQaEntries?: number;
  maxJsonBytes?: number;
  /** Test-only guard: recursively freezes cached JSON/session objects to catch accidental in-place mutation. */
  freezeCachedValues?: boolean;
}

export interface WriteJsonAtomicOptions {
  indent?: number;
  mkdir?: boolean;
  dotPrefix?: boolean;
  beforeRename?: () => void;
  fsync?: boolean;
}

export interface PersistedFactRow {
  rel: string;
  stamp: string;
  at: number;
  whole: boolean;
  json: Record<string, unknown> | null;
}

export interface ExportedFactSnap {
  factsVersion?: number;
  at: number;
  whole: boolean;
  json: Record<string, unknown> | null;
}

type FileCacheEntry =
  | {
      kind: 'json';
      stamp: string;
      at: number;
      maxBytes: number;
      projection: JsonProjection;
      value: Record<string, unknown>;
    }
  | {
      kind: 'truncated';
      stamp: string;
      at: number;
      maxBytes: number;
      projection: JsonProjection;
    }
  | {
      kind: 'invalid';
      stamp: string;
      at: number;
      maxBytes: number;
      projection: JsonProjection;
      error: unknown;
    }
  | {
      kind: 'session';
      stamp: string;
      at: number;
      fields: SessionFields;
    }
  | {
      kind: 'pid';
      stamp: string;
      at: number;
      pid: number | null;
    };

/** Bit-for-bit equivalent to Node/libuv `Stats.mtimeMs` IEEE 754 millisecond conversion. */
export function statsMtimeMs(mtimeNs: bigint): number {
  const rem = mtimeNs % NS_PER_SEC;
  const sec = rem < 0n ? mtimeNs / NS_PER_SEC - 1n : mtimeNs / NS_PER_SEC;
  const nsec = mtimeNs - sec * NS_PER_SEC;
  return Number(sec) * 1000 + Number(nsec) / 1e6;
}

/** 5-field BigInt file stamp (`dev:ino:size:mtimeNs:ctimeNs`), distinct from legacy 3-field `mtimeMs:size:ino`. */
export function fileStampOf(st: fs.BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/** Legacy 3-field file stamp (`mtimeMs:size:ino`) matching previous `display/thin-jobs.json` entries. */
export function legacyFileStampOf(st: fs.BigIntStats): string {
  return `${statsMtimeMs(st.mtimeNs)}:${st.size}:${st.ino}`;
}

/** Directory stamp including `nlink` to detect subdirectory creation and removal. */
export function dirStampOf(st: fs.BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.nlink}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * Validate either the 5-field BigInt stamp or the legacy 3-field `mtimeMs:size:ino` stamp
 * against the live file on disk without following symlinks.
 */
export function isFileStampCurrent(filePath: string, stamp: string): boolean {
  if (!stamp) return false;
  try {
    const st = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
    if (!st || !st.isFile()) return false;
    return fileStampOf(st) === stamp || legacyFileStampOf(st) === stamp;
  } catch {
    return false;
  }
}

function errnoError(code: string, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, path });
}

function nonRegularFileError(filePath: string): Error {
  return Object.assign(new Error(`nonregular_job_file: ${filePath}`), { path: filePath });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function questionNumber(name: string): number {
  const match = QUESTION_FILE_RE.exec(name);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseSessionFields(text: string): SessionFields {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const mapped = SESSION_KEY_MAP[line.slice(0, eq)];
    if (!mapped) continue;
    const value = line.slice(eq + 1).trim();
    if (value) fields[mapped] = value;
  }
  return fields as SessionFields;
}

/**
 * Open one regular file without following symlinks or blocking on FIFOs, capture its
 * BigInt `fstat` on the opened descriptor (eliminating TOCTOU), and read at most `maxBytes`.
 */
function readRegularFileBounded(
  file: string,
  maxBytes: number
):
  | { kind: 'ok'; bytes: Buffer; stat: fs.BigIntStats }
  | { kind: 'truncated'; stat: fs.BigIntStats }
  | { kind: 'missing' }
  | { kind: 'error'; error: NodeJS.ErrnoException | Error } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', error: error as NodeJS.ErrnoException };
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return { kind: 'error', error: nonRegularFileError(file) };
    const limit = BigInt(maxBytes);
    if (stat.size > limit) return { kind: 'truncated', stat };
    const cap = maxBytes + 1;
    let buffer = Buffer.alloc(Math.min(Math.max(0, Number(stat.size)) + 1, cap));
    let length = 0;
    while (length < cap) {
      if (length === buffer.length) {
        const larger = Buffer.alloc(Math.min(cap, Math.max(4096, length * 2)));
        buffer.copy(larger);
        buffer = larger;
      }
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) return { kind: 'truncated', stat };
    return { kind: 'ok', bytes: buffer.subarray(0, length), stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', error: error as NodeJS.ErrnoException };
  } finally {
    fs.closeSync(fd);
  }
}

function clampNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export class JobIndexCache {
  readonly hudHome: string;
  readonly jobsRoot: string;

  private readonly jobsPrefix: string;
  private readonly maxFileEntries: number;
  private readonly maxQaEntries: number;
  private readonly maxJsonBytes: number;
  private readonly freezeCachedValues: boolean;

  private jobsDirCache: { stamp: string; ids: readonly string[] } | null = null;
  private readonly files = new Map<string, FileCacheEntry>();
  private readonly qa = new Map<string, QaSnapshot>();

  constructor(hudHome: string, options?: JobIndexCacheOptions) {
    this.hudHome = resolve(hudHome);
    this.jobsRoot = join(this.hudHome, 'jobs');
    this.jobsPrefix = this.jobsRoot.endsWith(sep) ? this.jobsRoot : this.jobsRoot + sep;
    this.maxFileEntries = clampNonNegativeInt(options?.maxFileEntries, DEFAULT_MAX_FILE_ENTRIES);
    this.maxQaEntries = clampNonNegativeInt(options?.maxQaEntries, DEFAULT_MAX_QA_ENTRIES);
    this.maxJsonBytes = Math.max(1, clampNonNegativeInt(options?.maxJsonBytes, DEFAULT_MAX_JSON_BYTES));
    this.freezeCachedValues = options?.freezeCachedValues === true;
  }

  stats(): { fileEntries: number; qaEntries: number } {
    return { fileEntries: this.files.size, qaEntries: this.qa.size };
  }

  // --- Layer 1: `$HUD_HOME/jobs/` directory listing ---

  listJobIds(opts?: { onError?: (error: NodeJS.ErrnoException) => void }): readonly string[] {
    let st: fs.BigIntStats | undefined;
    try {
      st = fs.lstatSync(this.jobsRoot, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
      this.jobsDirCache = null;
      opts?.onError?.(error as NodeJS.ErrnoException);
      return EMPTY_STRING_ARRAY;
    }
    if (!st) {
      this.jobsDirCache = null;
      this.pruneRemovedJobs(new Set());
      return EMPTY_STRING_ARRAY;
    }
    if (!st.isDirectory()) {
      this.jobsDirCache = null;
      opts?.onError?.(errnoError('ENOTDIR', `ENOTDIR: not a directory, scandir '${this.jobsRoot}'`, this.jobsRoot));
      return EMPTY_STRING_ARRAY;
    }
    const stamp = dirStampOf(st);
    if (this.jobsDirCache && this.jobsDirCache.stamp === stamp) return this.jobsDirCache.ids;

    let names: string[];
    try {
      names = fs.readdirSync(this.jobsRoot);
    } catch (error) {
      this.jobsDirCache = null;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.pruneRemovedJobs(new Set());
        return EMPTY_STRING_ARRAY;
      }
      opts?.onError?.(error as NodeJS.ErrnoException);
      return EMPTY_STRING_ARRAY;
    }

    const ids = Object.freeze(names.filter((name) => JOB_ID_RE.test(name)));
    this.jobsDirCache = { stamp, ids };
    this.pruneRemovedJobs(new Set(ids));
    return ids;
  }

  readJobDirMeta(id: string): JobDirMeta | null {
    if (!JOB_ID_RE.test(id)) return null;
    const dir = join(this.jobsRoot, id);
    const st = fs.lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    return st?.isDirectory() ? { id, dir, mtimeMs: statsMtimeMs(st.mtimeNs), birthtimeMs: statsMtimeMs(st.birthtimeNs) } : null;
  }

  listJobDirsByMtime(opts?: {
    limit?: number;
    sortBy?: 'mtime' | 'birthtime';
    onDirError?: (error: NodeJS.ErrnoException) => void;
    onStatError?: (id: string, error: unknown) => void;
  }): { dirs: JobDirMeta[]; totalValid: number } {
    const ids = this.listJobIds({ onError: opts?.onDirError });
    const metas: JobDirMeta[] = [];
    for (const id of ids) {
      try {
        const meta = this.readJobDirMeta(id);
        if (meta) metas.push(meta);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') opts?.onStatError?.(id, error);
      }
    }
    const totalValid = metas.length;
    if (opts?.sortBy === 'birthtime') {
      metas.sort((a, b) => b.birthtimeMs - a.birthtimeMs || b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
    } else {
      metas.sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
    }
    const dirs = opts?.limit !== undefined && opts.limit >= 0 ? metas.slice(0, opts.limit) : metas;
    return { dirs, totalValid };
  }

  /** Display window over already-ranked directories. Bound receipt discovery separately from
   * expensive card/status reads: up to N roots and N of their children, never N mixed jobs. */
  recentJobFamilies(dirs: readonly JobDirMeta[], limit: number, parse?: (text: string) => unknown): readonly JobDirMeta[] {
    if (dirs.length <= limit) return dirs;
    const roots = new Set<string>(), children = new Map<string, string>();
    let scanned = 0;
    const parentOf = (id: string) => {
      const job = this.readJob(id, { acceptFacts: true, parse });
      return job.status === 'ok' && typeof job.value.parent_job === 'string' ? job.value.parent_job.trim() : '';
    };
    for (const { id } of dirs) {
      if (roots.size === limit || scanned === MAX_FAMILY_LOOKUPS) break;
      scanned++;
      const parent = parentOf(id);
      if (parent) children.set(id, parent);
      else roots.add(id); // An unreadable receipt is not evidence of a child.
    }
    const selected = new Set(roots);
    for (const [id, parent] of children) {
      if (selected.size - roots.size === limit) break;
      if (roots.has(parent)) selected.add(id);
    }
    // A parent's directory may have been touched after its children. Follow its durable
    // .sonic links beyond the root cutoff without opening unrelated historical receipts.
    if (scanned < Math.min(dirs.length, MAX_FAMILY_LOOKUPS) && selected.size - roots.size < limit) {
      const linked = new Set<string>();
      let markerBudget = MAX_FAMILY_LOOKUPS;
      for (const id of roots) {
        if (!markerBudget) break;
        const path = join(this.jobsRoot, id, '.sonic');
        try {
          if (!fs.lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
          const index = fs.opendirSync(path);
          try {
            for (let e; markerBudget && (e = index.readSync()); markerBudget--)
              if (JOB_ID_RE.test(e.name)) linked.add(e.name);
          } finally { index.closeSync(); }
        } catch { /* Optional parent index; no unverified children. */ }
      }
      for (let i = scanned; linked.size && i < dirs.length && scanned < MAX_FAMILY_LOOKUPS && selected.size - roots.size < limit; i++) {
        const { id } = dirs[i];
        if (!linked.has(id)) continue;
        scanned++;
        if (roots.has(parentOf(id))) selected.add(id);
      }
    }
    return dirs.filter(({ id }) => selected.has(id));
  }

  // --- Layer 2: Structured metadata files ---

  readJson<T = Record<string, unknown>>(
    filePath: string,
    opts?: { maxBytes?: number; parse?: (text: string) => unknown; acceptFacts?: boolean }
  ): CachedJsonResult<T> {
    const target = resolve(filePath);
    const maxBytes = Math.max(1, clampNonNegativeInt(opts?.maxBytes, this.maxJsonBytes));
    const acceptFacts = opts?.acceptFacts === true;

    let st: fs.BigIntStats | undefined;
    try {
      st = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
      this.files.delete(target);
      return { status: 'error', error: error as NodeJS.ErrnoException };
    }
    if (!st) {
      this.files.delete(target);
      return { status: 'missing' };
    }
    if (!st.isFile()) {
      this.files.delete(target);
      return { status: 'error', error: nonRegularFileError(target) };
    }

    const stamp = fileStampOf(st);
    const hit = this.files.get(target);
    if (hit && (hit.kind === 'json' || hit.kind === 'truncated' || hit.kind === 'invalid')) {
      let stampMatched = hit.stamp === stamp;
      let upgradedLegacy = false;
      if (!stampMatched && hit.projection === 'facts' && hit.stamp === legacyFileStampOf(st)) {
        stampMatched = true;
        upgradedLegacy = true;
      }
      const projectionOk = hit.projection === 'full' || acceptFacts;
      const limitOk =
        hit.kind === 'truncated'
          ? maxBytes <= hit.maxBytes
          : st.size <= BigInt(maxBytes);
      if (stampMatched && projectionOk && limitOk) {
        if (upgradedLegacy) {
          hit.stamp = stamp;
          hit.at = statsMtimeMs(st.mtimeNs);
        }
        this.touchFile(target, hit);
        if (hit.kind === 'json') {
          return {
            status: 'ok',
            value: hit.value as T,
            stamp: hit.stamp,
            at: hit.at,
            projection: hit.projection,
            hit: true,
          };
        }
        if (hit.kind === 'truncated') {
          return { status: 'truncated', stamp: hit.stamp, at: hit.at };
        }
        return { status: 'invalid', stamp: hit.stamp, at: hit.at, error: hit.error };
      }
    }

    const loaded = readRegularFileBounded(target, maxBytes);
    if (loaded.kind === 'missing') {
      this.files.delete(target);
      return { status: 'missing' };
    }
    if (loaded.kind === 'error') {
      this.files.delete(target);
      return { status: 'error', error: loaded.error };
    }
    const fStamp = fileStampOf(loaded.stat);
    const at = statsMtimeMs(loaded.stat.mtimeNs);
    if (loaded.kind === 'truncated') {
      this.setFile(target, { kind: 'truncated', stamp: fStamp, at, maxBytes, projection: 'full' });
      return { status: 'truncated', stamp: fStamp, at };
    }

    const parse = opts?.parse ?? JSON.parse;
    try {
      const parsed = parse(loaded.bytes.toString('utf8'));
      if (!isPlainJsonObject(parsed)) {
        const error = new TypeError('json_object_required');
        this.setFile(target, { kind: 'invalid', stamp: fStamp, at, maxBytes, projection: 'full', error });
        return { status: 'invalid', stamp: fStamp, at, error };
      }
      const stored = this.freezeCachedValues ? deepFreeze(parsed) : parsed;
      this.setFile(target, {
        kind: 'json',
        stamp: fStamp,
        at,
        maxBytes,
        projection: 'full',
        value: stored,
      });
      return {
        status: 'ok',
        value: stored as T,
        stamp: fStamp,
        at,
        projection: 'full',
        hit: false,
      };
    } catch (error) {
      this.setFile(target, { kind: 'invalid', stamp: fStamp, at, maxBytes, projection: 'full', error });
      return { status: 'invalid', stamp: fStamp, at, error };
    }
  }

  readJob<T = Record<string, unknown>>(
    id: string,
    opts?: { parse?: (text: string) => unknown; acceptFacts?: boolean }
  ): CachedJsonResult<T> {
    if (!JOB_ID_RE.test(id)) return { status: 'missing' };
    return this.readJson<T>(join(this.jobsRoot, id, 'job.json'), opts);
  }

  /** Return a detached mutable copy (`structuredClone`) for callers that edit a job before writing it back. */
  readJobMutable<T = Record<string, unknown>>(id: string): CachedJsonResult<T> {
    const res = this.readJob<T>(id);
    if (res.status !== 'ok') return res;
    return { ...res, value: structuredClone(res.value) };
  }

  readStatus<T = Record<string, unknown>>(
    id: string,
    opts?: { parse?: (text: string) => unknown; acceptFacts?: boolean }
  ): CachedJsonResult<T> {
    if (!JOB_ID_RE.test(id)) return { status: 'missing' };
    return this.readJson<T>(join(this.jobsRoot, id, 'STATUS.json'), opts);
  }

  readSession(id: string, opts?: { throwOnError?: boolean }): { fields: SessionFields; stamp: string } | null {
    if (!JOB_ID_RE.test(id)) return null;
    const target = join(this.jobsRoot, id, 'SESSION.txt');
    let st: fs.BigIntStats | undefined;
    try { st = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false }); }
    catch (error) { this.files.delete(target); if (opts?.throwOnError) throw error; return null; }
    if (!st || !st.isFile()) {
      this.files.delete(target);
      if (st && opts?.throwOnError) throw nonRegularFileError(target);
      return null;
    }
    const stamp = fileStampOf(st);
    const hit = this.files.get(target);
    if (hit && hit.kind === 'session' && hit.stamp === stamp) {
      this.touchFile(target, hit);
      return { fields: hit.fields, stamp: hit.stamp };
    }
    const loaded = readRegularFileBounded(target, DEFAULT_MAX_SESSION_BYTES);
    if (loaded.kind !== 'ok') {
      this.files.delete(target);
      if (opts?.throwOnError && loaded.kind === 'error') throw loaded.error;
      return null;
    }
    const fStamp = fileStampOf(loaded.stat);
    const at = statsMtimeMs(loaded.stat.mtimeNs);
    const parsed = parseSessionFields(loaded.bytes.toString('utf8'));
    const fields = this.freezeCachedValues ? deepFreeze(parsed) : parsed;
    this.setFile(target, { kind: 'session', stamp: fStamp, at, fields });
    return { fields, stamp: fStamp };
  }

  readPid(filePath: string): number | null {
    const target = resolve(filePath);
    let st: fs.BigIntStats | undefined;
    try {
      st = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    } catch {
      this.files.delete(target);
      return null;
    }
    if (!st || !st.isFile()) {
      this.files.delete(target);
      return null;
    }
    const stamp = fileStampOf(st);
    const hit = this.files.get(target);
    if (hit && hit.kind === 'pid' && hit.stamp === stamp) {
      this.touchFile(target, hit);
      return hit.pid;
    }
    const loaded = readRegularFileBounded(target, MAX_PID_BYTES);
    if (loaded.kind !== 'ok') {
      this.files.delete(target);
      return null;
    }
    const raw = Number(loaded.bytes.toString('utf8').trim());
    const pid = Number.isInteger(raw) && raw > 1 ? raw : null;
    const fStamp = fileStampOf(loaded.stat);
    const at = statsMtimeMs(loaded.stat.mtimeNs);
    this.setFile(target, { kind: 'pid', stamp: fStamp, at, pid });
    return pid;
  }

  // --- Layer 3: `qa/` & `report.md` metadata ---

  /** Non-ENOENT errors (including non-directory `qa/`) propagate unchanged. `ENOENT` is never negative-cached. */
  readQa(idOrDir: string): QaSnapshot {
    const qaDir = join(this.resolveJobDir(idOrDir), 'qa');
    let st: fs.BigIntStats | undefined;
    try {
      st = fs.lstatSync(qaDir, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
      this.qa.delete(qaDir);
      throw error;
    }
    if (!st) {
      this.qa.delete(qaDir);
      return { exists: false, openIds: EMPTY_STRING_ARRAY, allQuestionFiles: EMPTY_STRING_ARRAY, stamp: null };
    }
    if (!st.isDirectory()) {
      this.qa.delete(qaDir);
      throw errnoError('ENOTDIR', `ENOTDIR: not a directory, scandir '${qaDir}'`, qaDir);
    }
    const stamp = dirStampOf(st);
    const hit = this.qa.get(qaDir);
    if (hit && hit.stamp === stamp) {
      this.touchQa(qaDir, hit);
      return hit;
    }

    let names: string[];
    try {
      names = fs.readdirSync(qaDir);
    } catch (error) {
      this.qa.delete(qaDir);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, openIds: EMPTY_STRING_ARRAY, allQuestionFiles: EMPTY_STRING_ARRAY, stamp: null };
      }
      throw error;
    }
    const nameSet = new Set(names);
    const allQuestionFiles = Object.freeze(
      names
        .filter((name) => QUESTION_FILE_RE.test(name))
        .sort((a, b) => questionNumber(a) - questionNumber(b) || a.localeCompare(b))
    );
    const openIds = Object.freeze(
      allQuestionFiles
        .filter((name) => !nameSet.has(name.replace(/\.md$/, '.answer.md')))
        .map((name) => name.slice(0, -3))
    );
    const snapshot: QaSnapshot = Object.freeze({ exists: true, openIds, allQuestionFiles, stamp });
    this.setQa(qaDir, snapshot);
    return snapshot;
  }

  readReportStat(idOrDir: string): ReportStat {
    const reportPath = join(this.resolveJobDir(idOrDir), 'report.md');
    try {
      const st = fs.lstatSync(reportPath, { bigint: true, throwIfNoEntry: false });
      if (!st || !st.isFile()) return { present: false, mtimeMs: null, stamp: null };
      return { present: true, mtimeMs: statsMtimeMs(st.mtimeNs), stamp: fileStampOf(st) };
    } catch {
      return { present: false, mtimeMs: null, stamp: null };
    }
  }

  // --- Write-Through (via atomic-fs) & explicit invalidation ---

  /**
   * Publish JSON through `writePrivateFile` (`src/utils/atomic-fs.ts`) and write through to the cache
   * only if the live path's `(dev, ino)` still matches the published inode. If another writer raced
   * in after rename, the cache entry is evicted instead of storing stale data.
   */
  writeJsonAtomic(
    filePath: string,
    value: Record<string, unknown>,
    options?: WriteJsonAtomicOptions
  ): fs.Stats {
    const target = resolve(filePath);
    const text = JSON.stringify(value, null, options?.indent) + '\n';
    const published = writePrivateFile(target, text, {
      mkdir: options?.mkdir,
      dotPrefix: options?.dotPrefix,
      beforeRename: options?.beforeRename,
      fsync: options?.fsync,
    });
    this.commitPublishedJson(target, published, text);
    return published;
  }

  /**
   * Reconcile an external `writePrivateFile` JSON write with the cache using the `fs.Stats`
   * returned by `atomic-fs.ts`. Returns `true` if cached, `false` if evicted due to a race or error.
   */
  recordAtomicJson(
    filePath: string,
    published: Pick<fs.Stats | fs.BigIntStats, 'dev' | 'ino'>,
    value: Record<string, unknown>
  ): boolean {
    return this.commitPublishedJson(resolve(filePath), published, value);
  }

  invalidateFile(filePath: string): void {
    this.files.delete(resolve(filePath));
  }

  invalidateQa(idOrDir: string): void {
    this.qa.delete(join(this.resolveJobDir(idOrDir), 'qa'));
  }

  invalidateJob(id: string): void {
    if (!JOB_ID_RE.test(id)) return;
    const dir = join(this.jobsRoot, id);
    const dirPrefix = dir + sep;
    for (const key of this.files.keys()) {
      if (key === dir || key.startsWith(dirPrefix)) this.files.delete(key);
    }
    for (const key of this.qa.keys()) {
      if (key === dir || key.startsWith(dirPrefix)) this.qa.delete(key);
    }
  }

  noteJobDir(id: string): void {
    if (!JOB_ID_RE.test(id)) return;
    if (this.jobsDirCache && !this.jobsDirCache.ids.includes(id)) {
      this.jobsDirCache = null;
    }
  }

  evictJob(id: string): void {
    if (!JOB_ID_RE.test(id)) return;
    this.invalidateJob(id);
    this.jobsDirCache = null;
  }

  clear(): void {
    this.jobsDirCache = null;
    this.files.clear();
    this.qa.clear();
  }

  // --- Cold-start persistence bridge (`display/thin-jobs.json`) ---

  hydrateFacts(rows: readonly PersistedFactRow[]): void {
    for (const row of rows) {
      if (
        !row ||
        typeof row.rel !== 'string' ||
        !FACT_REL_RE.test(row.rel) ||
        typeof row.stamp !== 'string' ||
        !row.stamp ||
        typeof row.at !== 'number' ||
        !Number.isFinite(row.at) ||
        typeof row.whole !== 'boolean' ||
        !(row.json === null || isPlainJsonObject(row.json))
      ) {
        continue;
      }
      const target = join(this.jobsRoot, row.rel);
      const existing = this.files.get(target);
      // Never downgrade an already-loaded full entry to a pruned facts projection.
      if (existing && (existing.kind === 'json' || existing.kind === 'truncated' || existing.kind === 'invalid') && existing.projection === 'full') {
        continue;
      }
      if (!row.whole) {
        this.setFile(target, {
          kind: 'truncated',
          stamp: row.stamp,
          at: row.at,
          maxBytes: this.maxJsonBytes,
          projection: 'facts',
        });
      } else if (row.json === null) {
        this.setFile(target, {
          kind: 'invalid',
          stamp: row.stamp,
          at: row.at,
          maxBytes: this.maxJsonBytes,
          projection: 'facts',
          error: new SyntaxError('hydrated_invalid_json'),
        });
      } else {
        const copy = structuredClone(row.json);
        const stored = this.freezeCachedValues ? deepFreeze(copy) : copy;
        this.setFile(target, {
          kind: 'json',
          stamp: row.stamp,
          at: row.at,
          maxBytes: this.maxJsonBytes,
          projection: 'facts',
          value: stored,
        });
      }
    }
  }

  exportFacts(
    seenPaths: Iterable<string>,
    factKeys: ReadonlySet<string>,
    opts?: { factsVersion?: number }
  ): [string, string, ExportedFactSnap][] {
    const normalizedSeen = new Set<string>();
    for (const p of seenPaths) normalizedSeen.add(resolve(p));

    const out: [string, string, ExportedFactSnap][] = [];
    for (const [filePath, entry] of this.files) {
      if (!normalizedSeen.has(filePath)) continue;
      if (entry.kind !== 'json' && entry.kind !== 'truncated' && entry.kind !== 'invalid') continue;
      if (!filePath.startsWith(this.jobsPrefix)) continue;
      const rel = filePath.slice(this.jobsPrefix.length).split(sep).join('/');
      if (!FACT_REL_RE.test(rel)) continue;
      const isJob = rel.endsWith('/job.json');
      const versionField = isJob && opts?.factsVersion !== undefined ? { factsVersion: opts.factsVersion } : {};

      if (entry.kind === 'truncated') {
        out.push([rel, entry.stamp, { ...versionField, at: entry.at, whole: false, json: null }]);
        continue;
      }
      if (entry.kind === 'invalid') {
        out.push([rel, entry.stamp, { ...versionField, at: entry.at, whole: true, json: null }]);
        continue;
      }
      if (entry.value.checks) continue;
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry.value)) {
        if (factKeys.has(k)) filtered[k] = v;
      }
      if (isJob && factKeys.has('project_root') && filtered.project_root === undefined) {
        const mainRoot = (entry.value.worktree as { main_root?: unknown } | null | undefined)?.main_root;
        if (mainRoot !== undefined) filtered.project_root = mainRoot;
      }
      out.push([rel, entry.stamp, { ...versionField, at: entry.at, whole: true, json: filtered }]);
    }
    return out;
  }

  // --- Internal helpers ---

  private resolveJobDir(idOrDir: string): string {
    return JOB_ID_RE.test(idOrDir) ? join(this.jobsRoot, idOrDir) : resolve(idOrDir);
  }

  private jobIdFromPath(filePath: string): string | null {
    if (!filePath.startsWith(this.jobsPrefix)) return null;
    const rest = filePath.slice(this.jobsPrefix.length);
    const idx = rest.indexOf(sep);
    const segment = idx === -1 ? rest : rest.slice(0, idx);
    return JOB_ID_RE.test(segment) ? segment : null;
  }

  private commitPublishedJson(
    target: string,
    published: Pick<fs.Stats | fs.BigIntStats, 'dev' | 'ino'>,
    textOrValue: string | Record<string, unknown>
  ): boolean {
    const expectedDev =
      typeof published.dev === 'bigint'
        ? published.dev
        : Number.isSafeInteger(published.dev)
          ? BigInt(published.dev)
          : null;
    const expectedIno =
      typeof published.ino === 'bigint'
        ? published.ino
        : Number.isSafeInteger(published.ino)
          ? BigInt(published.ino)
          : null;
    if (expectedDev === null || expectedIno === null) {
      this.files.delete(target);
      return false;
    }

    let afterSt: fs.BigIntStats | undefined;
    try {
      afterSt = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    } catch {
      this.files.delete(target);
      return false;
    }
    if (!afterSt || !afterSt.isFile() || afterSt.dev !== expectedDev || afterSt.ino !== expectedIno) {
      this.files.delete(target);
      return false;
    }

    const jobId = this.jobIdFromPath(target);
    if (jobId) this.noteJobDir(jobId);

    const stamp = fileStampOf(afterSt);
    const at = statsMtimeMs(afterSt.mtimeNs);
    if (afterSt.size > BigInt(this.maxJsonBytes)) {
      this.setFile(target, {
        kind: 'truncated',
        stamp,
        at,
        maxBytes: this.maxJsonBytes,
        projection: 'full',
      });
      return true;
    }

    const parsed = typeof textOrValue === 'string' ? JSON.parse(textOrValue) : structuredClone(textOrValue);
    if (!isPlainJsonObject(parsed)) {
      this.files.delete(target);
      return false;
    }
    const stored = this.freezeCachedValues ? deepFreeze(parsed) : parsed;
    this.setFile(target, {
      kind: 'json',
      stamp,
      at,
      maxBytes: this.maxJsonBytes,
      projection: 'full',
      value: stored,
    });
    return true;
  }

  private pruneRemovedJobs(liveIds: ReadonlySet<string>): void {
    for (const key of this.files.keys()) {
      const id = this.jobIdFromPath(key);
      if (id && !liveIds.has(id)) this.files.delete(key);
    }
    for (const key of this.qa.keys()) {
      const id = this.jobIdFromPath(key);
      if (id && !liveIds.has(id)) this.qa.delete(key);
    }
  }

  private setFile(key: string, entry: FileCacheEntry): void {
    if (this.maxFileEntries <= 0) return;
    this.files.delete(key);
    this.files.set(key, entry);
    while (this.files.size > this.maxFileEntries) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  private touchFile(key: string, entry: FileCacheEntry): void {
    this.files.delete(key);
    this.files.set(key, entry);
  }

  private setQa(key: string, snapshot: QaSnapshot): void {
    if (this.maxQaEntries <= 0) return;
    this.qa.delete(key);
    this.qa.set(key, snapshot);
    while (this.qa.size > this.maxQaEntries) {
      const oldest = this.qa.keys().next().value;
      if (oldest === undefined) break;
      this.qa.delete(oldest);
    }
  }

  private touchQa(key: string, snapshot: QaSnapshot): void {
    this.qa.delete(key);
    this.qa.set(key, snapshot);
  }
}

const homeCaches = new Map<string, JobIndexCache>();

/** Per-`HUD_HOME` LRU registry (capped at `MAX_CACHED_HOMES = 8`) for in-process panel/CLI collectors. */
export function getJobIndexCache(hudHome: string, options?: JobIndexCacheOptions): JobIndexCache {
  const key = resolve(hudHome);
  const existing = homeCaches.get(key);
  if (existing) {
    homeCaches.delete(key);
    homeCaches.set(key, existing);
    return existing;
  }
  const created = new JobIndexCache(key, options);
  homeCaches.set(key, created);
  while (homeCaches.size > MAX_CACHED_HOMES) {
    const oldest = homeCaches.keys().next().value;
    if (oldest === undefined) break;
    homeCaches.delete(oldest);
  }
  return created;
}

export function clearJobIndexCaches(): void {
  for (const cache of homeCaches.values()) cache.clear();
  homeCaches.clear();
}
