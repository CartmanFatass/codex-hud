/** Reversible migration of explicitly selected compatible settings, never source authority. */
import * as fs from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { MAPPING, SETTINGS_FILE, transform } from './mappings.js';
import {
  type Directory,
  type Fingerprint,
  type Snapshot,
  privateDirectory,
  readPrivate,
  fingerprint,
  hash,
  same,
  createPrivate,
  locked,
  fail,
  jsonObject,
  LIMIT,
} from './private-files.js';
export { MAPPING } from './mappings.js';
export { MigrationError } from './private-files.js';
export interface Selection {
  mapping: string;
  source: string;
  target: string;
}
export interface MigrationPlan {
  version: 1;
  mapping: string;
  source: string;
  target: string;
  inputDigest: string;
  sourceHash: string;
  currentHash: string | null;
  proposedHash: string;
  changes: ReturnType<typeof transform>['changes'];
  excludedSourceKeys: number;
  backup: string | null;
  temporary: string | null;
  lock: string | null;
  settingsEnvironment: { CODEX_HUD_SETTINGS_PATH: string };
  caches: 'not copied; rebuilt by normal collectors when needed';
}
interface Prepared {
  plan: MigrationPlan;
  source: Snapshot;
  current: Snapshot | null;
  bytes: Buffer;
}
function prepare(selection: Selection, source: Directory, target: Directory): Prepared {
  if (selection.mapping !== MAPPING) fail('migration_unsupported_mapping');
  if (same(source.identity, target.identity)) fail('migration_same_directory');
  source.check();
  target.check();
  const input = readPrivate(join(source.fdPath, SETTINGS_FILE));
  if (!input) fail('migration_source_missing');
  const current = readPrivate(join(target.fdPath, SETTINGS_FILE));
  const output = transform(input.bytes, current?.bytes ?? null);
  const inputDigest = hash(
    JSON.stringify({
      version: 1,
      mapping: selection.mapping,
      source: selection.source,
      target: selection.target,
      sourceDirectory: source.identity,
      targetDirectory: target.identity,
      sourceFile: fingerprint(input),
      targetFile: fingerprint(current),
      outputHash: hash(output.bytes),
    })
  );
  const prefix = join(target.path, `.hud-migrate-${inputDigest}`);
  const plan: MigrationPlan = {
    version: 1,
    mapping: MAPPING,
    source: join(source.path, SETTINGS_FILE),
    target: join(target.path, SETTINGS_FILE),
    inputDigest,
    sourceHash: hash(input.bytes),
    currentHash: current ? hash(current.bytes) : null,
    proposedHash: hash(output.bytes),
    changes: output.changes,
    excludedSourceKeys: output.excludedKeys,
    backup: output.changes.length ? prefix + '.backup.json' : null,
    temporary: output.changes.length ? prefix + '.tmp' : null,
    lock: output.changes.length ? join(target.path, '.hud-migrate.lock') : null,
    settingsEnvironment: { CODEX_HUD_SETTINGS_PATH: join(target.path, SETTINGS_FILE) },
    caches: 'not copied; rebuilt by normal collectors when needed',
  };
  source.check();
  target.check();
  return { plan, source: input, current, bytes: output.bytes };
}
function selected<T>(selection: Selection, work: (source: Directory, target: Directory) => T): T {
  if (selection.mapping !== MAPPING) fail('migration_unsupported_mapping');
  return privateDirectory(selection.source, (source) =>
    privateDirectory(selection.target, (target) => work(source, target))
  );
}
export function previewMigration(selection: Selection): MigrationPlan {
  return selected(selection, (source, target) => prepare(selection, source, target).plan);
}
interface Backup {
  version: 1;
  mapping: typeof MAPPING;
  target: string;
  targetDirectory: Directory['identity'];
  inputDigest: string;
  original: string | null;
  originalHash: string | null;
  originalMode: number;
  installed: Fingerprint;
}
export function applyMigration(
  selection: Selection,
  expected: string
): { status: 'applied' | 'unchanged'; plan: MigrationPlan } {
  if (!/^[a-f0-9]{64}$/.test(expected)) fail('migration_expected_digest_required');
  return selected(selection, (source, target) => {
    const first = prepare(selection, source, target);
    if (first.plan.inputDigest !== expected) fail('migration_input_changed');
    if (!first.plan.changes.length) return { status: 'unchanged', plan: first.plan };
    return locked(target, () => {
      const prepared = prepare(selection, source, target);
      if (prepared.plan.inputDigest !== expected) fail('migration_input_changed');
      const temporary = join(target.fdPath, basename(prepared.plan.temporary!));
      const backup = join(target.fdPath, basename(prepared.plan.backup!));
      const file = join(target.fdPath, SETTINGS_FILE);
      // Refuse a prior attempt rather than overwrite its recovery information.
      if (fs.existsSync(backup) || fs.existsSync(temporary)) fail('migration_recovery_exists');
      let temporaryCreated = false;
      try {
        createPrivate(temporary, prepared.bytes, prepared.current?.fingerprint.mode ?? 0o600);
        temporaryCreated = true;
        const installed = readPrivate(temporary)!;
        const record: Backup = {
          version: 1,
          mapping: MAPPING,
          target: prepared.plan.target,
          targetDirectory: target.identity,
          inputDigest: expected,
          original: prepared.current?.bytes.toString('base64') ?? null,
          originalHash: prepared.plan.currentHash,
          originalMode: prepared.current?.fingerprint.mode ?? 0o600,
          installed: installed.fingerprint,
        };
        createPrivate(backup, Buffer.from(JSON.stringify(record) + '\n'));
        target.sync(); // Recovery data is durable before the target can change.
        source.check();
        target.check();
        if (prepare(selection, source, target).plan.inputDigest !== expected) fail('migration_input_changed');
        fs.renameSync(temporary, file);
        temporaryCreated = false;
        target.sync();
        target.check();
        return { status: 'applied', plan: prepared.plan };
      } finally {
        if (temporaryCreated) fs.unlinkSync(temporary);
      }
    });
  });
}
function validFingerprint(value: unknown): value is Fingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).join(',') === 'hash,dev,ino,mode,uid,size,mtimeMs' &&
    typeof v.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(v.hash) &&
    ['dev', 'ino', 'mode', 'uid', 'size'].every((key) => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0) &&
    [0o400, 0o600].includes(Number(v.mode)) &&
    Number(v.size) <= LIMIT &&
    typeof v.mtimeMs === 'number' &&
    Number.isFinite(v.mtimeMs)
  );
}
function readBackup(target: Directory, backupPath: string): { record: Backup; original: Buffer | null } {
  if (dirname(backupPath) !== target.path || !/^\.hud-migrate-[a-f0-9]{64}\.backup\.json$/.test(basename(backupPath)))
    fail('migration_invalid_backup');
  const saved = readPrivate(join(target.fdPath, basename(backupPath)), LIMIT * 2);
  if (!saved) fail('migration_backup_missing');
  const record = jsonObject(saved.bytes);
  if (
    record.version !== 1 ||
    record.mapping !== MAPPING ||
    record.target !== join(target.path, SETTINGS_FILE) ||
    !same(record.targetDirectory, target.identity) ||
    typeof record.inputDigest !== 'string' ||
    basename(backupPath) !== `.hud-migrate-${record.inputDigest}.backup.json` ||
    !validFingerprint(record.installed) ||
    !Number.isInteger(record.originalMode) ||
    ![0o400, 0o600].includes(Number(record.originalMode)) ||
    !(record.original === null || typeof record.original === 'string')
  )
    fail('migration_invalid_backup');
  const original = record.original === null ? null : Buffer.from(record.original as string, 'base64');
  if (
    (original ? hash(original) : null) !== record.originalHash ||
    (original && (original.length > LIMIT || original.toString('base64') !== record.original))
  )
    fail('migration_invalid_backup');
  return { record: record as unknown as Backup, original };
}
export function restoreMigration(
  targetPath: string,
  backupPath: string
): { status: 'restored'; target: string; backup: string } {
  return privateDirectory(targetPath, (target) => {
    const { record, original } = readBackup(target, backupPath);
    return locked(target, () => {
      const file = join(target.fdPath, SETTINGS_FILE);
      const check = () => {
        target.check();
        if (!same(fingerprint(readPrivate(file)), record.installed)) fail('migration_restore_conflict');
      };
      check();
      if (original) {
        const temporary = join(target.fdPath, `.hud-migrate-${record.inputDigest}.restore.tmp`);
        // Exclusive create also conservatively refuses an interrupted restore.
        createPrivate(temporary, original, record.originalMode);
        try {
          check();
          fs.renameSync(temporary, file);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      } else {
        check();
        fs.unlinkSync(file);
      }
      target.sync();
      target.check();
      return { status: 'restored', target: record.target, backup: backupPath };
    });
  });
}
