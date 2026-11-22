# Opt-in Linux runtime bundle and private prefix

This is an application-code and locked Node-dependency bundle, not a bundled Node
binary, npm publication, provider installation, or live-provider qualification.
Use Linux with Node **22.x >=22.13** or **24.x** already available. Neither building
nor installing grants a capability or changes either production capability matrix.
Both existing matrices and the two Pi TypeScript extension exceptions are retained.

## Build and inspect

From a reviewed checkout, with its build tools available:

```sh
node scripts/pack-runtime.mjs
```

All selected source and dependency bytes use descriptor-based bounded reads:
regular-file/type/size checks precede allocation, with inode/metadata/content checks
around the read. Catchable builder SIGINT/SIGTERM interrupts the exact still-owned
child group only after PID birth/group validation, observes exit/close within a
separate cleanup deadline, and writes a failure receipt. Loss of ownership or
unconfirmed cleanup remains explicit uncertainty, never permission to retry.

The builder creates a new ignored `tmp/cloud-development/runtime-*` directory. It
prints a `runtime-build.json` receipt containing the unpacked `runtime` directory,
`.tgz` archive, exact manifest digest and per-command evidence. Each command receipt
records argv, cwd, timestamps, deadline, owned PID, exit/close state and result.
The archive is transport only: the installer never accepts or extracts an archive.
Extract it yourself into a trusted private location before inspecting/running it.

Selection shares the preview's exact tracked-source/fresh-TypeScript-output mapping.
It does not recursively copy working `dist` or `node_modules`. An additional fixed
legacy helper closure is audited in `scripts/runtime-package/manifest.mjs`. The
existing preview CLI, exclusions and inspection-only semantics remain unchanged.

Production dependencies are exactly lockfile `@iarna/toml@2.2.5`,
`chokidar@5.0.0`, and `readdirp@5.0.0`, including their distributed package files and
licenses. They are materialized in a separate temporary directory using
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, a fresh private cache,
empty user/global npm configs, and a credential-free environment. Package scripts
are not run. Registry/cache failure fails the build; it is never permission to
omit dependencies or copy an unverifiable working dependency tree.

`RUNTIME-MANIFEST.json` schema 1 records:

- `repositorySha` and `repositoryTree`: full 40-hex HEAD commit and tree identities.
- `dirty`: whether tracked/staged/untracked source differs from that commit.
- `sourceContentSha256`: a content snapshot of the selected source/build inputs.
- `lockfileSha256`, `platform`, `nodeRequirement`, `builtWithNode`, `dependencies`.
- `provenance` and `capabilityLimitation`: explicit scope and limitations.
- `entries`: every payload file except the manifest itself, with relative `path`,
  byte length `bytes`, SHA-256 `sha256`, four-digit octal `mode` (`0600` or `0700`),
  and `origin` (tracked source, generated package metadata, or locked package).

The root and entry field sets above are closed: unknown fields, malformed metadata,
NUL, unpaired Unicode surrogates and invalid UTF-8 are rejected. Entry `origin` is
optional, and an optional entry `provenance` string is also accepted as inert text.
`platform`, `nodeRequirement`, `sourceContentSha256`, `builtWithNode`, `dependencies`,
`provenance` and `capabilityLimitation` are the only optional root fields; the builder
emits all of them. The six other listed root fields are required. Metadata never
chooses code, paths or capabilities. Annotation strings have individual bounds and
a combined 256KiB budget. The manifest is at most 2MiB, with at most 5,000 payload
files, at most 2MiB each, and at most 50MiB of payload bytes (manifest excluded).

The full manifest byte SHA-256 is the immutable release directory key. This is
integrity and provenance, **not a publisher signature**. A malicious bundle can
replace its own manifest and installer. Obtain and review a trusted source first.
Dirty bundles remain visibly dirty; packaging is not production runtime evidence.
The manifest excludes install-time shims, selector and recovery receipts outside
the payload. No timestamp or absolute path is part of the manifest's content identity.

## Preview and explicitly apply

Supply an **existing, canonical absolute directory**, owned by the current user,
with no group/other permissions (normally mode `0700`). There is no default prefix.
No symlink component, missing directory, shared prefix or foreign file is accepted.
Use a dedicated prefix; this is not a merger into an existing general-purpose `bin`.
The installer accepts only its own adjacent unpacked manifested bundle.

```sh
node /trusted/bundle/install-runtime.mjs preview --prefix '/private/hud runtime'
node /trusted/bundle/install-runtime.mjs apply --prefix '/private/hud runtime' --expect PLAN_DIGEST
```

