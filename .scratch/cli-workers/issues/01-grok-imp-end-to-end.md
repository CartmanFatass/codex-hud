# 01: A grok role runs a brief end to end like pi imp

**What to build:** the owner registers a role whose harness is an interactive CLI (`harness: "cli"`, `agent: "grok"`,
model, thinking, can_continue, idle grace, extra args) and dispatches it with `hud_create` like any pi role. The MCP
opens the job's herdr tab, starts grok with the role's model/effort and its bypass flag (nothing else), checks for
the directory-trust dialog (decline and fail with a clear reason if shown), submits the brief prompt, and hands the
job to a per-job supervisor that drives STATUS.json from herdr's status events as in the feature spec: working →
idle_grace when report.md is written → `/quit` and closed when the grace ends unused; the existing watcher reaps the
tab. The brief prompt points the worker at a harness-neutral implementer instruction file shipped with the HUD
(pi-roles' implementer rules without pi-only tools) and at the brief. `hud_roster` and the Project tab show the role's
harness, agent kind, model and thinking; `hud_create` accepts `model`/`thinking` overrides for CLI roles (pi launch
switches and `pi_args` stay pi-only). A `grok-imp` role (grok-4.7, high, can continue) ships with the HUD.

See `.scratch/cli-workers/spec.md` for the role file shape, per-kind facts, the STATUS keys and the lifecycle.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Role registry accepts and validates `cli` roles; invalid files are refused like today; pi and Jev roles unchanged
- [ ] The kind-specific bits (flags, trust-dialog text and decline keys, start timeout, startup quirks) live in one small per-kind table, so adding a kind is a table row
- [ ] Launch passes only the model/effort, bypass and role `args`; no home/session/config flag or env override; no CLI config is written by the HUD
- [ ] Trust dialog → dialog declined, CLI gone, job `failed` with a reason naming the directory and the CLI
- [ ] STATUS carries the spec's keys (no `session_id`); `pi-role-reap` reaps a closed CLI job and closes its tab
- [ ] working → idle_grace → closed with a fake herdr in unit/integration tests (no real model calls in tests)
- [ ] One real grok job run by hand: report written, card shown in the panel, tab closed after grace (record it in the ticket comments)
- [ ] The existing test suite stays green

## Comments

- 2026-11-13 orchestrator: implemented by grok-4.7 high (direct herdr dispatch). Real run through the new MCP with an
  isolated HUD_HOME and a 60 s-grace grok role: create → report in 20 s → idle_grace → `/quit` at grace end → closed
  (settled) → watcher reaped with pi-role-reap, tab closed, watcher exited. grok's session stayed in its default
  store; the job dir held no session files. Panel card not checked (isolated HUD_HOME). Rollout note: MCP servers
  still running the previous code throw `invalid_role` on a bundled `cli` role file, so `grok-imp.json` is parked in
  `tmp/tasks/CLI-WORKERS-01/` until every client's hud MCP restarts on the new build.
