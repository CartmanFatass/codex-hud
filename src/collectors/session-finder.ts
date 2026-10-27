import { sessionParentId } from '../utils/session-parent.js';
/**
 * Session finder for locating active/recent Codex session rollout files
 * Searches ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';
import { time } from '../utils/profile.js';
import { DaemonBinding } from './daemon-binding.js';

const DEFAULT_LOOKBACK_DAYS = 30;

// Minimum gap between fallback session scans.
const FALLBACK_RESCAN_MS = 2000;

// A session that started before the HUD is almost always today's or, across
// midnight, yesterday's. The shallow scan covers those two directories.
const RECENT_LOOKBACK_DAYS = 1;

// The full 30-day walk only runs when the shallow scan found nothing at all,
// and then at this cadence rather than on every fallback tick.
const DEEP_RESCAN_MS = 30_000;

// Entries kept in the per-file caches below. A HUD session sees far fewer
// rollouts and snapshots than this; the cap only bounds a pathological home.
const FILE_CACHE_LIMIT = 4096;

function cachePut<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= FILE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, value);
  return value;
}

export interface SessionFile {
  path: string;
  sessionId: string;
  timestamp: Date;
  size: number;
  modifiedAt: Date;
  // File identity: changes when the file is replaced via rename-over, which
  // size/mtime alone cannot distinguish from an append. Optional because some
  // filesystems report 0.
  ino?: number;
}

export { getCodexHome, getSessionsDir };

const SHELL_SNAPSHOTS_SUBDIR = 'shell_snapshots';
const ARCHIVED_SESSIONS_SUBDIR = 'archived_sessions';

function normalizePath(input?: string | null): string | null {
  if (!input) {
    return null;
  }

  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/**
 * Peek at the first line of a rollout file to get its CWD
 */
function readFirstLine(filePath: string, maxBytes: number = 1024 * 1024): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bufferSize = 4096;
    const buffer = Buffer.alloc(bufferSize);
    let bytesReadTotal = 0;
    let line = '';

    while (bytesReadTotal < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, bufferSize, bytesReadTotal);
      if (bytesRead <= 0) {
        break;
      }
      bytesReadTotal += bytesRead;

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex !== -1) {
        line += chunk.slice(0, newlineIndex);
        return line;
      }

      line += chunk;
    }

    if (bytesReadTotal >= maxBytes) {
      throw new Error(`Rollout first line exceeds ${maxBytes} bytes: ${filePath}`);
    }

    return line.length > 0 ? line : null;
  } finally {
    fs.closeSync(fd);
  }
}

interface RolloutMeta {
  cwd: string | null;
  isRoot: boolean;
  /** A subagent's root session: `session_id` where Codex wrote one, else its parent. */
  rootId?: string;
}

/**
 * A rollout's `session_meta` is its first line and is never rewritten: the
 * file is only ever appended to. Reading it once per path is therefore safe,
 * and it is what turns a fallback scan from "open every rollout of the last 30
 * days, twice" into a directory listing.
 */
const rolloutMetaCache = new Map<string, RolloutMeta | null>();

function peekRolloutMeta(filePath: string): RolloutMeta | null {
  const cached = rolloutMetaCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  return cachePut(rolloutMetaCache, filePath, readRolloutMeta(filePath));
}

function readRolloutMeta(filePath: string): RolloutMeta | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) return null;

    const entry = JSON.parse(firstLine.trim()) as {
      type?: string;
      payload?: {
        id?: string;
        session_id?: string;
        cwd?: string;
        parent_thread_id?: string;
        source?: unknown;
        thread_source?: string;
      };
    };
    if (entry.type !== 'session_meta' || !entry.payload) {
      return null;
    }
    const parentId = sessionParentId(entry.payload);
    const threadSource = entry.payload.thread_source;
    const isRoot = !parentId && threadSource !== 'subagent';
    const sessionId = entry.payload.session_id;
    const rootId = isRoot ? undefined : sessionId && sessionId !== entry.payload.id ? sessionId : parentId ?? undefined;
    return {
      cwd: normalizePath(entry.payload.cwd),
      isRoot,
      ...(rootId ? { rootId } : {}),
    };
  } catch {
    return null;
  }
}

