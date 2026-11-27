/** Compressed cold archive under $HUD_HOME/archive/cold/YYYY-MM/: text forever, raw capped. */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import {
  DEFAULT_MAX_SYNC_FRAME_BYTES,
  isSafeTarPath,
  isTarFileEntry,
  streamTarZstFile,
  streamTarZstFileSync,
  TarZstFrameWriter,
  writeAllSync,
  type TarEntryMeta,
  type TarFileEntry,
  type TarInput,
} from '../utils/tar-zst.js';
import { epoch } from './job-usage.js';

export const DEFAULT_COLD_RAW_CAP_GB = 20;
export const BYTES_PER_GB = 1024 * 1024 * 1024;
const CONFIG_LIMIT = 64 * 1024;
const DEFAULT_TEXT_ENTRY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_TEXT_TOTAL_LIMIT = 64 * 1024 * 1024;
const STREAM_IO_CHUNK_BYTES = 256 * 1024;

const COLD_ID = '(?:[jqbw][0-9a-f]{16}|f[0-9a-f]{16}(?:-[1-9]\\d*)?|te[0-9a-f]{32})';
export const COLD_ID_RE = new RegExp(`^${COLD_ID}$`);
const MONTH_RE = /^\d{4}-\d{2}$/;
const MEMBER_RE = new RegExp(`^(${COLD_ID})\\.(text|raw)\\.tar\\.zst$`);

export type ColdPart = 'text' | 'raw';

export interface ColdMemberStat {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ColdArchiveItem {
  id: string;
  month: string;
  text?: ColdMemberStat;
  raw?: ColdMemberStat;
}

export interface ColdArchiveWriteOptions {
  frameBytes?: number;
  maxSyncFrameBytes?: number;
}

export interface ColdEntrySliceRequest {
  offset?: number;
  length: number;
}

export interface ColdEntrySlice {
  size: number;
  sha256: string;
  data: Buffer;
}

export interface ReadColdJobTextOptions {
  names?: readonly string[];
  slices?: Readonly<Record<string, ColdEntrySliceRequest>>;
  /** Skip selected whole entries above these per-name byte limits. */
  skipOversizeEntries?: Readonly<Record<string, number>>;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export function coldArchiveRoot(home: string): string {
  return join(home, 'archive', 'cold');
}

export function monthFromMs(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 7);
}

/** Read retention.coldRawCapGB from $HUD_HOME/config.json (default 20 GiB). */
export function coldRawCapGB(home: string): number {
  try {
    const raw = readJsonBounded(join(home, 'config.json'), CONFIG_LIMIT);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_COLD_RAW_CAP_GB;
    const retention = (raw as Record<string, unknown>).retention;
    if (!retention || typeof retention !== 'object' || Array.isArray(retention)) return DEFAULT_COLD_RAW_CAP_GB;
    const cap = (retention as Record<string, unknown>).coldRawCapGB;
    if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0) return cap;
  } catch { /* Missing or unreadable config.json: default cap. */ }
  return DEFAULT_COLD_RAW_CAP_GB;
}

export function coldRawCapBytes(home: string): number {
  return Math.floor(coldRawCapGB(home) * BYTES_PER_GB);
}

export function isRawJobPath(rel: string): boolean {
  return (
    rel === jobFiles.sonicStdout ||
    rel === jobFiles.sonicStderr ||
    rel === jobFiles.sonicSession ||
    (rel.startsWith(`${jobFiles.sonicSession}.`) && !rel.includes('/')) ||
    rel.startsWith('sessions/') ||
    /(?:^|\/)sessions\//.test(rel)
  );
}

function isSkippedJobPath(rel: string): boolean {
  return rel === jobFiles.archived || rel.endsWith('.tmp');
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`not_a_directory:${dir}`);
  if ((stat.mode & 0o777) !== 0o700) {
    try { fs.chmodSync(dir, 0o700); } catch { /* Best-effort mode tighten. */ }
  }
}

function ensureMonthDir(home: string, month: string): string {
  if (!MONTH_RE.test(month)) throw new Error(`invalid_archive_month:${month}`);
  const archive = join(home, 'archive');
  const cold = join(archive, 'cold');
  const dir = join(cold, month);
  ensurePrivateDir(archive);
  ensurePrivateDir(cold);
  ensurePrivateDir(dir);
  return dir;
}

