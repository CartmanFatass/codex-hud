# Reversible display-settings migration (E2/E3/M4 slice)

`hud migrate` is an explicit Linux-only migration tool. Its default invocation and
help are read-only; preview reads only two named configuration files. It does not
search HOME, initialize HUD storage, install a package, change defaults, or launch
an agent. Existing `hud`, `codex-hud`, `hud codex`, and `hud codex-hud` entrypoints
and environment variables remain unchanged. The published package is still
`codex-hud`.

## Supported mapping and compatibility

The versioned mapping `codex-display-v1` reads an explicitly selected
`SOURCE/hud-settings.json` and updates `TARGET/hud-settings.json`. These are the
existing `src/settings.ts` schema, consumed through `CODEX_HOME` or
`CODEX_HUD_SETTINGS_PATH`. No new universal settings location is invented.

Only validated display preferences are selected: theme, density, glyphs/icons,
look/motion/context, agent colors, statusline visibility, sort, mouse, visible
panes, refresh/width/linger, timeline style/hours, panel layout, language and card
presentation. Legacy `folded` pane values become `closed`. The complete allowlist
is in `src/core/migration/mappings.ts`; unsupported values for selected fields
are refused rather than silently coerced. Nonfinite numbers and integers outside
JavaScript's safe range are refused in either JSON input so unrelated values are
not silently rounded or converted to null. Unknown fields are not copied, and
preview reports only their count, never their names or values.

Source credentials, API endpoints/models, model-call budgets, outbound grants,
notification settings, executable paths, profile capabilities, verification,
transcripts, source identities, ledger and cache files are never migrated. Existing
unrelated target settings are preserved. In particular a disabled target model or
outbound permission is not enabled by a source setting. Target caches are left
alone; source caches are not copied, and ordinary collectors rebuild missing
caches as needed. Migration does not run collectors or promise eager rebuilding.

This is a reversible **display-settings migration**, not completion of all E3
source/ledger migration, all E2 environment aliases, or M4 installation/release
qualification. Claude `statusLine` installation is a separate explicit command.
Live accounts, real user configuration, default switching and package publishing
are outside this slice.

## Preview, review, apply, select, restore

Both selected directories must already exist, resolve canonically without symlink
components, be owned by the effective user and be private (normally `0700`). Files
must be regular, single-linked, uid-owned and `0600` or `0400`. Each settings file
is bounded to 64 KiB. Migration never creates/chmods the supplied directories.
Use separate private temporary directories when rehearsing.

```sh
hud migrate --help
hud migrate preview --mapping codex-display-v1 \
  --source /absolute/private/old-source --target /absolute/private/new-source
```

The JSON preview gives the exact source/target paths, field changes, input digest,
proposed content hash, backup path, temporary path and lock path. It does not print
a whole target settings object: unrelated target secrets remain private. Review
this output, then repeat the **same** selection with its digest:

```sh
hud migrate apply --mapping codex-display-v1 \
  --source /absolute/private/old-source --target /absolute/private/new-source \
  --expect DIGEST_FROM_PREVIEW
```

Apply recomputes the plan and verifies both directory identities and both input
fingerprints, again immediately before target replacement. Fingerprints include
content hash, device/inode, mode, uid, size and modification time. A stale plan is
refused. A no-change preview/apply returns no backup and creates no state. An old
successful digest is not reusable; obtain a fresh preview. The source is unchanged.

Apply does **not** switch a reader. After reviewing the result, explicitly select
its `settingsEnvironment.CODEX_HUD_SETTINGS_PATH` when launching the desired HUD,
for example:

```sh
CODEX_HUD_SETTINGS_PATH=/absolute/private/new-source/hud-settings.json hud panel
```

The path override selects presentation settings, not a source identity or provider
credential. Existing `CODEX_HOME` and all other launch settings retain their
existing meanings. A target's unrelated API configuration is also preserved, so
review the target's existing model/outbound settings before launching it.

To undo the target edit, use the exact private backup path returned by preview
and apply:

```sh
hud migrate restore --target /absolute/private/new-source \
  --backup /absolute/private/new-source/.hud-migrate-DIGEST.backup.json
```

Restore verifies the original target directory/path and the installed fingerprint,
then restores the original bytes and private mode, or removes the file if it did
not exist before apply. It refuses intervening content, identity, permission or
mtime changes rather than overwriting them. Repeated restore is a conflict, not a
second write. The backup is retained for inspection/recovery. The backup contains
exact original **target** bytes and may therefore contain that target's existing
secrets. Keep it private; do not upload or attach it to reports. Source secrets
never enter the backup. No authorization is imported from the source on restore.

## Concurrency, interruptions and recovery

Stop other settings writers while applying/restoring. The tool uses a private
exclusive lock, bounded nonblocking no-follow reads, inode-pinned Linux directory
handles, exclusive temporary/backup files and same-directory atomic rename.
Private recovery data is fsynced before replacing the target; the target directory
is fsynced afterward. Preview includes the recovery path even if output is lost.
The lock serializes this tool, not arbitrary external editors: there remains a
small check-to-rename race with a noncooperating same-uid writer. This is not an
adversarial same-uid transaction primitive or proof against timestamp forgery.

- `migration_input_changed`: nothing is intentionally overwritten. Inspect current
  files and obtain a new preview; do not substitute the old digest.
- `migration_restore_conflict`: keep the current file and backup. Reconcile the
  user's intervening edits manually; restore does not offer `--force`.
- `migration_recovery_exists`: a prior attempt left the digest's backup or temporary
  file. Do not remove it blindly or retry writes. Inspect it with all writers stopped.
- `migration_busy`: another invocation or an interrupted invocation owns the lock.
  There is no automatic stale-lock deletion. Confirm no migration is running before
  manually removing only that lock in the selected private directory.
- `migration_io_or_output_failure`, other I/O failure or interruption: the target is either the old file or the
  atomically installed file. A stdout failure can happen after a successful write;
  it does not mean nothing happened. Inspect the preview's backup and target. After resolving a stale lock, guarded restore succeeds
  only for the matching installed fingerprint. If replacement did not occur, the
  original remains in place and restore conservatively refuses. Keep recovery data.
- A crash during restore may leave the exact original target restored while the
  backup/temporary/lock remains. A repeated restore then refuses. Inspect before
  cleanup; do not treat refusal as lost data.

A restored source/target directory cannot be substituted by a same-name different
inode. Moving directories requires manual recovery; the command does not chase
backup-record paths to other locations. The on-disk backup is a local rollback
payload, not a transferable configuration or authorization document.

## Cloud checks

Synthetic fixtures use temporary HOME/source/target directories only. Build and run:

```sh
npm run build
npm run build:test
node --test dist-test/tests/unit/migration.test.js \
  dist-test/tests/unit/product-cli-routing.test.js \
  dist-test/tests/unit/settings.test.js \
  dist-test/tests/unit/hud-link-export.test.js
```

Tests cover read-only default/help/preview, exact byte/mode and absent-file restore,
stale source/target digests, repeat operations, private files, symlinks, hardlinks,
FIFOs, oversize/invalid input, injected rename failure, directory substitution,
source-secret/grant exclusion, unrelated target preservation and CLI routing.
These are local cloud-computer functional checks, not hosted CI, live-client
validation, performance qualification or an authorized switch of user settings.
