import { existsSync, lstatSync, readFileSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerKey, type NativeOwner } from './relations.js';

export interface JevRelation {
  owner: NativeOwner;
  callId: string;
  instanceId: string;
  targetId: string | null;
  sessionId: string | null;
  createdAt: number;
}

/** Only direct ownership facts are persisted. No inferred task state or restart replay. */
export function readJevRelations(
  home: string,
  owner?: NativeOwner,
  maxRecords = Number.POSITIVE_INFINITY
): JevRelation[] {
  const directory = join(home, 'native-relations');
  if (!existsSync(directory)) return [];
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || dir.mode & 0o077)
    throw new Error('unsafe_jev_relation_directory');
  const rows: JevRelation[] = [];
  const cursor = opendirSync(directory);
  let scanned = 0;
  try {
    while (rows.length < maxRecords && scanned < maxRecords * 8) {
      const entry = cursor.readSync();
      if (!entry) break;
      scanned++;
      if (!/^jev-[a-f0-9-]+\.json$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw new Error('unsafe_jev_relation_file');
      if (stat.size > 262144) throw new Error('jev_relation_file_too_large');
      const row = JSON.parse(readFileSync(path, 'utf8')) as JevRelation;
      const text = (value: unknown): value is string =>
        typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
      if (
        !row ||
        !row.owner ||
        !['codex', 'claude', 'pi'].includes(row.owner.harness) ||
        !text(row.owner.sourceId) ||
        !text(row.owner.sessionId) ||
        !(row.owner.threadId === null || text(row.owner.threadId)) ||
        !text(row.callId) ||
        !text(row.instanceId) ||
        !Number.isFinite(row.createdAt) ||
        !(row.targetId === null || text(row.targetId)) ||
        !(row.sessionId === null || text(row.sessionId))
      )
        throw new Error('invalid_jev_relation');
      if (!owner || ownerKey(row.owner) === ownerKey(owner)) rows.push(row);
    }
  } finally {
    cursor.closeSync();
  }
  return rows;
}
