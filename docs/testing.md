# Project test map — TEST-SLIM-0 draft

**Status: proposal for orchestrator approval, not an implementation or a new merge gate.**
Snapshot: `f1d086e`, branch `test-slim-0`, 2026-11-10 audit follow-up. R6A-A5 is included;
R5UX-P3B and PIROLE-PR4 are not. The external TEST-SLIM-0 `inventory.json` and `proposal.md`
contain the census, per-case consolidation dispositions, timing provenance and execution slices.

## 1. Scope and ownership rules

This is a product-boundary map, not a catalogue of package briefs. A row has one owning
file and named test; distinct failure conditions become named table rows there, not new
per-package fixtures. A test can own several related observations. The title below is the
current source title (template variables mean generated rows); a future slice preserves
individual row identities and assertions when it consolidates. Other tests may exercise a
path as integration support; that does not create a second owner or justify deletion.

Current scope is concept §15's 2026-11-07 fixed-role facade, herdr CLI execution, owned Jev
and main-session chaining. Contracts' supersession headers apply. Old ledger/run/claim,
retirement and automatic-control machinery is **compatibility coverage, not a requirement
for the new path**. Do not remove it merely because it is historical; the owner must decide
any supported-profile change. WF1 remains deferred. No synthetic test qualifies a real
provider, browser account, parent-exit durability profile or WSL performance target.

**Frozen overlaps:** WP0 `main-features.json`, every file it maps (including mixed files),
and visual baselines remain byte-for-byte unchanged. An owner below in such a file is a
routing pointer only: list overlap, do not fold, move, retitle or regenerate it in TEST-SLIM.
`run-main.mjs` checks carrier mappings, executed assertion titles, assertion-statement
hashes and visual frame hashes; keeping only similar coverage is insufficient.

## 2. Layers