function peekRolloutCwd(filePath: string): string | null {
  return peekRolloutMeta(filePath)?.cwd ?? null;
}

function peekRolloutIsRoot(filePath: string): boolean {
  return peekRolloutMeta(filePath)?.isRoot === true;
}

/**
 * Parse a rollout filename to extract timestamp and session ID
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<session-id>.jsonl
 */
function parseRolloutFilename(filename: string): { timestamp: Date; sessionId: string } | null {
  // Match pattern: rollout-2026-01-15T17-47-44-019bc10d-c89d-7352-935c-76b351384357.jsonl
  const match = filename.match(
    /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-f0-9-]+)\.jsonl$/
  );

  if (!match) {
    return null;
  }

  // Parse timestamp: 2026-01-15T17-47-44 -> 2026-01-15T17:47:44
  const timestampStr = match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
  const timestamp = new Date(timestampStr);

  if (isNaN(timestamp.getTime())) {
    return null;
  }

  return {
    timestamp,
    sessionId: match[2],
  };
}

interface DirListing {
  signature: string;
  entries: Array<{ path: string; sessionId: string; timestamp: Date }>;
}

// A directory modified this recently is listed afresh rather than from a
// cache: on a filesystem with coarse timestamps the next creation could still
// carry the same mtime, and a listing cached now would hide it.
const DIR_SETTLE_MS = 2000;

/**
 * A directory's mtime and size, which change when an entry is created,
 * renamed or removed but not when a file in it is appended to: a sound key
 * for its *list* of entries. Null while the directory is still settling.
 */
function directorySignature(stats: fs.Stats, nowMs: number = Date.now()): string | null {
  return nowMs - stats.mtimeMs < DIR_SETTLE_MS ? null : `${stats.mtimeMs}:${stats.size}`;
}

// Day directories' rollout lists. The sync finder still stats every file.
// The panel's yielding finder stats new, growing and priority files, plus a
// few quiet ones, and keeps the rest from the last stat.
const dirListingCache = new Map<string, DirListing>();

function listRollouts(dirPath: string): DirListing['entries'] {
  let signature: string | null;
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return [];
    }
    signature = directorySignature(stats);
  } catch {
    dirListingCache.delete(dirPath);
    return [];
  }

  const cached = dirListingCache.get(dirPath);
  if (signature !== null && cached && cached.signature === signature) {
    return cached.entries;
  }

  const entries: DirListing['entries'] = [];
  try {
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) {
        continue;
      }
      const parsed = parseRolloutFilename(file);
      if (!parsed) {
        continue;
      }
      entries.push({
        path: path.join(dirPath, file),
        sessionId: parsed.sessionId,
        timestamp: parsed.timestamp,
      });
    }
  } catch {
    // Directory read error
    return [];
  }

  if (signature !== null) {
    cachePut(dirListingCache, dirPath, { signature, entries });
  } else {
    dirListingCache.delete(dirPath);
  }
  return entries;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

// Every directory the by-id walk below has listed, by the same key.
const dirEntryCache = new Map<string, { signature: string; entries: DirEntry[] }>();

/** A directory's entries, re-read only when the directory itself changed. Throws like readdirSync. */
function listDirectory(dirPath: string): DirEntry[] {
  const signature = directorySignature(fs.statSync(dirPath));
  const cached = dirEntryCache.get(dirPath);
  if (signature !== null && cached && cached.signature === signature) {
    return cached.entries;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  }));
  if (signature !== null) {
    cachePut(dirEntryCache, dirPath, { signature, entries });
  } else {
    dirEntryCache.delete(dirPath);
  }
  return entries;
}

/**
 * Find all rollout files in a date directory
 */
function findRolloutsInDir(dirPath: string): SessionFile[] {
  const results: SessionFile[] = [];

  for (const entry of listRollouts(dirPath)) {
    try {
      const stats = fs.statSync(entry.path);
      results.push({
        path: entry.path,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        size: stats.size,
        modifiedAt: stats.mtime,
        ino: stats.ino > 0 ? stats.ino : undefined,
      });
    } catch {
      // Skip files we cannot stat
    }
  }

  return results;
}

