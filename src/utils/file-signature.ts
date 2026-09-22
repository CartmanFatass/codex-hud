import * as fs from 'node:fs';

/**
 * Cheap "has this file changed?" stamp.
 *
 * A rollout is append-only and can reach tens of megabytes, so opening and
 * reading it to discover that nothing was appended is far more expensive than
 * one stat. Size and mtime catch appends; the inode catches a rename-over,
 * which size and mtime alone cannot distinguish from an append.
 *
 * Returns null when the file cannot be stat'd, which callers treat as
 * "unknown" and therefore as a reason to parse rather than to skip.
 */
export function fileSignature(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
  } catch {
    return null;
  }
}
