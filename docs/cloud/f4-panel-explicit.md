# Explicit selected-report digest in the panel

This is a source implementation for a separate test candidate based on
`a1250f07995465b40e29a284a732978894c3e7ee`. It is not a release, an integration
merge, or evidence of rendered/provider qualification.

## Interaction

Select one loaded delegated session with a completed report for its current run.
The control bar offers **Digest** when the selected immutable frame has an
unambiguous candidate. The uppercase **D** key is active only in the focused
monitor and only while that button is drawn. Prefix D sends the named
`delegation-digest` command, does not repeat, and is a no-op with the panel closed.
Lowercase d still opens diagnostics; the unrelated workbench decoder is unchanged.
A narrower control bar may hide Digest; its key then does nothing.

The first activation only plans. A private dialog identifies the exact
harness/session/thread, source, ledger/link/run/report and one-report coverage.
It shows the configured endpoint origin/path, declared account label, model,
language and relative per-source model/outbound configuration hints. Arrow keys
scroll all exact identifiers. No report body, report path, credential or local
home path appears in this dialog. Generation requires a second explicit Enter
or Generate click, and the confirmation can be used only once. Missing scope,
outbound permission, disabled configuration or paused source models cannot send.

The planning/confirmation/running dialog exclusively owns letters, Enter,
paste and pointer events. Escape or Cancel cancels; q/close shuts down the
panel. A request for another overlay dismisses the digest dialog rather than
forwarding its input to the harness. Bytes later in the same input read remain
consumed after dismissal. The existing Pause models action additionally cancels
this request locally; resuming legacy generation never restarts it and never
grants this source permission.

A successful result opens Inspector with keys held locally. It is labelled
**Model summary · one completed report** and shows the model, original
`generatedAt`, cache status and parsed conclusion/basis/caveats. Escape hands
keys back using the existing focus convention. This summary does not certify
correctness or run termination and does not replace report/status/card/log facts.

## Bounds and revocation

There is at most one active controller operation and one in-memory result.
Selection, root, ledger, run, report or another modal invalidates its epoch;
shutdown aborts it. Each settled operation returns its exact snapshot as a completion receipt. The page
applies focus, scroll, keyboard and repaint effects only while that same receipt
is current. A canceled or repeated confirmation returns no receipt, including
a canceled A that settles after a same-report B has completed. Old promises
cannot publish into a newer selection or reset its UI. There
is no automatic generation, request retry, all-node queue, new polling cadence,
saved-note consumer, chat/send UI or new provider layer.

At an existing ordinary collection completion, a retained result is hidden
before one metadata-only revalidation of its original opaque core lifetime.
The shared production page seam owns this hook, early surface routing and the
entire input read. Its revalidation timer includes the hide/restore paints and
metadata work inside the existing outer collection timer; paints alone do no
source revalidation. One successful retained check currently performs three
short metadata transactions (nine observed queries) and four JSON reads, not
one underlying read. Preparation performs six transactions (18 queries) and
eight JSON reads. These are source-path counts until the instrumented tests run.
Only the exact same target, accepted metadata, source configuration, outbound
policy and live selected credential may restore it. The lifetime is a veto, not
an authorization grant; it cannot be reconstructed from the public plan. Any observed failure permanently clears
that request; restoring configuration does not resurrect text or run a model.
The current core's 60-second whole-invocation limit is not extended. Planning
uses a separate bounded 3-second metadata wait and cannot send report text.

Per-source model/material/outbound settings remain authoritative. Legacy brief,
resultDigest, preset/reset and API configuration do not grant access. Each observed revision-only or same-label credential change is terminal for
that lifetime. There is no watcher or claim to detect unobserved A→B→A changes. Account
labels are declarations, not independently authenticated account identities;
the core's cross-process/restart account-evidence limitation is unchanged.

## Validation status

Actual TypeScript compilation, emitted unit suites, rendered terminal behavior,
format checking, visual baselines and scoped render-cost measurements are
**NOT_RUN** in the implementation environment because the normal local compiler,
formatter and runtime dependencies are absent. No substitute compiler, stripping
or TypeScript transformation, foreign node_modules, remote build or dependency
installation was used.

The two actual shell scripts pass `bash -n`. Dependency-free tests run those
scripts with a private temporary synthetic HOME and fake tmux: uppercase D binds
without repeat, lowercase d remains diagnostics, and a closed/dead panel exits before
querying a main pane or invoking the toggle. These are shell checks, not panel UI
or live host tests. Three new TypeScript suites are written for controller/core,
rendering and input, including real temporary SQLite and fake transport. They
must be run locally, not inferred from old base CI.

See [handoff and local checklist](handoff/f4-panel-explicit.md).
