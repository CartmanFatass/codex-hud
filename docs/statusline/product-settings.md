# Product stdin statusline and explicit reversible settings

`node bin/hud-statusline` renders the existing bounded stdin implementation as a
product entrypoint: model, native context percentage and reported session estimated
USD cost. USD is not an invoice. No settings are changed by normal rendering.
The [bounded read-only delegation line](delegation-summary.md) is available when
an explicit registered Claude source and existing ledger are supplied. A full-tree
summary cache and toktrack tee remain separate work; this is not a claim that all
D3/D5/E3 or default migration is finished.

```sh
npm run build
printf '%s' '{"model":{"display_name":"Claude"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":0.12}}' | node bin/hud-statusline
```

Output: `Claude · ctx 42% · $0.12`. The inherited renderer limits input to 64 KiB,
uses a one-second input guard and emits no raw input in diagnostics. `--width` is
supported. No real Claude provider/account is required to develop or test this.

## Optional installation workflow

These commands are **explicit user actions**, not commands the assistant has run
against your actual settings. Linux only (requires /proc/self/fd); macOS/Windows settings installation is not
supported. Existing HOME and HOME/.claude must be real, owned directories that are
not group/world-writable. Rendering itself remains independent of installation.

1. Preview and save the plan, then inspect it:

   ```sh
   node bin/hud-statusline settings preview > /absolute/private/statusline-plan.json
   ```

   Preview reads HOME/.claude/settings.json but changes nothing. If the settings
   file is absent, it proposes creating it. The plan contains target, current hash,
   proposed hash and the shell-quoted absolute Node/entrypoint command. It contains
   no other settings values. Keep the plan in a private location and review the
   command before applying; a user-edited plan is not cryptographically signed.

2. Apply exactly that plan when ready:

   ```sh
   node bin/hud-statusline settings apply --plan /absolute/private/statusline-plan.json
   ```

   Only `statusLine` is replaced with `{type:"command",command:...}`. Other JSON
   fields retain their values; the installed JSON formatting is normalized.
   Current content must match the preview hash. Apply returns a private backup
   path; save it. The backup stores exact original bytes/mode and installed hash.
   Existing file mode is preserved; new settings and backups use mode 0600.

3. Restore explicitly, using the returned absolute backup path:

   ```sh
   node bin/hud-statusline settings restore --backup /absolute/HOME/.claude/settings.json.hud-statusline-backup-ID.json
   ```

   Current settings must still match the installed hash. Restore returns original
   bytes and mode exactly, or removes the newly created file if none existed.
   Backups remain for manual inspection/recovery. If any settings changed after
   install, restore refuses rather than discarding those changes.

The command points to this checkout's `bin/hud-statusline` and current Node binary.
Keep them available; moving the checkout requires a new reviewed preview/apply.
No package-wide command registration or default statusline replacement occurs.
Claude's [statusline documentation](https://code.claude.com/docs/en/statusline)
defines the stdin payload and command-shaped `statusLine` setting. No live client
compatibility or plugin/configuration-wide installation is claimed here.

## Conflict and failure behavior

Settings/plan/backup reads reject symlinks, non-regular files, foreign owners and
hard links or group/world-writable inputs. Nonblocking open rejects FIFOs before any read. Reads consume at most
the configured limit plus one byte, including if a file grows after stat. Settings
are limited to 1 MiB; backup input permits Base64 overhead.
Apply/restore acquire an exclusive cooperative lock, check the current hash and
use same-directory temporary replacement. An owned directory handle pins all
settings/backup/lock/temp mutations through Linux proc-fd paths; pathname and inode
are rechecked before commit and on return. Directory swaps cannot redirect writes
to a replacement directory. Backups are saved before modification.
Files and directory entries are fsynced. Filesystem/platform errors remain possible.

This is not a filesystem CAS against unrelated writers: another program that
ignores the lock can race between the final hash check and replacement. Close
settings editors while applying/restoring. Stale lock files are not auto-deleted;
inspect the situation before manually removing one. A crash or output error can
leave a completed change or a backup even if no success response was received.
Do not blindly retry; inspect the target and backup first. Failed apply retains
its original backup. This tool does not delete backups or overwrite conflicts.

Tests use temporary HOME exclusively and actual product subprocesses, covering
rendering, read-only preview, apply, exact restore, absent settings, stale plans,
post-install edits, unsafe paths, locks and backup integrity. They never touch
real ~/.claude or change the user's default.