| Layer      | Purpose and boundary                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pure`     | Deterministic projection, parsing, layout and policy from supplied values; no process or native state.                                                                                                                                                                         |
| `contract` | Real public module entry and its persistence/authority/transport boundary, with the shared synthetic ports; assertions concern user-visible facts and refused effects. Real private filesystem operations stay real for path/permissions/atomicity contracts.                  |
| `process`  | Only process, signal and lifecycle invariants: process stamps, inherited descriptors, parent death, exec/argv/environment, groups and cleanup. Use only processes created by the fixture. A slow functional lifecycle test does not become perf merely because it exceeds 5 s. |
| `e2e`      | Three small synthetic product scenarios E01–E03 compose the real facade, panel collection and packaged host. Extend these; do not replicate the entire failure matrix at this layer.                                                                                           |
| `visual`   | Existing pinned terminal frames, display widths, control targets and EN/ZH appearance. Baseline bytes are frozen; logic around them belongs to contract/pure owners.                                                                                                           |
| WP0        | Inherited main behaviour and its pinned assertions/frames, unchanged by TEST-SLIM. Run by its existing runner and opt-in rules, not a replacement for the product map.                                                                                                         |
| `perf`     | Opt-in latency, cold-cost, large-scale, RSS and throughput experiments in `tests/perf/`, run serially by `npm run test:perf` with host/Node/revision metadata. Never part of `npm test` or the merge gate. Small correctness residues remain in the default contract owners; frozen WP0 performance overlaps keep their existing routing.                                      |

## 3. Product behaviours and their owners

Paths are relative to `tests/unit/`, except `tests/hud-mcp/…`. Each named case executes
the stated boundary; compound provenance/cache, settings, snapshots and protocol
behaviours have separate owners. Frozen owners are routing pointers, never edits.

### Bar and statusline

| ID  | User/contract behaviour                                                                       | One owning test                                                                                                                    | Layer      |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B01 | Bar fits the requested terminal width without losing essential identity                       | `bar-layout.test.ts` — the alert survives every pane width                                                                         | `pure`     |

B16 is the opt-in owner-config parity boundary, not an expansion of B02's frozen-default
contract. It also owns transcript append/reset/malformed handling and the real repository
command-safety row.

| ID | User/contract behaviour | One owning test | Layer |
| --- | --- | --- | --- |
| B16 | Opt-in Claude 0.8.0 owner-config compact parity and bounded transcript/config/git evidence | `statusline-parity.test.ts` — B16 statusline parity: installed goldens and bounded real collectors | `contract` |

### Collectors and harness adapters

| ID  | User/contract behaviour                                                                                            | One owning test                                                                                                                                | Layer      |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C12 | Bounded model material retains marked head and tail, leaving short text unchanged                                  | `model-jobs.test.ts` — a long text keeps its head and its tail, the cut marked; a short one is left alone                                      | `pure`     |
| C13 | Finished-agent summary jobs digest the public final answer once and feed the brief/log                             | `model-jobs.test.ts` — a finished agent is digested once from its whole final answer, into its log, and the brief uses the digest              | `contract` |

### Jev

| ID  | User/contract behaviour                                                                    | One owning test                                                                                                                                      | Layer      |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| J07 | A decision network failure neither executes an action nor echoes cause text                | `jev-decisions.test.ts` — a network failure does not execute and does not echo the cause text                                                        | `contract` |
| J15 | Decision distributions reject probability sums outside the declared tolerance              | `jev-decisions.test.ts` — validateChoice accepts a full distribution and rejects a sum outside 0.02                                                  | `pure`     |
| J16 | Provider credentials never appear in enumerable or inspected properties                    | `jev-decisions.test.ts` — provider api keys stay out of enumerable and inspected properties                                                          | `contract` |

### Release, activation and packaging

| ID  | User/contract behaviour                                                                                                                 | One owning test                                                                                                                                            | Layer      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R04 | Pi package owns/restores the p10k footer with independent panel controls, preserves statuses and six proxies                                                | `pi-package.test.mjs` — REAL package entry start -> reload -> shutdown owns footer, restores defaults, keeps other statuses and exactly six proxies | `contract` |
| R05 | Pi tree/reload transitions require exact live generation proof and one-use fencing                                                      | `pi-package.test.mjs` — tree continuity ${variant}: live exact-generation proof, preference and one-use fencing                                            | `contract` |

R6B-1 dead-code exception: external Pi prototype conformance and its fake launcher/dispatcher,
the six disconnected transport experiments with their five tests/demos/four fixtures, and
`scripts/workbench/*` / `tests/workbench/*` retire with their code (architect §2 P/T/W).
They are not current product guarantees. The historical `check-cloud.mjs` runner drops those
selections and the app-server demo selection; default-suite legacy app-server tests remain
until slice L. Product UI `workbench*.test.ts`, WP0 and visual baselines are unchanged.
The mixed role-facade delegate_status compatibility case retires; its Jev schema assertions
remain under “role create accepts judge statements and rejects extra statement fields”.

Owner drain runbook (not run against owner data by this package):

```sh
node scripts/audit-r6b-drain.mjs --slice pi --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice transports --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice workbench --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice runtime --home "$HUD_HOME" --prefix "$HUD_PREFIX" --clients "$R6B_CLIENT_PATHS"
```

Use explicit canonical paths. `--clients` is a comma-separated list of complete client
config paths (a path containing a comma is unprovable here); optional `--inventory` takes
the small process-stamp JSON described in the script header. A stamp is evidence about
that process only, not a complete inventory or proof of pane/tab/browser closure. Confirm
all relevant homes/workspaces and cached clients with the owning release. Every FAIL or
UNKNOWN is nonzero and blocks automated drain approval: resolve it through that release's
inspection, never by asserting `closed`, replaying a stored executable, killing by name,
or deleting old releases. The script deliberately cannot attest complete client scope,
herdr resources, copied fixture children, ledger scopes or browser handles, even when the
readable process/config checks pass. Retain rollback and job-pinned releases. Slice L's
activation/resource checks remain an owner gate, separate from this source-only removal.

### Product scenarios

| ID  | User/contract behaviour                                                                   | One owning test                                                                                                                                            | Layer |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| E03 | Built pi package owns/restores footer across startup/footer-off/reload/shutdown; panel controls stay independent      | `pi-package.test.mjs` — REAL package entry start -> reload -> shutdown owns footer, restores defaults, keeps other statuses and exactly six proxies | `e2e` |

Footer parity owner: `pi-footer.test.ts` — the `p10k parity: ${row.name}` table compares exact original ANSI
captures (idle, spinner, every fitting/drop step, ASCII, Nord, defaults and switches off), plus the real delegation
segment's complete/partial/unavailable rows.

## 4. Shared stand-ins and fixtures

### One fake herdr: `tests/fakes/herdr.mjs`

`herdr-model.mjs` owns the single inventory state machine and exports `createHerdr` and
`herdrState` for in-memory use. `herdr.mjs` supplies the CLI/socket front ends;
`panel-herdr.mjs` and `pi-owned-herdr.mjs` are compatibility adapters. The owned profile's
journal admission and real synthetic worker hooks live in `herdr-owned.mjs`, not in a
second inventory parser. Existing role-facade argv/protocol semantics are retained. Union:

- tab creation/list/get/rename/close and pane split/down/right/get/list/close, stable owned
  IDs, labels, workspace and origin, structured environment and args-json forwarding;
- run/start, type/send/Enter, wait, bounded stdout/stderr, exit/timeout/missing executable,
  command log and exact call counts; caller PATH and metacharacters remain data;
- persisted synthetic state, lost reply before/after effect, malformed/partial/unknown
  inventory, reused IDs or foreign occupants, late registration and replaced generation;
- current command/foreground/session/editor proof, transient shell readiness, stall
  recovery, native TUI eligibility and token registration; explicit clock/barrier controls;
- optional owned synthetic worker launch and process stamps/cleanup, only for process
  owners. An in-memory port uses the same scripted state machine for contract tests;
  retain a thin subprocess adapter for argv/stdio/timeout and lifecycle proofs.

Do not make the fake reproduce real herdr scheduling or infer absence from incomplete
inventory. Each profile rejects unsupported commands; unknown state never becomes idle,
closed or safe to mutate. The owned profile refuses run/rename commands rather than
bypassing journal admission. Role CLI calls serialize their private state file and persist
script consumption even for before-effect failures; a deadline-lost effect keeps its lock
until it settles. A killed lock holder remains unresolved until fixture cleanup, never
silently displaced. Real herdr/tmux probes stay local and separate.

### One fake pi family: `tests/fakes/pi.mjs`

The shared module exports owned-worker and package-host profiles, not one executable
pretending these boundaries are the same protocol. `pi-owned-worker.mjs` and
`fixtures/pi-package-host.mjs` are thin compatibility adapters. R6B-1 removed the dead
external `pi-role.mjs` / `pi-dispatch.mjs` adapters and their shared launcher/dispatch profiles,
including their two protocol-only cases and two prerequisite-refusal rows in the mixed
`test-stand-ins.test.ts`; owned-worker/package-host and all herdr cases remain. Consumer-local API/context stand-ins migrate in their owning
area slices; no consumer assertions are replaced here.
`tests/fakes/pi-package.mjs` is **not a fake protocol**: it re-exports the unchanged real
installed-package and loader discovery as a separate prerequisite; package availability
is never fabricated.

- exact model/effort/role arguments, request and helper contracts, launch acknowledgement,
  private session header and lazy SESSION creation, editor text and one Enter, logs;
- primary/helper STATUS, output_written/artifact, QA timestamps, continuation baselines,
  stale/invalid/unknown snapshots, lost acknowledgements and failed reaping;
- managed worker tools, helper limits/reservations, startup/quit/stall/grace and closed
  verdicts, controlled failure before/after each admitted side effect;
- package SDK event registration, six tool proxies, command routing, UI setStatus/footer
  ownership, other-extension sentinel fields, reload/tree/fork/shutdown and canceled races;
- fake events, clocks, promises and counters without provider/network calls, plus an
  **optional real installed extension-loader adapter** for the pinned worker loader proof.

`pi-owned-loader-worker.mjs` and `pi-package-host.mjs` are real-loader/host fixtures, not
interchangeable fake protocols. Keep their real loader code path. `pi-owned-release.mjs`
and `pi-package-release.mjs` stage release fixtures; the latter builds when invoked, so
reuse already-built bytes once per suite rather than silently building per scenario.

### One temporary HUD home: `tests/fixtures/hud-home.ts`

`hudHome({ env?, files?, after? })` returns a private temporary root, distinct
HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR, source/session/task/job directories, a bounded
relative-path seed writer and idempotent cleanup. `after` registers cleanup before seeded
effects. Every HERDR_* variable, colour/settings override, live/provider opt-in and
credential variable is removed from the copied child env; no real home, secret or session
is copied. There is no mutable singleton. Domain routing/settings/clock/process builders
remain in their owning slices and can build on this fixture. Cleanup removes only the
fixture root; synthetic process owners must terminate their own children before cleanup.
Share builders and immutable seed bytes, not authority.

Domain capabilities retained by current inline setups (not silently normalized by this builder):
permissions/umask, symlink and FIFO/oversize cases,
atomic replacement and inode pins, private SQLite/WAL, JSONL incremental cursors,
request/receipt/STATUS/QA/report files, role/runtime package staging, fake executables on
isolated PATH, bounded process groups, cancellation/teardown and restore of test mocks.
Retain specialized unsafe-path and process fixtures on top; do not normalize away the
unsafe state under test. The static inventory detects 192 unit/mjs files with `mkdtemp`
at this snapshot; that is a temporary-root indicator, not proof all 192 override HOME.

### Other shared fixtures

- `hud-data`, `b10b-delegation`, `b10b-big`, `work-card-p2`, `workboard`: reuse deterministic
  trees, clocks, semantic Work facts and layout variants. Native and facade evidence
  remain separate; a display fixture is never authority to send a prompt.
- `b17`, `b21`, ledger and run fixtures: preserve real private SQLite transactions and
  signed/stamped reconciliation facts; share constructors, not accepted decisions.
- Jev fake CDP/page fixtures: one scripted CDP boundary and recorded synthetic DOM facts
  for ChatGPT/Studio, lease/record builders and deterministic judgments. Preserve real
  DOM extraction and actual no-second-click fences; do not stub the operation asserted.
- Release fixtures: one immutable prepared closure with per-case private copies for
  corruption/activation. Never edit hard-linked dependencies or working build outputs.
- Visual/WP0 fixture bytes and manifests: read-only. Do not merge generators or regenerate
  baselines in these slices. Historical package-specific fixture names may be adapters
  during migration, but contain no duplicated state machine.

## 5. How to plan a package's tests

1. Find the user/contract behaviour ID above before specifying any new test.
2. Read its owning case and the shared fixture's supported capabilities.
3. Extend that case with a named row for the genuinely new input, boundary or refusal.
4. If the owner is WP0/visual-frozen, record the overlap and ask for an allowed adjacent owner.
5. Add a map row only when no existing behaviour owns the new invariant.
6. Choose the cheapest layer that runs the real code and boundary under assertion.
7. Extend the shared stand-in; never copy it or start a fresh per-package fake.
8. Keep only E01–E03 for product composition; signals/lifecycle need their real-process owner.
9. Put scale/cost/latency distributions in opt-in perf, with a small correctness row left here.
10. Name affected owners, unique-coverage evidence and frozen overlaps in the brief and review.

## 6. Evidence and approval gates for consolidation

The inventory has 400 scoped files: 320 compiled unit, 43 direct mjs, 22 hud-mcp,
4 mutation drivers, 5 performance scripts and 6 MCP benchmark/trace support scripts.
It counts 138,126 lines in that scope (136,315 default-suite lines), not the audit's
broader 173k including other integration/fixture trees. Historical unit timing is 4,493
expanded cases, 1,332.547 summed seconds and 350.680 wall seconds. Static declarations
are not execution counts. The gate failed one P2 timing assertion; these are historical
observations, not a passing current baseline.

Later slices need a Node built-in lcov baseline and before/after per-test unique source
line/branch diff, canonicalized from all emitted trees to source paths. No unique covered
source line or branch may disappear without the orchestrator's explicit dead/display-only
exception. Exact commands, cost, failure handling, proposed savings and immutable overlap
rules are in the external `proposal.md`; no test is removed on title similarity alone.
