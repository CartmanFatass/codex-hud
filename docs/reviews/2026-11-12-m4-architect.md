Release: blocked

Recommendation: keep the passive collection → projection → rendering architecture and thin execution adapters; fix the Git command boundary shared by the bars, then qualify the actual clean-built release archive—no new execution framework or installer transaction system is needed.

Reviewed detached **62809b78**. One blocking finding; the remaining points are release/maintenance advice. I read the complete product spec, architecture, relevant reference and installer paths, the thin MCP/watcher, and all seven review rounds (round 7 read from the main checkout as directed by the orchestrator). The named in-flight M4-FIX7 changes and previously accepted residuals are not new findings here.

## Ranked points

### 1. **Blocking — two always-on bars execute commands from repository Git configuration**

**Evidence:** `src/harness/pi/p10k-footer.ts:276–284` runs plain `git status --porcelain=v1 -b`; `src/collectors/git.ts:158–188,315–325` disables fsmonitor but not clean/process filters before its status call. The latter is live through `src/collectors/hud-status.ts:169–184` and `src/index.ts`, not retired code. The pi footer runs its refresh at start/update (`p10k-footer.ts:543–561,673–684`).

**What the owner hits:** opening pi or the Codex HUD in a repository with a configured Git hook/filter can execute that command just to draw the bar. A same-length edit to a tracked, filter-attributed file makes status invoke its clean filter. Pi also invokes a configured `core.fsmonitor` executable. No panel, model request, worker dispatch or explicit Git action is necessary. This violates the specific **spec §4 prohibition on running commands from an untrusted repository**; it is not an added adversarial/multi-user requirement.

**Verified by execution:** an isolated inline Node probe through `tmp/env.sh` constructed four synthetic repositories directly as filesystem fixtures (HEAD, config, one loose blob and a valid index; no state-changing Git commands). A tracked file changed from `old\n` to `new\n`; its clean filter and fsmonitor wrote harmless marker files. The probe called the real built collectors, and started the real `createP10kFooter` with a minimal host/context, **without injecting its gitStatus dependency**:

```text
codex  {"cleanExecuted":true, "fsmonitorExecuted":false}
pi     {"cleanExecuted":true, "fsmonitorExecuted":true}
claude {"cleanExecuted":false,"fsmonitorExecuted":false}
project{"cleanExecuted":false,"fsmonitorExecuted":false}
```

The first probe's unequal-sized edit did not exercise the clean-filter branch; the equal-sized edit above did. The existing safety test covers Claude only and passes while these other shipping paths remain unsafe.

**Smallest change / implementer contract:** apply the existing safe Git policy to both callers. `src/collectors/worktrees.ts:41–83,176–201` already supplies asynchronous bounded execution and filter neutralisation; `src/statusline-parity/git.ts:21–104` supplies the fuller statusline policy. Reuse/extract the necessary policy rather than copy another partial argument list. Preserve asynchronous, single-flight refresh and existing bar output. Failure to discover/disable repository filters must skip the status read, not run an unsafe fallback. Keep fsmonitor disabled and lazy transport disabled; retain the supported distinction between trusted owner configuration and repository-provided commands.

**Tests required:** one real-filesystem regression matrix covering the production Claude, Codex, pi and Project/Changes Git paths, with a same-size modified tracked file and marker-producing repository clean/process filters and fsmonitor. Require dirty/branch facts where safe, and no marker execution. Keep the existing trusted-global-filter behavior test. Mock-only argument assertions would miss this defect.

### 2. **Advice — qualify the release artifact, not merely this checkout; current installation is path-bound**

**Evidence:** `install:60–74` installs dependencies and invokes TypeScript unless `--skip-build` is supplied; `install:79–91` creates links into the extracted tree and refuses an existing live command at another target. `install.d/pi.sh:46–63` records that tree and Node path in generated bindings. `packages/hud-mcp/tsconfig.json:4–9` emits its imported shared source into a nested output tree. `packages/hud-mcp/src/thin-main.ts:15–17,197,389` resolves bundled roles and launch scripts relative to that layout. A flat copy of just the MCP entry is insufficient.

**What the owner hits:** a binary-only archive offered with today's default `./install` attempts a source build; an archive missing roles/convention/integration assets can install links but fail later; removing/moving the extracted directory breaks installed commands. The already-installed checkout's live symlinks also prevent installation from a differently located release tree. This is a simple-install limitation, not a request for transactional upgrades.

