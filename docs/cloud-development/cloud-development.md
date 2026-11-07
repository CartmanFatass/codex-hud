# Cloud development handbook

## Scope and ground truth

Use isolated cloud worktrees to design, implement, review and test Universal HUD. Provider credentials, a logged-in CLI, a user's local machine and a real provider session are not prerequisites for implementation or cloud simulation. A result must identify its actual evidence: source specification, fixture, simulated process, native local process, or real-provider observation. Never promote one category into another by wording alone.

The reference baseline for this handbook is `CartmanFatass/codex-hud` integration commit `4899b3f5802657520509e5c0db1918395b031257`, not `main`. Existing feature branches and local WIP can move independently. Before work, read `AGENTS.md`, the relevant contracts and `docs/handoff/STATE.md`; inspect exact current branch heads and diffs before creating work. Do not overwrite, reset, or clean another worktree.

### Owner clarification (2026-11-06)

Use official interface documentation pinned to the relevant version (and capture date for moving documentation), together with synthetic/mock fixtures, for cloud design, implementation and tests. Real Claude/Codex/Pi harness access, provider credentials and real-scenario tests are not prerequisites for that work or for reviewed publication to an authorized test branch. The owner will perform unified real validation locally later. This does not authorize an integration merge, release, production capability claim, or a bypass of network/auth restrictions.

Lack of real access alone must not reopen this resolved blocking question in planning, review or agent handoff. Record the missing evidence, continue independent authorized work, and leave a precise local-validation checklist. Escalate a genuinely new contract, authorization or implementation issue on its own merits; do not disguise it as a request for credentials or mark an unrun check as passed.

### Owner clarification: project repair authorization (2026-11-06)

The owner has preauthorized the current project's tasks within their original goals and safety limits and cancelled the repair-round quota. Continue in-scope implementation and test repairs, with a fresh independent Oracle for each re-check, without a fixed iteration count. Do not stop or request repetitive confirmation solely because of the number of corrections, including when an earlier brief allowed only two rounds or one additional round. Report substantive new findings, preserve the review and check evidence, and continue independent authorized lanes while a genuinely blocked lane awaits resolution.

This clarification supersedes contrary repair-count or count-triggered owner-approval instructions in earlier workflow documents, package briefs, handoffs and reviews, including F4 digest-notes records. Those records retain their original wording as history; they do not reinstate a repair quota. Historical run-sizing guidance is not a substitute repair-count limit. A real scope, contract or permission change, an owner-reserved decision, or an applicable safety-policy limit still needs its proper decision, confirmation or handoff. Missing prerequisites and uncertain outcomes must still be reported honestly, and uncertain side effects must not be blindly retried.

This is not approval for unrelated work or expanded access. Current model roles, fresh independent review, security contracts, protected-branch restrictions, integration/merge gates and production capability gates remain unchanged. Continue to publish only to an already authorized target after its required review and checks; this clarification does not itself authorize a merge, release or deployment.

## Repeatable cloud setup

1. Provision a Linux cloud workspace with network and GitHub access appropriate to the environment. Record OS, architecture, Node, npm, Git and any test dependencies. The existing saved cloud configuration is configured for `main`, so explicitly select the intended branch. Its availability is environment-dependent.
2. Resolve the integration branch to a commit, create an isolated worktree or fresh clone, and pin the checkout. Example, after repository access has been configured:

```bash
git clone https://github.com/CartmanFatass/codex-hud.git hud-cloud
cd hud-cloud
git fetch origin codex/delegation-integration
BASE=$(git rev-parse FETCH_HEAD)
git switch --detach "$BASE"
git switch -c dots/<work-package>
printf 'base=%s\n' "$BASE"
git status --short
node --version && npm --version && git --version
npm ci
```

Replace `<work-package>` with an unoccupied branch name. Never expose credentials or reuse personal session directories for tests. Pin and document the actual lockfile and tool versions; use Node 22.13+ or 24 for `node:sqlite` paths. Package installation requires registry access or an available cache; report a failure rather than pretending setup succeeded. The inspected cloud host had Node 24.22.1 and npm 11.9.0, while tmux was absent; this is an observation, not a guarantee for a new workspace.

3. Use temporary `HOME` and `HUD_HOME`, synthetic identifiers and fixtures. For a dedicated test shell, one example is:

```bash
TEST_ROOT=$(mktemp -d)
export HOME="$TEST_ROOT/home" HUD_HOME="$TEST_ROOT/hud"
mkdir -p "$HOME" "$HUD_HOME"
# Run the selected checks in this shell. After test-owned processes exit:
rm -rf -- "$TEST_ROOT"
```

Verify `TEST_ROOT` is the temporary directory you created before cleanup. Do not read or modify real provider homes, settings, credentials or transcripts. Own and clean up only processes created by the test. Avoid concurrent resource-intensive runs on a shared host, and never kill processes by a broad name or pattern.
4. Keep work on a dedicated non-main branch; do not force-push, rewrite history, or stage `node_modules`. Review the exact changed tree and run checks relevant to it. Publication of a package is not a merge into `universal-hud` or a release.

