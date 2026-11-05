# Cloud development handbook

> Implementation update: [Cloud checks and local package preview](checks-and-preview.md) supplies the finite Node 22/24 workflow and commands on base `211f7e3`. Statements below about the original CI are observations at the original `4899b3f` baseline, not the current implementation status.

## Scope and ground truth

Use isolated cloud worktrees to design, implement, review and test Universal HUD. Provider credentials, a logged-in CLI, a user's local machine and a real provider session are not prerequisites for implementation or cloud simulation. A result must identify its actual evidence: source specification, fixture, simulated process, native local process, or real-provider observation. Never promote one category into another by wording alone.

The reference baseline for this handbook is `CartmanFatass/codex-hud` integration commit `4899b3f5802657520509e5c0db1918395b031257`, not `main`. Existing feature branches and local WIP can move independently. Before work, read `AGENTS.md`, the relevant contracts and `docs/handoff/STATE.md`; inspect exact current branch heads and diffs before creating work. Do not overwrite, reset, or clean another worktree.

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

Treat these as separate protocol surfaces. Pin the exact vendor version, captured specification date and fixture assumptions before implementation; never reuse JSON schemas or lifecycle semantics merely because multiple interfaces emit JSON.

- Claude: [`claude -p` and stream JSON, including `--bare`](https://code.claude.com/docs/en/headless) are distinct from [statusline stdin JSON](https://code.claude.com/docs/en/statusline), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), and [subagents](https://code.claude.com/docs/en/sub-agents). Exercise normal versus `--bare` discovery as separate cases rather than assuming the same settings, skills or hooks load. Do not claim an undocumented transcript field is a stable protocol.
- Codex: [non-interactive exec JSONL](https://learn.chatgpt.com/docs/non-interactive-mode) and [app-server](https://learn.chatgpt.com/docs/app-server) are different surfaces; app-server initialization and generated schemas must match the chosen version. [Hooks](https://learn.chatgpt.com/docs/hooks) and [configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) have their own contract. See also [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform). Treat hook transcript paths and undocumented on-disk formats as version-sensitive, not guaranteed long-term interfaces.
- Pi: pin the RPC version separately from the CLI and provider; its completion semantics vary by version, as below.

- [Claude Code statusline](https://code.claude.com/docs/en/statusline) specifies a configured command receiving session JSON on stdin. Snapshot the specific field descriptions and access date used by each fixture; optional and future fields require graceful handling.
- [Pi v0.73.1 RPC documentation](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/docs/rpc.md) documents `agent_end`; it does not list `agent_settled`. Current upstream may define additional events, which must not be assumed on older versions. The project does not pin an installed Pi version. Version fixtures and capability detection; use bounded completion and explicit uncertainty rather than indefinitely waiting for an unsupported event. The upstream project [announced its move](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home); distinguish tagged documentation from a moving main branch.
- [Codex documentation](https://developers.openai.com/codex/) and the repository's existing synthetic fixtures inform Codex-facing tests. Do not treat undocumented rollout details as a stable vendor API.

### Result record

For each scenario record these independent fields: specification URL and version or commit; fixture provenance and assumptions; implementation and repository SHA; execution mode (fixture, simulated process, real local process or real provider); command/environment; PASS, FAIL, SKIP or NOT_RUN and reason; implementation/review/integration status; and the runtime capability status. A fake PASS must never write or imply production `verified`. Preserve fail-closed runtime guards and make refusal reasons visible. Store only synthetic examples and logs.

The repo already contains fake interfaces in `tests/fakes/` and synthetic fixtures under `tests/fixtures/`. Fixtures should name their source and version, distinguish official fields from observed/assumed ones, and avoid real session content. Unsupported fields stay unknown; absent evidence must not become a fabricated value. Use a fixture only for the behaviour it can establish.

## Development loop and handoff

1. Select a narrowly scoped outcome and identify its owning files. Check existing branches and active work before assigning parallel slices.
2. Write a short brief: base SHA, inputs and authority, expected behaviours and failure cases, constraints, commands, and stopping condition. Build from a fixed SHA, not a stale local tracking ref.
3. Implement with synthetic fixtures; make security invariants executable where practical. Choose lightweight focused checks first and run broader checks when useful. Record failure and uncertainty, not just successes.
4. Run applicable functional regression checks on integrated code; documentation-only work needs diff, link and content checks, not unrelated full performance replay.
5. Maintain a finite ready queue, recording owner, next action, dependencies and stopping conditions. Before interruption persist branch/base SHA, worktree status, completed user-visible function, exact commands and outcomes, unresolved issues and the next command. Stop when no authorized ready package has inputs; do not invent work to stay busy.
6. Review the actual diff and stated evidence. Keep claims at the level tested. If a change alters an identity, authorization, execution or data-sharing contract, record the decision and revise the applicable contract explicitly instead of silently weakening it.
7. Commit to the agreed feature branch after review. Re-read its remote head and changed files. Leave a concise handoff containing base and head SHAs, scope, commands and outcomes, known gaps, next steps and source links. Integrate or publish only with the authority and review appropriate to that action.

## Safety and data boundaries

Simulation does not relax security: maintain unambiguous source/session identity and binding; protect request idempotency, execution authorization, process ownership, lease/fencing and failure recovery; do not retry uncertain side effects as though they failed; and keep model outbound consent bound to the source and approved destination. Use synthetic data in repository files, logs and examples. Preserve unknown and unverified states. Existing contract thresholds remain in force where they actually govern a release or integration; this plan does not declare a historical threshold passed or erase a real defect.