function forEachFileChunk(entry: TarFileEntry, onChunk: (chunk: Buffer) => void): void {
  const fd = fs.openSync(entry.filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`source_not_regular:${entry.name}`);
    if (
      (entry.dev !== undefined && stat.dev !== entry.dev) ||
      (entry.ino !== undefined && stat.ino !== entry.ino) ||
      stat.size !== entry.size
    ) {
      throw new Error(`source_changed:${entry.name}`);
    }
    const buf = Buffer.allocUnsafe(Math.min(STREAM_IO_CHUNK_BYTES, Math.max(1, entry.size)));
    let remaining = entry.size;
    while (remaining > 0) {
      const count = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (count <= 0) throw new Error(`source_changed:${entry.name}`);
      onChunk(buf.subarray(0, count));
      remaining -= count;
    }
    const probe = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, probe, 0, 1, null) > 0) throw new Error(`source_changed:${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

function hashInput(entry: TarInput): string {
  const hash = createHash('sha256');
  if (isTarFileEntry(entry)) {
    forEachFileChunk(entry, (chunk) => hash.update(chunk));
  } else {
    hash.update(entry.data);
  }
  return hash.digest('hex');
}

function writeInputToTar(writer: TarZstFrameWriter, entry: TarInput): void {
  const size = isTarFileEntry(entry) ? entry.size : entry.data.length;
  writer.beginEntry({ name: entry.name, size, mode: entry.mode ?? 0o600, mtime: entry.mtime });
  if (isTarFileEntry(entry)) {
    forEachFileChunk(entry, (chunk) => writer.writeEntryData(chunk));
  } else if (entry.data.length > 0) {
    writer.writeEntryData(entry.data);
  }
  writer.endEntry();
}

function listColdMonths(home: string): string[] {
  const root = coldArchiveRoot(home);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && MONTH_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

export function findColdMember(home: string, id: string, part: ColdPart): { path: string; month: string } | null {
  if (!COLD_ID_RE.test(id)) return null;
  const root = coldArchiveRoot(home);
  const fileName = `${id}.${part}.tar.zst`;
  for (const month of listColdMonths(home)) {
    const path = join(root, month, fileName);
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isFile()) return { path, month };
  }
  return null;
}

function findExistingMonth(home: string, id: string): string | null {
  return findColdMember(home, id, 'text')?.month ?? findColdMember(home, id, 'raw')?.month ?? null;
}

/** Atomically create or merge entries into $HUD_HOME/archive/cold/YYYY-MM/<id>.<part>.tar.zst with bounded memory. */
export function mergeColdMember(
  home: string,
  month: string,
  id: string,
  part: ColdPart,
  incoming: readonly TarInput[],
  mtimeMs?: number,
  options: ColdArchiveWriteOptions = {},
): { path: string; written: boolean } {
  if (!COLD_ID_RE.test(id)) throw new Error(`invalid_archive_id:${id}`);
  const dir = ensureMonthDir(home, month);
  const target = join(dir, `${id}.${part}.tar.zst`);
  if (!incoming.length) return { path: target, written: false };

  const incomingMap = new Map<string, TarInput>();
  for (const entry of incoming) {
    if (!isSafeTarPath(entry.name)) throw new Error(`invalid_tar_path:${entry.name}`);
    incomingMap.set(entry.name, entry);
  }
  const sortedIncoming = [...incomingMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  let existingFd: number | null = null;
  let existingSize = 0;
  try {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        throw Object.assign(new Error(`invalid_archive_target:${target}`), { code: st.isDirectory() ? 'EISDIR' : 'EEXIST' });
      }
      existingFd = fd;
      existingSize = st.size;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      existingFd = null;
    } else if (code === 'ELOOP' || code === 'EISDIR') {
      throw Object.assign(new Error(`invalid_archive_target:${target}`), { code });
    } else {
      throw error;
    }
  }

  const frameReadOpts = {
    maxFrameDecompressedBytes: options.maxSyncFrameBytes ?? DEFAULT_MAX_SYNC_FRAME_BYTES,
  };

  try {
    let existingSorted = true;
    if (existingFd !== null) {
      const existingMeta = new Map<string, { size: number; sha256: string }>();
      let prevName: string | null = null;
      let curName = '';
      let curSize = 0;
      let curHash: ReturnType<typeof createHash> | null = null;
      streamTarZstFileSync(existingFd, existingSize, {
        onEntryStart(meta) {
          if (prevName !== null && prevName.localeCompare(meta.name) >= 0) existingSorted = false;
          prevName = meta.name;
          curName = meta.name;
          curSize = meta.size;
          curHash = createHash('sha256');
        },
        onEntryData(chunk) {
          curHash!.update(chunk);
        },
        onEntryEnd() {
          existingMeta.set(curName, { size: curSize, sha256: curHash!.digest('hex') });
          curHash = null;
        },
      }, frameReadOpts);

      let changed = false;
      for (const entry of sortedIncoming) {
        const prev = existingMeta.get(entry.name);
        if (!prev) {
          changed = true;
          break;
        }
        const incomingSize = isTarFileEntry(entry) ? entry.size : entry.data.length;
        if (prev.size !== incomingSize || prev.sha256 !== hashInput(entry)) {
          changed = true;
          break;
        }
      }
      if (!changed) return { path: target, written: false };
    }

    const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    const outFd = fs.openSync(temp, 'wx', 0o600);
    let renamed = false;
    try {
      try {
        const writer = new TarZstFrameWriter(outFd, options.frameBytes);
        if (existingFd === null) {
          for (const entry of sortedIncoming) writeInputToTar(writer, entry);
        } else if (existingSorted) {
          let nextIncoming = 0;
          let skipping = false;
          streamTarZstFileSync(existingFd, existingSize, {
            onEntryStart(meta) {
              while (nextIncoming < sortedIncoming.length && sortedIncoming[nextIncoming]!.name.localeCompare(meta.name) < 0) {
                writeInputToTar(writer, sortedIncoming[nextIncoming++]!);
              }
              if (incomingMap.has(meta.name)) {
                skipping = true;
              } else {
                skipping = false;
                writer.beginEntry(meta);
              }
            },
            onEntryData(chunk) {
              if (!skipping) writer.writeEntryData(chunk);
            },
            onEntryEnd() {
              if (!skipping) writer.endEntry();
              skipping = false;
            },
          }, frameReadOpts);
          while (nextIncoming < sortedIncoming.length) {
            writeInputToTar(writer, sortedIncoming[nextIncoming++]!);
          }
        } else {
          let skipping = false;
          streamTarZstFileSync(existingFd, existingSize, {
            onEntryStart(meta) {
              if (incomingMap.has(meta.name)) {
                skipping = true;
              } else {
                skipping = false;
                writer.beginEntry(meta);
              }
            },
            onEntryData(chunk) {
              if (!skipping) writer.writeEntryData(chunk);
            },
            onEntryEnd() {
              if (!skipping) writer.endEntry();
              skipping = false;
            },
          }, frameReadOpts);
          for (const entry of sortedIncoming) writeInputToTar(writer, entry);
        }
        writer.finish();
        fs.fchmodSync(outFd, 0o600);
      } finally {
        fs.closeSync(outFd);
      }
      fs.renameSync(temp, target);
      renamed = true;
    } finally {
      if (!renamed) {
        try { fs.unlinkSync(temp); } catch { /* Preserve original failure. */ }
      }
    }
    if (mtimeMs !== undefined && Number.isFinite(mtimeMs)) {
      const sec = mtimeMs / 1000;
      try { fs.utimesSync(target, sec, sec); } catch { /* Best-effort timestamp stamp. */ }
    }
    return { path: target, written: true };
  } finally {
    if (existingFd !== null) fs.closeSync(existingFd);
  }
}

/** Collect regular file descriptors (metadata only) inside a directory tree without following any symlink. */
function collectTree(rootDir: string, relPrefix = ''): TarFileEntry[] {
  const out: TarFileEntry[] = [];
  const walk = (absDir: string, prefix: string) => {
    const names = fs.readdirSync(absDir).sort();
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, rel);
      } else if (st.isFile()) {
        if (isSkippedJobPath(rel)) continue;
        out.push({
          name: rel,
          filePath: abs,
          size: st.size,
          dev: st.dev,
          ino: st.ino,
          mode: 0o600,
          mtime: Math.floor(st.mtimeMs / 1000),
        });
      }
    }
  };
  walk(rootDir, relPrefix);
  return out;
}

/** Snapshot metadata for regular flow files in $HUD_HOME/flows/ owned by job j<hex>. */
function collectJobOwnedFlowEntries(home: string, jobId: string): TarFileEntry[] {
  const hex = jobId.slice(1);
  const flowsDir = join(home, 'flows');
  let names: string[];
  try {
    if (!fs.lstatSync(flowsDir).isDirectory()) return [];
    names = fs.readdirSync(flowsDir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const landRe = new RegExp(`^f${hex}(?:-[1-9]\\d*)?(?:\\.json(?:\\.(?:cancel|noticed|observed|gate-[1-9]\\d*(?:-rerun)?\\.log))?)?$`);
  const wfRe = new RegExp(`^j${hex}(?:\\.json)?$`);
  const entries: TarFileEntry[] = [];
  for (const name of names) {
    if (!landRe.test(name) && !wfRe.test(name)) continue;
    const abs = join(flowsDir, name);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isFile()) {
      entries.push({
        name: `flows/${name}`,
        filePath: abs,
        size: st.size,
        dev: st.dev,
        ino: st.ino,
        mode: 0o600,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    } else if (st.isDirectory()) {
      for (const child of collectTree(abs, `flows/${name}`)) entries.push(child);
    }
  }
  return entries;
}

/** Archive early-pruned raw logs (e.g. stdout.jsonl, stderr.log) into <job>.raw.tar.zst. */
export function archiveJobRawEntries(
  home: string,
  jobId: string,
  entries: readonly TarInput[],
  timestampMs: number,
  options?: ColdArchiveWriteOptions,
): { path: string; written: boolean } {
  const month = findExistingMonth(home, jobId) ?? monthFromMs(timestampMs);
  return mergeColdMember(home, month, jobId, 'raw', entries, timestampMs, options);
}

/** Archive a whole expiring job directory (plus any owned flow records) before deletion. */
export function archiveJobCold(
  home: string,
  dir: string,
  id: string,
  job: Job | null,
  status: Partial<JobStatus>,
  now: number,
  options?: ColdArchiveWriteOptions,
): { wroteText: boolean; wroteRaw: boolean; month: string } {
  const all = collectTree(dir);
  const textEntries: TarInput[] = [];
  const rawEntries: TarInput[] = [];
  for (const entry of all) {
    if (isRawJobPath(entry.name)) rawEntries.push(entry);
    else textEntries.push(entry);
  }
  for (const flowEntry of collectJobOwnedFlowEntries(home, id)) {
    textEntries.push(flowEntry);
  }
  const ts = epoch(status.ended_at) ?? epoch(status.settled_at) ?? epoch(job?.reaped_at) ?? now;
  const month = findExistingMonth(home, id) ?? monthFromMs(ts);
  const textRes = textEntries.length ? mergeColdMember(home, month, id, 'text', textEntries, ts, options) : { written: false };
  const rawRes = rawEntries.length ? mergeColdMember(home, month, id, 'raw', rawEntries, ts, options) : { written: false };
  return { wroteText: textRes.written, wroteRaw: rawRes.written, month };
}

/** Archive flow entries into <ownerId>.text.tar.zst (either a job j* or a standalone flow q* / b* / w* / te* / f*). */
export function archiveFlowCold(
  home: string,
  ownerId: string,
  entries: readonly TarInput[],
  timestampMs: number,
  options?: ColdArchiveWriteOptions,
): { path: string; written: boolean } {
  const month = findExistingMonth(home, ownerId) ?? monthFromMs(timestampMs);
  return mergeColdMember(home, month, ownerId, 'text', entries, timestampMs, options);
}

/** Enforce retention.coldRawCapGB by deleting oldest *.raw.tar.zst members first; never deletes text members. */
export function enforceColdRawCap(
  home: string,
  capBytes = coldRawCapBytes(home),
): { deleted: string[]; freedBytes: number; remainingBytes: number } {
  const root = coldArchiveRoot(home);
  const raws: { path: string; month: string; name: string; size: number; mtimeMs: number }[] = [];
  let totalBytes = 0;
  for (const month of listColdMonths(home)) {
    const dir = join(root, month);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = MEMBER_RE.exec(name);
      if (!m || m[2] !== 'raw') continue;
      const path = join(dir, name);
      const st = fs.lstatSync(path, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      raws.push({ path, month, name, size: st.size, mtimeMs: st.mtimeMs });
      totalBytes += st.size;
    }
  }
  if (totalBytes <= capBytes) return { deleted: [], freedBytes: 0, remainingBytes: totalBytes };
  raws.sort((a, b) => a.month.localeCompare(b.month) || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const deleted: string[] = [];
  let freedBytes = 0;
  for (const item of raws) {
    if (totalBytes <= capBytes) break;
    try {
      fs.unlinkSync(item.path);
      totalBytes -= item.size;
      freedBytes += item.size;
      deleted.push(item.path);
    } catch { /* Concurrent removal or error; continue to next oldest. */ }
  }
  return { deleted, freedBytes, remainingBytes: totalBytes };
}

/** List cold archive entries, newest month first. */
export function listColdArchive(home: string, options: { month?: string } = {}): ColdArchiveItem[] {
  const root = coldArchiveRoot(home);
  const months = options.month ? (MONTH_RE.test(options.month) ? [options.month] : []) : listColdMonths(home);
  const items: ColdArchiveItem[] = [];
  for (const month of months) {
    const dir = join(root, month);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const byId = new Map<string, ColdArchiveItem>();
    for (const name of names) {
      const m = MEMBER_RE.exec(name);
      if (!m) continue;
      const id = m[1]!, part = m[2] as ColdPart;
      const path = join(dir, name);
      const st = fs.lstatSync(path, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      const item = byId.get(id) ?? { id, month };
      item[part] = { path, size: st.size, mtimeMs: st.mtimeMs };
      byId.set(id, item);
    }
    const sorted = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    items.push(...sorted);
  }
  return items;
}

/** Stream entries from <id>.text.tar.zst, optionally filtering to specific names or bounded byte slices so huge entries never consume memory. */
export async function readColdJobText(
  home: string,
  id: string,
  options: ReadColdJobTextOptions = {},
): Promise<{ path: string; month: string; entries: Map<string, Buffer>; slices: Map<string, ColdEntrySlice> } | null> {
  const found = findColdMember(home, id, 'text');
  if (!found) return null;
  const wanted = options.names ? new Set(options.names) : null;
  const sliceRequests = options.slices ? new Map(Object.entries(options.slices)) : null;
  const skipLimits = options.skipOversizeEntries ? new Map(Object.entries(options.skipOversizeEntries)) : null;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_TEXT_ENTRY_LIMIT;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TEXT_TOTAL_LIMIT;
  const entries = new Map<string, Buffer>();
  const slices = new Map<string, ColdEntrySlice>();
  let keptTotalBytes = 0;
  let curMode: 'skip' | 'full' | 'slice' = 'skip';
  let curName: string | null = null;
  let curSize = 0;
  let curPos = 0;
  let curSliceStart = 0;
  let curSliceEnd = 0;
  let curHash: ReturnType<typeof createHash> | null = null;
  let curChunks: Buffer[] = [];
  const ok = await streamTarZstFile(found.path, {
    onEntryStart(meta) {
      const sliceReq = sliceRequests?.get(meta.name);
      if (sliceReq) {
        const offset = Math.max(0, Math.floor(sliceReq.offset ?? 0));
        const length = Math.max(0, Math.floor(sliceReq.length));
        curMode = 'slice';
        curName = meta.name;
        curSize = meta.size;
        curPos = 0;
        curSliceStart = offset;
        curSliceEnd = offset + length;
        curHash = createHash('sha256');
        curChunks = [];
        return;
      }
      const skipLimit = skipLimits?.get(meta.name);
      if ((wanted && !wanted.has(meta.name)) || (skipLimit !== undefined && meta.size > skipLimit)) {
        curMode = 'skip';
        curName = null;
        return;
      }
      if (meta.size > maxEntryBytes) throw new Error(`cold_entry_too_large:${meta.name}`);
      if (keptTotalBytes + meta.size > maxTotalBytes) throw new Error(`cold_read_limit_exceeded:${meta.name}`);
      keptTotalBytes += meta.size;
      curMode = 'full';
      curName = meta.name;
      curChunks = [];
    },
    onEntryData(chunk) {
      if (curMode === 'full') {
        curChunks.push(Buffer.from(chunk));
      } else if (curMode === 'slice') {
        curHash!.update(chunk);
        const nextPos = curPos + chunk.length;
        const start = Math.max(curSliceStart, curPos);
        const end = Math.min(curSliceEnd, nextPos);
        if (end > start) curChunks.push(Buffer.from(chunk.subarray(start - curPos, end - curPos)));
        curPos = nextPos;
      }
    },
    onEntryEnd() {
      if (curMode === 'full' && curName !== null) {
        entries.set(curName, curChunks.length === 1 ? curChunks[0]! : Buffer.concat(curChunks));
      } else if (curMode === 'slice' && curName !== null) {
        slices.set(curName, {
          size: curSize,
          sha256: curHash!.digest('hex'),
          data: curChunks.length === 1 ? curChunks[0]! : Buffer.concat(curChunks),
        });
      }
      curMode = 'skip';
      curName = null;
      curChunks = [];
      curHash = null;
    },
  });
  if (!ok) return null;
  return { path: found.path, month: found.month, entries, slices };
}

/** Descend component-by-component from a pinned directory fd with O_NOFOLLOW, then create the leaf file exclusively (0600). */
function openExtractFile(rootFd: number, relPath: string): number {
  const parts = relPath.split('/');
  let curFd = rootFd;
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      const segPath = `/proc/self/fd/${curFd}/${seg}`;
      try {
        fs.mkdirSync(segPath, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const nextFd = fs.openSync(segPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        fs.fchmodSync(nextFd, 0o700);
      } catch (error) {
        fs.closeSync(nextFd);
        throw error;
      }
      if (curFd !== rootFd) fs.closeSync(curFd);
      curFd = nextFd;
    }
    const leaf = parts[parts.length - 1]!;
    const leafPath = `/proc/self/fd/${curFd}/${leaf}`;
    const fileFd = fs.openSync(
      leafPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.fchmodSync(fileFd, 0o600);
    } catch (error) {
      fs.closeSync(fileFd);
      throw error;
    }
    return fileFd;
  } finally {
    if (curFd !== rootFd) fs.closeSync(curFd);
  }
}

/** Stream-extract <id>.text.tar.zst and/or <id>.raw.tar.zst byte-identically into a newly created private (0700) directory without following symlinks. */
export async function extractColdArchive(
  home: string,
  id: string,
  outDir: string,
  part: 'all' | 'text' | 'raw' = 'all',
): Promise<{ id: string; month: string; outDir: string; files: string[]; parts: ColdPart[] } | null> {
  if (!COLD_ID_RE.test(id)) return null;
  const textFound = part === 'raw' ? null : findColdMember(home, id, 'text');
  const rawFound = part === 'text' ? null : findColdMember(home, id, 'raw');
  if (!textFound && !rawFound) return null;

  const targetRoot = resolve(outDir);
  const parent = dirname(targetRoot);
  if (parent !== targetRoot) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Atomically create a fresh destination directory; fails with EEXIST if any file, symlink, or directory already sits there.
  fs.mkdirSync(targetRoot, 0o700);
  const rootFd = fs.openSync(targetRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fchmodSync(rootFd, 0o700);
    const files: string[] = [];
    const parts: ColdPart[] = [];
    const writePart = async (found: { path: string; month: string }, which: ColdPart) => {
      let activeFd: number | null = null;
      let activeMeta: TarEntryMeta | null = null;
      try {
        const ok = await streamTarZstFile(found.path, {
          onEntryStart(meta) {
            if (!isSafeTarPath(meta.name)) throw new Error(`unsafe_tar_path:${meta.name}`);
            activeFd = openExtractFile(rootFd, meta.name);
            activeMeta = meta;
          },
          onEntryData(chunk) {
            if (chunk.length > 0) writeAllSync(activeFd!, chunk);
          },
          onEntryEnd() {
            const fd = activeFd!;
            const meta = activeMeta!;
            activeFd = null;
            activeMeta = null;
            try {
              if (meta.mtime > 0) {
                try { fs.futimesSync(fd, meta.mtime, meta.mtime); } catch { /* Best-effort mtime restore. */ }
              }
            } finally {
              fs.closeSync(fd);
            }
            files.push(meta.name);
          },
        });
        if (ok) parts.push(which);
      } finally {
        if (activeFd !== null) {
          try { fs.closeSync(activeFd); } catch { /* Preserve original failure. */ }
        }
      }
    };
    if (textFound) await writePart(textFound, 'text');
    if (rawFound) await writePart(rawFound, 'raw');
    const month = textFound?.month ?? rawFound!.month;
    return { id, month, outDir: targetRoot, files, parts };
  } finally {
    fs.closeSync(rootFd);
  }
}
