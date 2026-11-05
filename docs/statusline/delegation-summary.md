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

This slice implements the contract-06 **direct-parent index fallback**, not a
persisted full-tree summary. The line always says `partial`. The reader uses one
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

## Budget and validation boundary

The 20 ms cooperative reader budget covers identity resolution, private-path
checks, SQLite capability verification/open, query, bounded projection decode and
connection close. Both ledger and this projection consumer use zero lock wait.
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
