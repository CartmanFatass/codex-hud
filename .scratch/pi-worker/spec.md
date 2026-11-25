# HUD-owned pi worker extension design (council j84ec335faab925fb synthesized by main)

Members: fable (j8552fffe30efb916), astra (j7690343fda20161b), carbon (jac897f5153d293dc). All three converge on the
shape; the disagreements below are settled by existing owner rules where one applies.

## Converged plan

1. **Launch from HUD core, no `pi-role`, no `--role-bundle`, no `--hud-*` flags.** HUD builds a pi-native argv in
   process and writes one private per-job contract `<job>/pi-worker.json` (read once at extension start via
   `HUD_JOB_DIR`; no secrets, no base64). Measured: `pi-role --args-json` costs 184–215 ms per dispatch (1 bash + 3
   node); in-process argv < 1 ms.
2. **One worker extension** (`src/harness/pi/worker/*` → installed under `$HUD_HOME/pi-worker/`, never `pi install`ed,
   interactive pi untouched). Modules: `contract`, `role-runtime` (model/thinking check, tool activation, role prompt
   section), `tools` (the five HUD worker tools; today's `hud.mjs` worker branch), `guard` (read-only roles),
   `mistral-budget` (images archived under the job dir), `web-search` (DeepSeek), `tab-lifecycle` (tab only, lazy),
   and a separate UI entry for tabs (HUD footer + native t/s). Headless loads no UI code.
3. **Lazy-load the dispatch graph in worker tools** (`src/worker/tools.ts` imports `orchestrator.js` eagerly: ~80 ms of
   the 83–125 ms tool import).
4. **Roles: one source.** Prompt body only from `packages/hud-mcp/instructions/<name>.md`. Model/thinking/read-only in
   the role JSON; a small in-code defaults table keyed by today's `pi_role` names (`sonic`, `implementer`, `reviewer`,
   `architect`→oracle, `general`) fills fields that owner/project role files omit (the owner's `sonic.json` deepseek
   preset has no `model` today and relies on `pi-roles/roles/sonic.md`). Existing role files keep working unedited.
5. **Reap and first-prompt stall move into HUD core** (`pi-role-reap` also reaps CLI tab workers today; port
   faithfully, keep the stderr text the watcher parses; separate review because it kills processes).
6. **Tab lifecycle (`dispatch.ts`) is load-bearing**, not dead code: STATUS writer, session link, async ask steer,
   Sonic child collection, idle grace (2/3 cache TTL ≤ 20 min, $0.50 warm cap), auto-close. Ported last, unchanged
   policy.
7. **QA**: one implementation in core (`src/worker/qa.ts`, fs-watch wake ~15 ms instead of a 2 s poll; no `sh` +
   `hud-notify` spawn).
8. Delete test-only twins `integrations/pi/roles/*.md` and `integrations/pi/skills/helper-pane`.

## Disagreements and decisions

| Topic | fable | astra | carbon | Decision (reason) |
|---|---|---|---|---|
| Legacy switch during migration | env override until cleanup | per-role canary for new jobs | per-slice `git revert` | Per-slice revert, no runtime switch (plugin independence: no legacy-default choices). |
| Tab footer | pi stock footer | parity with personal p10k | HUD `createP10kFooter` | HUD footer (R6: HUD owns the pi footer). |
| t/s telemetry | drop headless | keep `tps` entries as telemetry | native tracker, no headless entries | Native writer of compatible `tps` entries in both modes; footer reads them. toktrack's binary carries TPS fit fields, so dropping entries could remove facts it reads. Verify format in slice 1. |
| Oracle guard on pi | keep unguarded (parity), hardening later | enforce | `oracle` guard mode allowing `/tmp`, `/dev/shm`, job dir | Carbon's oracle mode: spec says oracle never changes the repository; brief listed the guard as kept. |
| MCP adapter source (on request only) | owner's pi install, else `builtin:mcp` | HUD-installed dependency under `$HUD_HOME` | owner's pi npm dir | HUD-installed under `$HUD_HOME/pi-worker/optional/` (plugin independence). |
| herdr state | herdr's installed file | owned module | herdr's installed file | herdr's own installed integration file (owned and versioned by herdr). |
| DeepSeek key | HUD setting + import | HUD credential, explicit import | `$HUD_HOME/credentials.env` + `hud import` | `~/.hud/credentials.env` (owner's single key store). |
| Web tools scope | all pi roles as today | eligible roles as today | Sonic only except code/docs scouts | As today (no removal); trimming is a later owner choice. |
| Worker pi agent dir | owner's (provider auth) | isolated `$HUD_HOME` agent dir + auth import | owner's | Keep pi's own agent dir for providers/auth (host config, like Claude's); `-ne -ns -np` stop discovery. Isolation is a later item. |
| `/role` in worker tabs | drop | keep inspection only | drop | Drop (owner confirms, R4). |
| `pi_role` | keep as profile key, 5 names | alias map into JSON roster | optional, defaults to role | Keep as the defaults-table key; unknown names rejected clearly. |

## Slices (each ships alone; rollback = revert)

1. **Headless Sonic end to end**: contract, argv builder, extension core (`role-runtime`, `tools`, `mistral-budget`,
   `web-search`, `tps` writer), defaults table entry for sonic, lazy tool imports, DeepSeek key import, cost probe.
   Parity dump (role section, tools, model, thinking) vs legacy; ~10 live Sonic jobs incl. a web scout.
2. **All headless roles**: guard (strict + oracle mode), session-mode ask/resume, borrowed instructions, rest of the
   defaults table, delete test twins.
3. **Reap + prompt-stall in core** (separate review: process-killing code).
4. **Tab workers**: lifecycle, QA consolidation, UI entry (HUD footer, t/s), herdr state, opt-in MCP/lens.
5. **Cleanup**: remove `pi-role`/`pi-role-reap`/`pi-dispatch` prerequisites (roster, doctor, setup, install), the
   `hud.mjs` worker branch, docs.

## Expected cost

Headless Sonic pre-model startup ~510–570 ms → ~250–315 ms (−45 %); tab ~800 ms → ~350–410 ms. Per turn: no pi-tps
hooks from npm, no ledger `git rev-parse`, ask wake ~15 ms. Fewer tool schemas only where MCP was auto-loaded.

## Removals needing the owner's confirmation

- R1 HUD pi workers stop writing the pi-roles ledger (`~/.local/share/pi-roles/runs.jsonl`, `briefs/`); new HUD runs
  no longer appear in `pi-runs-report`/`pi-run-rate`. HUD's archive, `hud stats` and toktrack keep the facts.
- R2 MCP no longer auto-loads in workers when MCP configs exist; only with `mcp: true` (job/place/role).
- R3 Worker tabs lose `/role`, `/brief`, `/deepseek-search`, `/deepseek-fetch` slash commands (tools stay) and the
  `PI_ROLES_KEEP_TAB` debug knob; right-click copy (already a no-op in regular TUI mode).
- R4 `pi_role` accepts only the five shipped names; `informer`, `security-implementer`, `security-reviewer` stay in
  pi-roles for manual use (no HUD role uses them).
- Not a removal, decided by R6: worker tabs show HUD's footer instead of the personal p10k footer.

**Owner 2026-11-25: R1, R2, R3, R4 all approved.**