## Commands and scope

At the pinned baseline, `package.json` defines these commands. Run only those appropriate to the change and record command, exit status, version and relevant output; listing a command does not claim it has passed.

```bash
npm run build
npm run build:test
npm test
npm run test:core
npm run test:visual
npm run build:hud-mcp && npm run test:hud-mcp
npm run format:check
npm run check:fixtures
git diff --check
```

The existing GitHub Actions workflow runs on `main` pushes and pull requests, not arbitrary branch pushes or manual dispatch. Its test matrix is Node 18/20/22, core matrix Node 22/24, and integration job installs tmux and uses Node 20. A branch-push/manual Node 22.13+/24 cloud profile is a proposed future work item, not an existing capability. Treat legacy Node compatibility as a separate explicit target; do not declare it passing from Node 24 results.

`npm run test:integration` may need tmux and shell dependencies; inspect each suite before running it. `npm run test:herdr` runs fake transport unit tests; its script runs separate private Herdr process tests only when Linux and Herdr are available, otherwise it explicitly skips them. Classify each result and do not mistake a skip for a pass. Real-provider or Windows tests remain optional promotion evidence, not an implementation prerequisite. Do not run resource-heavy historical performance loops by default. A focused, scoped performance check is justified when a change affects a budgeted path; document the host and measured scenario, and do not mistake cloud timing for another host's qualification.

## Simulation matrix

| Surface | Cloud inputs and tests | Honest limitation |
|---|---|---|
| Claude statusline | Official JSON-on-stdin fields, missing/unknown fields, malformed and truncated data, width and terminal text, simulated repeated invocations. | Does not prove behaviour in a signed-in Claude session or every vendor version. |
| Claude transcript/projection | Synthetic records based on documented or explicitly observed forms; test ordering, duplicates, incomplete writes, lifecycle and topology. | Unspecified transcript fields are observations or hypotheses, not vendor guarantees. |
| Pi reader/CLI | Version-labelled synthetic JSONL and CLI contract fixtures, branching/resume scenarios, malformed records and opt-in adapters. | Does not establish live Pi launch, provider access, MCP authorization or universal compatibility. |
| Codex adapter | Repository synthetic rollouts and fake adapter, relevant CLI and parser contracts; exercise no data, partial files and multiple sessions. | Does not prove a live authenticated Codex session. |
| Storage and supervision | Real temporary SQLite, deterministic fake clocks, and owned synthetic child processes; concurrency, idempotency, fencing, restart/crash and uncertain-result cases. | Fake process timing is not proof of every production OS or provider failure. |
| UI | Synthetic terminal-cell tests and focused interaction tests when their dependencies exist. | Text snapshots do not prove font rendering, Windows visuals or live UI behaviour. |

### Specification sources and versions

Use the [official harness reference index](../architecture/official-harness-reference-index.md) as the current source-to-interface-to-code map. The [simplified architecture proposal](../architecture/simplified-harness-architecture.md) selects one managed control path per harness: Codex app-server, Claude Agent SDK streaming Query, and Pi 1.4.0 exported RpcClient. These are proposed product connections, not a claim that the independent transport experiments already implement send/ask. The default proposal hosts SessionManager inside each existing hud-mcp process; it does not add a daemon or silently change G13. A native root may delegate under its explicitly configured owner/workspace scope without pretending that MCP automatically supplies a trusted native parent session ID.

Pin the vendor package or protocol source, captured specification date and fixture assumptions before implementation. Do not reuse lifecycle semantics merely because interfaces emit JSON. Keep interface support, configuration/permission, simulation results and real-provider evidence separate; an exact host fingerprint matrix is not an official API requirement.

