/** Private, exact-target digest retention. No model, policy writes, legacy notes or discovery reads. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fingerprint, revalidateMaterials, type MaterialEnvelope } from './index.js';
import { privateIdentity, type SourceSnapshot } from './source-config.js';
import type { CompletedReportMetadata } from '../delegated-report-read.js';
import type { DigestDocument } from './delegated-digest.js';

export type DigestRetentionReason = 'digest_note_busy' | 'digest_note_capacity' | 'digest_note_unsafe' |
  'digest_note_write_failed' | 'digest_note_publish_uncertain' | 'digest_note_authorization_changed';
export type DigestRetention = { state: 'saved'; noteId: string } |
  { state: 'not_saved'; reason: DigestRetentionReason };
export interface StoredDigestDocument {
  format: 'hud-delegated-digest-note'; schemaVersion: 1; label: 'model_generated';
  noteId: string; storedAt: number; document: DigestDocument;
  provenance: { runSeq: number; generation: number; acceptedSeq: number; acceptedAt: number };
}
export interface SavedDigestDocument {
  format: 'hud-delegated-digest-save'; schemaVersion: 1;
  document: DigestDocument; retention: DigestRetention;
}
export interface DigestNoteContext {
  source: SourceSnapshot;
  target: CompletedReportMetadata;
  envelope: MaterialEnvelope;
  /** Live, latched authority AND exact current material content check, owned by the service. */
  current(): boolean;
}
const MAX_BYTES = 256 * 1024;
const MAX_NOTES = 200;
const fail = (): never => { throw new Error('digest_note_unavailable'); };
const stamp = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
function identity(file: string, directory: boolean): string {
  const id = privateIdentity(file, directory);
  if ((fs.lstatSync(file).mode & 0o777) !== (directory ? 0o700 : 0o600)) fail();
  return id;
}
function proof(context: DigestNoteContext) {
  const { source, envelope, target } = context;
  if (!source.recipient || envelope.fragments.length !== 1 || envelope.fragments[0].provenance.length !== 1 ||
      envelope.purpose !== 'digest' || envelope.sources.length !== 1 ||
      envelope.sources[0] !== target.ref.sourceId || envelope.fragments[0].provenance[0].origin !== 'delegated' ||
      envelope.fragments[0].provenance[0].field !== 'result' ||
      fingerprint(envelope.fragments[0].provenance[0].ref) !== fingerprint(target.ref) ||
      !revalidateMaterials(envelope, source.authority, source.recipient)) fail();
  // The original scope revisions are not enumerable on MaterialEnvelope. This source has exactly one scope;
  // capture its revision explicitly, while retaining the original cacheDomain that also binds it.
  return {
    target, recipient: source.recipient, language: source.config.delegatedDigest.language,
    sourceConfiguration: fingerprint(source.config), scopeRevision: { [target.ref.sourceId]: source.config.revision },
    material: {
      sources: envelope.sources, purpose: envelope.purpose, recipientId: envelope.recipientId,
      policyRevision: envelope.policyRevision, fingerprint: envelope.fingerprint,
      coverage: envelope.coverage, cacheDomain: envelope.cacheDomain,
      fragments: envelope.fragments.map((fragment) => ({
        provenance: fragment.provenance, contentFingerprint: fingerprint(fragment.text),
      })),
    },
  };
}
export function digestNoteId(context: DigestNoteContext): string {
  return fingerprint(['hud-digest-note:v1', context.target, context.source.recipient,
    context.source.config.delegatedDigest.language]);
}
function documentIdentity(context: DigestNoteContext) {
  const { target, source } = context;
  return {
    format: 'hud-delegated-digest', schemaVersion: 1, ledgerId: target.ledgerId, linkId: target.linkId,
    runId: target.runId, reportId: target.reportId, ref: target.ref, origin: 'delegated', purpose: 'digest',
    material: 'completed_report_summary', recipientId: source.recipient!.recipientId,
    model: source.recipient!.model, language: source.config.delegatedDigest.language,
  };
}
function validDocument(document: DigestDocument, context: DigestNoteContext, parse: (text: string) => unknown): boolean {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const { generatedAt, cached, digest, ...rest } = document;
  return Number.isSafeInteger(generatedAt) && generatedAt >= 0 && typeof cached === 'boolean' &&
    fingerprint(rest) === fingerprint(documentIdentity(context)) &&
    parse(JSON.stringify(digest)) !== null;
}
/** The unreleased notes layout is a source sibling, outside the model runtime's recursive walk. */
function directories(context: DigestNoteContext, create: boolean) {
  const parent = dirname(context.source.runtimeDir);
  const parentId = identity(parent, true);
  const dir = join(parent, 'digest-notes-v1');
  if (create) {
    if (!context.current()) fail();
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const dirId = identity(dir, true);
  const checkPaths = () => {
    if (identity(parent, true) !== parentId || identity(dir, true) !== dirId) fail();
  };
  const check = () => { checkPaths(); if (!context.current()) fail(); };
  check();
  return { dir, dirId, parent, parentId, check, checkPaths };
}
function privateDescriptor(st: fs.Stats, directory: boolean): void {
  if (process.getuid?.() !== process.geteuid?.() || st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail();
}
/** Safe descriptor fsync, including the parent entry that makes a newly created notes directory reachable. */
function syncDirectory(dir: string, expected: string, check: () => void): void {
  check();
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    privateDescriptor(st, true);
    if (`${st.dev}:${st.ino}` !== expected || identity(dir, true) !== expected) fail();
    fs.fsyncSync(fd);
    check();
    if (`${fs.fstatSync(fd).dev}:${fs.fstatSync(fd).ino}` !== expected) fail();
  } finally { fs.closeSync(fd); }
}
function readBounded(file: string, check: () => void): { value: unknown; unchanged(): void } {
  check();
  identity(file, false);
  const before = fs.lstatSync(file);
  if (before.size < 1 || before.size > MAX_BYTES) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    privateDescriptor(opened, false);
    if (opened.size < 1 || opened.size > MAX_BYTES) fail();
    if (stamp(before) !== stamp(opened)) fail();
    check();
    const ready = fs.fstatSync(fd);
    privateDescriptor(ready, false);
    if (stamp(ready) !== stamp(opened)) fail();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size !== opened.size || size > MAX_BYTES || stamp(opened) !== stamp(fs.fstatSync(fd))) fail();
    const unchanged = () => {
      check();
      identity(file, false);
      if (stamp(fs.lstatSync(file)) !== stamp(opened)) fail();
    };
    unchanged();
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))), unchanged };
  } finally { fs.closeSync(fd); }
}
interface NoteWriterLock { file: string; id: string; fd: number }
type NoteDirectories = ReturnType<typeof directories>;
function checkWriterLock(lock: NoteWriterLock, paths: NoteDirectories): void {
  paths.checkPaths();
  const st = fs.fstatSync(lock.fd);
  privateDescriptor(st, false);
  if (`${st.dev}:${st.ino}` !== lock.id || identity(lock.file, false) !== lock.id) fail();
}
function releaseWriterLock(lock: NoteWriterLock): void {
  try { fs.closeSync(lock.fd); } catch { /* no retry */ }
  try { if (identity(lock.file, false) === lock.id) fs.unlinkSync(lock.file); } catch { /* never steal a replacement */ }
}
function acquireWriterLock(paths: NoteDirectories): NoteWriterLock {
  paths.checkPaths();
  const file = join(paths.dir, '.write-lock');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW, 0o600);
  const lock = { file, id: '', fd };
  try {
    const st = fs.fstatSync(fd);
    lock.id = `${st.dev}:${st.ino}`;
    checkWriterLock(lock, paths);
    return lock;
  } catch (error) { releaseWriterLock(lock); throw error; }
}
export interface DigestNoteSave {
  retention: DigestRetention;
  current(): boolean;
  /** Independent of permission to expose text. False only if no publish was attempted or removal was durable. */
  publicationUncertain(): boolean;
  /** Release the publication inode pin after the service's final settlement check. Idempotent. */
  dispose(): void;
}
/** save is synchronous and bounded; the service keeps this guard alive through delivery and settlement. */
export function saveDigestNote(context: DigestNoteContext, document: DigestDocument): DigestNoteSave {
  let reason: DigestRetentionReason = 'digest_note_unsafe';
  let lock: NoteWriterLock | undefined;
  let temporary: { file: string; id: string } | undefined;
  let attempted: { file: string; id: string } | undefined;
  let pin: { fd: number; id: string; size: number } | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const owned = pin; pin = undefined;
    if (owned) { try { fs.closeSync(owned.fd); } catch { /* no descriptor-number retry */ } }
  };
  let published = false;
  let removedDurably = false;
  let paths: ReturnType<typeof directories> | undefined;
  let publishedCheck: (() => void) | undefined;
  let invalid = false;
  const publicationUncertain = () => attempted !== undefined && !removedDurably;
  const current = () => {
    if (invalid || disposed) return false;
    try {
      if (!context.current()) fail();
      if (published && attempted && identity(attempted.file, false) !== attempted.id) fail();
      publishedCheck?.();
      return true;
    } catch {
      invalid = true;
      if (attempted && paths) {
        let cleanupLock: NoteWriterLock | undefined;
        let acquired = false;
        try {
          // Serialize the entire leaf comparison/unlink/fsync against cooperating save invocations.
          // During save, reuse our live lock. After release, try the SAME exclusive lock exactly once.
          cleanupLock = lock ?? acquireWriterLock(paths);
          acquired = lock === undefined;
          checkWriterLock(cleanupLock, paths);
          // This live descriptor keeps the original inode allocated even after peer replacement.
          // Metadata only: revoked authority never permits reading generated payload here.
          if (!pin || pin.id !== attempted.id) fail();
          const owned = fs.fstatSync(pin.fd);
          privateDescriptor(owned, false);
          if (`${owned.dev}:${owned.ino}` !== pin.id || owned.size !== pin.size) fail();
          if (identity(attempted.file, false) === pin.id) {
            fs.unlinkSync(attempted.file);
            syncDirectory(paths.dir, paths.dirId, paths.checkPaths);
            checkWriterLock(cleanupLock, paths);
            removedDurably = true;
          }
        } catch { /* Contention/ownership failure stays uncertain; no unlocked deletion, wait or retry. */ }
        finally { if (acquired && cleanupLock) releaseWriterLock(cleanupLock); }
      }
      return false;
    }
  };
  try {
    if (!context.current()) return { retention: { state: 'not_saved', reason: 'digest_note_authorization_changed' }, current, publicationUncertain, dispose };
    const provenance = proof(context);
    const noteId = digestNoteId(context);
    const record = { format: 'hud-private-digest-note', schemaVersion: 1, noteId, storedAt: Date.now(),
      provenance, document, outputFingerprint: fingerprint(document) };
    const bytes = Buffer.from(JSON.stringify({ ...record, recordFingerprint: fingerprint(record) }));
    if (bytes.length > MAX_BYTES) fail();
    paths = directories(context, true);
    const file = join(paths.dir, `${noteId}.json`);
    reason = 'digest_note_busy';
    lock = acquireWriterLock(paths);
    reason = 'digest_note_unsafe';
    paths.check();
    // Bounded iterator, not readdirSync: even an adversarially huge directory is capped.
    const entries = fs.opendirSync(paths.dir, { bufferSize: 16 });
    let count = 0; let existing: string | undefined;
    try {
      let entry: fs.Dirent | null;
      while ((entry = entries.readSync()) !== null) {
        if (entry.name === '.write-lock') continue;
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) fail();
        if (++count > MAX_NOTES) { reason = 'digest_note_capacity'; fail(); }
        const existingFile = join(paths.dir, entry.name);
        const id = identity(existingFile, false);
        if (fs.lstatSync(existingFile).size > MAX_BYTES) fail();
        if (entry.name === `${noteId}.json`) existing = id;
      }
    } finally { entries.closeSync(); }
    if (count === MAX_NOTES && existing === undefined) { reason = 'digest_note_capacity'; fail(); }
    paths.check();
    reason = 'digest_note_write_failed';
    const temp = join(paths.dir, `.pending-${randomUUID()}`);
    const out = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW, 0o600);
    pin = { fd: out, id: '', size: bytes.length };
    {
      const opened = fs.fstatSync(out);
      privateDescriptor(opened, false);
      pin.id = `${opened.dev}:${opened.ino}`;
      temporary = { file: temp, id: `${fs.fstatSync(out).dev}:${fs.fstatSync(out).ino}` };
      identity(temp, false);
      fs.writeFileSync(out, bytes);
      fs.fsyncSync(out);
      const written = fs.fstatSync(out);
      privateDescriptor(written, false);
      if (written.size !== bytes.length || `${written.dev}:${written.ino}` !== pin.id ||
          identity(temp, false) !== pin.id) fail();
    }
    reason = 'digest_note_authorization_changed';
    paths.check();
    if (fingerprint(proof(context)) !== fingerprint(provenance)) fail();
    reason = 'digest_note_unsafe';
    if (existing !== undefined) { if (identity(file, false) !== existing) fail(); }
    else { try { fs.lstatSync(file); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    paths.check();
    // From this point a failed rename/fsync/readback may have published. Never advise a run retry.
    reason = 'digest_note_publish_uncertain';
    attempted = { file, id: temporary.id };
    fs.renameSync(temp, file);
    published = true;
    temporary = undefined;
    syncDirectory(paths.dir, paths.dirId, paths.check);
    syncDirectory(paths.parent, paths.parentId, paths.check);
    const readback = readBounded(file, paths.check);
    publishedCheck = readback.unchanged;
    if (fingerprint(readback.value) !== fingerprint({ ...record, recordFingerprint: fingerprint(record) })) fail();
    paths.check();
    return { retention: { state: 'saved', noteId }, current, publicationUncertain, dispose };
  } catch {
    if (attempted) {
      try { published = identity(attempted.file, false) === attempted.id; } catch { /* still possibly published */ }
    }
    current(); // Remove only our new inode on observed invalidation; preserve another writer's replacement.
    return { retention: { state: 'not_saved', reason }, current, publicationUncertain, dispose };
  } finally {
    if (temporary) {
      try { if (identity(temporary.file, false) === temporary.id) fs.unlinkSync(temporary.file); } catch { /* leave for manual inspection */ }
    }
    if (!attempted && pin) {
      const unused = pin; pin = undefined;
      try { fs.closeSync(unused.fd); } catch { /* no retry */ }
    }
    if (lock) {
      const released = lock;
      lock = undefined; // Later delivery invalidation must reacquire, never reuse a closed descriptor.
      releaseWriterLock(released);
    }
  }
}
export function readDigestNote(context: DigestNoteContext, parse: (text: string) => unknown): {
  result: StoredDigestDocument; current(): boolean;
} {
  const expected = proof(context);
  const noteId = digestNoteId(context);
  const paths = directories(context, false);
  const read = readBounded(join(paths.dir, `${noteId}.json`), paths.check);
  const value = read.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'document,format,noteId,outputFingerprint,provenance,recordFingerprint,schemaVersion,storedAt' ||
      record.format !== 'hud-private-digest-note' || record.schemaVersion !== 1 || record.noteId !== noteId ||
      !Number.isSafeInteger(record.storedAt) || Number(record.storedAt) < 0 ||
      fingerprint(record.provenance) !== fingerprint(expected) || record.outputFingerprint !== fingerprint(record.document)) fail();
  const { recordFingerprint, ...body } = record;
  if (recordFingerprint !== fingerprint(body) || !validDocument(record.document as DigestDocument, context, parse)) fail();
  let invalid = false;
  const current = () => {
    if (invalid) return false;
    try { read.unchanged(); return true; } catch { invalid = true; return false; }
  };
  if (!current()) fail();
  const m = context.target;
  return { result: { format: 'hud-delegated-digest-note', schemaVersion: 1, label: 'model_generated', noteId,
    storedAt: Number(record.storedAt), document: record.document as DigestDocument,
    provenance: { runSeq: m.runSeq, generation: m.generation, acceptedSeq: m.acceptedSeq, acceptedAt: m.acceptedAt } }, current };
}
