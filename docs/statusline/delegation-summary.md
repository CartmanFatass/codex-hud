# Bounded read-only delegation statusline

The product entries `node bin/hud-statusline` and `node bin/hud statusline` keep
stdin model/context/estimated-cost facts on line one. With an explicit Claude
source and an existing private ledger, they may add line two:

```text
Stdin model · ctx 42% · $0.12
⧉ partial · ▸ ⌬ Synthetic review 1s
```

Run against an already registered source with either `--source /absolute/claude-root`
or an explicit `CLAUDE_CONFIG_DIR`. A bare session ID, stdin transcript path or
guessed default Claude directory never selects a source. `HUD_HOME` selects the
ledger location, otherwise explicit `HOME/.hud` is used. Rendering does not create
missing directories, register sources, collect transcripts, inspect processes,
call providers, install hooks or change settings. The standalone
`hud-statusline-preview` remains stdin-only.

## What the second line means

The reader first tries the **versioned shared committed summary** described below,
then the existing **direct-parent index fallback**. Both are deliberately partial,
not a persisted full-tree summary. The line always says `partial`. The fallback uses one
`links_parent` candidate page of at most 50 rows, capped **before** filtering old
owners. It joins only each candidate's latest run/current binding and latest link
event sequence. Descendants are not traversed. Historical rows consume the page:
a long history can hide later children, which is reported as `partial (limit)`.
Reaching exactly 50 candidates says the limit was reached, not that a 51st exists.
Folded `+N` glyph groups count only displayed-page children; no tree total, active
capacity or remaining slot count is invented. Tree counts remain null.

A child projection is read only from its existing committed observation store,
without selecting or decoding recovery bodies. Each projection is at most 32 KiB,
with a 256 KiB aggregate decode allowance. Its source/ref, run, binding generation,
ledger sequence, terminal flag and observation age must agree. Observation age
must be between zero and five seconds. Global `inputLedgerSeq === asOfSeq` is
intentionally conservative: even an unrelated newer ledger event can make a
child display `not loaded` until a fresh projection is committed. This prevents
stale projection facts from being promoted to current state. The returned child
retains its actual observation stamp and coverage; unknown evidence stays null.

Freshness is recalculated at rendering time. Markers and ordering share the panel's
pure marker logic. Human-attention states appear first; ordinary ended runs drop
out, and recent failures can remain visible briefly. Labels are escaped before
width fitting. A missing/unsafe/busy ledger, unknown identity or exceeded budget
falls back to line one; missing child evidence cannot fabricate activity. If no
child needs a row, or the width cannot fit the explicit partial label, only line
one is emitted.

## Shared committed summary

The existing owned observation worker publishes `delegation-summaries-v1` under
its private HUD_HOME after its normal observation publication settles. It uses the
exact refreshed committed view and its original ledger-read time, never a second
collector, transcript scan, model call, recovery read or v2 snapshot overwrite.
Files are keyed by the full harness/source/session/thread tuple. Each whole
version-1 envelope is atomically renamed into place with private permissions.
The ledger file identity is pinned before collection and checked at publication
and consumption, so a replaced ledger cannot lend its identity to an older view.

The envelope carries ledger ID/sequence, original child observation stamps,
explicit direct-child partial coverage, at most 50 candidates per parent, and
null tree counts. Derivation is additionally capped at 50 parents and 2,500
relations from the already bounded view. Payloads over 256 KiB are not published.
No task/report/transcript bodies, credentials, recovery state or control authority
are copied. Publication failure leaves readers' fallback available.

The cache expires no later than five seconds after the original successful ledger
read. Each child also keeps its original observation time and independently
expires after five seconds. Rewriting a cache cannot freshen old evidence.
Current run, binding generation, source/ref, lifecycle and conflicts must agree;
a child's older ledger stamp remains usable across unrelated sibling events.
Future ledger stamps, conflicts, incompatible generations and old evidence have
no current status, while healthy siblings retain their facts. Conflict markers
use the same renderer as the panel. This is a derived local display cache, not a
new observation commit or an external export contract. Concurrent panels may
replace a file with an older still-valid snapshot; the original expiry is not
extended. Readers are not live lifecycle authority or a linearizable status API.

The cache hit reads only the selected bounded file and private metadata, with no
SQLite import/query or observation/recovery body reads. Read/open races fail soft;
opens are nonblocking and refuse symlinks. Readers never create the directory or
modify a file. Pi's shipped opt-in footer consumes the same schema with explicit
source configuration and native current session checks, outside its render path.
See [Pi footer](../cloud/pi-footer.md).

## Budget and validation boundary

The 20 ms cooperative reader budget covers identity resolution, private-path
checks, cache open/read/strict schema decode/close, and, on a miss, SQLite
capability verification/open, query, bounded projection decode and connection close. Both ledger and this projection consumer use zero lock wait.
Synchronous OS/SQLite operations cannot be preempted: any observed overrun returns
`unavailable/budget_exceeded` with its complete elapsed time. A deadline check is
not a hard-real-time guarantee, and this functional slice does not qualify the
historical 1000-sample statusline performance gate or live Claude compatibility.

Focused tests use synthetic ledgers and temporary HOME/source directories. They
exercise both actual product CLIs, stdin priority, source/thread isolation,
read-only persistent contents, invalid recovery separation, stale/future/oversized
projections, sequence/binding invalidation, bounded candidate history, private
paths, cleanup/budget failure and terminal-safe width fitting. Existing settings,
stdin preview, product routing, observation-store and marker tests are regressions.
No real user settings are installed or modified by this delivery.

The focused `delegation-summary.test` uses the actual owned worker and actual
`hud-statusline` CLI/shipped Pi extension with synthetic temporary ledgers. It also
covers sibling-event preservation, run/generation conflicts, partial limits,
expiry, schema rejection, unsafe paths and an interrupted atomic replacement.
This delivery does not qualify full-tree D3 coverage, a live Pi/Claude installation,
or the historical performance gates.
