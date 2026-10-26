# Herdr context and status across tmux and the Codex daemon

Verified locally on 2026-10-17 with Codex 0.163.0. The outer Herdr shell
and `codexH2` launcher had the correct `HERDR_*` values. The first shell
inside the reused tmux server inherited a different, older pane identity;
commands executed by the shared Codex daemon had no Herdr context at all.
`shell_environment_policy.inherit = "all"` cannot supply values missing
from that daemon's environment.

`bin/codex-hud` now passes the caller's Herdr context through session-scoped
`tmux new-session -e` arguments before starting the first shell. Missing
values are explicitly empty, because removing a session entry can expose
the stale global tmux value again. No global tmux variables are changed.

`bin/codex-with-herdr-context` then forwards that client's context as
individual `-c shell_environment_policy.set.HERDR_…` options. They apply to
commands executed by Codex even when the shared backend was started from
another terminal. The helper uses argv and JSON/TOML string quoting; values
are never executable shell text. Existing policy settings and user-supplied
arguments are preserved. Outside Herdr, empty context values make the usual
preflight reject Herdr control instead of inheriting another client's identity.

On this machine, the `codex`, `codex1`, and `codex2` functions in `~/.zshrc`
also call the helper, retaining their existing account selections. `codexH`,
`codexH1`, and `codexH2` receive the fix through the HUD launcher. The original
shell configuration was backed up under `~/.local/state/codex-herdr-fix/`.

New HUD launches pick up the fix immediately. New interactive shells load
the updated direct CLI functions. Existing Codex threads must be restarted
or resumed through the fixed launcher to receive the per-client settings;
no running backend, user session, or unrelated terminal was restarted.
No pane IDs were written to global Codex configuration. The helper needs
the Python 3 interpreter already installed on this machine.

## Sidebar status: native Herdr detection across tmux

Context propagation and agent detection are separate problems. The outer pane
runs a tmux client. Herdr cannot identify the inner Codex process from that
client alone. The launcher now sets `HERDR_AGENT=codex` **only on the outer
`tmux attach-session` process**, using Herdr's supported host-visible wrapper
hint. The native Codex SessionStart hook continues reporting its original
`herdr:codex` session reference for session restore.

The launcher also sets two **session-scoped** tmux options: `set-titles on`,
and a `set-titles-string` pane loop that selects only the stored main pane ID.
This relays Codex's real OSC title to Herdr even when the side panel has focus.
Herdr then uses its native Codex title/screen detection and notification rules.
No global tmux title/environment option, installed integration, or detection
manifest is changed. The title is normal terminal UI; diagnostic files do not
store title or screen content. `CODEX_HUD_HERDR_BRIDGE=0` disables the launcher
integration. Deferred session creation alone starts no companion or attach hint.

The title relay matters for the full side-panel layout. A native screen rule
can recognize a normal full-width Working footer, but the side panel adds
columns to that line. The Codex spinner/blocked/idle title remains usable
independently of those columns and of which inner pane has focus.

### Why the original custom reporter missed production completion

The original companion sent `pane.report_agent` with source
`codex-hud:codex`. A simulated Codex process without its real SessionStart hook
passed those tests. Real Codex first reports a native session through
`pane.report_agent_session` with source `herdr:codex`. In Herdr 0.9.5 that native
session owner conflicts with later lifecycle reports from the custom source.
The API can return `Ok` while ignoring the state change, so an acknowledged
request did not prove that idle or completion had applied.

The source evidence is Herdr 0.9.5
[`set_hook_authority_at` and `current_session_owner_conflicts`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs),
plus [`handle_pane_report_agent` and its successful response](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/panes.rs).
Sequence numbers are tracked separately per source; the official hook's
nanosecond sequence and the old bridge's microsecond sequence were **not**
the cause. Changing the sequence scale does not resolve owner conflict.

A custom Working report applied **before** native SessionStart can also remain
as old lifecycle authority and override later native screen/title detection.
Replacing the outer attach client alone does not clear that authority. A
controlled migration must first stop the verified old reporter, then release
**only** `codex-hud:codex` with `pane.release_agent`. In this exact case Herdr's
`preserve_foreign_persisted_session` guard keeps the native `herdr:codex`
session reference. Re-read that reference before and after migration.
`pane.clear_agent_authority` clears the persisted session, and releasing the
native source can clear it as well; neither is part of this migration.
The launcher does not automatically modify pre-existing source authority.
Recovery can pass through unknown and does not certify or replay the old
completion toast. A later natural completion remains a separate acceptance item.

