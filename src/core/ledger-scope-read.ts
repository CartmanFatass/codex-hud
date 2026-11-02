/// <reference path="../types/node-sqlite.d.ts" />
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ProcessKey, SessionRef } from './types/identity.js';

/** A comparison premise, never authority. B5 must compare it again in its write transaction. */
export type ScopeSnapshot = {
  processKey: ProcessKey;
  ledgerId: string | null;
  highWaterGeneration: number;
} & (
  | { kind: 'missing_ledger' | 'no_current'; current: null }
  | {
      kind: 'current';
      current: { generation: number; sessionRef: SessionRef | null; bindingEvidenceId: string | null };
    }
);
export interface ScopeSnapshotPort {
  read(processKey: ProcessKey): ScopeSnapshot;
}

/** Small synchronous B2 read port. No writer imports, migrations, retries or path creation. */
export class ReadOnlyScopeSnapshot implements ScopeSnapshotPort {
  constructor(private readonly path: string) {}
  read(processKey: ProcessKey): ScopeSnapshot {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!((major === 22 && minor >= 13) || major >= 24))
      throw new Error('Scope reads require Node 22.x >=22.13 or Node >=24 (23 unsupported)');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    // Probe before looking at the requested path, just like the B2 runtime adapter.
    const probe = new DatabaseSync(':memory:', { readOnly: true });
    let supported = false;
    try {
      try {
        probe.exec('CREATE TABLE readonly_capability_probe(value)');
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        supported = typeof code === 'number' && (code & 0xff) === 8;
      }
    } finally {
      probe.close();
    }
    if (!supported) throw new Error('Native SQLite readOnly support is required');
    if (!this.path.startsWith('/') || this.path.includes('\0')) throw new Error('Absolute ledger path required');
    let file;
    try {
      file = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { kind: 'missing_ledger', processKey, ledgerId: null, highWaterGeneration: 0, current: null };
    }
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.())
      throw new Error('Private regular ledger required');
    const key: unknown = JSON.parse(processKey);
    if (!Array.isArray(key) || key.length !== 5) throw new Error('Invalid ProcessKey');
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN');
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported ledger schema');
      const ledgerId = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get()?.ledger_id;
      if (typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 256) throw new Error('Invalid ledgerId');
      const highWater = db
        .prepare('SELECT coalesce(max(generation),0) AS generation FROM caller_scopes WHERE process_key=?')
        .get(processKey)?.generation;
      if (typeof highWater !== 'number' || !Number.isSafeInteger(highWater) || highWater < 0)
        throw new Error('Invalid scope high-water');
      const row = db
        .prepare(
          'SELECT generation,session_ref,binding_evidence_id FROM caller_scopes WHERE process_key=? AND closed_at IS NULL'
        )
        .get(processKey);
      let result: ScopeSnapshot;
      if (!row) result = { kind: 'no_current', processKey, ledgerId, highWaterGeneration: highWater, current: null };
      else {
        if (row.generation !== highWater || highWater < 1) throw new Error('Invalid current scope');
        let sessionRef: SessionRef | null = null;
        if (row.session_ref !== null) {
          if (typeof row.session_ref !== 'string') throw new Error('Invalid scope reference');
          const ref: unknown = JSON.parse(row.session_ref);
          if (
            !Array.isArray(ref) ||
            ref.length !== 4 ||
            ref[0] !== key[0] ||
            ref[1] !== key[1] ||
            typeof ref[2] !== 'string' ||
            !ref[2] ||
            (ref[3] !== null && typeof ref[3] !== 'string') ||
            typeof row.binding_evidence_id !== 'string'
          )
            throw new Error('Invalid scope reference');
          sessionRef = { harness: ref[0], sourceId: ref[1], sessionId: ref[2], threadId: ref[3] };
        } else if (row.binding_evidence_id !== null) throw new Error('Invalid scope evidence');
        result = {
          kind: 'current',
          processKey,
          ledgerId,
          highWaterGeneration: highWater,
          current: { generation: highWater, sessionRef, bindingEvidenceId: row.binding_evidence_id as string | null },
        };
      }
      db.exec('COMMIT');
      const after = lstatSync(this.path);
      if (after.dev !== file.dev || after.ino !== file.ino) throw new Error('Ledger replaced during scope read');
      return result;
    } finally {
      db.close();
    }
  }
}
