import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, opendirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { NativeRef } from './types.js';
export interface NativeOwner {
  harness: 'codex' | 'claude' | 'pi';
  sourceId: string;
  sessionId: string;
  threadId: string | null;
}
export interface DirectRelation {
  owner: NativeOwner;
  callId: string;
  child: NativeRef;
  workspace: string;
  profileId: string;
  createdAt: number;
}
export const ownerKey = (owner: NativeOwner): string =>
  createHash('sha256')
    .update(JSON.stringify([owner.harness, owner.sourceId, owner.sessionId, owner.threadId]))
    .digest('hex');
export function nativeKey(ref: NativeRef): string {
  return JSON.stringify([ref.harness, ref.harness === 'codex' ? ref.threadId : ref.sessionId]);
}
/** Read-only UI path: never creates a directory or starts a backend. */
export function readRelations(
  home: string,
  owner?: NativeOwner,
  maxRecords = Number.POSITIVE_INFINITY
): DirectRelation[] {
  const directory = join(home, 'native-relations');
  if (!existsSync(directory)) return [];
  return readRelationsDirectory(directory, owner, maxRecords);
}
function readRelationsDirectory(
  directory: string,
  owner?: NativeOwner,
  maxRecords = Number.POSITIVE_INFINITY
): DirectRelation[] {
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    directoryStat.mode & 0o077
  )
    throw new Error('unsafe_relation_directory');
  const result: DirectRelation[] = [];
  if (maxRecords <= 0) return result;
  const cursor = opendirSync(directory);
  let scanned = 0;
  try {
    for (;;) {
      if (scanned >= maxRecords * 8 || result.length >= maxRecords) break;
      const entry = cursor.readSync();
      if (!entry) break;
      const file = entry.name;
      scanned++;
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const path = join(directory, file),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw new Error('unsafe_relation_file');
      if (stat.size > 262144) throw new Error('relation_file_too_large');
      const row = JSON.parse(readFileSync(path, 'utf8')) as DirectRelation;
      if (!validRelation(row)) throw new Error('invalid_native_relation');
      if (!owner || ownerKey(row.owner) === ownerKey(owner)) result.push(row);
      if (result.length >= maxRecords) break;
    }
  } finally {
    cursor.closeSync();
  }
  return result;
}

function validRelation(value: unknown): value is DirectRelation {
  const row = value as DirectRelation;
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
  if (
    !row ||
    typeof row !== 'object' ||
    !row.owner ||
    !row.child ||
    !text(row.callId) ||
    !text(row.workspace) ||
    !isAbsolute(row.workspace) ||
    !text(row.profileId) ||
    !Number.isFinite(row.createdAt)
  )
    return false;
  const owner = row.owner,
    ref = row.child;
  if (
    !['codex', 'claude', 'pi'].includes(owner.harness) ||
    !text(owner.sourceId) ||
    !text(owner.sessionId) ||
    !(owner.threadId === null || text(owner.threadId))
  )
    return false;
  if (ref.harness === 'codex') return text(ref.threadId);
  if (ref.harness === 'claude') return text(ref.sessionId);
  if (ref.harness === 'pi')
    return (
      text(ref.sessionId) && (ref.sessionFile === undefined || (text(ref.sessionFile) && isAbsolute(ref.sessionFile)))
    );
  return false;
}