Copy `planDigest` from the preview. Default/help/preview only read and print; they
write nothing and launch no process. Apply also uses only Node builtins and does
not launch npm, a build, network access or a provider. It does not initialize
`HUD_HOME`, edit PATH/shell rc/provider configuration, register MCP, or activate a
statusline. Invoke `/private/hud runtime/bin/hud --help` explicitly afterward.

The plan binds bundle content, prefix/ancestor directory identities, current
selector, shim bytes and identities, release inventory and receipts. Any mismatch
requires a fresh preview. Symlinks, hard links, devices, nonregular files, unlisted
entries/directories, duplicate/traversing paths, malformed hashes/sizes, partial
stages and existing locks are refused. Reads, payload copies, file counts and
release/receipt counts have finite bounds. Releases are never overwritten.

Layout:

```text
PREFIX/bin/{hud,hud-run,hud-statusline,codex-hud,hud-mcp}
PREFIX/bin/package.json             # exact {"type":"module"} plus newline, 0600
PREFIX/releases/FULL_MANIFEST_SHA256/...
PREFIX/current
PREFIX/receipts/TRANSACTION_UUID.json
PREFIX/install-lock/                 # exists only during an operation or after failure
```

Directories and shims are `0700`; data/receipt/selector files are `0600` and
executable payload entries `0700`. A single atomic regular-file selector switch
activates an already verified release. The installer pins Linux directory handles,
uses no-follow opens and rechecks canonical identities before writes and selection.
It is designed for a private user-owned prefix and cooperating installers. It is
not an isolation boundary against a malicious process already running as the same
user or a privileged process changing the filesystem concurrently.

The selector uses schema 2 with exactly `schemaVersion`, `manifestDigest` and
`generation`. The generation is the transaction's fresh UUID v4, stored in the
same atomic selector file as the release digest. Schema-2 receipts bind their
transaction to that exact `after` generation. The generation participates in
preview, under-lock comparison, restore validation and final pre-switch checks;
launchers validate its format before dispatch. Inode identity remains an additional
replacement check, not evidence that a transaction generation has never been used.
The earlier rejected, unpublished schema-1 selector/receipt layouts are refused
without mutation. There is no automatic migration, cleanup or deletion of their
receipts, releases or other recovery evidence.

The six owned launch artifacts are the five command shims plus an exact 18-byte
`bin/package.json` containing `{"type":"module"}` followed by a newline, mode `0600`.
The marker is exclusively created and fsynced before command files. Its bytes and
identity participate in preview, receipts, under-lock validation, final pre-switch
checks and restore, just like the shims. Missing or foreign metadata in an existing
installation is refused, never repaired; pre-marker layouts are not migrated.
It remains present after initially absent restore and A→B→A rollback.

The four Node command shims use a syntax-neutral bootstrap with synchronous
`process.getBuiltinModule` access, so selection can refuse incorrect CommonJS
metadata as well as missing metadata. The exact marker defines their package scope
even beneath a CommonJS ancestor. Before selection they validate the private owned nonsymlink `bin`
directory and the marker using a bounded no-follow, single-link regular-file read
with exact mode, bytes and stable identity. Malformed package metadata can instead
be rejected by Node before entrypoint evaluation. Neither case launches a payload.
After selection, the fixed wrapper is dispatched once through Node's public
`process.getBuiltinModule('module').runMain(entry)` outside the selector error
handler. Node's native entrypoint lifecycle owns wrapper evaluation, preserving
unresolved-TLA exit 13 and native payload errors rather than translating them to
selector error 5. Dispatch stays in the same process,
setting `process.argv[1]` to the payload entry without changing user arguments. PID,
direct PPID, stdin/stdout/stderr, inherited descriptors, signals and exit status are
preserved; no Node proxy becomes MCP's parent. The legacy Bash shim uses a bounded,
short-lived Node selector and then `exec /bin/bash` on the fixed selected wrapper.
Its NUL-framed selection preserves spaces, quotes and newlines. One monotonic five-second deadline covers selector startup, the NUL frame,
terminal-state observation and actual successful wait. Interruption or failure
never launches the payload. Identity-bound cancellation has a separate two-second
cleanup deadline, finite poll counts and fixed `/usr/bin/sleep 0.02` polling. It
reports actual wait/reap evidence or `cleanup=UNKNOWN` with the owned PID/birth
identity; uninterruptible kernel I/O is not claimed to be recoverable. This changes no native identity/capability authorization requirement.