**Verified:** all three output directories were initially absent. `npm run build`, `npm run build:test` and `npm run build:hud-mcp` succeeded from current sources. The fresh default suites include the core and five-extension installation checks, client registration stand-ins, backups, repeat install, uninstall and retained-data assertions. Built `dist/` and `packages/hud-mcp/dist/` contained no `<home>/` or `MyHUD-wt/M4-ARCH` string in a targeted scan. That is not a general secrets audit. **No final release archive exists in this review, so archive installation is not certified.**

**Smallest release work:** use one explicit archive inventory and one extraction rehearsal:

- Start with empty build outputs; never tar a long-lived working `dist/`. Include executable `install`, `install.d/`, live launchers, both complete runtime output trees, package metadata/dependencies, bundled role JSON and convention, required integration/skill assets and third-party notices.
- With the current default installer, include `src/`, the package sources, both build configurations and lockfile, plus either usable build dependencies or a documented `npm ci` prerequisite/network path. If choosing a binary-only archive, make `./install` actually support that choice; do not silently require the owner to discover `--skip-build`.
- Exclude `.git`, `.codegraph`, job/session data, scratch/probe logs, credentials, developer-local dependency links and retired build artifacts. Audit **all archive members**, not only JS, for local paths and secrets. No immutable-release/receipt machinery is needed.
- Extract under a different path (including spaces), run the advertised install command in a clean temporary HOME, exercise `hud` and actual MCP initialize/tools/list/roster, then uninstall and verify unrelated config, keys, history and reports survive. Use client stand-ins for isolated registration checks; keep real-client acceptance explicit.
- Tell the owner to retain the extraction directory. For the checkout-to-archive transition, use the old installer's uninstall before installing the new path, preserving `$HUD_HOME`; do not remove unrelated colliding commands.

### 3. **Advice — the active structure fits the product, but the shipped documentation still teaches a retired architecture**

**Evidence:** the live six-tool dispatcher is `packages/hud-mcp/src/thin-main.ts:44–98,247–405`; browser work delegates to external CLIs in `packages/hud-mcp/bin/hud-jev.mjs:70–108`. The panel builds observations and invokes display generators in `src/tree-page.ts:917–1053`; render consumes the resulting board. In contrast, `packages/hud-mcp/README.md:3–16,46–116` advertises seven stub tools, `delegate.json`, caller proofs and future ledger transactions. `docs/reference.md:35–258` labels its old activation material historical but still contains extensive executable-looking instructions for removed bootstraps, owned workers and receipts. Historical descriptions also remain throughout `docs/ARCHITECTURE.md` beneath its newer superseding sections.

**What the owner/next implementer hits:** searches return obsolete install commands and execution contracts beside the real ones. This increases the chance that the next milestone rebuilds the platform the owner explicitly retired. I found no reason to replace the current observer/projection boundary, or to delete genuinely live read-only DTOs/readers simply because their directories have historical names.

**Smallest change:** replace the package README with the six current tools and pi-roles/external-browser dependencies. Move obsolete activation/owned-worker instructions out of the current reference, or omit them from the release documentation with one historical link. Make the architecture's current flow authoritative without multiple contradictory recipes. Keep historical reviews/contracts as repository history, not release setup instructions. No runtime layer is required.

**Basis:** source/document inspection; the passing thin-MCP tests corroborate the live tool surface. This is not another finding that the deleted execution runtime still runs.

### 4. **Advice — cost is controlled on frames and model requests, but not every history-dependent operation is bounded**

**Evidence:** `src/collectors/thin-jobs.ts:157–164` still lists/stats/sorts all job directories before limiting bodies to 200; `packages/hud-mcp/src/thin-main.ts:147–152` reads all job receipts for request-key lookup/listing. These are separate from the bounded returned card/list counts. `src/harness/pi/p10k-footer.ts:201–240,543–547` recomputes cumulative totals over the entire native session when the leaf changes, although rendering/resizing correctly reuses captured values. `src/collectors/decision-labels.ts:74–119` bounds current plans but may plan individual question classifications; this is the already accepted cost characteristic, not a new finding.

