/** Compressed cold archive under $HUD_HOME/archive/cold/YYYY-MM/: text forever, raw capped. */
import * as fs from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { decodeTarZst, encodeTarZst, isSafeTarPath, type TarEntry } from '../utils/tar-zst.js';
import { epoch } from './job-usage.js';

export const DEFAULT_COLD_RAW_CAP_GB = 20;
export const BYTES_PER_GB = 1024 * 1024 * 1024;
const CONFIG_LIMIT = 64 * 1024;
const TEXT_DECOMPRESS_LIMIT = 64 * 1024 * 1024;
const RAW_DECOMPRESS_LIMIT = 512 * 1024 * 1024;

export const COLD_ID_RE = /^[jqbw][0-9a-f]{16}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MEMBER_RE = /^([jqbw][0-9a-f]{16})\.(text|raw)\.tar\.zst$/;

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

export function coldArchiveRoot(home: string): string {
  return join(home, 'archive', 'cold');
}

export function monthFromMs(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 7);
}

/** Read retention.coldRawCapGB from $HUD_HOME/config.json (default 20 GB). */
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

function readRegularNoFollow(file: string): { data: Buffer; stat: fs.Stats } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    return { data: fs.readFileSync(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
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

/** Atomically create or merge entries into $HUD_HOME/archive/cold/YYYY-MM/<id>.<part>.tar.zst. */
export function mergeColdMember(
  home: string,
  month: string,
  id: string,
  part: ColdPart,
  incoming: readonly TarEntry[],
  mtimeMs?: number,
): { path: string; written: boolean } {
  if (!COLD_ID_RE.test(id)) throw new Error(`invalid_archive_id:${id}`);
  const dir = ensureMonthDir(home, month);
  const target = join(dir, `${id}.${part}.tar.zst`);
  if (!incoming.length) return { path: target, written: false };

  const merged = new Map<string, TarEntry>();
  let hadExisting = false;
  const existingFile = readRegularNoFollow(target);
  if (existingFile) {
    hadExisting = true;
    const limit = part === 'text' ? TEXT_DECOMPRESS_LIMIT : RAW_DECOMPRESS_LIMIT;
    for (const entry of decodeTarZst(existingFile.data, limit)) {
      merged.set(entry.name, entry);
    }
  } else {
    // Reject non-regular targets (e.g. a directory or symlink sitting at the member path).
    const st = fs.lstatSync(target, { throwIfNoEntry: false });
    if (st) throw Object.assign(new Error(`invalid_archive_target:${target}`), { code: st.isDirectory() ? 'EISDIR' : 'EEXIST' });
  }

  let changed = !hadExisting;
  for (const entry of incoming) {
    if (!isSafeTarPath(entry.name)) throw new Error(`invalid_tar_path:${entry.name}`);
    const prev = merged.get(entry.name);
    if (!prev || !prev.data.equals(entry.data)) {
      merged.set(entry.name, entry);
      changed = true;
    }
  }
  if (!changed) return { path: target, written: false };

  const ordered = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const payload = encodeTarZst(ordered);
  writePrivateFile(target, payload, { mkdir: false, dotPrefix: true });
  if (mtimeMs !== undefined && Number.isFinite(mtimeMs)) {
    const sec = mtimeMs / 1000;
    try { fs.utimesSync(target, sec, sec); } catch { /* Best-effort timestamp stamp. */ }
  }
  return { path: target, written: true };
}

/** Collect all regular files inside a directory tree without following any symlink. */
function collectTree(rootDir: string, relPrefix = ''): TarEntry[] {
  const out: TarEntry[] = [];
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
        const read = readRegularNoFollow(abs);
        if (!read) continue;
        out.push({ name: rel, data: read.data, mode: 0o600, mtime: Math.floor(read.stat.mtimeMs / 1000) });
      }
    }
  };
  walk(rootDir, relPrefix);
  return out;
}