Same-package reinstall with a fresh plan reports `NO_OP` and changes nothing.
Replaying an old pre-install plan fails, even if its intended package is now active.
A mutating plan reserves capacity before any write: at most 64 releases and 1,024
receipts. Same-package no-op remains available at capacity; restore needs a receipt
slot but no new release slot.
Upgrades retain old releases. Installed modern commands need no checkout, compiler,
npm, or package registry. Source bundles and older payloads are not modified.

## Restore preview and exact prior selection

Save the successful apply's absolute receipt path. Preview a restore, then apply
that specific restore plan:

```sh
node /trusted/bundle/install-runtime.mjs preview --prefix '/private/hud runtime' --restore-receipt '/private/hud runtime/receipts/UUID.json'
node /trusted/bundle/install-runtime.mjs restore --prefix '/private/hud runtime' --receipt '/private/hud runtime/receipts/UUID.json' --expect PLAN_DIGEST
```

Restore requires the same prefix and unchanged installed selector generation,
inode/bytes and owned shims. It switches back to the exact previous release under
a fresh transaction generation, or **removes the
selector** if selection was initially absent. In that fresh-install case the result
is explicitly `INACTIVE`; retained shims refuse with `runtime_installation_inactive`
instead of redirecting elsewhere. Neither release is deleted. A→B→A is a selector
rollback, not a rebuild or mutation of A. It does not restore A's old generation,
even if the filesystem reuses A's old selector inode. The initial A receipt and
the consumed B receipt therefore remain stale. A restore receipt is not an apply
receipt and cannot authorize redo. Restore itself produces a separate recovery record; automatic
redo/recovery is intentionally not supplied.

## Failures and uncertainty

The exclusive `install-lock` is never removed automatically after a failed write,
crash, timeout, stale under-lock plan or exception. There is no force option, stale
lock expiry or automatic retry. Before selector change a private recovery receipt
is fully written and fsynced, including exact prior/next bytes, prefix binding,
shims, next selector identity and the new generation when the target is active.
Restoring initial absence still creates a fresh transaction receipt with `after:null`;
any later apply allocates a new active generation. Files and containing directories are fsynced.
The immutable receipt says to inspect current selection: exact `after` means the
selection took effect; exact `before` means it did not. Any other state is uncertain.
A fault after switching can leave an active new release and retained lock. Stop,
inspect the reported receipt and filesystem, and preserve evidence. Do not blindly
repeat apply, delete the lock, overwrite stages or try to resume an uncertain copy.
Failures before receipt preparation explicitly report `not_yet_written` and leave
the owned lock/stage for inspection. Successful selection returns its receipt path. Terminal result output happens while
the inspection lock is still held. An output failure such as ENOSPC reports
`terminal_output_failed` and the receipt to stderr, retaining the lock even if
selection already changed. If removal of the lock succeeds but the following
parent-directory fsync fails, the installer attempts to restore only an inspection
barrier (never the selection), reports `finalization_uncertain`, and reports whether
the barrier is present, restored, absent or unknown. Do not infer lock presence from
an error alone, and do not replay an operation after uncertain finalization.

## Command prerequisites and verification limits

- `hud --help`, `hud statusline`, `hud-statusline`, `hud pi inspect`, `hud run --help`,
  `hud migrate --help`, and `hud-run --help` use Node and bundled application/dependency
  files. Statusline consumes JSON stdin; Pi inspect reads an explicitly supplied
  session. Actual data access remains subject to existing product contracts.
- `hud-mcp` includes its Node module/dependency closure. Starting it still requires
  an explicitly configured private owned `HUD_HOME` and its existing authorization
  and capability contracts. An expected refusal on a synthetic empty fixture proves
  startup closure only, not successful delegation or registration.
- `codex-hud` (also `hud codex`) remains the original legacy wrapper. Its external
  prerequisites include bash, tmux, Codex, Python 3 (the tracked
  `codex-with-herdr-context` helper), and common Unix tools. Existing legacy behavior
  is unchanged. Help/static dependency closure does not prove live wrapper success,
  quoting in every tmux flow, a signed-in provider, or supported native platforms.

Tests use synthetic private temporary roots, no real provider homes/configuration,
no user-host installation and no live providers. The focused gates are the two new
MJS suites, root/build-test/MCP builds, product CLI/statusline/migration regressions,
unchanged preview self-test/build, a clean runtime install/restore smoke on available
Node 22/24, helper syntax, scoped formatting, fixture hygiene and `git diff --check`.
Unavailable runtimes, registry access and live-provider checks are explicitly
`NOT_RUN` or blocked, never inferred passing. Final review and integration registration
are separate coordinator-owned steps.