**What the owner hits:** large retained history raises cold/status collection cost; long pi sessions raise update cost even though redraws are cheap. Retention normally reduces the job-directory portion, but legitimately retained jobs with preservation failures remain. I established **no new normal-use §4 cost blocker** and did not reclassify the earlier accepted directory/cache residuals.

**Smallest action:** retain the existing limits, shared LLM/Decision reservations and per-feature floors. Carry these specific growth paths into the next performance decision instead of describing the whole collector as constant/bounded work. If they become material, improve the relevant cursor or session aggregate, not the renderer, and do not add a resident index service or unapproved deletion policy. The spec's deferred transcript/retention candidates remain deferred.

**Verified:** fresh tests passed for unchanged/cold job cache reuse, Claude bounded replay, model-off/no-key behavior, shared concurrent call caps, request coalescing, panel backoff and render-without-I/O. Complexity above is inferred from loops; no new benchmark numbers or WSL qualification are claimed.

### 5. **Advice — keep process deadlines at external adapter boundaries**

**Evidence:** `packages/hud-mcp/src/thin-main.ts:164–191` resolves its child promise only on close, with no deadline; mutation calls share a chain at `:630–631,678–681`. The Jev wrapper's `cli()` similarly waits for the external process (`packages/hud-mcp/bin/hud-jev.mjs:51–69`). By contrast, the panel's herdr adapter is bounded, the watcher reaper has a 135-second timeout, and model requests have cancellation/deadline handling.

**What the owner could hit:** a wedged external launch/reap command holds subsequent mutations in that MCP process; a wedged browser CLI leaves its job working. These are inferred failure paths, **not reproduced normal-use hangs or a release blocker**. They do not justify supervising pi sessions or taking browser ownership back from the external runtime.

**Smallest change if this becomes a supported recovery requirement:** use the existing bounded herdr transport for short management operations, test a child that never replies, and retain the job/launch evidence on timeout. Do not retry an uncertain send/create automatically. Browser execution time limits belong first to the external CLI contract, not a guessed HUD timeout that kills valid long jobs.

## Lifecycle and data-safety assessment

The existing separation is worth keeping: the bar/panel observe; models write only display text; the MCP records and dispatches; pi-roles/browser CLIs execute; the on-demand watcher reaps. Panel reload has one replacement/supervisor path, not a growing parent chain (`src/utils/panel-reload.ts:46–77`), and panel shutdown cancels generators, timers, input and lifetime listeners (`src/tree-page.ts:1084–1117`). Fresh reload tests covered bad builds, dirty Settings, bound/unbound place restoration, repeated replacement, signals and width continuity.

Fresh watcher tests covered real legacy-session moves before deletion, link-target preservation, failed moves retaining jobs, reap-before-delete, working jobs with housekeeping failures, degraded polling/recovery and healthy-watch nonpolling. I do not reopen accepted reap timestamps, partial migration, coincident watchers, or the FIX7 SESSION.txt/log changes. No live owner data, providers or processes were used to establish these results.

## Commands and verification limits

All builds, tests and probes ran through `<repo>/tmp/env.sh` in the assigned worktree, on **Node v24.22.1**:

- Initial checks: HEAD `62809b78`; `dist/`, `dist-test/`, `packages/hud-mcp/dist/` all absent.
- `npm run build && npm run build:test && npm run build:hud-mcp` — **exit 0**.
- `npm run test:unit && npm run test:mjs` — **55 + 364 passed**, zero failures/skips/cancellations, **exit 0**.
- Independent real-Git/real-footer marker probe — **exit 0**, reproduced finding 1; fixtures removed in `finally`.
- Final `git status --short` — empty; `git diff --check` — **exit 0**. Only ignored build output and this requested report were retained.

These are synthetic integration checks, not logged-in Claude/Codex/pi/herdr/browser acceptance. No real homes/configs/keys/session history were inspected or changed. No external model calls were made. No final archive, production install/uninstall, Node-22 qualification or live terminal performance was certified.

## Optional hardening:

None beyond the scoped advice above. In particular, no identity framework, execution supervisor, transactional installer, new daemon or generic security abstraction is recommended.

**Scope:** inside task. This is architectural/release advice; the orchestrator decides the release gate. Finding 1 follows the existing owner-approved threat model and requires no product-scope change.
