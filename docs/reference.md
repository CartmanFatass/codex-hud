# Codex HUD reference

The details behind the [README](../README.md): the panel part by part, every key, the settings and the model features, the machine-readable state, and the configuration. [中文](./reference.zh.md)

- [The panel](#the-panel): [Panes](#panes) · [Layouts](#layouts) · [The control bar](#the-control-bar) · [Looks and icons](#looks-and-icons) · [The status card](#the-status-card) · [Scrolling and selection](#scrolling-and-selection) · [Keys](#keys) · [Switching sessions](#switching-sessions) · [Agents in the list](#agents-in-the-list) · [Timeline](#timeline) · [Agent log](#agent-log) · [Inspector and Changes](#inspector-and-changes) · [Settings](#settings) · [Card settings](#card-settings) · [LLM](#llm) · [Picture](#picture)
- [Output throughput](#output-throughput)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration): [Environment Variables](#environment-variables) · [Notifications](#notifications) · [config.toml](#configtoml)

## Installing

From the checkout, run `./install --with claude,pi,codex` (Node **22.13+ within 22.x, or 24.x**).
It does not install a harness, herdr, tmux, a browser or provider keys. Do not run the historical root `install.sh`.
The bottom status lines are always on: plain `claude` uses the global HUD statusline (an owner's existing
non-HUD statusline is kept), plain `pi` loads both the delegation and display packages, and Codex's tmux bar
comes with the installer's only printed shell function:

```sh
codexH() { hud codex "$@"; }
```

Only the panel is opt-in: `/hud` opens it in Claude and pi; F12 opens it in Codex. It never opens at launch.
Claude settings follow symlinks and keep a one-time plain backup; uninstall removes the HUD statusline and
restores a backed-up owner statusline. Codex keeps a one-time `.hud-backup` beside the resolved `config.toml`
before MCP edits and warns if its official commands drop comment lines. Uninstall with `hud uninstall` or
`./install --uninstall`; both pi packages are unregistered, and unrelated owner configuration stays.
See [installer extensions](../install.d/README.md) for selection, backups and multiple Codex homes.

The activation/receipt workflow below is historical, not the current checkout installer.

A release contains clean-built `dist/`, `packages/hud-mcp/{bin,dist}`, the canonical
`integrations/skills/hud-delegate/`, ordinary-named integration templates, notices and the bootstrap scripts.
Its manifest digest is its identity; one `releaseVersion` is shared by runtime package metadata, with commit,
source-content and lock provenance. A digest verifies integrity, not a publisher signature or live capability.
Dot-prefixed client metadata is materialized later, not admitted into the release inventory.

Example (synthetic absolute paths; create the chosen empty private prefix yourself):

```sh
mkdir -p /tmp/example-home/runtime
chmod 700 /tmp/example-home/runtime
node /tmp/example-bundle/install-runtime.mjs preview --prefix /tmp/example-home/runtime --stage-only yes
node /tmp/example-bundle/install-runtime.mjs stage --prefix /tmp/example-home/runtime --expect RUNTIME_PLAN_DIGEST
node /tmp/example-bundle/activate-runtime.mjs install preview \
  --prefix /tmp/example-home/runtime --release MANIFEST_DIGEST \
  --hud-home /tmp/example-home/hud --shim-dir /tmp/example-home/bin
node /tmp/example-bundle/activate-runtime.mjs install apply --plan ACTIVATION_PLAN_ID \
  --prefix /tmp/example-home/runtime --release MANIFEST_DIGEST \
  --hud-home /tmp/example-home/hud --shim-dir /tmp/example-home/bin
```

Repeat the **exact preview options** at apply. Preview is deterministic and writes nothing, including no saved
plan. Apply recomputes its content-addressed ID and refuses stale targets or the wrong ID.
The normalized plan also binds the complete sorted receipt-history digest (names, hashes and identities;
4096-receipt bound, no truncation). Restoring an attempt advances that history, so a fresh preview can install
again without overwriting any retained receipt. A concurrent receipt edit makes the plan stale. The already-installed
CLI has the same grammar: `hud install preview|apply --prefix ABS --release DIGEST ...`.
`--hud-home` defaults to `$HUD_HOME` or `~/.hud`; `--shim-dir` defaults to `~/.local/bin`.
Only **hud, hud-statusline, hud-mcp** are published there, as individually pinned owned files. Never add the
runtime prefix's whole `bin/` to PATH: it also contains internal compatibility commands. `cx`, `codex-hud`,
`hud-run` and legacy shell marker blocks are not published or changed. A foreign public-name collision refuses.
The MCP shim selects the six-tool roles surface for that process only.

Layout:

```text
/tmp/example-home/runtime/                 0700, existing runtime transaction
  releases/<manifest-digest>/              immutable; old releases retained
  current                                 atomic schema-v2 selector document
  bin/                                    internal selectors, not the public PATH directory
  receipts/                               runtime stage/install/restore receipts
/tmp/example-home/hud/                     0700, one HUD home for every harness
  display/  panels/                        missing owned directories only
  installation/<transaction-id>.json       private plan, backups and before/after journal
/tmp/example-home/bin/{hud,hud-statusline,hud-mcp}
```

Existing `credentials.env`, `config.json` and `routing.toml` keep their bytes and mode; activation never creates
samples over them. Client adapters can supply declarative `private-dir`/`owned-file` steps. An existing client
file needs its exact expected hash and explicit confirmation text; there is no generic overwrite permission.
Caller `private-dir` steps admit only `kind` and `path`. Caller `owned-file` steps admit `kind`, `path`, `content`,
`mode`, `expectedOriginalHash` and `confirmation`. Unknown keys and planner/journal-internal fields are refused
before any write; callers cannot mark their own files as generated or reused.

### Claude plugin activation (R6A-A4)

The `hud` plugin is generated from plain-named immutable templates with
`node RELEASE/claude-plugin.mjs preview --prefix ABS --release DIGEST --node ABS` (optional
`--hud-home`, `--shim-dir`, `--parity-inventory`). It lives under
`$HUD_HOME/installation/integrations/<integrationId>/claude`; preview is read-only, apply requires the exact
`--plan ID`, and `restore-preview|restore --receipt ABS [--plan ID]` reverses unchanged generated files.
The generated plugin pins its Node/release/home, copies the canonical skill and starts exactly the six-role MCP
surface in a child environment. A receipt-backed identical integration can be shared; the last active receipt
owns unchanged-file cleanup. Nothing writes HUD state to a Codex home.

`/hud:hud on|off|toggle|status|help` and `/hud:setup` use finite exact-command expansion hooks, not model recipes.
Setup defaults to preview. Apply and restore need `--plan ABS` / `--backup ABS` and call the existing statusline
settings commands. Bare `/hud` requires a separate collision-refusing alias activation and a passing temporary-home
zero-provider proof for the exact plugin artifact. No ordinary-prompt hook is installed. Unknown HUD commands and
catchable local failures stay blocked with a visible reason; prose and prefix lookalikes are untouched.
Only command interception has a bounded startup/nonzero failure guard; lifecycle failure stays quiet. An externally
imposed Claude hook timeout can still bypass interception, an explicitly measured platform limit in the runbook.

The panel never opens by itself; only `/hud` opens it. The registry has no affirmative topology field: this is
conservative inference, never hook JSON authority.
Worker/print/role sessions refuse explicit opens too; `off` is session-local. Generation-fenced close never closes jobs.
Real herdr split/focus and A7's panel registration remain separate acceptance gates.

Follow the [Claude owner runbook](../integrations/claude/README.md) for §H rows 4–6, exact preview commands,
backup/restore and the isolated native write-set rehearsal. Native plugin install remains a distinct owner-approved
step; rehearsal records every settings/registry/cache write with before/after hashes. Claude keeps the plugin cache
after uninstall; you can delete it by hand if wanted, using only the exact receipt-verified cache path
(synthetic: `$CLAUDE_CONFIG_DIR/plugins/cache/hud-rehearsal/hud/0.0.0`). HUD never deletes or restores it.

Statusline activation is **last**, after plugin/alias configuration. Draft a HUD-owned parity inventory with
`node RELEASE/claude-parity.mjs preview --home ABS --config ABS`, review/save stdout, and pin its path through
activation. Missing inventory, unsupported enabled fields, unknown keys, details-only fields or a tee/width/toktrack
wrapper block an automatic switch. Preview prints the difference; no feature parity exception is implicit.
All original settings/wrapper bytes stay in the existing statusline backup. Restore in reverse order: statusline
first, then alias, then native plugin registration, then generated integration. Stale edits refuse.

### Pi package activation (R6A-A5)

The ordinary `hud` package is materialized by
`node RELEASE/pi-package.mjs preview --prefix ABS --release DIGEST --node ABS` (then the same options with
`apply --plan ID`). It pins the immutable release/digest and HUD home, and explicitly loads one entry and the
hash-verified canonical delegation skill. It bundles no pi SDK and does not select the historical standalone
footer, managed delegation extension or worker-only entry. The ordinary package owns the p10k-style footer.

`/hud on|off|toggle|status|reconnect|help` runs locally through pi's command API, never as a model message.
Six role-tool proxies use the private evidence-bearing MCP channel, not `mcp.json` or a duplicate generic MCP
registration. Session changes synchronously fence the old epoch before cleanup. Canceled transitions remain
unbound until explicit reconnect; shutdown closes only the old channel and recorded display generation, not jobs.

The HUD owns the pi footer: one line below pi's own editor, drawn by the same builder as Claude's statusline and the
Codex bar (see [The bottom bars](#the-bottom-bars)), so it shows the same fields in the same order. pi has no quota,
so the session's cost stands in the quota's place when `quota` is on. Other extensions' `setStatus` values (pi-lens,
pi-viz, the HUD's own `review ok`) share the right cluster at the lowest priority. Native usage/rate/history capture is
outside render; repaint/resize only fits retained values. The post-persistence `context` hook refreshes the new
prompt's usage before the provider request.
Events and one 5-second single-flight TUI timer read the exact current root's bounded role-summary cache; no
scans/process launches/herdr/network occur on that summary path. Expired/unavailable cache clears idle counts.
The panel remains its only producer. Print/RPC modes have no footer, segment, timer or panel operations, even if
RPC reports hasUI; the role bridge remains available. Panel controls `/hud on|off|toggle` remain independent of
the everyday footer. `/hud footer off` restores pi's default editor/footer; `/hud footer on` mounts the HUD footer.

Footer settings live in `$HUD_HOME/config.json.piFooter`, with p10k's `footer`/`band` boolean keys. Without this
section all original defaults are on. Bare `/hud footer on|off` switches the whole footer for this session:
the choice survives same-session `/tree` and `/hud reconnect`, resetting only on a new session or reload.
With segment IDs and every other form, `/hud footer <original args>` changes the original options locally, e.g.
`/hud footer off lens viz`, `/hud footer band off`, `/hud footer toggle git`, `/hud footer reset` and
`/hud footer list`. To copy an old file explicitly, first run
`hud import preview --pi-footer --from ABS/p10k-footer.json`, then the same command with `apply` after inspection.
Preview writes nothing, apply changes only the section (and makes a backup), existing keys win and unknown keys
refuse. No pi settings discovery or automatic import occurs.

The panel never opens by itself: no session event splits a pane, and only `/hud` in the registered display
package (`$HUD_HOME/pi-display`) opens one. Worker, nested or unknown contexts cannot open a side panel. Inherited
pane variables alone are not proof; no tmux fallback is added. `/hud off` is session-local. No preference is written
by loading the package.

Owner row 7 is a **separate** `row-7-preview`/`row-7-apply --plan ID` with explicit `--settings ABS --package ABS`.
Both reuse A1 backups,
stale-edit refusal and exact restoration; symlinked settings refuse instead of writing a private target. No MCP
config is added and activation never reloads the client. Reverse newest receipts first with
`restore-preview|restore --receipt ABS [--plan ID]`. See the [pi owner runbook](../integrations/pi/package/README.md)
for complete preview options, write-set rehearsal and isolated real-CLI probes. **Before enabling the package,
the owner must remove p10k-footer from pi's extension selection** (two footer/editor owners would fight). Back up
the auto-discovered entry outside the extensions directory, at the approved install boundary:

```sh
mkdir -p "$PI_AGENT_DIR/backups"
mv "$PI_AGENT_DIR/extensions/p10k-footer.ts" \
  "$PI_AGENT_DIR/backups/p10k-footer.ts.$(date +%Y%m%d-%H%M%S).bak"
```

Use the explicit absolute pi agent directory (normally `~/.pi/agent`); moving a symlink preserves its target in
Fishpref. Deselect any explicit p10k resource and historical `hud-footer.ts` too. The HUD deliberately detects and
modifies none of these. Verify actual look, narrow widths and `/hud footer off` restoration after owner-controlled
restart/reload. For rollback, deselect the HUD package before restoring the backup to an absent original path.

### Owned pi worker resources (PR3, before facade cutover)

The staged release includes a separate `integrations/pi/worker.ts` and four fixed role texts. This worker loads no
ordinary HUD tools, side panel or footer; it does not yet change the facade's new-job launch selection. Native pi
authentication, base instructions, retry, compaction and transport remain pi's, not a new HUD authentication store.

Non-sonic roles can call blocking `call_sonic`; only implementers get `call_reviewer`, and sonic gets no helper tools.
Calls share one job, at most 10 sonic and 3 review reservations (failures count). A read-only caller's sonic is also
read-only except its own report and inherited QA/scratch exceptions. Implementer helpers use the owned right pane;
other sonic callers split down from their own pane, with a helper reviewer borrowing its outer reservation.
A returning or crashed reviewer cleans its reserved sonic child before releasing that reservation. Unknown cleanup
returns `helper_unresolved` with the child slot and blocks both helper kinds until explicit close/reap; it does not
start another helper or claim cleanup succeeded.

Successful implementers remain available for same-session continuation during fixed model cache-TTL grace (unknown
TTL means zero). Unused successful grace expiry and successful one-shots may make one finite post-exit tab cleanup
attempt. Quitting during grace, failure, a used continuation, or `HUD_KEEP_TAB=1` keeps the tab for inspection.
Completion and confirmed resource closure remain separate; explicit close uses the same conservative reaper.
A worker's herdr tab is labelled `<role> <package or brief title>` in about 28 columns (a short job suffix only when
another open job's tab has the same label); that one-line label is recorded as `TAB_NAME` and checked by `pi-role-reap`.

QA waits up to 1200 seconds. A timeout instructs the proposed default, but is neither a human answer nor proof that
it was followed. Implementers run focused tests while working and full checks twice, before first review and final
report. Background suite logs live in the job's `checks/` and end in `exit=<code>`. Reviewers never rerun full
suites: round 1 reports missing/failing/stale full-suite evidence as a finding; round 2+ notes expected stale
full-suite logs after fixes. Reviewers rerun missing/failing/stale focused checks and run the round's focused tests
and earlier-finding regressions. The full acceptance gate still belongs to the orchestrating session.

### Activation preview runbook

Before approving apply, inspect: schema/transaction and plan IDs, exact runtime digest/version, canonical paths,
original identity/hash/mode or absence, proposed hashes, public-name subset, preflight results, ordered actions,
owner-confirmation items and the recovery route. Close editors and approve every concrete diff. Symlinked or
foreign targets and unsupported layouts refuse; activation does not follow private configuration links.
The runtime and activation writers share the runtime prefix lock; concurrent writers refuse, not retry.
Both activation locks record the exact receipt and the owner's PID, start stamp, boot and PID domain.
After a hard interruption, only explicit `install restore --receipt R` can reclaim matching activation locks,
and only when that exact owner is provably dead. A live/unknown owner, different PID namespace, malformed lock
or runtime-owned lock refuses with its path for manual inspection. Preview/apply never reclaim locks.

No rc file is changed by default, nor when the shim directory is already on PATH. To request one POSIX shell
insertion, pass `--rc-file /tmp/example-home/profile` in both preview and apply. One universal-hud marked block
is appended; legacy codex-hud blocks remain untouched. Restore removes only that unchanged owned block and
preserves edits outside it. A hand-edited block is a conflict, not a forced overwrite.

Apply returns a receipt path; on interruption the error includes `restore_receipt=...`. It backs up before each
mutation and journals intent and completion. Do not blindly repeat an uncertain apply. Inspect the receipt and use:

```sh
hud install restore --receipt /tmp/example-home/hud/installation/TRANSACTION.json
hud uninstall preview --receipt /tmp/example-home/hud/installation/TRANSACTION.json
hud uninstall apply --receipt /tmp/example-home/hud/installation/TRANSACTION.json --plan UNINSTALL_PLAN_ID
# Before public shims exist, or after removal:
node /tmp/example-bundle/activate-runtime.mjs install restore --receipt /tmp/example-home/hud/installation/TRANSACTION.json
```

Restore/uninstall reverse the journal, restoring prior bytes/modes/absence only while targets still match the
recorded install. Changed files return a conflict report and remain untouched.
A reverse mutation interrupted before its completion record is reconciled under the same locks and durably
finalized before success; this preserves the proof needed to reverse an older activation after rolling back an upgrade. **Recovery metadata is the one
retention exception:** `$HUD_HOME/installation/` and its parent remain even if HUD_HOME was originally absent.
User-created keys, history and results are retained; nonempty created directories are not recursively removed.
Immutable releases and recorded owners are never garbage-collected: successful reversal reports
`deactivated; release retained`, not a purge. For multiple activations, reverse newest first.

For upgrades, stage N+1 beside N with the same bootstrap, then preview/apply activation separately. Staging does
not move `current`. New shims pin N+1; processes already holding N's immutable path keep using N.
A shim supplies its installed HUD_HOME only when the caller's HUD_HOME is unset or empty; an explicit override wins. There is no hot
replacement, automatic client reload or removal of old releases. Client settings/statusline pins need their own
later-package confirmation; changing the public selector does not rewrite them.

## Home and Work (R5UX-P2)

> **This section supersedes the stacked-pane description under [The panel](#the-panel)** for the main tabs, their
> keys and their content. The older text stays as the historical/secondary renderer description; the live panel
> follows this section.

The panel's main tabs are **Home** and **Work**. Both are passive: they display what the workflow already wrote to
disk and steer nothing.

| `Ctrl+\`, then | Opens |
|---|---|
| `1` | Home |
| `2` | Work |
| `3` | Changes |
| `4` or `v` | Inspector |
| `t` | Timeline |
| `S` | Main summary, in the Inspector |

**Keys on Home and Work.** Up/Down or `j`/`k` selects; Left/Right or `h`/`l` folds and expands; `v` inspects. Enter
on Home opens the corresponding Work lane, card or decision; Enter in Work is inert, except on a job card: it opens
that job's `report.md` (else `brief.md`) in `$EDITOR` beside the panel, as Enter on a decision opens its `qa` file. Esc
returns from the Inspector, and standalone Esc on the main page exits as before. The footer keeps whole hints only
(`←→ tab  ↑↓ move  ⏎ open`): at a narrow width the hints on the right are dropped, never cut.

**What Home shows.** Its badge and needs-you items count only terminal runtime jobs that ended needing a human. A
worker's QA result, a normal failure, a blocked job and a timeout never count. Partial coverage never reads as
"nothing needs you".

**Recorded calls are read-only.** A review counts only when its first line is exactly `Verdict: accept` or
`Verdict: changes-required`. A recommendation is labelled as a recommendation, explicitly not as an adoption. An
answer that leaves an explicit option is shown as `≠` with `instead`; an ambiguous answer or free text stays
routine. Only an explicit `One-way: true` line is pinned red; a prose mention is not. Routine and departure items
are capped at three with `+N earlier`, older than two hours fold, and the list rolls over at local midnight. There
is no seen state. Home labels its routine tier **decided for you** and shows each answer with its source question
and explicit selected-option text when resolvable. The question ID keeps clipped rows distinct; expansion/Inspector
shows the full bounded text. Home progress has a ten-cell ordinal axis only for observed design/build/review/acceptance
phases—not a completion percentage or evidence of an unobserved earlier phase. Unknown/mixed phases have no bar.

The one visible cursor belongs to one physical row. Worker lists align glyph, harness, role, task, model·effort and
right-hand minute age; unknown harness/age cells stay blank. The tab row carries the prefix hint and clickable
Inspector/Settings/Help controls (compact `v`, `,`, `?` labels where needed), using a second header row only when
necessary on narrower screens.

**What Work shows.** Lanes plus the shared compact work cards: one lane per observed package, invocation or native
session, its worker cards inside it and its recorded calls beside them. Navigation is logical rather than a cursor
over painted cells — lane, then its workers, then its decisions. Left folds the selected lane and collapses the
selected card; Right unfolds the lane and expands the selected card; Enter in Work is inert (a job card opens its
file, see Keys). Enter on Home hands the
selected lane, card or decision to Work and unfolds its lane. At 110 columns Home's peek draws the selected lane (the
first when none is selected) through the same lane/card renderer, not a second interpretation. Lanes are observation
navigation, not execution ownership; an unknown phase or order is shown as unknown. Wide Work reserves a written-title
column and a shared ordinal stage axis; browser cards use recorded phases, not role-inferred build/design. A lane of
jobs has the build, review, accept and done stops only once one of its jobs has a review round; until then (a sonic or
oracle job never gets one) its line map is build to done.

**The work card.** One compact card is shared by Work and Home's peek, and the retained secondary renderer draws the
same card. Collapsed, it is at most three physical lines: the role and short task with the state word and elapsed
minutes; the observed phase chain when there is one; and one deterministic line — the reason, the reported test and
file counts, or the optional stored model sentence where a native grant already allows one. The four active states
are needs you, working, to accept and stalled; done is the settled fifth. There is no blank sentence slot, no
task/report/helper prose, no telemetry, context meter, tok/s, model badge, child rows, relations or footer. The
Inspector keeps the full model and effort, the evidence and the time basis. A review counts only when its first line
is exactly `Verdict: accept` or `Verdict: changes-required` (CRLF allowed) and the helper status is settled with its
output written; a helper's exit alone is not a verdict. Current helper progress/failure also requires compatible known
primary/helper starts and file times; reused or unconfirmed slots show unknown helper state, never a current failure.
Readable current QA shows its question/default locally, with options and evidence in expanded detail and Inspector;
unavailable details use the generic inspect instruction. Native/facade Inspectors retain their original details and action
fences alongside the full Work state/history/evidence. A changes-required round shows `fixing` only once the primary
resumes, never merely because the review ended. A direct task cannot infer acceptance or a merge, and a pi STATUS
auto-close is not facade closure.

**Card state precedence.** A current request or failure comes first; then a result awaiting acceptance; then stalled —
stale, unknown or no observed activity, or the stall threshold (default 10 minutes, 1–120 stored) without meaningful
progress; then working. This is presentation only: it changes no execution status, wait semantics, acceptance or
source. A model call, a counter or heartbeat, or an identical file touch does not advance activity. A worker's QA
result or ordinary failure never becomes Home's needs-you. A facade result stays pinned at to accept until facade
closure. Home and Work share the existing finished-agent linger policy, including Home's overview/footer: counts are
of visible workers. Zero keeps every agent unchanged; `a` reveals/hides finished history on both tabs. Expiry never
hides terminal human-needed workers, admitted daily one-way decisions, partial coverage or unclosed facade output.

**Retained secondary renderer.** Production always supplies the workboard sidecar. The no-sidecar stacked renderer is
retained only for fixture and legacy callers, is never reached by the live panel, and is scheduled for removal after
P2 (q4). It uses the same compact work card, not the old rich cards, and gains no new features.

**What Home and Work do not have.** No old status-control footer, recovery, Resume, Reconcile, status-level or generation toggles. The
existing settings and backends load unchanged. Nothing fakes a queue position, a merged age or the publish job's
login blocker. The recap stays reachable through `S` and the Inspector, with its backend settings preserved.

**Colour.** Role inks colour role words only: imp cyan, reviewer pink, sonic coral, oracle violet, Jev teal. Ages on
Home and Work are minute-valued. Their local attention ink is the approved mockup's #efc15a; state colours elsewhere
are unchanged. Light/terminal palettes retain their legible equivalents. Mono and ASCII output keep their meaning.

## The panel

### Panes

There are four panes: **1 Agents** (the cards in rich, the tree in compact), **2 Timeline**, **3 Changes** (the worktrees over the changed files) and **4 Inspector**; Agents is open by default, the others open from the bar or with `Ctrl+\` `2`–`4`. Panes stack vertically. Each has a **title row** naming it, drawn as the panel's look draws it (below), with which rows are in view at its right end when it scrolls (`7–14/46`), or else how many it holds (`4 files`, `9 events`); then its rows behind a gutter `│` on the left only (in the accent for the focused pane, dim for the rest): no right border and no bottom rule. In a panel 30 rows or taller a blank row parts the sections: under the bar, between two panes and above the status card; never at a pane's expense, and not in the frame look, whose edges part them already. A pane is **open or closed**; a closed one takes no row at all. A click on a pane's title zooms it to the room between the bar and the status card, and a second click restores it, as `Ctrl+\` `z` does. A pane takes no more rows than it has to show; spare height goes to Agents, or to the Inspector while it has the focus. The agents area works the same way: its title row carries the counts, a click on it zooms the cards, and it can be closed from the bar, the other panes then sharing its room.

### Layouts

**Two layouts** (Settings → Panel → Layout). These are the retained secondary renderer: only fixture and legacy callers reach them, never the live panel, which follows [Home and Work](#home-and-work-r5ux-p2) above. They keep their secondary chrome, footer and keys; their cards are the same compact work card the live pages draw, so there is no second card renderer and no switch that brings the old rich body back. Their removal is scheduled after P2.

- **rich** (the default): one compact work card for every visible agent the main session started (an **L1**), active or idle, under the fixed summary row in one scrolling list, with the same order, filter and finished-agent linger window. There is no card expand/collapse state and no expansion arrow. Descendants remain in the owner's aggregate counts and Inspector, not separate cards or child rows. The summary row counts L1s by status (`!1 failed  ✓3 done  ▸3 run`), counts an L1 as running while a subtask runs, and includes guardian reviews (`◈N`, error colour if one failed); where room permits it adds the subtasks and their failures (`· 17 subtasks, 1 failed`) and the combined output rate of every running thread (`· ~186 tok/s`; the main session's rate is in the status band). The card itself is the three-line work card described under [Home and Work](#home-and-work-r5ux-p2): role, task, state and minutes, the observed phase chain, and one detail line, with no telemetry or child rows.
  - **Selection (fixture only):** a click on the card selects it; a second click on its name within 400 ms switches the Codex conversation, the name underlined when the Codex pane is at least 63 columns or its width is not yet known. `Ctrl+\` `Enter`, Space or `v` opens the Inspector on the selection and never expands a card. The selected card is on a lighter band. The live Home and Work pages have their own selection and no native switch.
- **compact**: the Agents pane (the tree, one row per agent and subtask, by Codex's own name, under the same title row as rich) with the brief, the recap and the agent log under it, as before.

Every view counts alike: an **agent** is one the main session started, a **subtask** an agent under one, at any depth, and a **review** a guardian approval review, wherever it sits. The Agents pane's title row and cards, the status card's alert and notifications, which say the failures as one phrase (`! 1 agent · 1 subtask · 1 review failed`), the bar's Agents field and alert, the Agents brief and `codex-hud --json` all count the three apart, and an agent counts as running while a subtask of it runs. Those aggregate counters are unchanged; compact work cards do not repeat subtask/review counters.

### The control bar

**The control bar** is the panel's first row (two in the frame look), and every control the panel has is on it; cards, the status card and the panes' titles draw none. Each control is a **button**: its icon, and its word where it fits. No key is written on it; the keys are in the help.

```
120 columns   ⌂ Main   ▦ Agents   ≣ Timeline  ± Changes  ◫ Inspect  ⚙ Settings                  ǁ Pause models  ⊕ 1 finished  ? Help
 56 columns   ⌂  ▦ Agents   ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
 40 columns   ⌂  ▦ Agents  ≣ ± ◫ Settings     ǁ ⊕1 ?
 32 columns   ⌂  ▦  ≣ ± ◫ Settings    ǁ ⊕1 ?
```

- `⌂` returns Codex to the main session. Its word (Main) shows where every button has room for its own, and in the frame look's title wherever it fits.
- The tabs are the panes, in their order: `▦` Agents, `≣` Timeline, `±` Changes, `◫` Inspect, each the icon its pane's title carries. The focused tab is drawn as the look draws it (a filled tab in the tab look); an open one is in the text colour, a closed one dim. In the stacked layout one click opens a closed pane and focuses it, and closes an open one, the cards included; in the tabs layout it shows that pane, and the pane's title leaves its name to the tab: it is the pane's counts and where its rows are (`✓38 done  · 101 subtasks    23–44/103`), or in the frame look the frame's edge alone.
- `⌨` (Keys here) appears while the panel keeps the keys (after a click on a blank row or a gutter): nothing typed reaches Codex until Esc or a click on it hands them back. It is in the accent, its word where the row has room, and it is never given up for room before the help button.
- `⇢` (Switch) appears while an agent is selected in the Agents pane, or open in the Inspector: a click switches the actual Codex conversation to it, as `o` does. It gives way for room together with the models' button.
- `ǁ` / `▶` (Pause models / Resume models) pauses or resumes all model generation, shown while a model backend is configured; `⊕N` shows the finished agents the linger window put away and `⊖` hides them again, shown only when there are some (in rich, the agents, the list's rows: their descendants belong to their cards rather than adding entries to this button's count; in compact, every row the tree put away). Where the row fits the words it reads `⊕ N finished`, or `⊖ Hide` while they are shown; otherwise it stays `⊕N` / `⊖N`. With icons set to text it stays `+N older`. The labelled **Settings** navigation tab opens settings; `?` opens the help. Settings stays on the navigation row, including the frame look's second row, not among the right-side actions. Its word survives at 24 columns and above; below that it uses a short word, not a gear alone.
- The bar follows the width. The older agents' button takes its words whenever that row fits them, and the icon alone when it does not, before a button or another word is dropped. The other actions' words show only when every button has its word; then the closed tabs' words, then the open tabs' but the focused one's, then that one's, the columns between the tabs narrowing from three to one on the way. Then buttons go: the closed panes' tabs, the older agents' button, the models' pause button, the other tabs, the focused tab. The main session's button, settings and help never go. A click anywhere between the midpoints of the gaps either side of a button is that button. Without colour (`theme: none`) the focused tab is in brackets, and a closed pane has no tab.

### Looks and icons

**Look** (Settings → Display → Look, or `CODEX_HUD_LOOK`) draws the bar and the panes' titles in one of five ways. Picking a look in Settings sets Icons to the set it was drawn with (`CODEX_HUD_LOOK` alone leaves them as they are); Icons can change them after.

```
tab     ⌂  ▦ Agents   ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
band    ⌂ ▦ Agents   ≣ Timeline   ±   ◫   ⚙ Settings ── ǁ ⊕1 ?
tile    ⌂  🤖 Agents    🕘    📝    🔍    Settings      ǁ ⊕1 ?
frame  ╭─ ⌂ Main ────────────────────────── ǁ ⊕ 1 finished ? ─╮
       │  ▦ Agents    ≣ Timeline   ±   ◫   ⚙ Settings         │
pill    ⌂ ▦ Agents  ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
```

- **tab** (Tab row, the default; Unicode icons): the focused tab is filled, a column of its colour either side of its face. A pane's title is its icon and name, the accent where the focus is, on no surface of its own.
- **band** (Status band; Unicode icons): the bar is a band on its own background, as the status card's is, its spare columns an accent rule between the tabs and the actions; the focused tab is in the accent. The panes' titles are bands too, a zoomed one filled as the focused tab is.
- **tile** (Emoji tiles; emoji icons): every open tab sits on a chip of its own, the focused one filled; a pane's title runs on into a rule, the accent where the focus is.
- **frame** (Frame; Unicode icons): a rounded frame round the whole panel. The main session is the title on its top edge, with the actions at that edge's right end; the tabs are the row under it; each pane's title is an edge across the frame (`├─ ± Changes ──────────── 4 files ─┤`), its rows between the frame's sides (the left one in the accent beside the focused pane), and the status card's corner closes it (`╰─ … ─╯`). Under 20 columns it is drawn as tab.
- **pill** (Pills; Nerd Font icons): the focused tab is a pill with rounded ends; the panes' titles are pills, the focused pane's in the tab colour, the rest on a chip.

**Icons** (Settings → Display → Icons, or `CODEX_HUD_ICONS`) picks the set: `unicode` (the glyphs above), `nerd` ([Nerd Font](https://www.nerdfonts.com/) icons: a home `U+F015`, a robot `U+F06A9`, a history clock `U+F1DA`, a diff `U+F440`, an info circle `U+F05A`, pause / play `U+F04C` / `U+F04B`, an eye and a struck eye `U+F06E` / `U+F070`, a cog `U+F013`, a question circle `U+F059`), `emoji` (the panes as 🤖 🕘 📝 🔍, two columns each, the actions keeping their Unicode glyphs), or `text`: the buttons are words alone (`← Main`, `Agents Timeline Changes Inspect`, `Pause models`, `+1 older`, `Settings Help`), shortened where narrow (`Ag Tl Ch In`, `Pause`); set to text, the panel's other marks are words too (the status card's Needs, Goal, Now, Done, `12d ago`, the bottom bar's `Working` and `Idle`). Model label (`glyphs`) is the panel's model badge's alone: its text value writes the model and effort as words and leaves the icons as they are. The bottom bar always names the model in words. The Unicode and Nerd Font icons and the pills' rounded ends are drawn by MesloLGS NF (see [Font](../README.md#font)).

### The status card

**The status card** at the foot is a band and a corner, as omp draws its status line, and its meters are thin lines with the reading where the fill ends:

```
 ✓ Idle ★◆ 5d ──────────────────────56%──────────────────272K ~3m
│ ◎ Make the tokenizer twice as fast without breaking CJK text
│ ▸ Waiting on the CJK fix and the cache review
│ ✓ Streaming API merged
│   Benchmarks set up on the 50 MB corpus
│   Dependency audit clean
│   Add the streaming tokenizer API
╰─ parser-kit · main * ↑2 7d ───────────────────────────99% ↺4d18h
```

- **The band**, on its own background across the width: the session's state (while it works, the running tool and its target, the turn's clock and `~N tok/s`; idle, how long it has waited on you since the turn finished, from a minute on: `✓ Idle 12m`; the bottom bars do not say when a turn ended), the model badge and the session's age; the context meter, the percentage where the fill ends and the window size at the tail (a `┃` tick marks the auto-compact point when `config.toml` sets `model_auto_compact_token_limit`); then, wherever a brief is configured, its state (`~3m` for the recap's age, then in words: writing…, failed, paused). A click anywhere on the band steps the level, as `r`.
- **The body** hangs off a left gutter (`│`) in the main session's state colour: dim idle, info working, error failed, warning stale or needing you (an approval, a failed tool, agent, subtask or review, a recap that needs you).
- **The corner** (`╰─`): where the session works (the project in bold, `› repo` when it differs, `· branch`); the quota meter for the tightest window, labelled `7d` and read `99%` (a full window with credits behind it reads the balance instead, `credits 31.8K`, and is not marked `!`: Codex goes on, on credits); and the reset countdown.
- Meters fill in the info colour, warning past 70 %, error past 85 %, over a dim track.
- Short of room, the band drops the rate, the tasks, the age, the window size, the model and the brief's state, then the meter shrinks to its percentage; the corner drops other windows, the branch, the window, the repo and the forecast, then its meter and the reset. The state and the percentages go last. Under 24 columns there is no card. At 32 columns or fewer the card draws as min, and the saved level comes back when the panel is wider. A saved full stays full in shorter windows too, as far as the height permits; changing agent card contents does not change its level.

It has three levels (Settings → Panel → Status card, saved like the other panel preferences); `Ctrl+\` `r` or a click on its band steps through them:

- **min**: the band alone, with the brief's state and the quota's reading at its right end, marked `!` when a tool, agent, subtask or review failed or the recap says it needs you. Its context meter is named `Ctx` (as the quota's reading is named by its window, `5h 61%`), so the two percentages do not read alike; the name outlasts the meter's bar, the window size and the brief's state.
- **status**: the band, the alerts when there are any, and the corner.
- **full** (the default): those, then the main session's brief: the pending approval in the model's words first (`⚑ ~ …`), then the recap with its labels inline in one column, needs (`!`, in the warning colour) first, then goal (`◎`), now (`▸`) and the newest two done items (`✓`, a dim `+N` for the rest), each value at most two lines; the whole-picture sentence stands in for Now only when there is no recap; then a failed call or a reply in another shape than asked for. Paused, the brief steps back to dim. With Icons set to text, the labels are words (Needs, Goal, Now, Done) padded to one column. The card takes at most a third of the panel and leaves the agents at least ten rows when the panel is tall enough; in rich mode its height is reserved independently of card content settings, so longer agent cards scroll instead of taking room away from the recap. A brief taller than its room keeps needs, now and goal in view and the rest a scroll away (the wheel over the card), with a line saying what is out of view.

Compact keeps its layout: the brief and recap stay in the area under the tree, in the same inline fields, so its card has only min and status (full there is status) and `Ctrl+\` `r` switches between the two.

### Scrolling and selection

The view under the agents' title row scrolls when it does not fit: the wheel over it, `PgUp`/`PgDn`, and moving the selection, which brings the selected agent into view. The title row says at its right end which rows are in view (`6–17/40`). Where it is scrolled to holds across repaints and new content, and is clamped when content shrinks. A view under 12 rows drops its blank lines before it hides content. The status card and the open panes 2–4 keep their place.
At 16–20 columns, margins shrink. Use `Ctrl+\` `z` to give the focused pane the full height.
Selection follows agent IDs and file paths across refreshes, and every pane retains its scroll position.

### Keys

Every key below follows the prefix: `Ctrl+\`, then the key (or the prefix chosen in Settings; a settings file saved before `Ctrl+\` became the default, with no prefix of its own, keeps `Ctrl+]`, which Codex 0.160 also binds to Skip Question). Outside settings, help, activity and evidence modals, a key typed without it goes to Codex.

| `Ctrl+\`, then | Action |
|-----|--------|
| `u` | Activity hub: inbox, since viewed, find, history |
| `p` | Find agents by name, role or path; pin selected agents |
| `c` | Evidence sources, model-call dashboard, diagnostic preview/export |
| `,` / `?` | Open settings / the help (also the Settings tab and `?` button); in settings, arrows, Enter and click change values, Save applies them. The help has three pages, a tab each beside its title: Keys, Mouse (the buttons and the mouse) and Legend; a click on a tab, Tab/Shift+Tab or ←/→ turn them, ↑/↓ and PgUp/PgDn scroll one. Too narrow for the three tabs, it shows `‹ page ›`, each arrow a click to the page before or after |
| `Tab` / `Shift+Tab` | Cycle pane focus (in the tabs layout, show the next or the previous pane) |
| `1`–`4` | Open and focus a pane, or close it if it is open: `1` Agents (the cards in rich), `2` Timeline, `3` Changes, `4` Inspector; in the tabs layout, show it; so does a click on its tab |
| `x` | Close the focused pane (stacked layout) |
| `j` / `k`, `↑` / `↓` | Move the selection or scroll; repeats without the prefix for half a second (`Ctrl+\` `j` `j` `j`) |
| `PgUp` / `PgDn`, `g` / `G` | Page (the agents view scrolls a page; repeats), first/last item |
| `Enter` / Space / `v` | Open Inspector on the selection (no card expansion); inside Inspector, expand/collapse timestamps, IDs and full paths (`▾ More`); in the Timeline, open the agent of the entry under the cursor (↑/↓ step through the agents' entries), else bring back twenty earlier entries |
| `h` / `l` (compact) | Fold/unfold or navigate parent/child agents |
| `s` | Active-first / creation order |
| `a` | Show or hide the finished agents the tree has put away (the `⊕N` button) |
| `f` or `/` | Filter all, running, failed, unknown |
| `n` / `N` | Where the delegation tree is drawn: the next / previous row that needs a person (`⚑`, a live `!`, `⚠`, an unsure `?`; a collapsed row over one counts, and stays collapsed). Wraps at the ends; nothing when there is none |
| `L` | Where the delegation tree is drawn: the log of the selected headless run, in any state (the bar's `⇢ Log`). The panel resolves the key and the page's dispatcher is still to come, so nothing opens the log yet |
| `R` | Where the delegation tree is drawn: the bar's `↻` for the selected row. Reconcile copies the reconcile command; Resume only says the local resume entry is not verified here (ask the parent to `delegate_resume`). The panel resolves the key; copying and showing the answer wait for the page's dispatcher |
| `o` | Switch the actual Codex conversation to the selected agent at once (`⌂` does the same for the main session; the bar's `⇢` Switch does the same as `o`). Where the delegation tree is drawn, `o` does what the selected row's `⇢` says: Switch for a Codex agent of the main session, Open (focus the pane of a visible delegated run) when its host is verified; on a greyed Open or a Log row it does nothing. A click selects; a second click on the name within 400 ms switches |
| `m` | Return the Codex conversation to the root session (the `⌂` button) |
| `z` | Zoom/restore focused pane, a click on its title too (stacked layout) |
| `b` | Pause / resume all model calls (the `ǁ` button) |
| `r` | Status card level: min → status → full (compact: min ↔ status); a click on the card's band too |
| `Esc` | While keys are kept in the panel, hand them back to Codex; then dismiss help, unzoom, or step back to the Agents list, and stop there. Esc never closes the panel: `q` or F12 does |
| `q` | Close the panel |
| `Ctrl+\` | Send `Ctrl+\` itself to the pane with the cursor |

| Mouse | Action |
|-----|--------|
| Click / wheel | Select or scroll; the wheel scrolls the agents view without moving the selection, and over the status card (rich, full) its brief |
| Click a card (rich) | Select it, without expanding or collapsing. A second click on the name within 400 ms switches (underlined when the Codex pane is at least 63 columns). A child line selects that child. Enter, Space, `v` or `◫` opens the Inspector |
| Click an agent (compact) | Open the Inspector; a second click within 400 ms switches |
| Click a blank row, or the gutter | Keep the next keys in the panel until Esc. While they are held the bar shows `⌨ Keys here` (the glyph alone where narrow, `Keys` with icons set to text); a click on it hands them back too |

### Local activity and evidence

`Ctrl+\ u` opens a modal with five tabs. Tab/left/right change tabs, arrows/wheel select rows, Enter inspects a current agent, and Escape returns. Historical agents absent from the current tree are not used as live navigation targets.

- **Inbox:** observed approvals, failures and readback/collection problems. Mark read (`r`), snooze ten minutes (`s`), pin (`p`), or use the named buttons. Read is not resolved: recovery requires successful evidence from the corresponding source. This does not add another desktop notification channel.
- **Since viewed:** unacknowledged completion/failure, observed Git-state changes and stored model-summary changes. `v` / Mark viewed acknowledges only the visible events; opening or closing the modal does not discard unseen events. Git file state is collected on demand while this tab or Changes is open; unavailable/stale state is labelled. This is not a complete between-times Git diff.
- **Find:** filter name, role or agent path, including Unicode and pasted text. Ordinary letters are query text while editing; Ctrl+P or the Pin button pins the selection, Ctrl+F returns to query editing. Pins are scoped to the root session. Normal input forwarding resumes when the modal closes.
- **History:** bounded observed state snapshots and their retained events, explicitly labelled historical. It does not record the conversation, restore the terminal or rerun tasks.
- **Sessions:** the root sessions started in this session's directory over the last 7 days (at most eight, the most recently written first): when, how long ago, the title a model wrote earlier where there is one (else the id's head), and `this session` on the current one. The selected one's resume command is under the list, whole (the id on lines of its own where the line cannot hold it): `$ codex resume <id>`. The HUD never runs it, and nothing here calls a model; the list is read from the rollouts' first lines only while the tab is open, at most every ten seconds.

The private atomic journal under `$HUD_HOME/display/activity/` is scoped by root session and bounded to 500 events, 48 snapshots, 200 agents/pins, 30 days and 4 MiB serialized. It retains only necessary status, bounded paths and already generated model summaries, not raw tasks, conversation, commands or reasoning. Bar and panel both observe; concurrent panels merge changes. A contended/unwritable store remains visibly pending for a later flush. Time without a running HUD is not reconstructed.

`Ctrl+\ c` explains main/selected-agent evidence, timestamps, estimated TPS and Herdr readback/conflicts. The status-band TPS is clickable; `Ctrl+\ d` retains the Inspector diagnostics with a Sources/Calls/Export entry. Unknown data remains unknown, and lifecycle completion does not verify work quality.

The Calls tab groups locally observed requests, cache hits, successes, failures, cancellations, limits and mean dispatch-to-settlement duration by feature, including connection probes. Retention is 24 hours / 1000 records. Requests include cached consumers and refusals, not just provider calls; durations exclude queue time. Other panels' pending work and older/pre-instrumentation calls are unavailable. Unknown tokens and dollar cost are not estimated as billing.

Export shows a fixed full JSON preview first. Save report / `s` writes those exact bytes to a new 0600 file under `$HUD_HOME/display/diagnostics/`. It excludes credentials, endpoints, identifiers, file paths and source/summary text. Versions, platform and a startup entry-file hash identify only the entry observed at process start, not the whole build or current Git checkout.

Repeated positively idle, unchanged observations gradually reduce collection to at most five seconds (an already slower configured cadence is preserved). Activity, uncertainty, failure, input or source change restores normal polling. Redraw/input remain independent. Large scans yield between chunks; individual JSON parsing remains synchronous. Poll cadence is not a model or notification delivery guarantee.

### Switching sessions

Session switching drives Codex's own `/subagents` picker (verified against Codex 0.154 and 0.157) and selects the row showing the agent's exact UUID; it never submits guessed `/agent <id>` commands. It requires an empty composer (including the read-only composer of a sub-agent view) or the recognized picker. Drafts, copy mode and unsupported views produce a visible message instead of forced input. Keyboard selection alone previews the agent; `o` switches. Visible targets are reached in one movement batch, long lists a page at a time, and the row is rechecked before Enter. The picker is not reopened afterward, avoiding a second popup and transcript redraw. A delivered request does not independently confirm the final Codex view.

Below about 63 columns Codex stops printing UUIDs in the picker. The agent is then matched by the name the picker prints (its task path, or `Main [default]`), and only when no other agent of the session prints the same name; otherwise the switch is refused with a request to widen the Codex pane. While agents are running, Codex adds a "Sub-agents running" note to the conversation each time the picker opens; that note is Codex's own.

### Agents in the list

The panel also observes role-facade CLI/browser jobs, dispatch helpers and explicitly
registered external Herdr tasks in the same Agents pane. Jobs attach only to their exact
recorded root. Native sessions are enriched only by a complete matching native reference;
labels, pane names or reused session strings do not establish a match. Source freshness,
lifecycle and outcome remain separate: an unavailable host is not a task failure, and a
report file is not proof of successful work. Stale live work is counted as unknown.
Job-only summaries are unavailable: local labels, questions and report text are never sent
to the model. Native-enriched rows keep the ordinary native summary path. Brief dry-run
explicitly reports omitted job-only summaries without starting a backend or writing state.
These observation ids cannot be used for Codex Switch, legacy Open or Resume.

`hud panel` opens the existing all-delegations view. To view only one root, use
`hud panel --root <namespace/session-id>`; this is an observation selector, not execution
identity or permission. Without a native root, all-roots mode uses a metadata-only root
container, not a fabricated Codex session or footer. Embedded no-argument panels continue
to follow the current bound session.

External tasks appear only after explicit metadata registration:

```sh
hud observe-herdr --root synthetic/main --id checks --agent synthetic-agent \
  --pane pane-1 --tab tab-1 --label 'Synthetic checks'
hud observe-herdr --root synthetic/main --id checks --remove
```

Registration does not launch/adopt a task; removal does not close its agent, pane or tab.
Optional `--workspace <id>` records its locator. Conflicting targets for the same root/id
are refused. Herdr is sampled read-only at most every five seconds; failed or mismatched
live evidence leaves last-known/unknown state. Jev liveness is file/process-only, with no
runtime connection, resume or launch from observation.

Active sorting only rearranges siblings. A running descendant brings its entire branch forward;
latest turn starts determine order, while ordinary token and log updates do not reshuffle the tree.
Parent links support both metadata locations. Missing status evidence stays unknown.

Each agent's rollout is read once, each read going on from where the last one stopped. How far each was read and what it held (status, stages, open calls) is kept in `$HUD_HOME/display/scan/`, one file for each rollout of more than 256 KB (mode 0600, removed after a week neither used nor written), so a panel or bar started again reads only what was written since. A saved read is used only while the file still matches it (the same file and thread, the bytes it ended on unchanged); otherwise the rollout is read again from its start.

Agents are named by the last segment of their task path, the name Codex's `/subagents` picker shows: `/root/essays_2020_2021` reads `essays_2020_2021`. That name heads the tree row, the card and the agent's log block until a label arrives. With Agent names on (as name, the default, once a backend is set), the model's short name for what the agent is on now then stands in for it in cards, rows, the compact tree, the timeline and the Inspector's heading, and changes as its work moves on (Settings → LLM → Agent names: under name keeps Codex's name on the compact card and puts the label below the name in the log; off keeps Codex's names); the Inspector always keeps the name Codex prints, and the retained native switch always goes by that name; the retired Original name card control does not return. Cards → Task label controls labels only on cards: off keeps their Codex names without changing the naming policy in other views or generating a new label. The random nickname Codex also assigns (Copernicus, Meitner…) stays in the Inspector; observed roles appear on work cards. Guardian approval reviews have no separate work card: their evidence remains in the Inspector and aggregate counts, not a card chip.

With the session read and its tree built, a session that has started no agent, subtask or review says so in one dim line under the title (`No agents started in this session yet`), with where the help is; until then, or with no session bound, the view stays blank rather than guess. With no model backend set and Agent summary shown, one dim line after the last card says no new summaries are written (`~ No model backend, so no new summaries: Settings → LLM`); stored ones stay on their cards.

Finished agents leave the list 3 minutes after they finish (Settings → Hide finished: 1m, 3m, 10m, 30m or never). Running and failed agents never leave, and a finished agent whose child is still shown stays dimmed (still a card in rich). The optional card clock, or the compact row, says how long ago it finished; the control bar counts what was put away (`⊕12`), and clicking that or `Ctrl+\` `a` shows everything again.

### Timeline

Pane 2, closed by default, lays the session out on the main session's axis, newest first, each entry with its age, said once at the top of a run of entries of one age.

| Level | What gets a line |
|-------|------------------|
| The main session (left) | A turn that finished, with the head of what it told you (`⏎`), approvals asked for and answered, compaction, a quota window crossing 80 % and 95 %, turns interrupted or failed, and failed tool calls, each by the command it ran (an `exec` script's first command, `✗ rg -n …`), else the tool's name; the same one in a row is one line with `×N`. |
| An agent the main session started (a level in) | A line for each of its stages: one that ended sits at its end, with how long it took, the subtasks under it, at any depth, that finished in that time (`✓2 ✗1`) and, for the agent's newest, the first lines of what it returned; one still running sits at its start, with its clock and what the agent said it would do. A helper's stage names the lead it was for (`Performance advice → Tokenizer speed`). |
| A subtask (a level further in) | Only those that matter (failed, flagged or in Key roles, independent of the card Child scope), at their end |

- Each agent is in its direction's colour, the one its card's name has: an L1 and the agents under it share a colour, a helper takes its lead's, and directions at work side by side get colours apart.
- **Agent colours** (Settings → Display, `agentColors`) says where that colour shows: on names and marks (`name`, the default), on the marks alone (`mark`: the timeline's rails and lanes, and the work kind's glyph on a card, the names in the text colour), or nowhere (`off`). The Inspector's heading follows it too.
- A failure's cause, when Failure cause wrote one, is under it, marked `~`.
- Facts the rollouts recorded only: a quiet stretch is not an entry. Guardian reviews' comings and goings are left out, their failures kept.
- A pending approval also says how long it has waited, on the bar's alert (widest form) and in the panel's status card.

Settings → Panel → Timeline style draws the levels three ways:

```
rail      28m ⏎ CJK stage 1 is merged; vertical punct…
          30m ├─▸ Performance advice                 ◵
              │    Checking whether the lookup table
          40m │ ╰✗ b03_review_harness              15m
          50m ├─▸ CJK correctness                    ◴

indent    28m ⏎ CJK stage 1 is merged; vertical punct…
          30m   ▸ Performance advice                 ◵
                  Checking whether the lookup table
          40m     ✗ b03_review_harness             15m
          50m   ▸ CJK correctness                    ◴

lanes     28m ⏎ │ │ CJK stage 1 is merged; vertical p…
          30m │ ▸ │ Performance advice               ◵
              │ │ │   Checking whether the lookup
          40m │ ✗ │   b03_review_harness           15m
          50m │ │ ▸ CJK correctness                  ◴
```

- **rail** (the default): the main session's entries on a rail down the left, the agents' off it, a subtask's a step further.
- **indent**: the same levels as indents alone.
- **lanes**: a lane beside the main session's for each direction that has subtasks or is at work, three of them, four from 48 columns wide; a direction's entries sit on its lane, and a lane runs from the top while its direction is at work.

Settings → Panel → Timeline span is the window: the last 1, 3 (the default), 6, 12 or 24 hours, and at least the newest eight entries whatever their age; a stage still running shows wherever it started. What is earlier is counted on a last row, `▸ 40 earlier`: a click on it, or Enter while the Timeline has the focus, brings back twenty more at a time. An agent's entry opens that agent in the Inspector: a click on any of its lines, or ↑/↓ to put the cursor on it (the cursor stops only on agents' entries and the earlier row; down starts at the top of the view) and Enter. Esc from that Inspector comes back to the Timeline, its cursor where it was. PgUp/PgDn, `g`/`G` and the wheel still scroll the view, and let the cursor go.

### Agent log

Each subagent has a log, newest first: its starts, finishes and failures and its latest updates as observed, written on the same read that updates the tree, and model-written brief/progress notes, digests and causes, marked `~` as model-written in compact and the Inspector. A rich card does not list that log (see the cards above); the Inspector does.

- **Language:** What a model wrote shows in the language it was written in: switch Language and the other language's notes step aside until a generator writes them again, while the observed entries stay.
- **It only grows:** a new brief adds to it rather than replacing the last.
- **It follows the tree:** An agent the tree hides (put away, filtered out, under a collapsed parent) is not shown, and a collapsed parent says how many logs are folded under it; showing the agent again shows its whole log.
- **In compact:** Each block is headed by the agent's status, kind glyph and Codex name, with its model name or task on the line under it; each agent shows its latest two entries, the selected one six and leads the list, and the Inspector shows all of them but the update it shows above, and none while the log holds only starts and finishes. Each entry's age is a column of its own, its text hanging beside it, without chat markdown. Clicking a log line opens the Inspector on that agent.
- **Storage and switches:** The log is kept per session in `$HUD_HOME/display/agent-log/` (mode 0600, removed after 30 days). Stored model notes, digests and causes remain available in the current panel language even with the backend off or models paused. In compact and the Inspector, observed entries are always available with a backend; with the backend off, Agents → Agent log controls those observed entries independently. Neither switch turns the log into card history.

### Inspector and Changes

Inspector shows, in this order:

1. Name, model and effort (the glyphs, then the full slug and effort: `☀◆ gpt-6-astra · max`; the card's badge is the short form, `6astra·max` in text mode)
2. Its task path, when that path has more than one segment
3. Status
4. Its context (`Ctx`) and, while it writes, its output rate (`Out ~42 tok/s`)
5. What it has spent over its life, once its rollout has reported it (`Tokens 1.2M in (cache 84%) · 32.1K out`, the cumulative `total_token_usage` of its newest report; narrow, the cache share goes, then the output)
6. Where the parent rollout still has plaintext from before this agent was created, that text under What it was given
7. Where the rollout keeps the task sealed, what it said it would do as it opened its newest stage (`Took on`, its own words, whole)
8. Its latest update, its task (always) and its log, turn age and last activity

Press `v` for full timestamps and UUIDs. Session-switch notices stay in the footer. A click on a blank row, or on the gutter left of a pane, keeps the next keys in the panel until Esc, or a click on the bar's `⌨ Keys here` chip, hands them back to Codex. Each long part sits under a dim rule (`── What it was given ──`), two columns in. A click on a card only selects it; a second click on its name within 400 ms switches the session. Enter, Space, `v` or `◫` opens the Inspector on the selection. `o` and `⌂` switch at once. In narrow Codex panes, session switching uses the unique-name fallback or asks for more width, as described in [Switching sessions](#switching-sessions).

The Inspector's **~ Model summary** section shows the newest stored model note in the panel language, separately from the agent's own Latest update. **Coverage** (`coverageAt`) identifies the public snapshot covered; **Generated** (`generatedAt`) is when the result was produced. Each appears only when that metadata is explicitly known. Older or periodic notes without coverage metadata say **Recorded** (their log timestamp), never an invented coverage boundary; no generated time is inferred. The section also explains progress context: backend off, models paused, live progress disabled, summary hidden, agent not live, no public progress evidence, refresh cooldown, retry wait (and remaining retry delay when known), progress concurrency cap or hourly model call cap. Queued and writing are distinct states. These diagnostics read existing state and do not broaden progress targets; rendering them makes no model call.

Changes lists the worktrees over the files, where there is more than one: a row each, the one whose files are listed marked `●` and in bold, how far its branch is from upstream (`↑2`, `↓1`) and its state on the right (`4 mod`, `clean`, `locked`); then a rule naming it again with its counts (`─ main · 2 unstaged ───`), and its files. One cursor runs through the worktrees and the files: on a worktree's row it lists that worktree's files, and Enter shows its details in the Inspector (its HEAD commit's subject, branch, state and counts, the full path under More; no hash). A settings file from before, with a Worktrees pane saved open, opens Changes. The files belong to the listed worktree; no file ownership is inferred from agent activity.
Each file is one letter for what happened to it, in its colour: `M` modified (yellow), `A` added (green), `D` deleted (red), `R` or `C` renamed or copied (blue), `!` a conflict (red); the lines it adds and removes are at the right end where they fit (`+12 −3`), and the counts above the list say how many are staged and unstaged. Untracked files fold into one last row, `▸ 12 untracked`: Enter or a click lists them under it, and again folds them. Compact summaries use Δ for changed files, S for staged and U for unstaged.
Select a file and press Enter for staged/unstaged patches (their hunks; the git header, which repeats the path and names blobs by hash, is left out) or bounded untracked-file content; an untracked directory lists how many files it holds and their paths. The heading names the file, with the lines it adds and removes (`+12 −3`) and, dim under it, its folder; each section is headed Staged, Unstaged or Untracked in the panel's language. A long line wraps where a word ends, its later rows two columns in so the `+`/`-` column starts only its first; a tab is spaces to the next fourth column. Inspector zooms automatically; Esc restores the panes.
Long preview lines wrap; additions are green, deletions red and hunk markers cyan, retaining +/- markers without color. Git reads disable external diffs,
content filters and partial-clone lazy fetching. The panel provides no staging, commit or checkout actions.

### Settings

The main Settings tab remains above the page and is highlighted while settings is open. Back, Save and Reset group are on the row beneath it; Reset all appears when there is room. Clicking the active Settings tab preserves the draft and cursor. Back, Esc, another navigation tab or a prefix command that leaves settings checks for unsaved changes. A dirty draft opens a confirmation: **Save and leave**, **Discard changes**, or **Continue editing** (the default; Esc also continues editing). Saving successfully applies the draft before continuing to the requested destination; a save failure keeps both the draft and the prompt, showing the error so you can retry or keep editing. With no changes, leaving is immediate. Navigation selects/opens its target rather than toggling an already-open view closed. This protection covers in-panel navigation, not F12 pane replacement, process termination or a killed tmux session.

**Reset group** (or plain `r` while settings is open) changes only the selected row's section in the draft; **Reset all** resets the known preferences owned by the settings page, not the entire settings file. Both require Save to apply. Neither resets the model backend, API credentials/base, model tiers or model override, reasoning option, hourly call cap, or picture asset path/file. Resetting LLM, or resetting all preferences, conservatively turns off every generation feature and sets Pause models on; it does not restore enabled generation defaults or grant permission to send material. Other section resets leave model permissions alone.

Settings → Panel → Width offers the widths the panel is laid out for: 32, 40, 48 columns (the default) and 56, each a step in what fits (the row meters, the model badge's words, the timeline's fourth lane); ←/→ step between them and come round past either end. Another width, from the settings file or a dragged border, still draws, and ←/→ step on from where it falls. Save applies it at once, and Codex keeps at least 41 columns, so in a narrow window the panel gets less than it asks for. A 0 from an older settings file reads as the default width, 48. The width is applied again whenever the tmux window changes size, as when a session started detached is attached from a wider terminal; dragging the border by hand is left alone. `CODEX_HUD_TREE_WIDTH` remains an initial override when no saved settings exist.

Settings has seven contiguous groups, in this order:

| Group | Rows |
|-------|------|
| Display | Theme, Look, Icons, Model label, Agent colours, Motion |
| Panel | Language, Layout, Panes, Status card, the Timeline's style and span, Width, Picture |
| Agents | Order, Hide finished, Key roles, Agent log |
| Cards | Task label, Agent summary, Turn clock, Stall threshold and Corners ([Card settings](#card-settings)) |
| LLM | Every feature that sends material to a model ([LLM](#llm)) |
| Status bar | Bar on launch, Density, Context, Notifications |
| Input | Mouse, Prefix key, Refresh |

Settings that only work together are one row: Brief pace (its two intervals as a pair), Agent names (as name, under name or off) and Notifications (off, tmux, or tmux and the desktop). The panes 2–4 have no row: the bar opens and closes them, and remembers them.

**Moving around**

- The page is an accordion: only the selected row's group is open, under its heading (`── ▾ Cards ──`); every other group is folded to one line with its name and the values that say most about it (`▸ Display  terminal · Tab row · Unicode`, a `*` in front when a row in it is unsaved), so all seven fit a 24-row page.
- ↑/↓ walk the rows in order and open each group as they enter it; PgUp/PgDn jump to the first row of the next or previous group; a click on a folded line opens that group at its first row without changing any value.
- The page is a modal: while it is open its keys are its own (arrows, Enter, `s` saves, `r` resets the current group, `Esc` requests leaving), and the footer names only the moves the buttons do not cover. Narrow views retain complete Back/Save buttons and use short labels.

**Rows and values**

- Labels stay left and values align at the actual pane's right edge, a non-default value in the accent; from 70 columns a stable help column occupies the right-hand portion instead.
- Saving a new panel width reflows the settings rows to that real width, not a fixed left-packed column; the selected one reads `‹ value ›`, and ←/→, Enter or a click change it (a click on `‹` steps back).
- The line under the list says what the selected setting does; when it is inactive, an additional selected-row message explains why.
- While Theme, Panes, Look or Icons is selected, a Preview above that line draws the panel's bar and a pane's title as the unsaved value would, so a look can be seen before it is saved.

**Saving**

- Unsaved fields show `*` and the Save button lights up; Bar on launch applies from the next launch.
- Save persists to `$HUD_HOME/hud-settings.json` (or `HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins.

**Rows that depend on others**

- Rows with unavailable dependencies are dim, but remain selectable so preferences can be preconfigured.
- The selected-row reason distinguishes backend off, model generation paused, and Task label without agent names.
- Card progress retains its original rich-layout and native summary-eligibility gates (Agent summary or saved child-summary preferences); Brief pace needs a periodic agent brief, main recap or change summary.
- Backend off is also explained by "takes effect with a backend" beneath it.
- Pause models keeps stored text visible; it does not turn off presentation switches.
- Agent log controls observed entries in compact and the Inspector when the backend is off, never a card history; with a backend, those observed entries are always available.
- Stored model notes remain available in the panel language with the backend off or paused, independently of Agent log.

**When the panel last read the session.** Above the help line, one row says when the panel last read the session (`HUD read the session 2s ago`) and, if a read has failed, where, when and why; a failure newer than the last good read is shown as a warning. That is how a quiet session and a HUD that cannot read stop looking alike, since a failed read otherwise leaves the last good values on screen.

Agents → Key roles (`importantRoles` in the settings file) names the roles whose subtasks matter. The page offers none, the default, each role the session's subtasks have, as the observed roles say it, and what is set; several at once are a comma list in the settings file (`"importantRoles": "critic, oracle"`), which the page keeps among its values. A subtask in one of them is eligible under its lead's saved important-scope child-summary policy (not a restored child-card row), gets a line in the Timeline and is named in the Agents brief's report, as a failed one or one a note flagged is. A name matches the role or the role's end after a dash, so `critic` names `team-platform-critic`. With none, only failed and flagged subtasks matter.

### Card settings

Settings → Cards is presentation, not permission to send material. The compact work card has five controls:

| Setting | JSON key | Default | Controls |
|---|---|---|---|
| Task label | `cardLabel` | `true` | Model-written task label on the card; no label-generation request |
| Agent summary | `cardSummary` | `true` | The newest stored model summary, shown only where a native grant already allows one; no model call or source permission is added |
| Turn clock | `cardClock` | `true` | Minute-valued elapsed time on the card |
| Stall threshold | `cardStallMinutes` | `10` | Minutes without meaningful progress before a card reads stalled; an integer 1–120, offered as 5, 10, 15, 30 or 60 |
| Card corners | `cardCorners` | `square` | `square` or `round` |

The content presets and ten retired rich-card booleans no longer have controls or restore old card contents; Task label, Agent summary and Turn clock remain active. Old settings files still load. Persisted native summary-eligibility preferences keep their existing collector/privacy effects, without granting material or a model call. Turning off Agent summary removes that card's sentence; it does not change periodic briefing, result digest, failure cause, label generation or another generator's permission.

### LLM

Everything the panel asks a model to write is in the LLM settings group, each item with its own switch, and every item is written in the panel's language and displayed as model-written text, not as observed fact (card summary text is model-written; compact and Inspector mark model text with `~`).

- **Backend:** LLM → Backend picks who writes, `agy` or any OpenAI-compatible chat completions endpoint (`api`); off makes no model calls and sends nothing. Generation/privacy settings are separate from the Cards presentation switches. OMP is removed; saved `omp` settings migrate to `api`.
- **One queue, one cache, one cap:** All items share one queue (one call at a time), one cache and one hourly cap (Call cap, 60 calls an hour by default, counted across panels of the same `$HUD_HOME`); a request past the cap is refused and the reason is shown where its text would be. Settings shows the calls made today under the list.
- **Brief pace** controls the periodic agent brief, main recap and change summary, not on-demand Card progress, with two figures; it offers 1m · 5m, 2m · 10m, 5m · 15m and 10m · 30m:

  | Figure | Default | How often it may run an item |
  |--------|---------|------------------------------|
  | **Interval** | 5 minutes | News that matters: a stage, status or failure changing, a prompt, a final reply |
  | **Floor** | 15 minutes | Routine news: an agent's new update or command, a turn that runs long, a diff that changed |

- **Language:** Settings → Panel → Language is the language of everything a model writes too: switching it asks again at once, what a model wrote in the other language is neither shown nor sent back as the previous brief or recap, and what the next run keeps from them it translates. A reply plainly in another language than asked (Japanese or English for Chinese, Chinese or Japanese for English) is refused as an invalid response, never cached, and shown as a failure where its text would be; a name or a short quote in another language passes.
- **Storage:** The cache and the call log (timestamps only) are kept in `$HUD_HOME/display/model-cache/`, mode 0600.

What each item sends:

- **Periodic agent brief** (`briefAgents: true` by default; requires a backend): a sentence on the subagents as a whole at the top of the area, and a note per agent that goes into its log. It sends a report with an entry for each agent the main session started (guardian reviews left out), one that works for another right after it: its name and role; its stage and how long it has run, or when it finished or failed; who assigned it, and its task (300 characters) or else the words it took the task on with, its first update of the stage; its latest public update (600 characters) and the command it is running now (200); what its last stage returned and, shorter (300), the two before; its subtasks counted by role, with up to four that matter (failed, flagged by a note, or of a role named in `importantRoles`) named with their state and their answer or cause; failed approval reviews; and who wrote to it during the stage. An answer of up to 1,500 characters is sent as it is; a longer one as its Result digest when that is on, otherwise as its head and tail. The report starts with the agents that need attention (they or a subtask failed in the last hour, or a note says so), then the running ones, then those finished in the last half hour; one finished longer ago gives only its last result. With it go what happened since the previous brief (stages begun and ended, failures; 20 events at most) and the previous brief itself, its sentence and the newest notes, so the model writes notes only for the agents the news is about, eight at most, and every other agent keeps its note. The request is held to 16 KB: past that, lines give way in a fixed order, each from the bottom of the report and only as far as needed (earlier stages' answers; all but the first line of an agent with no subtasks; agents finished over half an hour ago; latest updates; the subtasks that matter; the answers of agents finished in the last half hour, then those agents; all but each agent's first line; then whole agents), and an agent that needs attention is never cut. With Agent names on, each note also names what the agent is on now and its kind of work (below), in the same reply. It runs at most once per interval, when an agent's stage, status or failures change; a new update, the command it runs or its routine subtasks moving on are sent at most once per floor. A reply that is not the JSON asked for is sent back once to be put right; if that fails too, the last brief stays, and the area says so.
- **Main recap** (`briefMain: false` by default): a rolling recap of the main session, shown in the status card (rich) or at the top of the brief area (compact): the goal, what is done (at most four items), where it stands, and, painted as a warning, what it needs from you. It sends your prompts and the assistant's public replies and commentary (each cut to about 600 characters, about 4,000 characters in all, never its reasoning), the plan steps, a pending approval's summary, the compaction count, the goal set with Codex's `/goal` and its status (read from `$CODEX_HOME/goals_1.sqlite`, read only, when it can be), and the name, status and turn time of each subagent; subagents' tasks and updates are sent only when Agents brief is on as well. A prompt that starts with a tag in square brackets (`[watcher] …`) or with a peer's header, who to whom and that it is a peer's (`Docs lead → Root (peer, no reply owed).`), is sent marked as possibly automatic, since tools that write into the session tend to start that way, and does not count as you sending a prompt. Each run is given the previous recap and only what was said since, so it stays cheap and survives Codex compacting the conversation. It runs as soon as the interval allows when you send a prompt, a final reply lands, a turn ends, a plan step completes or an approval is asked for; while a turn runs long (waiting on subagents, say) it is refreshed at most once per floor (15 minutes by default, never more often than the interval) if anything at all changed, commentary or a subagent moving on included. Nothing changed, nothing is sent. The recap is saved per session in `$HUD_HOME/display/recaps/` (mode 0600, removed after 30 days), so reopening the panel or `codex resume` shows the last one at once with its age; a recap in the other language is asked for again. In rich it is shown in the status card at level full; in compact, at the top of the brief area.
- **Card progress** (`agentProgress: true` by default, independently of `briefAgents`): generates current notes through the unchanged **native summary-eligibility policy**, while the Agents pane is shown and no modal is open; task/facade-only text is never a new subject. Agent summary off excludes that L1; Child agents or Child summaries off excludes those children. Saved Child scope, list filters and linger rules continue to constrain eligible native targets; it does not request every descendant merely because a parent is present. An allowed native note can supply the compact card's optional sentence; full notes and queue/writing/failure/cap diagnostics remain in the Inspector, not the compact body. Retired child-display preferences still constrain native collector eligibility for compatibility; they do not restore helper prose on cards. Raw reports and log history stay in the Inspector. It sends only public current-turn evidence: up to four reports (600 characters each), stage intent (300), open tool/action (200), plaintext task and pre-create charge (300 each), name/role (80 each), stage metadata and descendant status counts. No reasoning or sealed task is sent. With no public report, stage intent or open action, no progress is invented and no request is made. Output is **one sentence of at most 120 characters** in the panel language. The first request does not wait for Brief pace; unchanged input is deduplicated/cached, changed input refreshes at most once per minute, and failures retry after ten minutes. Hiding the relevant summary or Agents pane, opening a modal, backend off, Pause models, or changing session/language/turn cancels obsolete work. Card progress shares the queue and call cap but remains independent of the periodic agent brief and recap.
- **Result digest** (off by default): when a subagent finishes, its whole final answer (the public final reply only; when it is longer than about 8,000 characters, its head and its tail) is sent once, and comes back as three short lines: the conclusion, what it rests on, and the caveats the agent itself gave. An agent the main session started has each stage's answer longer than 1,500 characters digested as well, when the stage ends. The digest goes into the agent's log, is shown in the Inspector under "~ Result digest", and stands in for the answer in the Agents brief's material. Agents that finished more than an hour before the panel saw them are digested only when you inspect them.
- **Agent names** (as name, on by default; nothing is sent until a backend is set): a short name for what each agent is working on now, of about 10 Chinese characters or 4 English words, and a kind of work (research, experiment, fix, review, writing, summary or other). The Agents brief writes them beside its notes, in the same reply and at no extra cost, from what it is sent already; it keeps a name while the work is the same and gives a new one when the work moves on, and the newest in the panel's language is shown. Codex 0.162 and later send a subagent its task encrypted. The labels job sends, once, what the parent wrote in plaintext before that subagent was created (400 characters, with the task path and role), or a plaintext task when there is no such text, several in one request; a Fernet payload is not sent. That name is the one the card uses. The brief's name, from the agent's updates and stages, is the fallback until it arrives, and does not replace it. Outside compact work cards, the kind is drawn as a fixed glyph the HUD picks, dim beside the agent's name: ⌕ research, ⚗ experiment, ⚒ fix, ◈ review, ✎ writing, ∑ summary, none for other (the legend is in `?`). As name, the short name stands in for the agent's name in the panel; under name, the compact card keeps the native name and the label remains below the name in the log block; off keeps Codex's names and asks for neither. Cards → Task label can suppress the label on cards without changing other views, and Codex's original name is retained in the Inspector, not a second card-name row. The Inspector keeps Codex's name, the one `/subagents` prints, and switching goes by it. Until a name arrives, with the feature off, or when the call fails, a card shows Codex's name and no glyph. The brief's names are kept with its notes in the agent log; names from task texts are kept by a hash of the text in `$HUD_HOME/display/model-cache/labels.json` (0600), so a task is named once ever, and entries written before names had a kind still read, as kind other. The session also gets a title: the recap's goal when Main recap has written one (no call), otherwise one call with your **first prompt** (1,500 characters). The title is saved as `<session>.title.json` beside the recaps and shown in the bar's session field at its widest reading, with the session id beside it.
- **Failure cause** (off by default): when a main-session tool call fails, the command and the last 2,000 characters of its output are sent; when a subagent ends in error, the error events from the end of its rollout (or the last failed command's output) are. One line naming the cause comes back, shown under the event in the Timeline and, for an agent, in its log and the Inspector. A failure whose rollout recorded no error output sends nothing.
- **Change summary** (off by default): while the Changes pane is open, when the diff's files or line counts change, at most once per floor, the per-file stat (40 files at most) and up to 6,000 characters of the staged and unstaged hunks are sent; untracked files are sent by name only. One or two lines on what the diff does come back at the head of the pane, marked `~`; once the diff has moved on, the old summary says so until the next one.
- **Approval words** (off by default): when a command waits for approval, the whole command (2,000 characters at most) is sent, and one sentence describing what it does is shown at the top of the brief area as "~ Approval, in the model's words:". It describes only: a reply that judges whether the command is safe is dropped rather than shown. It does not replace reading the command; Codex's approval prompt is still where you answer.

Reasoning and private channels are never read for these model features. Card visibility affects display and automatic progress targets only: periodic briefs and the independently enabled digest, name, cause, change and approval generators keep their own scope. Presets, resets and summary diagnostics add no new model material, network destination or credential storage; the existing LLM permissions and connection settings still govern generation.

Background job answers are cached by their input, backend, endpoint and actual model, also across panels. Briefs and rolling recaps are not cached. A failed background job retries after 10 minutes.

`codex-hud brief --dry-run` prints the brief the panel would send now for the current directory's session, the instructions and the material with their sizes, from the saved settings, the agent log and the last recap; no model is called and nothing is written, and it works while the backend is off. It previews brief/recap material, not Card progress or the other background jobs. `codex-hud brief --dry-run FILE` writes it to FILE (mode 0600) instead.

`Ctrl+\` `b`, or a click on the bar's pause button (Pause models), pauses and resumes every item above (`briefingPaused`, default `false`; offered with a model backend). LLM → Pause models is the same switch; stored model text is kept, including when both periodic brief switches are off. The connection is not typed into the panel: with LLM → Backend selected, Settings names the settings file (`$HUD_HOME/hud-settings.json`, `~/.hud/hud-settings.json` by default, or `HUD_SETTINGS_PATH`) and its connection keys, says whether a base and a key are set (never showing either value), and for `agy` names `CODEX_HUD_BRIEF_MODEL`. For `api`, set these in `hud-settings.json`:

```json
{ "briefing": "api",
  "briefingApiBase": "https://api.mistral.ai/v1",
  "briefingApiModel": "",
  "briefingApiLiteModel": "deepseek-v4-1-flash-1017",
  "briefingApiLowModel": "deepseek-v4-1-flash-1017",
  "briefingApiMediumModel": "deepseek-v4-1-flash-1017" }
```

An empty base is `https://api.mistral.ai/v1`. The key comes only from the process environment or `$HUD_HOME/credentials.env`, by **exact endpoint origin**: `https://api.mistral.ai` gets `MISTRAL_API_KEY`, `https://api.openai.com` gets `OPENAI_API_KEY`. Environment variables override the matching credentials-file names. Custom/local endpoints, lookalike hosts, HTTP variants and non-default ports receive neither key; URLs with userinfo are rejected. With no matching key the feature is off and no request is made. HTTP redirects are refused rather than forwarding credentials or session material. Settings hold no key: keep keys in the environment or the credentials file (settings are written 0600).

API tasks route by feature: labels, titles and approval descriptions use the lite tier; active progress summaries, agents briefs, result digests and change summaries use low; main recaps and failure causes use medium. A nonempty `briefingApiModel` overrides all API tiers; `CODEX_HUD_BRIEF_MODEL` overrides either backend. Product defaults are the Mistral base and `deepseek-v4-1-flash-1017` on all three tiers; `agy` keeps `gemini-3.8-flash-low`.

Settings → LLM offers **Lite effort**, **Low effort**, **Medium effort** (`briefingApiLiteEffort`, `briefingApiLowEffort`, `briefingApiMediumEffort`). They default to `none`, `low` and `high` and offer `off | none | low | high | xhigh | max`. `off` omits `reasoning_effort`; `none` explicitly disables reasoning. Other values send exactly the chosen effort. `minimal` and `medium` are accepted only when explicitly typed in a settings file for an endpoint that supports them; they are never inferred or offered by the panel. DeepSeek V4.1 Flash on Mistral rejects those two values. There are no silent fallback/retry requests with another model or effort. When a bounded request sends reasoning other than `none`, `max_tokens` includes 512 extra reasoning tokens above its ordinary output bound. Thinking parts in a multipart Mistral response are ignored; only answer text is displayed.

Removed legacy keys (`briefingApiKey`, `briefingApiReasoning`) are ignored when an old settings file is read and dropped the next time settings are saved; the other keys in that file are kept.

### HUD credentials and Jev configuration

The HUD reads `$HUD_HOME/credentials.env` (`HUD_HOME` defaults to `~/.hud`). It must be a regular file with mode **0600**; symlinks and FIFOs are refused without following/blocking. Format is `NAME=VALUE`, optionally prefixed `export ` and/or quoted; there is **no interpolation**. Known names are `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MISTRAL_API_KEY`, `MISTRAL_BASE_URL` and `TEXT_MODEL_*`. Model/base settings otherwise stay in configuration; file names for these non-secret legacy settings are retained for compatibility.

```dotenv
TYPESAFE_API_KEY=synthetic-typesafe-key
OPENAI_API_KEY=synthetic-openai-key
MISTRAL_API_KEY=synthetic-mistral-key
```

Credentials are re-read, not cached. Each name resolves from the process environment first, then `credentials.env`. Missing files yield no keys. No key is read implicitly from pi, Codex, jev-ask or any other file, and `jev.env` is never a fallback.

**Decision provider.** `config.json` takes `decisions.primary` and `decisions.fallback`, each `typesafe` or `openai`; with neither set they are `typesafe` and `openai`. When top-level `decisions.primary` is absent, `decisions.provider` is read as primary, then the older `jev.decisions.provider`. A fallback is used only when its key is present. It takes over that one call for a quota (429), auth (401/403), 5xx or timeout failure from the primary; a malformed or refused answer stays with its provider. A missing primary key with a fallback key present uses the fallback with reason `credentials_missing`; with neither key the call fails `jev_credentials_missing`, naming the primary's variable. There is at most one fallback call and no second browser action: the job record's `decisionCalls` names the provider that answered and any fallback reason.

**Importing old configuration.** Old locations are reached only by an explicit one-time `hud import preview|apply [--from <file>]...`; nothing is discovered automatically and no Codex home is guessed. Name each old `hud-settings.json` or jev-ask TOML with `--from`; an explicitly named `.env` is supported too. `$HUD_HOME/jev.env` is merged into `credentials.env` automatically when present. `preview` prints sources, destinations and the names/keys it would add or skip, and writes nothing; `apply` never overwrites an existing HUD value (existing wins, each skip is reported), backs up every destination it changes (timestamped, 0600) and is idempotent. Output never contains values. A TOML's `[jev]` section maps to `jev` in `config.json` (`cdp_url` → `cdpUrl`, `chrome`, `profile`, `state_dir` → `stateDir`, and the other camelCase fields) and `[aistudio]` to `aistudio` (`cdp_url` → `cdpUrl`, `state_dir` → `stateDir`, `models`, `default_model` → `model`, `default_thinking` → `thinking`). Runtime TOML and `JEV_ASK_CONFIG` are ignored.

```bash
# Preview: sources, destinations and names only; writes nothing.
hud import preview --from /tmp/old-codex/hud-settings.json --from /tmp/old-jev/config.toml
# Apply once: existing HUD values win; changed files get timestamped 0600 backups.
hud import apply --from /tmp/old-codex/hud-settings.json --from /tmp/old-jev/config.toml
```

**Jev locations.** `cdpUrl`, `chrome`, `profile` and `stateDir` are required in the `jev` section of `$HUD_HOME/config.json`; there is no built-in CDP URL. A missing one fails closed before any browser contact (`pre_send`), naming the missing key and `hud import`. Sharing the owner's existing logged-in Chrome and jev-ask state directory is supported only as explicit values in that file, never as a code default. AI Studio settings live in `aistudio`, with `stateDir` required and `cdpUrl`, `models`, `model` and `thinking` optional; its `stateDir` keeps the deliberately shared one-send-per-key semantics and must already exist. `jev.stateDir` likewise explicitly names the owner's shared operation-record directory. A missing configuration reports the HUD file.

**Source-scoped keys.** A delegated-digest source may name its own key variable in its private `model.json` (`connection.keyEnv`). That name resolves from the captured environment first, then `$HUD_HOME/credentials.env`, and from no other file; `keyEnv: null` is accountless and sends no key. It is separate from the panel: a host-matched panel key is never sent to a source's custom base, and a source's key never feeds the panel. The panel path with a custom base and no host-matched key is off and makes no request.

### Picture

Panel → Picture draws a picture in the panel's empty space: braille dots, dots in the picture's own colours, or ASCII. It only takes lines nothing else is using, and gives them back as the agents and the brief need them. `bin/codex-hud-art <image> [dots|color|ascii]` copies a picture next to the settings and switches it on; `bin/codex-hud-art off` switches it off. ffmpeg reads the picture, so any format it knows works.

## Output throughput

The bottom bars do not show the rate (they show no clocks or rates at all, see [The bottom bars](#the-bottom-bars)); the panel's status band writes `~42 tok/s`.
Selected-agent details show that agent's estimate; expand with `v` to see the sample interval.
The estimate follows the **wallclock** convention: measured **output** tokens divided by
elapsed time in the current turn, including initial latency (TTFT) and generation stalls,
minus the union of identifiable tool-call/output waits. Parallel waits are deducted only once.
Only fully closed wait unions are deducted; missing results conservatively remain in elapsed time
instead of freezing the denominator while output continues to grow.
There is no 30-second rolling window, smoothing, speed cap or one-second minimum.
Codex rollouts lack exact per-request start/stream-end telemetry, so `~` marks a turn-level
proxy, not an exact reproduction of Pi's request-timed wall TPS or pure decoding speed.
Unidentified waits and logging delays may remain in the denominator.
If the prior counter is missing, the estimate waits for two cumulative reports and covers only
their measured interval. A first report's last-call usage may repeat the previous turn, so it
is never used to invent a turn-start counter.
Repeated unchanged counters do not dilute or refresh a reading.
A new turn excludes the preceding idle gap. After 10 seconds without a new sample, the panel's
`last ~42.1 tok/s` retains the previous reading. Context usage stays in the bar; the workbench has no Ctx trend.

## Machine-readable state

The bar fits itself to a pane: it shortens what it says and hides what does not
fit, which is right for a reader and wrong for a script. So each collection
tick, of whichever of the bar or the panel is running, also writes what it knows to
`$HUD_HOME/display/state/<tmux-session>.json`, and `codex-hud --json` prints the
file belonging to this directory's session. The panel writes an empty `bar.segments`.

```bash
codex-hud --json | jq '.context.percent, .agents.active, .attention[].label'
```

It carries the session, project, activity, context, quota, tokens, agents and
attention items, `approvalSince` while an approval is pending, `quotaForecast`
when a projection holds (an estimate, not a reading), plus `bar.segments`: which field ended up in which columns of
the line that was actually drawn. That is what turns a click at a column into
the field under it.

`agents` counts as the panel does (see [Layouts](#layouts)): `active`,
`completed`, `failed` and `unknown` are the agents the main session started,
one active while a subtask of it is; `agents.subtasks` and `agents.reviews`
give the same four for their subtasks and for the guardian reviews; and
`agents.nodes` lists every thread with its `kind` (`agent`, `subtask` or
`review`). This is `version` 2; version 1 counted every thread together.

The same rules as the display apply. Every value is something that was
observed, and a field with no data is absent rather than zero, so `no quota
snapshot` and `quota at 0%` do not look alike. The file is written atomically
with mode `0600`, only when something other than the clock changed, at most
once a second, and it is deleted when the process that wrote it stops: a state file for a HUD
that is no longer running would read as live. The owner is the pid in `<file>.owner`. A process that does not own the file leaves it in place, so a panel that is closing does not delete a snapshot the bar has just taken over.

`health` says whether the bar's own reads go through: `lastReadAt`, when the
session lookup and rollout read last succeeded, and `lastError` (`source`,
`message`, `at`), the most recent failed collection. Each is absent until it
happens. Another successful read alone does not rewrite the file, so
`lastReadAt`, like `updatedAt`, is as of the last write.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_DENSITY` | `balanced` | Kept for old settings files; the bottom bars no longer read it, `barFields` chooses their fields |
| `CODEX_HUD_THEME` | `terminal` | Palette (`terminal` / `titanium` / `mocha` / `latte` / `none`) |
| `CODEX_HUD_LOOK` | `tab` | How the panel's bar and pane titles are drawn (`tab` / `band` / `tile` / `frame` / `pill`) |
| `CODEX_HUD_ICONS` | `unicode` | The panel's icons (`unicode` / `nerd` / `emoji` / `text`) |
| `CODEX_HUD_GLYPHS` | `both` | Model badge style (`glyph` / `text` / `both`) |
| `CODEX_HUD_STATUSLINE` | `1` | Bottom bar enabled by default; `0` disables for new HUD sessions, overriding Settings → Bar on launch |
| `CODEX_HUD_CONTEXT` | `used` | The panel's context percentage: `used` or `remaining`; also available in Settings. The bottom bar reads tokens |
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | `1` | HUD height in lines |
| `CODEX_HUD_MOUSE` | `1` | Enable mouse/trackpad scrolling |
| `CODEX_HUD_SKIP_FONTS` | unset | `1`: the installers leave the MesloLGS NF font out |

Status glyphs use semantic colors: cyan `▸` working, green `✓` turn complete, yellow `■` interrupted, red `✗` failed. Yellow `?` means collection failed. Silence does not turn a working session idle.

### The bottom bars

Claude's statusline, pi's footer and Codex's tmux bar are one line each, built by one function
(`src/render/layout/bar-fields.ts`) from facts each client collects. They show the same fields in the same order, at
every width, and a field a client cannot supply is left out, never shown as zero:

```
model effort │ context %/window │ repo branch(dirty) │ quota │ notice zone ········ MCP n  skills n
```

- **model**: the model and its effort, the name short and taken from the model id (`opus-5.5 high`, `5.6-astra xhigh`,
  `v4.1-flash max`: the route and vendor words, the date or build and the `[1m]` tag go, version hyphens become dots);
  the provider's mark leads it in both styles (`✻ opus-5.5 high`; `text` icons: the provider's initials).
- **context**: claude-hud's bar and the percentage against the window (`████░░░░░░ 40%/400K`, the same on all three:
  ten cells, `█` filled and `░` empty in dim, the filled cells and the percentage green below 70%, yellow from 70%, red
  from 85%; in the p10k style the capsule has the percentage only). The window is where the client compacts when it
  says so: Claude's `autoCompactWindow` (the model's
  own entry under `modelSettings`, else the top-level one, in `settings.json` under `$CLAUDE_CONFIG_DIR` or `~/.claude`;
  a `[1m]` suffix on the model id is ignored; used only when `autoCompactEnabled` is not `false` and the value is below
  the model's window) and Codex's `model_auto_compact_token_limit` from `config.toml`; otherwise the model's whole
  window. pi has no such setting. The files are read, never written.
- **project**: the repository and its branch with its state (`example main*↑2`; pi: `main +1 *1 ?1`).
- **quota**: each client shows only its own. Claude: the `rate_limits` in its statusline input; Codex: its account's
  windows; either as claude-hud draws them, `5h █░░░░░░░░░ 8% (1h19m)` (the bar and percentage bright blue, bright
  magenta from 75%, red from 90%; the reset in parentheses). The 5 h window always shows; the 7 d window only from 80%
  (or when it is the only one). Codex's credits that carry the account on show as `credits 6.8K`. pi has no window: its
  session cost, `$0.420` as pi reports it, `~$0.420` when the list price estimates it. No client reads another's usage.
- **notice zone**: events only. A subagent or HUD job that started, finished or failed, and a skill that was loaded,
  each show for three minutes. A subagent or job is claude-hud's agents line, its name, model and effort and nothing
  else (`◐ frontend-implementer [sonnet-5.5 · xhigh]` while it starts or runs, `✓ …` finished, `✗ …` failed; the name in
  magenta, the brackets dim; a part that is unknown is left out, so `[haiku-4.5]` or no brackets at all). The name is
  the Claude subagent's type, the HUD job's role or the Codex agent's role (else its nickname); the model is the
  call's (else the result's, else the type's definition) and the effort is the type's definition's `effort:`, read
  from the frontmatter of `.claude/agents/<type>.md` in the project, else of `agents/<type>.md` in `$CLAUDE_CONFIG_DIR`
  or `~/.claude` (built-in types have none); a HUD job's are its own model and thinking. A skill load keeps its age
  (`✦ skill hud-delegate · 30s ago`). Each subagent or job has one item, its latest event, so `✓` replaces `◐`. The
  zone shows two items side by side where there is room for both (each at least as its name alone), the pair advancing
  every five seconds (`k = floor(now / 5 s) % ceil(n / 2)`, items 2k and 2k+1); with room for one it shows one and the
  current ones take turns; nothing rotates when everything fits.
  What needs you (an approval, a HUD job's question) is pinned on the alert colour in the first slot for as long as it
  is open, and the second slot rotates through the events. There is no running line, no tool at work, no turn-done
  notice and no last-event fallback: an idle session leaves the zone empty. A notice shows in full: when it is in the
  way the whole `loaded` cluster goes first, then the other fields shorten in the order below, and when that is not
  enough it is cut at a word with `…` (a bracket goes whole or not at all) before the effort goes. Skill loads come
  from Claude's transcript only; pi and Codex expose none.
- **loaded**, at the right edge: MCP servers and skills (`MCP 2  skills 10`), and in pi the other extensions' words.

Gone from the bars: tasks, output rate, cache percentage, time to first token, the turn's clock, active time, turn-done
notices, hooks, CLAUDE.md and rules counts, sandbox/approval mode and session age. The panel keeps its own band.

Narrow, the line gives up in this order, cheapest loss first, and the model is never dropped: the loaded cluster (to
counts only, or at once when a notice is showing); the context bar (the numbers stay); the quota's reset; the quota's
bar (`5h 8%` stays); the project's short form; the loaded cluster; a notice is cut at a word; the effort; the
project's name only; the quota; the project; the context.

Two keys in `$HUD_HOME/hud-settings.json` (or the environment) apply to all three bars at once; there is no settings page
for them, and a saved key wins over the environment like the other display settings:

| Key | Environment | Values |
|-----|-------------|--------|
| `barStyle` | `HUD_BAR_STYLE` (`CODEX_HUD_BAR_STYLE`) | `line` (default: `│` separators), or `p10k` (powerline capsules: each field on its own colour with a space either side and a powerline arrow into the next, flat without arrows when `icons` is `text`; theme `none` has no colours, so it stays `line`) |
| `barFields` | `HUD_BAR_FIELDS` (`CODEX_HUD_BAR_FIELDS`, comma separated) | A list from `model, context, project, quota, notice, loaded`; the default is all of them. The order stays fixed; the key only switches fields off. |

With the `text` icon set (`CODEX_HUD_ICONS=text`) the provider mark in the p10k look is the provider's initials.

The panel's context percentages follow [Codex 0.154's calculation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L2258), subtracting the fixed 12K baseline from both the latest context usage and the window, so `20%` there equals native `80% context left`. Custom windows <=12K retain a raw-window fallback. Cumulative session tokens never measure context fill.

```bash
CODEX_HUD_STATUSLINE=0 codex
CODEX_HUD_CONTEXT=remaining codex
CODEX_HUD_GLYPHS=glyph CODEX_HUD_THEME=mocha codex
```

Saved display preferences override environment defaults; change Context, Theme and Model label in Settings when preferences already exist. Wheel events go to mouse-aware applications or fall back to tmux history scrolling. HUD bindings use a separate key table, and right-clicking the side panel no longer pastes clipboard text or moves keyboard focus.

Settings → **Bar on launch** saves the bottom bar preference for the next new HUD session. An explicit `CODEX_HUD_STATUSLINE` takes precedence over that saved value.

<details>
<summary>All environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_NOTIFY` | `0` | Announce failures and finished agents through tmux |
| `CODEX_HUD_NOTIFY_COOLDOWN` | `300` | Seconds before a different alert of the same kind can fire |
| `CODEX_HUD_NOTIFY_DESKTOP` | `0` | Also raise a desktop notification (needs `CODEX_HUD_NOTIFY=1`) |
| `CODEX_HUD_REDUCED_MOTION` | `0` | Stop the traffic marker from animating |
| `NO_COLOR` | (unset) | Any value forces the `none` palette |
| `CODEX_HUD_HEIGHT_AUTO` | `0` | Auto-adjust height based on width |
| `CODEX_HUD_HEIGHT_MIN` | `CODEX_HUD_HEIGHT` | Min height in auto mode |
| `CODEX_HUD_HEIGHT_MAX` | `12` | Max height in auto mode |
| `CODEX_HUD_AUTO_ATTACH` | `0` | Auto-attach to latest session in same dir |
| `CODEX_HUD_HERDR_BRIDGE` | `1` | In Herdr, enable native Codex detection with a foreground-process hint and main-pane title relay; read back status for diagnostics. `0` disables this integration. No Herdr configuration changes. [Details](./herdr-context-fix.md) |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | tmux alternate-screen for codex pane |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | Clear scrollback on first render |
| `CODEX_HUD_CWD` | (unset) | Override working directory |
| `CODEX_HUD_PROFILE` | `0` | `1` times each stage of the bar's and the panel's ticks and appends a summary per stage every 10 s to `$HUD_HOME/display/profile.log` |
| `HUD_HOME` | `~/.hud` | The one HUD home: settings, `config.json`, `credentials.env` and everything the HUD writes under `display/` |
| `HUD_SETTINGS_PATH` | `$HUD_HOME/hud-settings.json` | Explicit settings file override |
| `CODEX_HOME` | `~/.codex` | Codex home directory; read for transcripts and Codex's own config, never written by the HUD |
| `CODEX_SESSIONS_PATH` | (unset) | Override sessions directory |

</details>

### Notifications

Off by default, because Codex has its own notifier and two pop-ups for one
event is worse than none. Settings → Status bar → Notifications, or
`CODEX_HUD_NOTIFY=1`, turns them on: `tmux` for tmux messages, `tmux + desktop`
for desktop notices as well (`CODEX_HUD_NOTIFY_DESKTOP`). A variable that is
set wins over the setting. The open panel announces on the same terms, on its collect tick.

```bash
CODEX_HUD_NOTIFY=1 codex
```

It announces failures it observed, approvals Codex is waiting on, and agents
that finished, one message per occurrence, with a cooldown so a flapping
condition cannot become a stream. It never acts on the session: no
auto-approval, no keystrokes, no retries.

`CODEX_HUD_NOTIFY_DESKTOP=1` adds a notification outside the terminal. It is a
second opt-in because leaving the terminal is a bigger ask than a tmux message.

```bash
CODEX_HUD_NOTIFY=1 CODEX_HUD_NOTIFY_DESKTOP=1 codex
```

Two routes, both best-effort and both silent when unsupported: the OSC 9 and
OSC 777 sequences a terminal may raise itself (wrapped in tmux passthrough,
which the wrapper enables), and `notify-send` on Linux or `osascript` on macOS.
Notification text comes from the rollout, so every control character is
stripped before it is written: a message cannot close the sequence and have its
tail run as terminal commands.

### config.toml

The HUD reads from `CODEX_HOME/config.toml`:

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

New sessions start with the compact bottom bar; `F12` or `/hud` opens the panel. The main session rate keeps space ahead of optional model/age fields at ordinary panel widths. A sample older than ten seconds, from a previous turn, or shown while idle is labelled `last`, rather than disappearing or implying a live measurement.

### Diagnostics and connection checks

Press the HUD prefix (`Ctrl+\` by default), then `d`, to open HUD diagnostics
in the Inspector, including the main session's TPS sample time, sample duration
and estimation method. In an agent's Inspector, Enter expands those same TPS
details. Current-turn, older/previous-turn and missing measurements are distinct.
The JSON snapshot also includes optional `outputRate` evidence and `health.sessionBound`.

The normal panel shows current faults without opening Settings: no bound Codex
session, failed session reads, Herdr probe/transport failure, uncertain notification
history after reconnection, and classified model failures or queue waiting. The
compact bar shows collection/bridge problems. Diagnostic details retain the last
successful read/acknowledgement; normal operation adds no diagnostic banner.

Settings → LLM offers **Test API** (or `t` in that group), and `t` again cancels.
It checks the lite/low/medium routes from the current draft, with fixed synthetic
messages only, up to 256 output tokens per request and a 15-second request timeout.
The three calls share the normal hourly budget; nothing is saved and no session
text is sent. Backend off or AGY does not issue an API test. Closing Settings or
changing the connection cancels pending checks and prevents late results from
reappearing. Results distinguish authentication, unavailable model, rate limiting,
timeout, connection/service failure, output truncation and invalid responses. The test can run while
ordinary model generation is paused because it is an explicit user action.

Model calls sharing one local CODEX_HOME now atomically reserve a budget slot
before sending. Replies merge into a shared cache under coordination; simultaneous
identical cacheable requests share one result. A crashed/cancelled sender may
conservatively consume its reserved slot. Coordination failure refuses the call
instead of sending without accounting. Approvals and explicit probes precede
queued visible progress, which precedes background summaries; background requests
are protected from starvation. In-flight requests are not preempted. Shared-disk
coordination requires local filesystem atomic rename and coherent directory reads.

### Universal CLI

Build with `npm run build && npm run build:hud-mcp` (Node 22.x ≥22.13 or Node ≥24;
23 is unsupported), or install with `./install --with claude,pi,codex`.
`hud codex ...` and `hud codex-hud ...` invoke the existing tmux-bar launcher.

`hud panel [--width N]` opens the interactive panel beside the caller in herdr;
`--here` renders in the current terminal. The default width is 56 columns.
It reads jobs from `$HUD_HOME/jobs` and the clients' transcripts, not a ledger.
Claude and pi open it with `/hud`; Codex uses F12. See `hud panel --help` for syntax.

The MCP exposes six tools: `hud_roster`, `hud_create`, `hud_read`, `hud_send`,
`hud_respond` and `hud_close`. Roles and the dispatch convention come from files;
job records and reports are plain files under `$HUD_HOME/jobs`.
`hud_read` reads a report and marks it read for the panel. A successful new
`hud_send` continuation makes the next report unread again.

## Job sentences (R5UX-P3B)

Job sentences are the optional "doing now" line on a job card, read by the small model from the
job's own bounded output. They are default-deny and display only.

**Where it shows.** The sentence appears on Work cards and in the 110-column Home peek, and nowhere
else. The Inspector shows the full sentence, the model assessment, the bounded local basis with
coverage gaps, and the deterministic state beside it. A sentence never changes `job.status`, waits,
acceptance, permissions or cleanup, and nothing is ever sent to an agent. Home's needs-you badge stays
terminal needs-human only; a model `attention` renders as "Model assessment" on the card and never
replaces the deterministic state.

**Consent.** Settings > LLM > Job content consent grants or revokes `job_card` for the currently
applied concrete recipient, with an explicit Enter/click. Save connection preferences first; an
ordinary save or reset never grants, and backend, Card progress, card summary and pause still gate.
With no grant, cards are the deterministic render.

**What may be sent.** Facade jobs with a grant only. Auto-discovered `tmp/tasks` directories get no
grant and no sentence. Admitted material is the bounded brief goal, headings and explicitly owned
paths; verified primary public assistant text; review verdicts and finding titles; the current
question (not its answers); and the report. Home answers and design notes, tool/reasoning/user text,
raw browser output and runtime payloads are never material. A request carries at most 16 KiB in
32 fragments; local detail being visible is not permission to send it.

**When it runs.** Only when eligible content changed, through the existing SmallModel transport,
queue and hourly cap: at most 3 outstanding requests and one per job per minute. Redraws, resizes,
fold changes and the clock request nothing. The selected Inspector retains and revalidates its
existing sentence/basis or diagnostic without becoming a request target. Three persistent extraction/
in-flight slots finish a batch before admitting another, so thin collection slices do not evict
unfinished material. Completed notes are revalidated round-robin; while waiting, their model-attention
overlay is cleared conservatively but their prose and deterministic state remain. Collection shares the panel's existing per-tick budget
after the deterministic collectors (32 files, 1 MiB, 128 entries), so a cold job can take several
ticks through a typed `pending` state. A job that cannot finish within the cumulative 8192-probe
admission cap is declined with an Inspector reason and is not retried blindly; that cap is a
configured admission limit, not a measured performance claim.

**Which recipient.** The applied recipient is labelled by canonical origin plus the selected key
source name and whether it came from the environment or `credentials.env` — never the key value and
never a fingerprint. A key value changing in-process under the same source denies; a source, name or
origin change needs fresh consent; a rotated key across a restart under the same selection is the
same account. Credential selection, the A0 panel rule and the F4 path are unchanged, and Settings
shows only the safe origin/model/source description.

**Changes and failures.** A language, policy, recipient, root, episode or question change cancels or
fences obsolete work; a same-episode append lets an in-flight snapshot finish, but a stale basis
cannot keep attention. An empty valid reply shows no sentence, and an invalid or failed reply leaves
the deterministic card. Model output never becomes material for a later request.