### Read-only health companion

`bin/codex-hud-herdr.mjs` now runs in `native` mode for each outer attach.
It reads only the stored main pane and calls `pane.get` for that client's
`HERDR_PANE_ID`. It sends **no lifecycle report, release or clear request**,
including when it stops. Native detection and notifications continue if this
observer temporarily fails. A connected socket alone does not establish that
native state agrees with the main pane: the companion explicitly compares them.

The exact main pane is polled every 750 ms. Each tmux probe and socket request
has a 450 ms deadline; work is single-flight, including shutdown. An uncertain
probe failure preserves the last confirmed observation for up to 3 seconds
from the first failure. Continued failure classifies the target unknown;
a missing pane/server, dead pane, non-Codex foreground process or mismatched
session classifies it unknown immediately. No alternate pane is searched.
These observations are diagnostics; they do not overwrite Herdr's native state.

Connection recovery only reads the latest native state. It keeps no transition
replay queue and does not manufacture working/idle edges. A sticky notification
gap says the observer cannot certify history; a readback outage does not itself
prove the native client missed a toast. Native completion may continue normally
while new API connections are unavailable.

Each attach writes `$CODEX_HOME/hud/herdr/<session>/<bridgePid>.json`, with the
launcher's resolved account-specific home. Session names use
`session.replace(/[^A-Za-z0-9._-]/g, '_')`. Files are atomically replaced, mode
0600, in 0700 bridge/session directories. Separate attaches have separate files
and outer pane identities. Stopped records remain available with
`lifecycle: stopped`. The version 1 schema contains:

| Field | Meaning |
|---|---|
| `schemaVersion`, `mode` | `1`; launcher mode is `native` (`report` is retained only for legacy protocol regression) |
| `session`, `mainPaneId`, `parentPid`, `bridgePid`, `herdrPaneId` | Exact inner session/target, attach/observer processes and outer identity |
| `startedAtMs`, `updatedAtMs` | Unix milliseconds; every poll updates health even when state is unchanged |
| `lifecycle` | `running` or `stopped` |
| `observedState` | Last classified inner main-pane state |
| `nativeState` | Actual `pane.get` state: idle, working, blocked, done or unknown; null when unavailable |
| `publishedState` | In native mode, latest native state with done mapped to idle for schema compatibility; no write is implied |
| `stateMatches` | Whether main-pane observation agrees with native readback; null when readback is unavailable |
| `probe.status` | `ok`, `retrying`, `unavailable`, or `mismatch` when readable metadata disagrees with native state |
| `probe.consecutiveFailures`, `probe.lastSuccessAtMs` | Probe failure count and last successful metadata read; timestamp may be null |
| `transport.status` | `pending`, `connected` or `disconnected`; connected means readback succeeded, not notification delivery |
| `transport.consecutiveFailures`, `transport.lastSuccessAtMs` | Readback failure count and last successful readback; timestamp may be null |
| `notificationGap` | Sticky true after readback uncertainty or prolonged probe failure; historical toast delivery is unverified |
| `healthWriteError` | In-memory diagnostic writer failure; successful later writing clears it |

Files contain no task/title text, screen contents, socket path or credentials.
Consumers should ignore stopped records, match the current outer pane when
available, and mark running records older than 20 seconds unresponsive. A stale
or unreadable sidecar is a diagnostic gap. Stopping one observer does not
release another attach or alter native session restore information.

Validation:

```sh
node --test tests/unit/herdr-bridge.mjs
bash tests/integration/test-wrapper-herdr-bridge.sh
bash tests/integration/test-wrapper-herdr-context.sh
bash tests/integration/test-wrapper-main-pane-env.sh
bash tests/integration/test-wrapper-codex-home.sh
bash -n bin/codex-hud tests/integration/test-wrapper-herdr-bridge.sh
```

