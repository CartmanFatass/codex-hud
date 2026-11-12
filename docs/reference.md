# Codex HUD reference

The details behind the [README](../README.md): the panel part by part, every key, the settings and the model features, the machine-readable state, and the configuration. [中文](./reference.zh.md)

- [The panel](#the-panel): [Panes](#panes) · [Frame](#frame) · [Icons](#icons) · [Scrolling and selection](#scrolling-and-selection) · [Keys](#keys) · [Native agents on Home](#native-agents-on-home) · [Inspector](#inspector) · [Changes summary](#changes-summary) · [Settings](#settings) · [LLM](#llm)
- [Output throughput](#output-throughput)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration): [Environment Variables](#environment-variables) · [Notifications](#notifications) · [config.toml](#configtoml)

## Installing

From the checkout, run `./install --with claude,pi,codex,browser,herdr` (Node **22.13+ within 22.x, or 24.x**).
Choose any of the five extensions: **claude**, **pi**, **codex**, **browser**, **herdr**; core is always included.
External tools are checked and reported, never silently installed; provide provider keys separately.
The herdr extension checks herdr and pi-roles on PATH (only missing herdr fails; uninstall is a no-op).
The browser extension checks PATH for `google-chrome`, `jev-ask`, `jev-aistudio` and `jev-flow`;
missing Chrome or `jev-ask` fails before any changes. It writes no browser config, directories or backups,
never launches Chrome or signs in, and uninstall is a no-op. Configure Chrome and the external Jev CLIs
separately. Project uses the same Chrome + `jev-ask` PATH check. The Decision API and panel work without it.
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

## Project

Project shows **Waiting for you** (the bullet list under `## Waiting for the owner` in
`docs/handoff/STATE.md`, falling back to root `STATE.md`), **Progress**, **Tickets** when present, **Working tree** (branch and change counts,
working HUD jobs whose cwd is this tree, last commit), **Docs** (STATE's `Milestone:` value and the newest
of up to twelve reviews), then **Control plane**. No milestone is guessed when the line is absent.
Tickets come from Matt's `to-tickets` local-file tracker, not GitHub or Linear.

Progress is a read-only board from the project files, not a model estimate:

- **Updated** is STATE's file mtime (HH:MM today, otherwise YYYY-MM-DD). The summary is the text after the
  first colon in its `## Now (...)` heading.
- The full-width stacked bar and its six-state legend count STATE's `## Slices` ledger. Each bullet has the form
  `- working · M3b · SLICE-ID · what it is (optional commit)`. Recognised states are `working`, `blocked`, `try`
  (landed, to try), `todo`, `accepted`, `dropped`; comments and unknown states do not count. Zero counts remain visible.
- Milestone chips come, in order, from the top-level bold `M…` bullets in `docs/spec.md`'s `## 5. Milestones`.
  Those before the first token of STATE's `Milestone:` line are done, the current chip is highlighted, and later
  ones are dim. Missing or unmatched milestone: plain ids, no guessed progress.
- Each working/blocked slice has a block; linked worktrees whose ids are not active in the ledger also appear.
  A job is the newest receipt whose cwd resolves to that linked worktree. Its `now:` line reuses Home's card
  text (and coloured model keywords when the master switch is on), with role and age or an unanswered-question `?`.
  Slices with no job have only the first row. The main checkout's editing jobs stay under Working tree.
- Attention `!` marks ledger drift: a working slice with **no worktree** (blocked slices are exempt), a linked
  worktree **not in ledger**, or one whose **ledger: state** is no longer working/blocked. The header counts these marks.
- STATE's `## Next` bullets follow, with continuation lines joined, at most four shown and `+n` for the rest.

Summary and chips open STATE.md; slice rows open the job's report, else brief, else STATE.md; Next opens STATE.md.
Progress folds like the other sections. The last commit stays in Working tree because the ledger replaces the
separate landed-commit list. Linked worktree discovery shares the five-second git gate. Job lookup reads only
`job.json` and `STATUS.json` in the newest 64 job directories by mtime; report/brief existence is checked without
reading their bodies. Card text comes from the already-collected workboard, including jobs hidden on Home.

**Tickets** groups `.scratch/<feature-slug>/issues/<NN>-<slug>.md` by feature, newest ticket change first;
tickets are ordered by number. The header counts features and tickets; each feature shows done/total and
starts folded if every ticket is done. Enter or `o` toggles a feature or opens a ticket file in its own tab.
No local tickets means no section. Collection is limited to 16 features × 64 files, 64 KiB per file, with
signature reuse and no extra git/model calls or writes.

The local format used is:

```markdown
# 01: Ticket title
**What to build:** The end-to-end behaviour.
**Blocked by:** None (can start immediately)
**Status:** ready-for-agent
- [ ] Acceptance criterion
- [x] Completed criterion
```

The heading number must match the filename; missing heading, Blocked by or Status fields and oversized
files are skipped. **Done** (`✓`) means status done/closed/complete (any case), or all checkboxes checked
with at least one box. Otherwise **blocked** (`○`) means an unfinished dependency from Blocked by, matched
within the feature by number, else title; **ready** (`●`) means no unfinished blocker. Dependencies can be
comma/semicolon/`and` separated numbers or titles; `None …` means no blockers. An unresolved reference stays
blocked. Unknown status words show as written, dim; `0/0` is not completion. The right column is checked/total
acceptance criteria, not a model estimate.

A matching HUD job adds role, state and age (`◐` while active). Its explicit package label must equal the
feature slug, and its task or brief must mention the ticket filename or standalone number (`02`, not `102`).
The existing newest-64 job-directory lookup is reused; only matching-package briefs need bounded body reads.
The newest matching dispatch wins, with age from settlement, else start/creation. Jobs do not change a ticket's
file-derived state. Below 64 columns the job text drops to leave room for the ticket and acceptance count.

Control plane starts folded. It lists the same effective role registry as `hud_roster`, each role's
harness/model/thinking, HUD and pi-roles source files, the project/user/default convention in effect,
CLAUDE.md and AGENTS.md. Native custom agents (Claude user/project and Codex user) have their own fold.
Keys show names and ✓/− only (empty declarations count as unavailable); no credential value is kept or displayed,
and that row cannot be opened. Browser ✓ means only that `google-chrome` and `jev-ask` are found on PATH,
not that a browser is running or logged in. Nothing starts the MCP, browser or a model.

Up/Down move over file rows and section headers; Enter or `o` folds a header or opens the selected file
in `$EDITOR` (default `vim`) in its own focused herdr tab in the panel's workspace. The tab is labelled with
the first file's basename (at most 24 cells) and closes when the editor exits. If the workspace lookup fails,
a split beside the panel is used instead. Project keeps its cursor and scroll separate
from Home. Full collection runs only while Project is shown (not behind Help, Settings, Changes or the Inspector),
uses stat-signature caches and 64 KiB file reads, and probes git at most once per five seconds through the
existing safe git helper. Home reads only STATE and local tickets through the same caches; unchanged files need
no body reread. Rendering only consumes the retained snapshot.

## Home (ONE-PAGE)

> **This section supersedes the stacked-pane description under [The panel](#the-panel)** for the main tabs, their
> keys and their content. The older text stays as the historical/secondary renderer description; the live panel
> follows this section.

The panel has two passive tabs: **Home** (needs-you questions or `✓ Nothing needs you · N running`, package lanes with job cards, then **Decided for you**) and **Project** (the project at a glance). There is no Work tab.

**Recommended mode.** Settings → Panel → Home mode selects Default (unchanged) or Recommended. Recommended batches up to 200 current cards' ids, lanes, state, role (80 chars), title (160), age, sentence/reason (240), question flag and outcome into the selected Decision API (default OpenAI), without file bodies. Scores 0–4 order lanes/cards; settled cards below 2 join the existing older fold (`a` reveals them). Questions, failures and ended-needing-human cards stay first and never fold; native sibling subtrees rank by their maximum score while children retain their order under the parent. A short EN/ZH progress brief from the same digest, through the job-sentence chat channel, wraps below the needs-you band. Ranking is cached in memory per card-set/state fingerprint and requested at most once per two minutes, never on a frame. Changed boards wait with Default order; errors, malformed ranking or no decision key retain Default order without error text. The brief has its own state/sentence digest and cache: only changed material requests it, at most once per Summary interval, regardless of ranking success or availability. A failed/unavailable chat brief is omitted without discarding a valid ranking; models off hides both. No state, count or card wording changes.

**Spare-row progress.** After the cards and decisions, Home uses only otherwise unused rows for one block, set off
from the decisions by a blank row and drawn like Home's other sections (a title, a rule, a right-hand fact):

```
Progress ───────────────────────────── Milestone M3b
  <STATE's one-line "Now" summary, cut to the width>
  ████████████████▓▓▓▓░░░░░░░██████░░░░░░░░
  ● working 2   ● blocked 1    ● landed, to try 1
  ● todo 1      ● accepted 1   ● dropped 1
Tickets · <feature> ──────────────────────── 1/12 done
  09 <title>                                 working
  02 <title>                                   ready
  +5 more
```

The stacked bar is as wide as the legend, not the pane. The legend lists states with a nonzero count in aligned
columns, in the fewest rows that fit (at most 60 cells wide). Open tickets per feature are a short list, at most
six rows: working first, then ready, then blocked, with `+N more` for the rest. Completed/dropped tickets and
slices in flight are not repeated. As the pane shortens, tickets shrink first, then the legend, then the bar, then
the summary; the whole block goes before it can displace a card. Up/Down selects it; Enter or a click opens Project
at Progress or the ticket's feature, unfolded. Home does not trigger git, control-plane, custom-agent or
ticket-job scans.

| `Ctrl+\`, then | Opens |
|---|---|
| `1` | Home |
| `2` | Project |
| `3` | Changes summary |
| `4` or `v` | Inspector |

**Keys on Home.** `1` returns Home; `2` opens Project; `3` opens Changes. Tab/Shift-Tab and Left/Right (`h`/`l`) switch Home ⇄ Project. Up/Down (`j`/`k`, PgUp/PgDn, Home/End) move the selection; `n`/`N` select the next/previous trouble without leaving Home. Enter, or a click on the selected item, expands/collapses in place. Only the newest current settled card starts expanded until its fold time (see Card lifetimes); every other card, decision and question slab starts collapsed. HUD jobs and native agents compete together. Enter's choice for a card wins for the rest of the panel's life, even when another card becomes newest (display only, not saved). On a lane header Enter folds or
unfolds the lane. `o` opens the selected item's file in `$EDITOR` in its own herdr tab: a job's open question with its
answer file, else its `report.md`, else its `brief.md`; a decision's `qa` file. `v` or Space inspects. Esc returns from
the Inspector, and standalone Esc on the main page exits as before. The footer
keeps whole hints only (`↑↓ move  ⏎ expand  o open  v inspect  a all  , settings  ? help  ←→ tab`): at a narrow width the hints
on the right are dropped, never cut. Help lists both tabs and the Changes shortcut.

**What Home shows.** Its badge and needs-you items count only terminal runtime jobs that ended needing a human. A
worker's QA result, a normal failure, a blocked job and a timeout never count. Partial coverage never reads as
"nothing needs you".

**Recorded calls are read-only.** A review counts only when its first line is exactly `Verdict: accept` or
`Verdict: changes-required`. A recommendation is labelled as a recommendation, explicitly not as an adoption. An
answer that leaves an explicit option is shown as `≠` with `instead`; an ambiguous answer or free text stays
routine. Only an explicit `One-way: true` line is pinned red; a prose mention is not. Current decisions appear under **Decided for you**, departures first, newest first within each group. Decisions hide after 30 minutes, ◆ departures after 2 hours. `a` shows/hides older decisions as well as finished jobs in place; there is no History tab. Older items are wholly muted, bandless one-row titles with no older prefix, and a lane whose jobs are all old has a muted header too. Each answer is one row: mark, lane, role and question ID (`◇ AI-THIN · imp q1`), title and age. Enter expands its answer, question, departure alternative and why; model text adapts these to the Settings language, with the original text as fallback. Home's question card is short: the question in at most three lines, one
`N options · default: …` line, the evidence file with `⏎ expand  o open`; Enter expands it to the question whole, the
`blocked` context and every option (`⏎ collapse`). A lane's row has the package label and
its phase word on the left and, on the right, one glyph per job, oldest dispatch first: `✓` done, `◉` running, `?`
asking, `✗` failed, `−` stopped (`+ @ ? x -` in text glyphs), then the role of the newest job that is running or
asking. When the jobs do not fit, the newest keep their glyphs and `+N` counts the older ones. There is no progress
track: a lane's phase is the word, not a percentage or an unobserved earlier stage.

The top row has Home and Project tabs, with their asking/waiting counts, and the models on/off word on the right, which a click or `b` toggles. Lanes are observation navigation, not execution ownership; unknown phases stay unknown.

**The work card.** All Home lanes share one compact card: a title row with role, short task, state and minute age,
then two fixed sentence rows. Until text arrives the sentence area shows `┃ …`; a longer sentence ends with `…`
on its second row. Enter expands the full sentence and factual detail. The four active states are needs you,
working, to accept and stalled; done is the settled fifth. Only the newest current settled card opens automatically;
other cards start collapsed. After 5 minutes settled cards fold to one title row; after 15 they hide (Settings → Panel).
There is no task/report/helper prose, model badge, relations or footer. The
Inspector keeps the full model and effort, the evidence and the time basis. A review counts only when its first line
is exactly `Verdict: accept` or `Verdict: changes-required` (CRLF allowed) and the helper status is settled with its
output written; a helper's exit alone is not a verdict. Current helper progress/failure also requires compatible known
primary/helper starts and file times; reused or unconfirmed slots show unknown helper state, never a current failure.
Readable current QA shows its question/default locally, with options and evidence in expanded detail and Inspector;
unavailable details use the generic inspect instruction. Native cards use the same thin Inspector, with their transcript as the openable detail. A changes-required round shows `fixing` only once the primary
resumes, never merely because the review ended. A direct task cannot infer acceptance or a merge, and a pi STATUS
auto-close is not facade closure.

**Card state precedence.** A current request or failure comes first; then a result awaiting acceptance; then stalled —
stale, unknown or no observed activity, or the stall threshold (default 10 minutes, 1–120 stored) without meaningful
progress; then working. This is presentation only: it changes no execution status, wait semantics, acceptance or
source. Thin HUD jobs count the newest observed creation/STATUS/report/review/session-file mtime as activity: a working session's fresh writes prevent a false stall even if STATUS is old, with model text on or off and no extra transcript body read. A model call or counter alone does not advance activity. A worker's QA
result or ordinary failure never becomes Home's needs-you. A facade result stays pinned at to accept until facade
closure. Running/asking jobs stay; a settled job or native agent folds, then hides (**Card lifetimes** below). Lanes show only with visible jobs, and **Decided for you** only with visible decisions. `+N older · a` at the end counts hidden jobs and decisions; while they are shown it reads `N older shown · a hide`. `a` reveals them newest first as muted, bandless one-row titles (no older prefix), one row each until Enter expands; `a` again hides them. Decisions keep fixed lifetimes (30 minutes, ◆ departures 2 hours), and the scan bounds history to its newest 200 jobs. Expiry never
hides terminal human-needed workers, admitted daily one-way decisions, partial coverage or unclosed facade output.

**Card lifetimes.** A settled HUD job or native agent has two stages, both counted from its settlement. After **Fold after** (default 5 minutes) it is one row, like a **Decided for you** row: state mark, role, title, outcome tag, state word and age. Enter opens it in full, Enter again folds it, and a folded card never opens by itself (the newest result opens by itself only before its fold time). After **Hide after** (default 15 minutes) it leaves Home for `a`; a failed or stopped card stays at least 30 minutes. A hide time shorter than the fold time counts as the fold time. Both are Settings → Panel rows, apply without a restart, and never touch running cards, cards asking the owner or decisions.

**One renderer.** Home, Project and the kept passive pages share the workboard renderer. Callers without a sidecar project their native tree into the same Home lanes.

**What Home does not have.** No old status-control footer, recovery, Resume, Reconcile or status-level controls.
The top-row models on/off word and `b` toggle the same Model text master switch; the Models settings are described
under [LLM](#llm). Nothing fakes a queue position, a merged age or the publish job's login blocker. `S` has no binding.

**Colour.** Role inks colour role words only: imp cyan, reviewer pink, sonic coral, oracle violet, Jev teal. Ages on Home are minute-valued. Their local attention ink is the approved mockup's #efc15a; state colours elsewhere
are unchanged. Light/terminal palettes retain their legible equivalents. Mono and ASCII output keep their meaning.

## The panel

### Automatic build reload

The panel checks its own installed `dist/tree-page.js` on each refresh. After a change is quiet for two seconds, it checks that the new entry and its imports load, then restarts in the same pane with the same arguments and environment (Codex, Claude and pi alike). Home/Project, selection, scroll, expanded/folded cards, show-all and open Inspector/Settings/Help are retained through private restart state. Settings drafts are never carried: unsaved edits delay the restart until saved or discarded. A bad build leaves the old panel running with a dim “new build failed to load” notice until the next good build. Statusline bars are separate and unchanged.

### Panes

Home and Project are the two tabs. Changes (repository/worktree summary), the Inspector, Settings and Help remain. There is no Agents pane, compact-tree layout, pane zoom, agent log, native session-switch control, Timeline, activity hub, Summary or diagnostics page.

Every view counts alike: an **agent** is one the main session started, a **subtask** an agent under one, at any depth, and a **review** a guardian approval review, wherever it sits. Notifications, which say the failures as one phrase (`! 1 agent · 1 subtask · 1 review failed`), the bar's Agents field and alert, and `codex-hud --json` all count the three apart, and an agent counts as running while a subtask of it runs. Those aggregate counters are unchanged; compact work cards do not repeat subtask/review counters.

### Frame

The live pages (Home, Inspector, Settings, Help, Changes) share one frame grammar, drawn from the workboard rows in
`src/render/workboard-rows.ts`:

- one top title band: Home on the left with the asking count when there are questions, and the models on/off word on
  the right, which a click or `b` toggles; each subpage shows `‹` and its name (`‹ Settings`, `‹ Help`, `‹ Changes`,
  and `‹ Home › …` in the Inspector), and a click on `‹` or Esc returns;
- exact-width rows: `section` rules (`Files ──── 3`), `kvRows` label/value pairs, `itemRow` glyph, title and
  right-hand value, `subTopRow` and `footRow`;
- one footer: factual on the left (`✓ N done today` on Home) and whole hints on the right, dropped from the right when
  narrow, never cut.

All callers use this frame, including callers without an explicit workboard. There is no alternate Agents layout.

### Icons

Icons are `unicode` (the default) or `text` (words and ASCII marks): Settings → Display → Icons, or
`CODEX_HUD_ICONS`. Old `nerd` and `emoji` values load as `unicode`. There is no look selector. In text mode the panel's
marks become words or ASCII (`+ @ ? x -`, `12d ago`, the bottom bar's `Working` and `Idle`); everywhere else the
Unicode glyphs are used. The bottom bar always names the model in words. The Unicode icons are drawn by MesloLGS NF
(see [Font](../README.md#font)).

### Scrolling and selection

Each page scrolls when it does not fit: wheel, `PgUp`/`PgDn`, or moving the selection. The cursor follows stable card IDs; Home, Project and the Inspector retain their own scroll positions. Native descendants remain under their parent in the session lane, including when `a` reveals older cards.

### Keys

Every key below follows the prefix: `Ctrl+\`, then the key (or the prefix chosen in Settings; a settings file saved before `Ctrl+\` became the default, with no prefix of its own, keeps `Ctrl+]`, which Codex 0.160 also binds to Skip Question). Outside Settings and Help, a key typed without it goes to Codex.

| `Ctrl+\`, then | Action |
|-----|--------|
| `1` | Home |
| `2` | Project |
| `3` | Changes summary |
| `4` or `v` | Inspector on the selected item |
| `↑` / `↓` (`j` / `k`) | Move the selection; repeats without the prefix for half a second (`Ctrl+\` `j` `j` `j`) |
| `PgUp` / `PgDn`, `g` / `G` | Page, first/last item |
| `Enter` | Expand or collapse the selected card, decision or question in place; on a lane header, fold or unfold the lane |
| `o` | Open the selected item's file in `$EDITOR`: a job's open question (`qN.md`), else its `report.md`, else its `brief.md`; a decision's `qa` file |
| `v` or Space | Inspect the selected item |
| `a` | Show or hide older jobs and decisions in place |
| `n` / `N` | Next / previous trouble (needs-you or stalled), without leaving Home |
| `b` | Models on / off (the top-row word does the same) |
| `,` | Settings |
| `?` | Help |
| `Esc` | Back from Help, Settings or the Inspector; in Settings with a dirty draft, the Save and leave / Discard changes / Continue editing dialog |
| `q` | Close the panel |
| `Ctrl+\` | Send `Ctrl+\` itself to the pane with the cursor |

`2` opens Project. On Home or Project, Tab/Shift-Tab and Left/Right switch between them. The Inspector keeps its own keys.

In Settings, ↑/↓ select, ←/→ or Enter change a value, `s` saves, `r` resets the selected group, `t` runs the Models Test API, and Esc leaves. In the Inspector, ↑/↓ select a file, Enter or `o` opens it, and Esc returns to Home. Help scrolls with ↑/↓ and PgUp/PgDn; Esc returns.

| Mouse | Action |
|-----|--------|
| Click / wheel | Select a row, or scroll the page; the wheel does not move the selection |
| Click a row again | Expand or collapse it in place |
| Click `‹` | Return from a subpage |
| Click the models word | Toggle the Model text master preference |
| Click a blank row, or the gutter | Keep the next keys in the panel until Esc. While they are held the bar shows `⌨ Keys here` (the glyph alone where narrow, `Keys` with icons set to text); a click on it hands them back too |

Repeated positively idle, unchanged observations gradually reduce collection to at most five seconds (an already slower configured cadence is preserved). Activity, uncertainty, failure, input or source change restores normal polling. Redraw/input remain independent. Large scans yield between chunks; individual JSON parsing remains synchronous. Poll cadence is not a model or notification delivery guarantee.

HUD job titles on Home and in the Inspector prefer the first heading in the job's stored `brief.md`.
Without a heading, Model text uses the short task name returned with the existing sentence; while pending,
off or unavailable, the first task line is cut to fit. Referenced brief paths are not followed. Project slice
blocks keep their short ledger ID and description, not the raw dispatch text.

### Native agents on Home

Each main session has one lane (`Claude · this session`, `Codex · this session`) beside the package lanes, with one card per native subagent, including custom Claude agents. Children indent one level; deeper descendants are flat and say `↳ parent`. Native cards use the job grammar and lifetimes: done folds after 5 minutes (Fold after) and hides after 15 (Hide after), failed/stopped hide after 30 at least; `a` reveals them in place. A hidden parent never hides a live descendant. pi has no native subagents; its HUD helpers already appear as job cards.

Ordinary `hud panel` resolves the caller through `herdr pane current` at open time, only with `HERDR_PANE_ID` set (never the focused-pane fallback). A Claude session UUID binds its existing transcript under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`: the cwd slug first, then at most 256 immediate project entries. Explicit `--root` or `--harness claude --session ID --source <project transcript directory>` wins. Missing evidence, herdr errors or a one-second timeout retain the unbound jobs view. The statusline writes no binding; no pane-keyed file is used.

Codex retains its incremental rollout tree. Claude reads the bounded `ID/subagents/agent-*.meta.json` membership and replays JSONL forward in bounded passes, remembering public Agent/Task calls so a nested card stays under its parent even when the starting call is far from the transcript's end. Unchanged transcripts cost no body read; truncated/replaced transcripts replay from the start with old parent evidence cleared. During catch-up, an unmatched nested card waits for its parent rather than appearing at top level; if all transcripts catch up without a match, it appears at top level so work is not hidden indefinitely. Unreadable/deferred evidence is incomplete, not idle. Native coverage conservatively keeps base polling; the job-only 5-second backoff still requires positively empty native coverage. `o` opens a native transcript, never switches the client's conversation.

While Claude transcripts replay on panel open, cards retain their metadata status and settlement time: long-finished agents stay done and hide under the normal age rules, never temporarily running/unknown. No sentence request is made until that card's replay catches up. A finished Claude subagent returns to running (`◉`) only when its transcript grows after completion, including after waiting for background work. It settles again when fresh metadata says finished or its last public record is an assistant `end_turn` with no open tool call. Partial/replaying records cannot supply that final reply. Each new settlement can refresh the result sentence from the real last public reply, with the same two-minute spacing and shared call cap; unchanged finished transcripts keep their result without extra reads or model calls.

### Historical job observations

The panel also observes role-facade CLI/browser jobs, dispatch helpers and explicitly
registered external Herdr tasks as read-only workboard observations. Jobs attach only to their exact
recorded root. Native sessions are enriched only by a complete matching native reference;
labels, pane names or reused session strings do not establish a match. Source freshness,
lifecycle and outcome remain separate: an unavailable host is not a task failure, and a
report file is not proof of successful work. Stale live work is counted as unknown.
Legacy facade-only summaries remain unavailable. Thin jobs use the bounded job-local sentence path
under [LLM](#llm); native cards share that sentence service.
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

**Thin-job display cache.** `$HUD_HOME/display/thin-jobs.json` is a private (0600), atomically replaced cache of stat-signature-checked `job.json` and `STATUS.json` facts shared by the panel and statusline. It avoids re-parsing unchanged files across processes; it is disposable display state, not job authority. Missing or malformed cache data is rebuilt from the job files.

Native names remain factual until the shared model service supplies a short task name. There is no agent-log page, preference or writer; existing files remain on disk. A single generated sentence covers current work, the final result or failure cause, under the same master/key/language/rate gates as job sentences.

### Inspector

**Thin Inspector.** For a Home card or question slab, `v` opens the thin Inspector: the expanded card (or the
question with its slab and options), then the facts role/harness, model/effort, package, state/phase, started and
activity (or asked/ended), with local times and two facts per row from 80 columns. Under `Files` it lists the job's
readable workflow files — `brief.md`, qa pairs, `review-N.md`, `report.md` — and ↑/↓ select one; Enter or `o` opens it.
An open question opens only `qN.md`; an answered pair opens both files. The selected row defaults to the open question,
else `report.md`, else `brief.md`. A decision shows its band and full title stem, then asked, answer (or verdict),
instead and why, and both qa files.

Native cards use this same Inspector: expanded card, role/harness, model/effort, parent, state and times, then its transcript under Files (`o`/Enter opens it). One additional facts row shows context fill %, estimated tokens/s and cumulative tokens spent when those observations already exist for that agent; missing fields are omitted and the row makes no extra read or model call. The old queue diagnostics, stage/peer/log histories and native session-switch controls are gone. The transcript is the full detail.

### Changes summary

`3` / `Ctrl+\ 3` keeps Changes as a factual summary: the source repository's branch and HEAD, ahead/behind counts (unknown without upstream evidence), staged/unstaged/untracked counts, and one row per worktree with its path, branch and dirty/clean state. Missing or stale status stays unknown. There are no per-file lists, file/worktree selection, Inspector previews or diffs. Collection runs only while Changes is focused, with bounded round-robin worktree status probes; Git filters and lazy fetching stay disabled. It provides no staging, commit or checkout actions.

### Settings

Settings is one page with four open groups, in this order:

| Group | Rows |
|-------|------|
| Display | Theme, Bar style, Icons, Language |
| Panel | Home mode (`homeMode`: `default` / `recommended`, saved in `hud-settings.json`), Width, Stall threshold, Fold after, Hide after, Notifications, Refresh, Mouse |
| Models | Model text, Model, Decision API, Call cap (LLM only), Decision cap, Summary interval; separate calls-this-hour counters and Test API ([LLM](#llm)) |
| Codex | Prefix key, Bar on launch |

Bar style cycles the shared `BAR_STYLES` (`line`, `p10k`, `gauge`, `tide`, `micro`, `stacked`, `headline`, `triptych`) and saves `barStyle` for the bottom bars.

#### Themes

Theme paints the bars and, with its own board inks, Home, Project and the Inspector: every theme has its own surfaces (a card's header, its body, the selected row, a failed card, a question) and its own inks, so switching shows on every page. Colour still means demand on the owner: the ask colour and `attention` for what waits for an answer, `danger`, `success`; role colours stay on role words; `none` (and `NO_COLOR`) emits no escape. Dark themes pin their text colour under every row; `terminal` keeps the terminal's own.

| Theme | ZH | Made for | Look |
|-------|----|----------|------|
| `terminal` (default) | 终端 | any dark terminal | deep navy cards, the terminal's own text, soft amber, green and blue; muted and rules lifted for contrast |
| `titanium` | 钛金 | dark | omp's steel greys with electric blue, readout green and amber |
| `mocha` | 摩卡 | dark | Catppuccin Mocha: purple-tinted surfaces, pastel inks |
| `arctic` | 极地 | dark | cool slate with frost and muted aurora inks (after Nord) |
| `ember` | 余烬 | dark | warm brown-greys, cream text, earthy inks (after gruvbox) |
| `contrast` | 高对比 | dark, bright rooms | true black, white text, bright inks, loud rules |
| `latte` | 拿铁 | light | Catppuccin Latte, its inks darkened to read on the surfaces |
| `paper` | 纸白 | light | warm cream with ink-dark text and earthy inks |
| `none` | 无 | any | no colour |

The bars follow the theme through the palette (a light theme also gets light greys and tints in the gauge and tide looks). Every board ink reads on its surfaces: 4.5:1 on a card's header and body, 4:1 on a failed card and a question, 3:1 on the selected row (`tests/unit/themes.test.mjs`).

The page is a draft: Theme and Icons paint in the draft value, so it is its own preview, and there is no separate Preview block. The selected row's help sits under it as a `┃` stem. A non-default value is in the accent, and a changed row is marked `*`. The top band reads `‹ Settings` and, when the draft is dirty, `unsaved` at the right; a click on that word saves. `s` saves, `r` resets only the selected group, and `t` runs the Models Test API. Esc with a dirty draft opens **Save and leave**, **Discard changes**, **Continue editing** (the default; Esc also continues editing). There are no Reset all or header buttons, no accordion and no read-health dump. ↑/↓ select rows; PgUp/PgDn jump groups. Short panes scroll and retain the selected row's help.

Resetting the Models group turns generation off (`modelEnabled: false`) and preserves the connection, model and call cap. Calls this hour is real reserved usage, including a known zero while the master is off. Under each LLM/Decision counter, one width-cut EN/ZH line lists this hour's calls by feature, largest first; zero calls show no breakdown. LLM features are job sentence, native sentence, decision title, Home brief and probe; Decision features are outcome, kind, looping, question category, review severity and Home ranking. Old timestamp-only entries count toward the total and appear as Earlier format. Test API is one summary row, not a per-tier block.

Settings → Panel → Width applies to every client: Claude, pi and Codex. Presets are 40, 48, 56 (default), 64, 80 and 100 columns; ←/→ cycle through them. Other saved widths still load (16–200, including the old 32); 0 means the default, 56. Saving a changed Width resizes this panel immediately, keeping at least 41 columns for the agent when space permits; narrow windows give the panel less. The keeper reapplies the policy when the containing split/window changes size, not when someone drags the border. Saving unrelated settings also leaves a dragged border alone. `CODEX_HUD_TREE_WIDTH` remains an initial tmux override when no saved settings exist.

Fold after (`cardFoldMinutes`, default 5: 1 / 2 / 5 / 10 / 15 / 30 minutes) and Hide after (`cardHideMinutes`, default 15: 5 / 10 / 15 / 30 / 60 / 120 minutes) set when a finished job or native agent shrinks to one row and when it leaves Home (Card lifetimes under Home); stored integers 1–1440, and a hide time below the fold time counts as the fold time. They apply to finished jobs and agents only, not to running cards, cards asking you or decisions.

Related notification preferences share one row: Notifications (off, tmux, or tmux and the desktop).

**Rows and values.** Labels stay left and values align at the actual pane's right edge; the selected value reads `‹ value ›`, and ←/→, Enter or a click change it (a click on `‹` steps back). Saving a new panel width reflows the rows to that real width. Rows with unavailable dependencies are dim but remain selectable so preferences can be preconfigured. Model generation needs both Model text on and a matching endpoint key. Off hides generated text and restores native names and factual lines. `agentLog`, `cardLabel`, `cardSummary`, `agentsPane` and the old card-only visibility keys are ignored on load and omitted on save; existing user caches/log files are not deleted.

**Saving.** Unsaved fields show `*`; Save persists to `$HUD_HOME/hud-settings.json` (or `HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins. Bar on launch applies from the next launch.

**Removed preferences.** `look`, `glyphs`, `motion`, `panelStyle`, `statusCard`, `art`, `artImage`, `density`, `context`, `cardCorners` and `cardClock` are deleted. Unknown old keys are ignored and omitted on the next save; old `nerd` and `emoji` Icons values load as `unicode`. There is no layout selector, picture or foot status card. The art renderer, decoder and script are deleted; user assets are untouched. (The optional picture was already absent on Home.)

### LLM

The Models group has exactly three preference rows. There is one chat-completions model, not a backend or per-feature selector:

| Setting | JSON key | Default | Meaning |
|---|---|---|---|
| Model text | `modelEnabled` | Key-aware | Master switch for new model text; off sends nothing |
| Model | `model` | `deepseek-v4-1-flash-1017` | Model ID for chat-completions text; Decision labels use their providers' own models |
| Call cap | `modelCallsPerHour` | `60` | LLM calls per hour (sentences, titles, brief): 30 / 60 / 120 / 240 / unlimited |
| Decision cap | `decisionCallsPerHour` | `0` (unlimited) | Decision-API calls per hour (labels, Home ranking): 600 / 2000 / unlimited |
| Summary interval | `summaryIntervalMinutes` | `5` | Running job/native sentences and Home brief: 2 / 5 / 10 / 15 / 30 minutes; applied without restart (validated 1–120) |

Without a saved master preference, Model text defaults on when a Mistral, OpenAI or Gemini key is available from the HUD credential reader, otherwise off. A saved boolean wins. Even when on, text needs a matching key for its configured chat endpoint; Decision labels separately need a Gemini or OpenAI key. `b` and the top-row models word toggle this same master preference; there is no separate pause setting. Turning it off hides stored model text and falls back to native names and factual state without deleting caches or logs.

Model text covers **job/native card sentences and native task names**, **decision titles**, **Recommended Home ranking/brief**, and the **Decision labels** below. They follow the master switch together; none has its own LLM setting. Model text is display text, not observed fact or a verdict; its keywords use the same painting on Home, Project and in the Inspector.

**Keyword grammar.** Sentences can carry up to four marks: `«keyword»` keeps the original identifier colour (lavender on dark themes); `«+approve»` / `«+批准»` is success green; `«-reject»` / `«-拒绝»` is error red; `«!recommends X»` / `«!认为更简单»` is opinion cyan, distinct from identifiers, success, error and attention. Recognised stance prefixes and delimiters never display. A stance prefix needs a following character that is not another prefix (`+`, `-`, `!`); `«--orchestrator»` keeps both hyphens as an identifier, as do `«-x»`-style flags inside backtick code spans. Stance prefixes express approve/accept/agree/pass (批准、同意、通过、接受) or reject/object/oppose/fail/block (拒绝、反对、驳回、失败、阻塞). Filenames with extensions (`report.md`) and paths (`src/tree-page.ts`) always use identifier ink, even unmarked or inside another mark. Malformed/nested, empty/prefix-only or more-than-four marks lose keyword emphasis and display as plain text; deterministic file painting remains. Prompts require `«…»` in every language, including Chinese. Short `「…」` keyword marks (including stance/opinion prefixes) paint identically without brackets and count toward the same four-mark limit. Only balanced, non-nested payloads of 1–24 Unicode characters, excluding an optional prefix, qualify: no whitespace or sentence/clause punctuation (`。！？!?，,；;：:` or a final period); internal filename dots are allowed. Other corner quotations stay literal, without keyword emphasis, so a quoted sentence is not coloured wholesale. Old cached `«…»` still works. With text icons, opinions are plain; theme none emits no colour.

- **Thin-job card sentence:** One sentence on what the job is doing now (or did once settled), in the panel language. The model marks up to four keywords with the grammar above; cards remove the syntax and paint valid marks and deterministic files. Collapsed, the card has a title plus two fixed sentence rows, cut at a word with `…` on the second when needed; `┃ …` holds the sentence area until text arrives. Enter expands the whole sentence with keywords coloured and the whole factual line underneath; Enter again collapses it. Without model text, expansion shows the whole factual line. Off/no matching key keeps the factual line unchanged. Input stays inside that job directory: brief title/goal, STATUS state/phase, open question, newest review verdict, first report lines once settled, and four recent public assistant-text/tool-call blocks from a bounded 32 KiB session tail while working. State, phase, question/answer, report/review and session-activity changes are folded into running requests at the Summary interval (default five minutes), with no overlapping requests for that job. One successful final sentence freezes that settlement (`settledAt`); continuing the same job and settling again allows a new final sentence after the fixed two-minute floor. Failed final requests retry after two minutes; running retries follow Summary interval, and unchanged running input makes no model call. Last sentences/fingerprints survive panel reopen in `display/model-cache/job-sentences.json` (200 records), without a new call for unchanged input. These requests share the ordinary queue/cap. The collapsed settled card's final sentence is its result in the two sentence rows; expansion reveals the factual detail, not a second generated result.
- **Decision titles and language:** Each thin-job “Decided for you” row gets what was decided in at most eight words, in the Settings language, from only its question and answer files (4096 bytes each). The same `title` feature call (lite DeepSeek flash, reasoning effort `none`, up to 400 output tokens) returns JSON with `title`, `question`, `answer`, `instead` and `why`, omitting absent fields. Detail is faithfully adapted, kept short, and identifiers, paths, code and flags stay unchanged; text already in the target language stays the same. Titles may mark up to two keywords with the same grammar/painting; delimiters and prefixes do not count toward the eight-word cap, and a capped mark is closed. Expanded rows and the Inspector prefer the localized detail, falling back field by field to original text; Enter is unchanged. A plain-text reply still supplies just the title. Off/without a key sends nothing and shows original text. These display-only fields persist together in `display/model-cache/decision-titles.json` (200 records), keyed by version, decision id, answer revision and language: old title-only records get one new call; a second render or reopened panel makes no call; a changed answer revision gets a new response. Visible decisions go first, with at most three pending requests on the shared queue/cap; failures retry after two minutes.
- **Native names and sentences:** The same `JobSentences` queue/cache generates a short task name and one sentence about current work, a settled result or failure cause. Running requests use the Summary interval (default five minutes), shared across languages; final results keep the fixed two-minute floor, with a successful final sentence frozen to its settlement; the shared service admits at most three pending handles. Native input reuses the collected name/role (80 chars each), public task/pre-create charge (400), latest public report (600), tool/action (200), latest stage/public final result (8,000 head/tail) and recorded error output (2,000). A settled Codex agent may need one safe 32 KiB transcript tail; Claude uses its already-collected public text. Sealed tasks, reasoning/private/unknown channels and legacy job-only nodes stay excluded. No separate labels/digests/causes/progress schedulers or agent-log writer remain. Off/no key restores the native name and factual line without deleting old caches.

#### Decision labels

With Model text on and `GEMINI_API_KEY`, `OPENAI_API_KEY` or `TYPESAFE_API_KEY` available, the panel adds:

- **Outcome:** settled Home cards show `[done / partial / failed / blocked]` beside the factual state. The
  Inspector adds confidence; Project's progress slice shows the same mark. One request reads the final
  state and first 12 report lines (4096-byte head), once per settlement. Later report edits do not
  relabel that settlement; continuation and resettlement allow a new label.
- **Kind:** the Inspector shows any of ui, bug fix, feature, refactor, review, research, docs, chore.
  One request per job reads only the first two brief paragraphs (1500-byte head), while running or within one day of settlement. Older settled jobs never backfill.
- **Looping:** after three quiet minutes a running HUD or native card can show `⚠ looping`; the Inspector
  adds confidence. Input is only the last 12 public tool calls and matching result summaries, each
  bounded to 600 characters, from the same 32 KiB session tail used for its sentence. At most once per
  five minutes, never for unchanged activity; new different activity clears the mark immediately.
- **Question category:** pending questions and Decided for you rows carry design trade-off, clarification,
  owner authorisation or blocked chips. Authorisation questions sort first. Only the question file's
  first 4096 bytes are sent, once per revision (up to 100 questions per observed job).
- **Review findings:** the Inspector and progress slice show must fix / should fix / optional counts.
  One request per newest review revision classifies up to 24 Markdown list items, 400 characters each,
  from a 32 KiB review head (or a settled reviewer job's report). Headings need no special spelling;
  non-finding/check bullets are excluded. No findings means no counts.

Labels are display only: they never alter job status, send work, answer a question or delay its handling.
They use the **Decision API chosen in Settings → Models (default OpenAI)**, with the same automatic fallback
and Gemini quota cooldown as Jev decisions. Failed labels show nothing, never provider HTTP text; existing
per-revision retry/cache rules remain unchanged. Every HTTP attempt, including fallback,
uses the separate Decision cap/ledger shared with Home ranking across panels, never the LLM cap. Cached successes and failed attempts survive reopen
in private `display/model-cache/decision-labels/` records. Master off/no decision key hides labels and sends
nothing; language changes translate cached enums locally without a call. No per-label switch, watcher or process is added. All labels are available in English/Chinese at 80 and 120 columns.

Reasoning and private channels are excluded. Only the thin-job inputs listed above are newly admitted; legacy facade-only jobs and task directories remain excluded. There is no job-content consent flow. Periodic overviews, main recaps, session titles, approval wording and change summaries are no longer generated or loaded. Hidden/secondary views receive factual state only, not generated overview text. The old `codex-hud brief --dry-run` command now reports that periodic briefs and recaps were removed; it is not an input preview.

**Language and storage.** Retained features write in Settings → Display → Language. Off-language stored entries step aside; replies plainly in the wrong language are rejected and not cached. Names and short quotes may contain another language. Model cache and call-log files under `$HUD_HOME/display/model-cache/` are private (0600). Native and thin-job running failures follow Summary interval; final failures wait at least two minutes. Text requests share their single-flight queue/cache; Decision labels have one separate in-flight request and per-source revision records, sharing only the Decision cap/log with Home ranking. Text cache identity includes input, endpoint and actual model, never the key. Settings shows calls made this hour.

**Budgets and pacing.** LLM calls use `display/model-cache/calls.json`; labels and Home ranking use `display/model-cache/decision-api/calls.json`. Both counters aggregate panels on the same `$HUD_HOME`, include fallback attempts in the appropriate ledger, and keep logging when unlimited. Both caps store unlimited as `0`; the counter reads `n/∞`, without a bar or “at the cap” warning. Summary interval changes apply live; running material must also have changed. Final-settlement and ranking floors remain two minutes.

| Model feature | Tier / default effort |
|---|---|
| Job/native sentences and names | low / low |
| Decision titles | lite / none |
| Recommended Home progress brief | medium / high (4096 output-token allowance plus reasoning allowance, 90 s timeout) |
| Decision labels and Home ranking | Decision API structured judgments, not chat tiers |

**Connection.** Configure the endpoint in the settings file (`$HUD_HOME/hud-settings.json`, or `HUD_SETTINGS_PATH`); there is no connection editor in the panel:

```json
{
  "modelEnabled": true,
  "model": "deepseek-v4-1-flash-1017",
  "modelCallsPerHour": 60,
  "briefingApiBase": "https://api.mistral.ai/v1"
}
```

An empty base uses `https://api.mistral.ai/v1`. The existing transport sends `POST <base>/chat/completions`; it is separate from Jev's decision provider. `CODEX_HUD_BRIEF_MODEL` remains an environment override for the model ID. Reasoning effort is an internal per-purpose default (job/native sentences and names `low`, titles `none`, Home brief `high`), not a preference. Bounded requests with reasoning add 512 tokens to the output allowance. There is no silent fallback to another model or effort.

Keys come only from the process environment or `$HUD_HOME/credentials.env`, by **exact endpoint origin**: `https://api.mistral.ai` gets `MISTRAL_API_KEY`, `https://api.openai.com` gets `OPENAI_API_KEY`. Environment variables override the matching credentials-file names. Custom/local endpoints, lookalike hosts, HTTP variants and non-default ports receive neither key; URLs with userinfo are rejected. With no matching key no request is made. HTTP redirects are refused rather than forwarding credentials or session material. Settings hold no key.

Retired backend, pause, per-feature, pace, model-tier, effort and consent settings are ignored, not migrated. In particular, old `briefing`, `briefAgents`, `briefMain`, `agentProgress`, `resultDigest`, `agentLabels`, `failureCause`, `changeSummary`, `approvalDescription`, `briefingPaused` and `briefingApi*Model`/`briefingApi*Effort` values cannot enable, disable or route a feature. Removed keys are dropped on the next settings save; current validated preferences are preserved. Existing user caches and state are not deleted.

### HUD credentials and Jev configuration

The HUD reads `$HUD_HOME/credentials.env` (`HUD_HOME` defaults to `~/.hud`). It must be a regular file with mode **0600**; symlinks and FIFOs are refused without following/blocking. Format is `NAME=VALUE`, optionally prefixed `export ` and/or quoted; there is **no interpolation**. Known names are `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MISTRAL_API_KEY`, `MISTRAL_BASE_URL` and `TEXT_MODEL_*`. Model/base settings otherwise stay in configuration; file names for these non-secret legacy settings are retained for compatibility.

```dotenv
GEMINI_API_KEY=synthetic-gemini-key
TYPESAFE_API_KEY=synthetic-typesafe-key
OPENAI_API_KEY=synthetic-openai-key
MISTRAL_API_KEY=synthetic-mistral-key
```

Credentials are re-read, not cached. Each name resolves from the process environment first, then `credentials.env`. Missing files yield no keys. No key is read implicitly from pi, Codex, jev-ask or any other file, and `jev.env` is never a fallback.

**Decision provider.** `config.json` takes `decisions.primary` and `decisions.fallback`, each `gemini`, `openai` or `typesafe`. The default primary is **OpenAI**; automatic fallback is the first other keyed provider in Gemini → OpenAI → TypeSafe order. An explicit fallback is preserved unless it equals the primary, when automatic selection applies. When top-level `decisions.primary` is absent, `decisions.provider` is read as primary, then the older `jev.decisions.provider`. Settings → Models → **Decision API** cycles Gemini / OpenAI / TypeSafe and saves only `decisions.primary` with `s`; `(no key)` marks a missing credential but does not prevent selection. Changes apply to the next job, decision CLI invocation or uncached label request; running jobs keep their provider and explicit job profiles stay pinned. Keys are never shown or edited in the panel. A fallback is used only when its key is present. It takes over that one call for a quota (429), auth (401/403), 5xx or timeout failure from the primary; a malformed or refused answer stays with its provider. A missing primary key with a fallback key present uses the fallback with reason `credentials_missing`; with neither key the call fails `jev_credentials_missing`, naming the primary's variable. Gemini (`gemini-decision-1`) uses `x-goog-api-key`, no context cache and zero output tokens. Its free tier is 200 RPM, 50,000 TPM and 10,000 RPD. A Gemini quota/rate-limit reply (429 or `RESOURCE_EXHAUSTED`) skips Gemini for an in-memory, per-process cooldown: `Retry-After` / `retryDelay`, otherwise 60 seconds; after expiry Gemini is tried again. A safety 400 is a refusal, not failover. If Gemini is the job's fallback and is cooling down, it is skipped and the primary's error is returned; no third provider is tried. TypeSafe remains explicitly selectable. There is at most one fallback call and no second browser action: the job record's `decisionCalls` names the provider that answered and any fallback reason.

**Importing old configuration.** Old locations are reached only by an explicit one-time `hud import preview|apply [--from <file>]...`; nothing is discovered automatically and no Codex home is guessed. Name each old `hud-settings.json` or jev-ask TOML with `--from`; an explicitly named `.env` is supported too. `$HUD_HOME/jev.env` is merged into `credentials.env` automatically when present. `preview` prints sources, destinations and the names/keys it would add or skip, and writes nothing; `apply` never overwrites an existing HUD value (existing wins, each skip is reported), backs up every destination it changes (timestamped, 0600) and is idempotent. Output never contains values. A TOML's `[jev]` section maps to `jev` in `config.json` (`cdp_url` → `cdpUrl`, `chrome`, `profile`, `state_dir` → `stateDir`, and the other camelCase fields) and `[aistudio]` to `aistudio` (`cdp_url` → `cdpUrl`, `state_dir` → `stateDir`, `models`, `default_model` → `model`, `default_thinking` → `thinking`). Runtime TOML and `JEV_ASK_CONFIG` are ignored.

```bash
# Preview: sources, destinations and names only; writes nothing.
hud import preview --from /tmp/old-codex/hud-settings.json --from /tmp/old-jev/config.toml
# Apply once: existing HUD values win; changed files get timestamped 0600 backups.
hud import apply --from /tmp/old-codex/hud-settings.json --from /tmp/old-jev/config.toml
```

**Jev locations.** The HUD does not contact a browser. Browser tasks run the external `jev-*` CLIs, which own Chrome, profile, CDP and operation-state setup; configure those tools directly. The legacy `jev` location and `aistudio` sections written by `hud import` are not used for browser setup by the HUD. The Decision API configuration above remains HUD-owned.

## Output throughput

The bottom bars do not show the rate (they show no clocks or rates at all, see [The bottom bars](#the-bottom-bars)); the native Inspector writes `~42 tok/s`.
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

`agents` counts as the panel does (see [Agents in the list](#agents-in-the-list)): `active`,
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
| `CODEX_HUD_THEME` | `terminal` | Theme (`terminal` / `titanium` / `mocha` / `arctic` / `ember` / `contrast` / `latte` / `paper` / `none`; [Themes](#themes)) |
| `CODEX_HUD_ICONS` | `unicode` | The panel's icons (`unicode` / `text`); old `nerd` and `emoji` values load as `unicode` |
| `CODEX_HUD_STATUSLINE` | `1` | Bottom bar enabled by default; `0` disables for new HUD sessions, overriding Settings → Bar on launch |
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | `1` | HUD height in lines |
| `CODEX_HUD_MOUSE` | `1` | Enable mouse/trackpad scrolling |
| `CODEX_HUD_SKIP_FONTS` | unset | `1`: the installers leave the MesloLGS NF font out |

Status glyphs use semantic colors: cyan `▸` working, green `✓` turn complete, yellow `■` interrupted, red `✗` failed. Yellow `?` means collection failed. Silence does not turn a working session idle.

### The bottom bars

Claude's statusline, pi's footer and Codex's tmux bar are one line each (except the opt-in Stacked look), built by one function
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
  magenta from 75%, red from 90%; the reset in parentheses). One window only: the one with the least left (`7d …`
  when the week is tighter than the 5 h window). Codex's credits that carry the account on show as `credits 6.8K`. pi has no window: its
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

Two keys in `$HUD_HOME/hud-settings.json` (or the environment) apply to all three bars at once; Bar style has a Display row in Settings; `barFields` is file-only. A saved key wins over the environment like the other display settings:

| Key | Environment | Values |
|-----|-------------|--------|
| `barStyle` | `HUD_BAR_STYLE` (`CODEX_HUD_BAR_STYLE`) | `line` (default), `p10k`, `gauge`, `tide`, `micro`, `stacked`, `headline`, `triptych`; unknown values fall back to `line`. |
| `barFields` | `HUD_BAR_FIELDS` (`CODEX_HUD_BAR_FIELDS`, comma separated) | A list from `model, context, project, quota, notice, loaded`; the default is all of them. The order stays fixed; the key only switches fields off. |

The looks (same facts, fuller forms first as width allows):

- `line` — today's look: coloured text with `│` separators; the default is unchanged.
- `p10k` — powerline capsules, each field on its own colour; flat without arrows with `icons: text`.
- `gauge` — **Gauge Plates**: context and quota (reset included) sit on plates filled to their readings, bold dark text on the level colour over a track; event tags are raised, a `▌` in the event's colour leading.
- `tide` — **Tide**: the whole row is tinted to the context percentage (teal, amber from 70%, red from 85%); requires `COLORTERM=truecolor` or `24bit` for tints, with tier-coloured numbers and no tint on 256-colour terminals. `ctx` is spelt out, the reset is dim.
- `micro` — **Micro Glyphs**: model and `⋔ repo` first, then the meters, then the notices, with two columns inside a group and four between groups. Both meters are ten-cell eighth-block bars when there is room, or both one-cell level glyphs when tight; a reset reads `↻1h19m`.
- `stacked` — **Stacked**: values over their details in two aligned rows in Claude's statusline and pi's footer (the effort under the model's name, a thin bar and the window under the context, the branch under the repo, the reset under the quota, an agent's `model · effort` under its name, `MCP` over `skills`; pi's extension words get a column of their own); Codex's fixed one-row tmux pane falls back to `line` (no pane-height policy changes).
- `headline` — **Headline**: warning tags (context from 70%, quota from 75%) and events lead on the left, the alert alone when something needs you; model, project, context, quota and `MCP`/`skills` follow as one dim cluster flush right, so a quiet bar is a whisper at the right edge.
- `triptych` — **Triptych**: identity on the left, notices between leader rules (`·` dots when quiet), pressure on the right: recessed gauges, a ten-cell one for the context and an eight-cell one for the quota, then the loaded counts.

The six looks have their own ink table (256-colour, from the approved concepts; `latte` swaps in the light set), so they do not follow the terminal's ANSI palette or the panel palette: levels green 71, yellow 179, red 167, quota blue 69 and magenta 170, branch and agent names 176, event marks blue 75 (running), green 71, red 167, violet 141 (skill), alert 209 with dark bold text. Names and readings are bold (not in Headline); an agent's name is bold except in Micro and Triptych. Fields are separated by three columns (Triptych two, Stacked five from 160 columns wide) and by two when the line is short. When a line is still too wide the shared ladder applies: the loaded cluster gives way to a notice first, then the other fields as in the list above.

`NO_COLOR` and theme `none` fall back to `line`. The pi editor's top-right ribbon follows the chosen look too;
under `line` and `p10k` it keeps today's powerline ribbon. Its border remains one row even under Stacked, using
compact muted fields. Other extensions' statuses keep their place before it. pi's cost stays only in that ribbon,
not duplicated on the bottom bar. Gauge Plates, Micro Glyphs, Stacked, Headline and Triptych use 256 colours;
Tide alone adds truecolor tints. No new font is required (block and line glyphs are standard Unicode).

With the `text` icon set (`CODEX_HUD_ICONS=text`) the provider mark in the p10k look is the provider's initials.

The panel's context percentages follow [Codex 0.154's calculation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L2258), subtracting the fixed 12K baseline from both the latest context usage and the window, so `20%` there equals native `80% context left`. Custom windows <=12K retain a raw-window fallback. Cumulative session tokens never measure context fill.

```bash
CODEX_HUD_STATUSLINE=0 codex
CODEX_HUD_THEME=mocha codex
```

Saved display preferences override environment defaults; change Theme and Icons in Settings when preferences already exist. Wheel events go to mouse-aware applications or fall back to tmux history scrolling. HUD bindings use a separate key table, and right-clicking the side panel no longer pastes clipboard text or moves keyboard focus.

Settings → **Bar on launch** saves the bottom bar preference for the next new HUD session. An explicit `CODEX_HUD_STATUSLINE` takes precedence over that saved value.

<details>
<summary>All environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_NOTIFY` | `0` | Announce failures and finished agents through tmux |
| `CODEX_HUD_NOTIFY_COOLDOWN` | `300` | Seconds before a different alert of the same kind can fire |
| `CODEX_HUD_NOTIFY_DESKTOP` | `0` | Also raise a desktop notification (needs `CODEX_HUD_NOTIFY=1`) |
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
event is worse than none. Settings → Panel → Notifications, or
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

Current read failures appear as notices in the panel; inspect an agent with `v` for its evidence
in the Inspector, including the main session's TPS sample time, sample duration
and estimation method. In an agent's Inspector, Enter expands those same TPS
details. Current-turn, older/previous-turn and missing measurements are distinct.
The JSON snapshot also includes optional `outputRate` evidence and `health.sessionBound`.

The normal panel shows current faults without opening Settings: no bound Codex
session, failed session reads, Herdr probe/transport failure, uncertain notification
history after reconnection, and classified model failures or queue waiting. The
compact bar shows collection/bridge problems. Diagnostic details retain the last
successful read/acknowledgement; normal operation adds no diagnostic banner.

Settings → Models offers **Test API** (or `t` in that group), and `t` again cancels.
It checks labels, progress and failure-cause requests using the same model ID
and their internal effort defaults, with fixed synthetic messages only. Each
request has a 256-token answer bound (plus the internal reasoning allowance
where applicable) and a 15-second timeout. The three calls share the normal
hourly budget; no preferences are saved and no session text is sent. Model text
off or a missing matching key makes no network request. Closing Settings or
changing the connection cancels pending checks and prevents late results from
reappearing. Results distinguish authentication, unavailable model, rate limiting,
timeout, connection/service failure, output truncation and invalid responses.

Model calls sharing one local `$HUD_HOME` atomically reserve a budget slot
before sending. Replies merge into a shared cache under coordination; simultaneous
identical cacheable requests share one result. A crashed/cancelled sender may
conservatively consume its reserved slot. Coordination failure refuses the call
instead of sending without accounting. Explicit probes precede queued visible
progress, which precedes native background jobs; background requests
are protected from starvation. In-flight requests are not preempted. Shared-disk
coordination requires local filesystem atomic rename and coherent directory reads.

### Universal CLI

Build with `npm run build && npm run build:hud-mcp` (Node 22.x ≥22.13 or Node ≥24;
23 is unsupported), or install with `./install --with claude,pi,codex`.
`hud codex ...` and `hud codex-hud ...` invoke the existing tmux-bar launcher.

`hud panel [--width N]` opens the interactive panel beside the caller in herdr;
`--here` renders in the current terminal. The new split uses saved Settings → Panel → Width (default 56 columns); explicit `--width N` overrides it for this open only, until a changed Width is saved.
It reads jobs from `$HUD_HOME/jobs` and the clients' transcripts, not a ledger.
Claude and pi open it with `/hud`; Codex uses F12. See `hud panel --help` for syntax.

The MCP exposes six tools: `hud_roster`, `hud_create`, `hud_read`, `hud_send`,
`hud_respond` and `hud_close`. Roles and the dispatch convention come from files;
job records and reports are plain files under `$HUD_HOME/jobs`.
`hud_create` accepts `role`, `request_key`, `task`, optional `cwd` and display-only `package`.
For pi roles only, override `model`/`thinking` or set boolean `lens`, `mcp`, `tps`, `ui_ext`,
`skills`, `split`; omitted switches keep pi-role defaults, and `split` defaults to the role file.
`ui_ext: false` passes `--no-ui-ext`; true keeps the default UI extensions (no flag).
`skills: true` passes `--skills`; false keeps personal skills excluded (no flag).
`split: true` reserves a right helper pane beside the left worker. `pi_args` is a string array
(maximum 128 strings, 4096 characters each), appended verbatim after pi-role's `--`, never through a shell.
`hud_roster` lists accepted options; job.json and `hud_read` expose the supplied switches, effective split
and pi arguments (omitted switches still mean pi-role defaults). A repeated `request_key` returns the
original job unchanged, even with different options. Jev roles reject these launch options.
`hud_read` reads a report (and stamps `read_at` in the job record). The panel does not
wait for that: a settled HUD job is done whether or not its report was read.