/**
 * Find all rollout files within the last N days
 */
export function findRolloutsInDays(maxDaysBack: number = DEFAULT_LOOKBACK_DAYS): SessionFile[] {
  const sessionsDir = getSessionsDir();
  const now = new Date();
  const rollouts: SessionFile[] = [];

  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    rollouts.push(...findRolloutsInDir(dayDir));
  }

  return rollouts;
}

interface StatMemo {
  size: number;
  mtimeMs: number;
  modifiedAt: Date;
  ino?: number;
  /** The last stat differed from the one before it, so the next tick looks again. */
  grew: boolean;
}

// Sizes from the panel's yielding finder. The sync finder does not read this:
// a test that appends and rebuilds immediately must see the new size.
const rolloutStatCache = new Map<string, StatMemo>();
let quietCursor = 0;
/** Quiet rollouts restated each yielding pass, so an idle file is not invisible forever. */
const QUIET_STAT_BUDGET = 2;

/** Drop the yielding finder's remembered sizes. Tests call this between homes. */
export function resetRolloutStatCache(): void {
  rolloutStatCache.clear();
  quietCursor = 0;
}

function rolloutFile(entry: DirListing['entries'][number], size: number, modifiedAt: Date, ino?: number): SessionFile {
  return { path: entry.path, sessionId: entry.sessionId, timestamp: entry.timestamp, size, modifiedAt, ino };
}

function rememberStat(entry: DirListing['entries'][number], stats: fs.Stats, previous: StatMemo | undefined): SessionFile {
  const ino = stats.ino > 0 ? stats.ino : undefined;
  const grew = Boolean(previous && (stats.size !== previous.size || stats.mtimeMs !== previous.mtimeMs || ino !== previous.ino));
  rolloutStatCache.set(entry.path, { size: stats.size, mtimeMs: stats.mtimeMs, modifiedAt: stats.mtime, ino, grew });
  return rolloutFile(entry, stats.size, stats.mtime, ino);
}

/**
 * The panel's rollout list. New files, files that grew last time, and
 * `priority` (the tree's own rollouts) are stat'd every pass. Quiet files
 * keep the last size, except two of them, taken in turn, so a file that
 * starts growing is seen within a few ticks. Each real stat yields, so a
 * long first pass does not hold the keys that are on their way to Codex.
 */
export async function findRolloutsInDaysYielding(
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS,
  priority: ReadonlySet<string> = new Set(),
): Promise<SessionFile[]> {
  const sessionsDir = getSessionsDir();
  const now = new Date();
  const listed: DirListing['entries'] = [];
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    listed.push(...listRollouts(path.join(sessionsDir, year, month, day)));
  }
  const listedPaths = new Set(listed.map(entry => entry.path));
  const prefix = sessionsDir.endsWith(path.sep) ? sessionsDir : sessionsDir + path.sep;
  for (const key of rolloutStatCache.keys()) {
    if (key.startsWith(prefix) && !listedPaths.has(key)) rolloutStatCache.delete(key);
  }
  if (rolloutStatCache.size > FILE_CACHE_LIMIT) {
    const extra = rolloutStatCache.size - FILE_CACHE_LIMIT;
    let dropped = 0;
    for (const key of rolloutStatCache.keys()) {
      if (dropped >= extra) break;
      rolloutStatCache.delete(key);
      dropped++;
    }
  }

  const yieldNow = () => new Promise<void>(resolve => { setImmediate(resolve); });
  const statOne = async (entry: DirListing['entries'][number]): Promise<SessionFile | null> => {
    try {
      const stats = fs.statSync(entry.path);
      const file = rememberStat(entry, stats, rolloutStatCache.get(entry.path));
      await yieldNow();
      return file;
    } catch {
      rolloutStatCache.delete(entry.path);
      return null;
    }
  };

  const quiet: DirListing['entries'] = [];
  const results: SessionFile[] = [];
  for (const entry of listed) {
    const memo = rolloutStatCache.get(entry.path);
    if (!memo || memo.grew || priority.has(entry.path)) {
      const file = await statOne(entry);
      if (file) results.push(file);
    } else {
      quiet.push(entry);
      results.push(rolloutFile(entry, memo.size, memo.modifiedAt, memo.ino));
    }
  }
  if (quiet.length > 0) {
    const count = Math.min(QUIET_STAT_BUDGET, quiet.length);
    for (let i = 0; i < count; i++) {
      const entry = quiet[(quietCursor + i) % quiet.length];
      const file = await statOne(entry);
      if (!file) continue;
      const at = results.findIndex(item => item.path === entry.path);
      if (at >= 0) results[at] = file;
    }
    quietCursor = (quietCursor + count) % quiet.length;
  }
  return results;
}