/** Snapshot any regular flow files in $HUD_HOME/flows/ owned by job j<hex>. */
function collectJobOwnedFlowEntries(home: string, jobId: string): TarEntry[] {
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
  const entries: TarEntry[] = [];
  for (const name of names) {
    if (!landRe.test(name) && !wfRe.test(name)) continue;
    const abs = join(flowsDir, name);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isFile()) {
      const read = readRegularNoFollow(abs);
      if (read) entries.push({ name: `flows/${name}`, data: read.data, mode: 0o600, mtime: Math.floor(read.stat.mtimeMs / 1000) });
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
  entries: readonly TarEntry[],
  timestampMs: number,
): { path: string; written: boolean } {
  const month = findExistingMonth(home, jobId) ?? monthFromMs(timestampMs);
  return mergeColdMember(home, month, jobId, 'raw', entries, timestampMs);
}

/** Archive a whole expiring job directory (plus any owned flow records) before deletion. */
export function archiveJobCold(
  home: string,
  dir: string,
  id: string,
  job: Job | null,
  status: Partial<JobStatus>,
  now: number,
): { wroteText: boolean; wroteRaw: boolean; month: string } {
  const all = collectTree(dir);
  const textEntries: TarEntry[] = [];
  const rawEntries: TarEntry[] = [];
  for (const entry of all) {
    if (isRawJobPath(entry.name)) rawEntries.push(entry);
    else textEntries.push(entry);
  }
  for (const flowEntry of collectJobOwnedFlowEntries(home, id)) {
    textEntries.push(flowEntry);
  }
  const ts = epoch(status.ended_at) ?? epoch(status.settled_at) ?? epoch(job?.reaped_at) ?? now;
  const month = findExistingMonth(home, id) ?? monthFromMs(ts);
  const textRes = textEntries.length ? mergeColdMember(home, month, id, 'text', textEntries, ts) : { written: false };
  const rawRes = rawEntries.length ? mergeColdMember(home, month, id, 'raw', rawEntries, ts) : { written: false };
  return { wroteText: textRes.written, wroteRaw: rawRes.written, month };
}

/** Archive flow files owned by a job (f* land flows + gate logs, or j* council/prewalk flows) into <job>.text.tar.zst. */
export function archiveJobFlowsCold(
  home: string,
  jobId: string,
  entries: readonly TarEntry[],
  timestampMs: number,
): { path: string; written: boolean } {
  const month = findExistingMonth(home, jobId) ?? monthFromMs(timestampMs);
  return mergeColdMember(home, month, jobId, 'text', entries, timestampMs);
}

/** Archive a standalone flow run (q*, b*, w*) into its own <flow>.text.tar.zst. */
export function archiveFlowCold(
  home: string,
  flowId: string,
  entries: readonly TarEntry[],
  timestampMs: number,
): { path: string; written: boolean } {
  const month = findExistingMonth(home, flowId) ?? monthFromMs(timestampMs);
  return mergeColdMember(home, month, flowId, 'text', entries, timestampMs);
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

/** Read all entries from <id>.text.tar.zst into memory (used by hud_read on pruned jobs). */
export function readColdJobText(home: string, id: string): { path: string; month: string; entries: Map<string, Buffer> } | null {
  const found = findColdMember(home, id, 'text');
  if (!found) return null;
  const raw = readRegularNoFollow(found.path);
  if (!raw) return null;
  const entries = new Map<string, Buffer>();
  for (const entry of decodeTarZst(raw.data, TEXT_DECOMPRESS_LIMIT)) {
    entries.set(entry.name, entry.data);
  }
  return { path: found.path, month: found.month, entries };
}

/** Extract <id>.text.tar.zst and/or <id>.raw.tar.zst byte-identically into outDir. */
export function extractColdArchive(
  home: string,
  id: string,
  outDir: string,
  part: 'all' | 'text' | 'raw' = 'all',
): { id: string; month: string; outDir: string; files: string[]; parts: ColdPart[] } | null {
  if (!COLD_ID_RE.test(id)) return null;
  const textFound = part === 'raw' ? null : findColdMember(home, id, 'text');
  const rawFound = part === 'text' ? null : findColdMember(home, id, 'raw');
  if (!textFound && !rawFound) return null;

  const targetRoot = resolve(outDir);
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  const parts: ColdPart[] = [];
  const writePart = (found: { path: string; month: string }, which: ColdPart) => {
    const raw = readRegularNoFollow(found.path);
    if (!raw) return;
    const limit = which === 'text' ? TEXT_DECOMPRESS_LIMIT : RAW_DECOMPRESS_LIMIT;
    const decoded = decodeTarZst(raw.data, limit);
    parts.push(which);
    for (const entry of decoded) {
      if (!isSafeTarPath(entry.name)) throw new Error(`unsafe_tar_path:${entry.name}`);
      const dest = resolve(targetRoot, entry.name);
      if (dest !== targetRoot && !dest.startsWith(targetRoot + sep)) throw new Error(`unsafe_extract_path:${entry.name}`);
      fs.mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writePrivateFile(dest, entry.data, { mkdir: false });
      if (entry.mtime && entry.mtime > 0) {
        try { fs.utimesSync(dest, entry.mtime, entry.mtime); } catch { /* Best-effort mtime restore. */ }
      }
      files.push(entry.name);
    }
  };
  if (textFound) writePart(textFound, 'text');
  if (rawFound) writePart(rawFound, 'raw');
  const month = textFound?.month ?? rawFound!.month;
  return { id, month, outDir: targetRoot, files, parts };
}
