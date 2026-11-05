import type { HudIO } from './link-export.js';
import {
  applyMigration,
  previewMigration,
  restoreMigration,
  MigrationError,
  MAPPING,
} from '../core/migration/index.js';

export const MIGRATE_HELP = `Usage: hud migrate [--help]
       hud migrate preview --mapping ${MAPPING} --source ABSOLUTE_DIR --target ABSOLUTE_DIR
       hud migrate apply --mapping ${MAPPING} --source ABSOLUTE_DIR --target ABSOLUTE_DIR --expect INPUT_DIGEST
       hud migrate restore --target ABSOLUTE_DIR --backup ABSOLUTE_BACKUP

Explicit Linux opt-in; default/help/preview never write or discover user homes.
${MAPPING}: selected presentation preferences in hud-settings.json only.
Both directories must already exist, be canonical, uid-owned and private (0700).
Files must be uid-owned, private (0600/0400), regular and non-linked; max 64 KiB.
Preview prints exact paths, field changes and an input digest. Apply requires it.
No source transcripts, caches, credentials, model/outbound grants or capability
verification are copied. Existing unrelated target settings remain unchanged.
Caches rebuild on normal collection, not during migration; target caches stay put.
Restore requires the original target directory and an unchanged installed file.
Keep the preview and private backup. Stop conflicting writers before apply/restore.
No environment aliases, package renaming, install or default source switching.
See docs/cloud-development/reversible-migration.md for recovery and compatibility.
`;
export async function migrateCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (
    !args.length ||
    (args.length === 1 && args[0] === '--help') ||
    (args.length === 2 && ['preview', 'apply', 'restore'].includes(args[0]) && args[1] === '--help')
  ) {
    await io.stdout(MIGRATE_HELP);
    return 0;
  }
  try {
    const operation = args[0];
    const allowed =
      operation === 'restore'
        ? ['--target', '--backup']
        : ['--mapping', '--source', '--target', ...(operation === 'apply' ? ['--expect'] : [])];
    if (!['preview', 'apply', 'restore'].includes(operation)) throw new MigrationError('migration_invalid_arguments');
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new MigrationError('migration_invalid_arguments');
      flags.set(args[i], args[i + 1]);
    }
    if (allowed.some((flag) => !flags.has(flag))) throw new MigrationError('migration_invalid_arguments');
    let result: unknown;
    if (operation === 'restore') result = restoreMigration(flags.get('--target')!, flags.get('--backup')!);
    else {
      const selection = {
        mapping: flags.get('--mapping')!,
        source: flags.get('--source')!,
        target: flags.get('--target')!,
      };
      result =
        operation === 'preview' ? previewMigration(selection) : applyMigration(selection, flags.get('--expect')!);
    }
    await io.stdout(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof MigrationError ? error.message : 'migration_io_or_output_failure'}\n`);
    return 2;
  }
}