/**
 * The root sessions started in `cwd` over the last `days`, the most recently
 * written first, at most `limit`: for the activity hub's Sessions tab, which
 * names them and the command that resumes one. Subagents' rollouts are left
 * out; each file's first line is read once (its `session_meta`).
 */
export function recentSessions(cwd: string | undefined, limit = 8, days = 7): SessionFile[] {
  const target = normalizePath(cwd);
  if (!target || !fs.existsSync(getSessionsDir())) return [];
  return findRolloutsInDays(days)
    .filter((r) => peekRolloutIsRoot(r.path) && peekRolloutCwd(r.path) === target)
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
    .slice(0, Math.max(0, limit));
}

/**
 * Find the most recent rollout file
 * Searches backwards from today's date
 */
export function findMostRecentRollout(
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS,
  targetCwd?: string
): SessionFile | null {
  const normalizedTarget = normalizePath(targetCwd);
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const now = new Date();
  let allSessions: SessionFile[] = [];

  // Search backwards from today
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    const rolloutsInDay = findRolloutsInDir(dayDir);
    
    let sessions = rolloutsInDay.filter((r) => peekRolloutIsRoot(r.path));
    if (normalizedTarget) {
      sessions = sessions.filter(r => peekRolloutCwd(r.path) === normalizedTarget);
    }
    
    allSessions = allSessions.concat(sessions);
    
  }

  if (allSessions.length === 0) {
    return null;
  }

  // Sort by modification time (most recent first)
  allSessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  return allSessions[0];
}

/**
 * Find rollout files modified within the last N seconds
 * Useful for finding actively-used sessions
 */
export function findActiveRollouts(
  withinSeconds: number = 60,
  targetCwd?: string,
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS
): SessionFile[] {
  const normalizedTarget = normalizePath(targetCwd);
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - withinSeconds * 1000);

  let rollouts: SessionFile[] = [];
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    rollouts = rollouts.concat(findRolloutsInDir(dayDir));
  }

  // Filter to recently modified and CWD
  return rollouts
    .filter((r) => {
      if (r.modifiedAt < cutoff) return false;
      if (normalizedTarget && peekRolloutCwd(r.path) !== normalizedTarget) return false;
      return true;
    })
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/**
 * Find an active session (convenience wrapper)
 * Returns the path to the most recently modified rollout file
 */
export async function findActiveSession(targetCwd?: string): Promise<string | null> {
  const active = findActiveRollouts(60, targetCwd, DEFAULT_LOOKBACK_DAYS);
  if (active.length > 0) {
    return active[0].path;
  }
  
  const recent = findMostRecentRollout(DEFAULT_LOOKBACK_DAYS, targetCwd);
  return recent?.path ?? null;
}

/**
 * Find a rollout file by session ID
 */
export function findRolloutBySessionId(
  sessionId: string,
  maxDaysBack: number = 7
): SessionFile | null {
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const now = new Date();

  // Search backwards from today
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    const rolloutsInDay = findRolloutsInDir(dayDir);

    const match = rolloutsInDay.find((r) => r.sessionId === sessionId);
    if (match) {
      return match;
    }
  }

  return null;
}

function parseSnapshotFilename(filename: string): { threadId: string; nonce: bigint } | null {
  const match = filename.match(/^([a-f0-9-]+)\.(\d+)\.[^.]+$/);
  if (!match) {
    return null;
  }

  try {
    return {
      threadId: match[1],
      nonce: BigInt(match[2]),
    };
  } catch {
    return null;
  }
}

interface SnapshotBinding {
  server: string | null;
  pane: string | null;
}