The mock socket/real tmux regression covers independent concurrent attaches,
read-only request shape, short probe failures, connection recovery, private
health, detach cleanup, opt-out, and unchanged global tmux identity. Legacy
report-mode unit tests retain protocol, cancellation, bounded peer, heartbeat
and transition-order coverage; they are not proof of native notification delivery.

## Completion notifications

Herdr projects unseen native working-to-idle completion as `done`; its client
then decides whether to display a notification. In Herdr 0.9.5 popup delivery
defaults to `off`, independently of sidebar state. Enable in-app notifications
in Herdr's own configuration and reload it:

```toml
[ui.toast]
delivery = "herdr"
delay_seconds = 1
```

Notifications are for background tabs. Viewing the completed tab acknowledges
completion; a status API read does not acknowledge it. The HUD does not send a
second custom toast outside Herdr's focus and completion rules.

The opt-in regression starts a separate real Herdr 0.9.5 server/TUI client,
with temporary HOME/config/state and a private tmux socket. It runs the actual
HUD wrapper with a synthetic Codex that sends native SessionStart with a
nanosecond sequence, writes real standard Working/idle/blocked footer content
and OSC titles to its PTY, and keeps the workspace in the background. It covers
compact and full side-panel layouts, side-pane focus with a conflicting title,
working-to-done and finished toast, rapid working/idle/working restart without
an obsolete completion toast, attention toast, repeated readbacks preserving
done, short observer probe failure, API socket loss/recovery, and observer exit
preserving native state/session. It also reproduces old custom authority and
verifies the narrowly scoped release preserves the original native reference.

```sh
CODEX_HUD_TEST_REAL_HERDR=1 bash tests/integration/test-herdr-completion-notification.sh
```

These are controlled synthetic turns through the real notification path. They
do not verify a real model's natural completion, desktop notifications, audio,
full Herdr server restart, or historical notifications during migration. Native
Windows was not tested. Per-client command environment overrides still require
a new/resumed Codex invocation; replacing an outer tmux client alone cannot
rewrite the environment of a running Codex process.

## Production acceptance boundary (2026-10-24)

On 2026-10-24 the controlled Jinjian outer-client migration preserved the
main Codex process and native session reference, removed only the verified old
custom reporter's authority, and recovered an actual native idle readback.
The read-only observer then reported matching idle with successful probes and
readback. This establishes that the stuck working state was released; it does
not establish delivery of the earlier completion toast. The transition passed
through an unknown gap, so historical toast delivery remains unverified.

The Learn-to-Write outer pane was no longer present, while its inner Codex
process was preserved. The cause of the outer pane disappearing was not verified. No subsequent real model turn and natural
completion in that outer pane has been observed. Controlled synthetic turns in
both layouts validate the repaired notification path, but do not replace that
remaining real-turn acceptance item.

### Isolated natural completion acceptance (2026-10-25)

New isolated sessions using real Codex 0.164.0 and Herdr 0.9.5 now establish
natural completion in both compact and panel layouts: native `working → done`,
a Herdr completion toast, and matching observer readback. The panel test kept
focus on the HUD pane and retained actual `task_started` / `task_complete`
record coordinates. It used a synthetic prompt and a private configuration,
not either existing production conversation. A compact-to-panel attempt left
the second prompt unsubmitted and is explicitly not counted as passing.
See the [acceptance report](./acceptance-20261025.md) and its machine-readable
receipt for evidence and the remaining desktop/audio/restart boundaries.

## Compatibility with already attached launchers

An attach started before native health reporting may have no diagnostic
sidecar and may still run the old custom lifecycle reporter. Missing health
files alone are not evidence of a disconnected bridge; source authority and
actual native readback must be checked separately. They are explained in the diagnostic
Inspector, rather than displayed as a persistent failure banner. A new HUD
launch enables the full health-reporting companion; a running Codex process does
not need to be interrupted just to remove the compatibility message.

F12 bindings pass a tmux session ID (`$N`) to the toggle helper. The replacement
panel now receives the resolved session **name**, matching the original launch,
bridge-health directory and snapshot filenames. Regression:

```sh
bash tests/integration/test-herdr-health-toggle.sh
```

This uses an isolated real tmux server, opens a panel by session ID, supplies a
synthetic name-keyed bridge report, and verifies the panel exports connected
health in the matching name-keyed snapshot.