- Claude managed control: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions) and [user input](https://code.claude.com/docs/en/agent-sdk/user-input). The proposal targets SDK 0.3.319, with the source/version caveats in the index; package installation and type conformance are not claimed. canUseTool does not intercept automatically approved calls. SDK use, third-party authentication and subscription access must respect the official terms; a working open-source client does not itself grant those rights.
- Claude observation and alternatives: [headless CLI](https://code.claude.com/docs/en/headless), [statusline stdin JSON](https://code.claude.com/docs/en/statusline), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp) and [subagents](https://code.claude.com/docs/en/sub-agents) remain distinct surfaces. Print/stream JSON is a valid alternative, not a second default SDK control loop. Normal versus --bare discovery and undocumented transcript fields retain their own version-labelled tests.
- Codex managed control: [app-server](https://learn.chatgpt.com/docs/app-server) and the [generated protocol at d786ff91fad8e7ddab8653ee07bc6313a6fcb03d](https://github.com/openai/codex/tree/d786ff91fad8e7ddab8653ee07bc6313a6fcb03d/codex-rs/app-server-protocol/schema/typescript). Initialization, thread/turn methods and server-initiated approvals must match the actual selected binary/schema. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and [exec JSONL](https://learn.chatgpt.com/docs/non-interactive-mode) are batch alternatives; do not revive the removed codex mcp-server route or silently retry a task through another transport.
- Codex tools and observation: [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp), [hooks](https://learn.chatgpt.com/docs/hooks), [configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), and [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform). Configuring an MCP tool server is not the same as controlling a Codex thread. Hook paths and undocumented rollout formats remain version-sensitive observations.
- Pi current managed development target: [1.4.0 package](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/package.json), [RPC guide](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc.md), [commands](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-commands.md), and [exported RpcClient](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts). The package requires Node >=22.19.0. A prompt response is acceptance/queued/handled, not task completion; handled does not imply a run, agent_end can precede automatic follow-on work, and agent_settled is the relevant settled boundary. The selected helper's handled, environment, extension-UI and shutdown limitations are recorded in the index; use a thin public-API adapter, not a replacement lifecycle client.
- Pi historical compatibility: [v0.73.1 RPC documentation](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/docs/rpc.md) remains the source for older transport fixtures. Do not relabel those fixtures as 1.4.0 or assume agent_settled exists there. The project selected 1.4.0 for newer work, but neither that choice nor this index proves the version installed on a user's machine. The upstream [move announcement](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home) is historical context, not a protocol pin.

### Result record

For each scenario record these independent fields: specification URL and version or commit; fixture provenance and assumptions; implementation and repository SHA; execution mode (fixture, simulated process, real local process or real provider); command/environment; PASS, FAIL, SKIP or NOT_RUN and reason; implementation/review/integration status; and the runtime capability status. Keep simulation, native-local and real-provider results separately labelled, each with its own status; a native-local process test is not a real-provider test. Missing access is NOT_RUN (or an actual suite SKIP with its reason), not PASS or evidence of a product failure; preserve any actual FAIL. A fake PASS must never write or imply production `verified`. Preserve fail-closed runtime guards and make refusal reasons visible. Store only synthetic examples and logs.

The repo already contains fake interfaces in `tests/fakes/` and synthetic fixtures under `tests/fixtures/`. Fixtures should name their source and version, distinguish official fields from observed/assumed ones, and avoid real session content. Unsupported fields stay unknown; absent evidence must not become a fabricated value. Use a fixture only for the behaviour it can establish.

## Development loop and handoff

1. Select a narrowly scoped outcome and identify its owning files. Check existing branches and active work before assigning parallel slices.
2. Write a short brief: base SHA, inputs and authority, expected behaviours and failure cases, constraints, commands, and stopping condition. Build from a fixed SHA, not a stale local tracking ref.
3. Implement with synthetic fixtures; make security invariants executable where practical. Choose lightweight focused checks first and run broader checks when useful. Record failure and uncertainty, not just successes.
4. Run applicable functional regression checks on integrated code; documentation-only work needs diff, link and content checks, not unrelated full performance replay.
5. Maintain a finite ready queue, recording owner, next action, dependencies and stopping conditions. Before interruption persist branch/base SHA, worktree status, completed user-visible function, exact commands and outcomes, unresolved issues and the next command. Stop when no authorized ready package has inputs; do not invent work to stay busy.
6. Review the actual diff and stated evidence. Keep claims at the level tested. If a change alters an identity, authorization, execution or data-sharing contract, record the decision and revise the applicable contract explicitly instead of silently weakening it.
7. Commit to the agreed feature branch after review. Re-read its remote head and changed files. Leave a concise handoff containing base and head SHAs, scope, commands and outcomes, known gaps, next steps and source links. Integrate or publish only with the authority and review appropriate to that action.

### Owner-local validation handoff

For each affected scenario, leave the owner a checklist for later unified local validation, without making its execution a prerequisite for authorized test-branch publication:

- Pin the test branch/head SHA, target OS, harness/provider and exact versions or protocol surface. Link the specification and synthetic fixture, and identify which assumption remains unverified.
- Give the exact command or manual steps, required local setup and permissions (never credentials in the handoff), expected observations and failure criteria, and cleanup for test-owned processes/files. Keep native-local checks separate from real-provider checks.
- Record the cloud commands and PASS/FAIL/SKIP/NOT_RUN results already obtained. Mark each unexecuted local/provider scenario NOT_RUN with its reason; append later observations and evidence against the tested SHA without relabelling simulation as real evidence. Keep runtime capability and production qualification separate and unverified until their applicable gates are met.

## Safety and data boundaries

Simulation does not relax security: maintain unambiguous source/session identity and binding; protect request idempotency, execution authorization, process ownership, lease/fencing and failure recovery; do not retry uncertain side effects as though they failed; and keep model outbound consent bound to the source and approved destination. Use synthetic data in repository files, logs and examples. Preserve unknown and unverified states. Existing contract thresholds remain in force where they actually govern a release or integration; this plan does not declare a historical threshold passed or erase a real defect.