// Shell snapshots are written once and never edited, so their recorded
// TMUX/TMUX_PANE values are parsed once per path instead of on every check.
// The comparison against the live server still happens per call.
const snapshotBindingCache = new Map<string, SnapshotBinding | null>();

function readSnapshotBinding(filePath: string): SnapshotBinding | null {
  const cached = snapshotBindingCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const tmux = content.match(/(?:^|\n)(?:export\s+)?TMUX=(?:'([^']*)'|"([^"]*)"|([^\n]+))/);
    const match = content.match(
      /(?:^|\n)(?:export\s+)?TMUX_PANE=(?:'([^']*)'|"([^"]*)"|([^\n]+))/
    );
    const pane = match?.[1] ?? match?.[2] ?? match?.[3];
    return cachePut(snapshotBindingCache, filePath, {
      server: tmux?.[1] ?? tmux?.[2] ?? tmux?.[3] ?? null,
      pane: pane ? pane.trim() : null,
    });
  } catch {
    return cachePut(snapshotBindingCache, filePath, null);
  }
}

/**
 * TMUX is "<socket>,<server pid>,<session index>". The socket path outlives a
 * server restart and the pane ids start over at %0, so a snapshot from an
 * earlier server names a pane that is not this one. Codex 0.159's app-server
 * daemon makes that common: it writes every session's snapshot from its own
 * environment, which is that of whatever pane started it, possibly days ago.
 */
function sameTmuxServer(recorded: string, current: string): boolean {
  const [recordedSocket, recordedPid] = recorded.split(',');
  const [currentSocket, currentPid] = current.split(',');
  if (recordedSocket !== currentSocket) return false;
  return !recordedPid || !currentPid || recordedPid === currentPid;
}

function readSnapshotPane(filePath: string): string | null {
  const binding = readSnapshotBinding(filePath);
  if (!binding) return null;
  const currentServer = process.env.TMUX;
  if (binding.server && currentServer && !sameTmuxServer(binding.server, currentServer)) return null;
  return binding.pane;
}

// The last answer of the scan below. Snapshots are written once and never
// edited, so while the folder lists the same files the answer for the same
// pane, server and launch time is the same; with Codex 0.159's daemon writing
// every session's snapshot there, the folder holds thousands of them.
let paneScanCache: { key: string; threadId: string | null } | null = null;

function findThreadIdForPane(mainPaneId: string, launchTime: Date | null): string | null {
  const snapshotsDir = path.join(getCodexHome(), SHELL_SNAPSHOTS_SUBDIR);
  let signature: string | null;
  try {
    signature = directorySignature(fs.statSync(snapshotsDir));
  } catch {
    return null;
  }
  const key = signature === null
    ? null
    : JSON.stringify([snapshotsDir, signature, mainPaneId, launchTime?.getTime() ?? null, process.env.TMUX ?? null]);
  if (key !== null && paneScanCache?.key === key) {
    return paneScanCache.threadId;
  }
  const threadId = scanSnapshotsForPane(snapshotsDir, mainPaneId, launchTime);
  paneScanCache = key === null ? null : { key, threadId };
  return threadId;
}

function scanSnapshotsForPane(snapshotsDir: string, mainPaneId: string, launchTime: Date | null): string | null {
  const matches: Array<{ threadId: string; nonce: bigint; path: string }> = [];

  try {
    const files = fs.readdirSync(snapshotsDir);
    for (const file of files) {
      const parsed = parseSnapshotFilename(file);
      if (!parsed) {
        continue;
      }
      // Snapshot nonces are Unix nanoseconds. Pane IDs can be reused after a
      // server restart: a prior launch's snapshot is not a current binding.
      if (launchTime && parsed.nonce < BigInt(Math.floor(launchTime.getTime() - 15_000)) * 1_000_000n) {
        continue;
      }

      const filePath = path.join(snapshotsDir, file);
      if (readSnapshotPane(filePath) !== mainPaneId) {
        continue;
      }

      matches.push({
        threadId: parsed.threadId,
        nonce: parsed.nonce,
        path: filePath,
      });
    }
  } catch {
    return null;
  }

  matches.sort((a, b) => {
    if (a.nonce === b.nonce) {
      return b.path.localeCompare(a.path);
    }
    return a.nonce > b.nonce ? -1 : 1;
  });

  return matches[0]?.threadId ?? null;
}

