# E1 panel logs and guarded Open

This slice completes the original panel actions, not the experimental chat UI.
The production `tree-page` wires the monitor's selected managed-run actions to an
in-panel log viewer and an optional fixed-run Herdr focus adapter. It does not
launch a pager, send input, start or resume a provider, install anything, or alter
capability qualifications.

## Logs

For a selected headless managed run, press `L` or click **Log**. The viewer reads
one 16 KiB page from that run's private stdout or stderr artifact. Terminal and
bidirectional controls are escaped, never executed. `Tab` changes stream, arrows
scroll or change page, `r` refreshes, and `Esc` closes. Reads happen on input, not
paint. A different root, selection, ledger, run, source or binding generation
closes the old view. Replaced/symlinked artifacts and mismatched metadata refuse.
Each stream's device/inode is pinned on its first successful read for that view;
Same-inode append or truncation is displayed as current file contents, but
replacement or disappearance then refuses. The viewer does not prove historical
byte integrity; truncation beyond the current offset displays an empty page.
Both Logs and Open cap `meta.json` at 64 KiB before allocation/JSON decoding,
including a bounded growth check during the read. Oversized metadata refuses;
this UI limit does not change artifact writer or recovery semantics.
The panel's mouse-disabled setting remains effective inside the viewer.

## Open

For a selected visible managed run, **Open** becomes available only after the
recorded exact Herdr server/workspace/tab/pane, process identities, ledger, latest
run, binding and private artifacts agree. The existing pinned Herdr 0.9.5 / protocol
22 client validates the host surface. Environment hints alone are not evidence.
The display snapshot expires after three seconds, including a backward clock.
Each click revalidates and may still refuse if anything changed.

SQLite checks use one owned, read-only worker per composition, not the paint
thread. One transaction reads the exact latest run, current binding and supervisor
registration plus a conservative full-SessionRef conflict check. It reads no
report bodies, slot history or general event payload history. Text is clamped in
SQLite and oversized values refuse before JSON decoding. Each request has a
500 ms implementation timeout and the composition has a three-second deadline;
these are not hard operating-system deadlines or performance qualification.
Cleanup awaits worker termination before allowing another selected-row check.
A delayed native SQLite operation can delay that cleanup, so no replacement is
spawned while it remains pending. Private mode, ownership, inode and single-link
identity are rechecked through use. Only the explicit `pane focus` action mutates
the host, and it remains in the parent after final target and process checks.

## Cloud verification

From a Linux Node 22.13+ or Node 24 checkout:

```sh
npm run build
npm run build:test
# Use a temporary HOME/HUD_HOME; unset NO_COLOR for the existing color assertion.
env -u NO_COLOR HOME=/your/private/temp/home HUD_HOME=/your/private/temp/home/.hud \
  node --test dist-test/tests/unit/panel-open-logs.test.js \
  dist-test/tests/unit/tpd1-dispatch.test.js \
  dist-test/tests/unit/b10b-s3-actions.test.js \
  dist-test/tests/unit/b10b-s3-selection.test.js \
  dist-test/tests/unit/b10b-s3-width.test.js \
  dist-test/tests/unit/b7-herdr.test.js \
  dist-test/tests/unit/b45-handshake.test.js
node scripts/demo-panel-open-logs.mjs
```

The demo composes the real renderer, action dispatcher and viewer with synthetic
metadata and private test files. Tests additionally exercise real temporary SQLite
and a fake pinned Herdr transport, including restart, version drift, stale
selection, binding revocation, conflict, timeout, late result, changed privacy and
changed file identity. They do not certify a real Herdr installation or a logged-in
provider. Actual user-machine/host validation remains NOT_RUN.
