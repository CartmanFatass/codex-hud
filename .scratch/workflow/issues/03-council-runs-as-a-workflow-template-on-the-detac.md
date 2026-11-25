# 03: Council runs as a workflow template on the detached runner and survives an MCP restart

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/workflow/spec.md` slice 3. Observed 2026-11-25: an MCP restart at 17:40 orphaned council j84ec335faab925fb — all three members finished, the parent stayed `working` forever because `runCouncil` lives in the MCP process. Add the `council` step kind (member fan-out with per-seat presets, quorum ≥ 2, synthesis = main hand-off packet or a `pro`/Fable job) running on the detached host; ship `council.toml`. Keep parent `j…` id and receipt (`council_members` with job/digest/failure, `synthesizer`, `synthesis_job`), `memberInstruction`/`synthesisTemplate` text, "Fewer than two member reports", browser index, grant reserve/spend/release (`council-grant.ts`) unchanged. Generalise the grant module so later costly runs can use it (bound grants come in the composition ticket).

- [ ] `thin-mcp-council.test.mjs` passes unchanged.
- [ ] New test: the MCP process exits while members run; members settle and the council parent closes with the member digests (main synthesis) without the MCP.
- [ ] Land gate passes.

## Comments

- 2026-11-25 main: scope (owner, D-2026-11-25-08): the engine ships only batch, prewalk, council and land templates; tickets 05-07 are deferred. workflow/02, 03 and 04 are built in parallel on the landed engine (4dbb54ab) and each adds a step kind: keep step-kind registration additive so the lands compose. Run the focused tests once at the end; the full gate is the land's job. Main test: a council survives an MCP restart (members finish, the synthesis hand-off still arrives). Generalise the grant module only as far as council needs, with a clean interface; no bound-grant work (06 deferred). No real model calls.