function findRolloutPathBySessionIdInRoot(rootDir: string, sessionId: string): string | null {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const expectedSuffix = `-${sessionId}.jsonl`;
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries: DirEntry[];
    try {
      entries = listDirectory(currentDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory) {
        stack.push(fullPath);
        continue;
      }

      if (
        entry.isFile &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith(expectedSuffix)
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

function buildSessionFile(filePath: string): SessionFile | null {
  const parsed = parseRolloutFilename(path.basename(filePath));
  if (!parsed) {
    return null;
  }

  try {
    const stats = fs.statSync(filePath);
    return {
      path: filePath,
      sessionId: parsed.sessionId,
      timestamp: parsed.timestamp,
      size: stats.size,
      modifiedAt: stats.mtime,
      ino: stats.ino > 0 ? stats.ino : undefined,
    };
  } catch {
    return null;
  }
}

/** Each thread the daemon named, by the root session it belongs to. */
const rootThreadCache = new Map<string, string>();
const rootThreadMiss = new Map<string, number>();

/**
 * The root session of `threadId`: itself, or for a subagent the session it
 * belongs to. Switching Codex to a subagent's view resumes that subagent's
 * thread on the TUI's connection; the panel stays on the session.
 */
function rootThreadOf(threadId: string): string {
  const cached = rootThreadCache.get(threadId);
  if (cached) return cached;
  // A thread with no rollout yet is its own root; whether it has one is the
  // caller's next question, so it is not asked twice here.
  if ((rootThreadMiss.get(threadId) ?? 0) > Date.now() - FALLBACK_RESCAN_MS) return threadId;
  const file = findSessionByThreadId(threadId);
  if (!file) {
    cachePut(rootThreadMiss, threadId, Date.now());
    return threadId;
  }
  const meta = peekRolloutMeta(file.path);
  return cachePut(rootThreadCache, threadId, meta && !meta.isRoot && meta.rootId ? meta.rootId : threadId);
}

function findSessionByThreadId(sessionId: string): SessionFile | null {
  const codexHome = getCodexHome();
  // The archive is only walked when the live tree does not have the file.
  const found = findRolloutPathBySessionIdInRoot(path.join(codexHome, 'sessions'), sessionId)
    ?? findRolloutPathBySessionIdInRoot(path.join(codexHome, ARCHIVED_SESSIONS_SUBDIR), sessionId);

  return buildSessionFile(found ?? '');
}

/**
 * Watch for the most recently modified rollout file
 * Returns the path to the file that should be monitored
 */
export class SessionFinder {
  private currentSession: SessionFile | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private targetCwd: string | null = null;
  private currentThreadId: string | null = null;
  private targetStartTime: Date | null = null;
  // The fallback scan walks session dirs; throttle it so a standalone HUD
  // (no pane binding) does not repeat the walk every tick.
  private lastFallbackScanMs = 0;
  // The 30-day walk behind the shallow scan runs on its own, slower clock.
  private lastDeepScanMs = 0;
  // The daemon's log, read for the main pane's TUI; made on first use.
  private daemon: DaemonBinding | null = null;

  constructor(
    targetCwd?: string,
    private onSessionChange?: (session: SessionFile | null) => void,
    targetStartTime?: Date | null
  ) {
    this.targetCwd = targetCwd || null;
    this.targetStartTime = targetStartTime ?? null;
  }

  private clearSession(): null {
    if (this.currentSession || this.currentThreadId) {
      this.currentSession = null;
      this.currentThreadId = null;
      this.onSessionChange?.(null);
    }
    return null;
  }

  private adoptSession(next: SessionFile, threadId: string): SessionFile {
    this.currentThreadId = threadId;
    if (!this.currentSession || this.currentSession.path !== next.path) {
      this.currentSession = next;
      this.onSessionChange?.(next);
      return next;
    }
    this.currentSession = next;
    return this.currentSession;
  }

  /**
   * The current session with its size and mtime brought up to date, or null
   * when there is none or its file is gone.
   */
  private refreshCurrentSession(): SessionFile | null {
    if (!this.currentSession) {
      return null;
    }
    try {
      const stats = fs.statSync(this.currentSession.path);
      this.currentSession.modifiedAt = stats.mtime;
      this.currentSession.size = stats.size;
      return this.currentSession;
    } catch {
      return null;
    }
  }

  /**
   * Codex CLI 0.147+ on WSL often writes shell snapshots without TMUX_PANE,
   * or skips snapshots until a shell tool runs. Fall back to the newest cwd
   * rollout created/touched around HUD start so token usage can still appear.
   */
  private findFallbackSession(): SessionFile | null {
    const cwd = this.targetCwd ?? undefined;
    // Today and yesterday answer this in every realistic case. Only when they
    // hold nothing at all does the 30-day walk run, and then at most every
    // DEEP_RESCAN_MS: before Codex has written its first rollout the HUD would
    // otherwise repeat that walk every two seconds, forever.
    let recent = findMostRecentRollout(RECENT_LOOKBACK_DAYS, cwd);
    // The session already found stays a candidate. Rollouts live under the day
    // they were created, so a HUD left running past the next midnight but one
    // no longer sees its own session in the shallow scan; without this it
    // would drop the session, wait for the deep scan to find it again, and
    // drop it two seconds later.
    const kept = this.refreshCurrentSession();
    if (kept && (!recent || kept.modifiedAt.getTime() >= recent.modifiedAt.getTime())) {
      recent = kept;
    }
    if (!recent && Date.now() - this.lastDeepScanMs >= DEEP_RESCAN_MS) {
      this.lastDeepScanMs = Date.now();
      recent = findMostRecentRollout(DEFAULT_LOOKBACK_DAYS, cwd);
    }
    if (!recent) {
      return null;
    }

    if (this.targetStartTime) {
      const startMs = this.targetStartTime.getTime() - 15_000;
      if (recent.timestamp.getTime() < startMs && recent.modifiedAt.getTime() < startMs) {
        return null;
      }
      return recent;
    }

    // Standalone HUD (no pane binding) can follow the newest matching rollout.
    if (!process.env.CODEX_HUD_MAIN_PANE) {
      return recent;
    }

    return null;
  }

  /**
   * Start watching for session changes
   */
  start(checkIntervalMs: number = 5000): void {
    this.check();
    this.checkInterval = setInterval(() => this.check(), checkIntervalMs);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check for active or recent sessions
   */
  check(): SessionFile | null {
    return time('session.find', () => this.checkNow());
  }

  private checkNow(): SessionFile | null {
    const mainPaneId = process.env.CODEX_HUD_MAIN_PANE;
    if (mainPaneId) {
      // The daemon's log says which conversation the pane's TUI has open,
      // a resumed one included, before it writes to it; the snapshots are
      // the older Codex's word for it.
      this.daemon ??= new DaemonBinding(getCodexHome(), mainPaneId, this.targetStartTime?.getTime() ?? null);
      const daemonThread = this.daemon.threadId();
      const threadId = (daemonThread && rootThreadOf(daemonThread)) || findThreadIdForPane(mainPaneId, this.targetStartTime);
      if (threadId) {
        if (this.currentSession?.sessionId === threadId) {
          const kept = this.refreshCurrentSession();
          if (kept) {
            this.currentThreadId = threadId;
            return kept;
          }
        }

        const next = findSessionByThreadId(threadId);
        if (next) {
          return this.adoptSession(next, threadId);
        }
      }
    }

    const fallbackScanFresh = Date.now() - this.lastFallbackScanMs < FALLBACK_RESCAN_MS;
    if (fallbackScanFresh) {
      this.refreshCurrentSession();
      return this.currentSession;
    }

    const fallback = this.findFallbackSession();
    this.lastFallbackScanMs = Date.now();
    if (!fallback) {
      return this.clearSession();
    }

    return this.adoptSession(fallback, fallback.sessionId);
  }

  /**
   * Get the current session
   */
  getCurrentSession(): SessionFile | null {
    return this.currentSession;
  }
}
