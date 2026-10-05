/**
 * Each rollout's scan, kept on disk: how far the tree read the file and what
 * it found there (its model, status, task, latest report and its ledger of
 * stages), so a panel or bar started again reads only what was written since
 * instead of every rollout of the session from its first byte.
 *
 * A saved scan is used only while it still describes the file: the same
 * path, inode and thread, the file at least as long as the scan, and the
 * 4 KB before the scan's end unchanged (`print`). Anything else is read
 * again. One small JSON file per rollout, mode 0600, under
 * `$CODEX_HOME/hud/scan/`; one neither used nor written for a week goes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivateFile } from './small-model.js';

/**
 * What the scan reads from a line: subagent-tree.ts `applyRolloutLine` and
 * agent-stages.ts `applyLedgerEntry`. A change to either bumps this, so
 * scans saved under the old reading are read again.
 */
export const SCAN_VERSION = 1;

/** Only a scan this far into its file is worth keeping: a shorter one is read again in no time. */
export const SAVE_MIN_BYTES = 256 * 1024;
/** Writes go out at most this often, and when the process stops. */
const FLUSH_EVERY_MS = 60_000;
/** A saved scan neither used nor written for this long is for a rollout the tree no longer reads. */
const KEEP_MS = 7 * 24 * 3600_000;
const PRINT_BYTES = 4096;

export interface SavedScan {
  version: number;
  path: string;
  /** The thread the file's first line names. */
  id: string;
  ino?: number;
  /** Bytes read: the scan resumes here. */
  offset: number;
  /** The hash of the bytes just before `offset`. */
  print: string;
  /** The fields as the scan left them, dates as ISO strings. */
  fields: Record<string, unknown>;
  ledger?: Record<string, unknown>;
}

/** The hash of the bytes before `offset`, up to 4 KB of them; '' at 0, undefined when they cannot all be read. */
export function scanPrint(file: string, offset: number): string | undefined {
  if (offset <= 0) return '';
  const start = Math.max(0, offset - PRINT_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(offset - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    return read === buffer.length ? createHash('sha1').update(buffer).digest('hex') : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class TreeScanStore {
  private dirty = new Map<string, () => SavedScan | undefined>();
  private flushedAt: number;

  /** `readOnly`: saved scans are used, none is written or removed (the brief's dry run). */
  constructor(private readonly dir: string, private readonly options: { readOnly?: boolean; now?: number } = {}) {
    this.flushedAt = options.now ?? Date.now();
    if (!options.readOnly) this.prune(this.flushedAt);
  }

  private file(rollout: string): string {
    return path.join(this.dir, `${createHash('sha1').update(rollout).digest('hex').slice(0, 20)}.json`);
  }

  /** The scan saved for `rollout`, if one was saved under this version for this very path. */
  load(rollout: string): SavedScan | undefined {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(rollout), 'utf8')) as Partial<SavedScan> | null;
      if (!saved || saved.version !== SCAN_VERSION || saved.path !== rollout || typeof saved.id !== 'string'
        || typeof saved.offset !== 'number' || !Number.isSafeInteger(saved.offset) || saved.offset < 0
        || typeof saved.print !== 'string' || !saved.fields || typeof saved.fields !== 'object') return undefined;
      return saved as SavedScan;
    } catch {
      return undefined;
    }
  }

  /** `rollout`'s saved scan was used: it is kept another week. */
  used(rollout: string, now = Date.now()): void {
    if (this.options.readOnly) return;
    const at = new Date(now);
    try { fs.utimesSync(this.file(rollout), at, at); } catch { /* gone: saved again once the scan moves on */ }
  }

  /** `rollout`'s scan moved on: `take` gives it as it stands when the writes go out. */
  mark(rollout: string, take: () => SavedScan | undefined): void {
    if (!this.options.readOnly) this.dirty.set(rollout, take);
  }

  /** Writes what moved on, once `FLUSH_EVERY_MS` has passed since the last time. */
  flushDue(now: number): void {
    if (this.dirty.size && now - this.flushedAt >= FLUSH_EVERY_MS) this.flush(now);
  }

  flush(now = Date.now()): void {
    this.flushedAt = now;
    if (this.options.readOnly) return;
    for (const [rollout, take] of this.dirty) {
      try {
        const saved = take();
        if (saved) writePrivateFile(this.file(rollout), `${JSON.stringify(saved)}\n`);
      } catch {
        // A scan that cannot be saved is read again next time.
      }
    }
    this.dirty.clear();
  }

  private prune(now: number): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < now - KEEP_MS) fs.unlinkSync(file); } catch { /* gone already */ }
    }
  }
}
