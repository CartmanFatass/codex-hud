# 03: Council runs as a workflow template on the detached runner and survives an MCP restart

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/workflow/spec.md` slice 3. Observed 2026-11-25: an MCP restart at 17:40 orphaned council j84ec335faab925fb — all three members finished, the parent stayed `working` forever because `runCouncil` lives in the MCP process. Add the `council` step kind (member fan-out with per-seat presets, quorum ≥ 2, synthesis = main hand-off packet or a `pro`/Fable job) running on the detached host; ship `council.toml`. Keep parent `j…` id and receipt (`council_members` with job/digest/failure, `synthesizer`, `synthesis_job`), `memberInstruction`/`synthesisTemplate` text, "Fewer than two member reports", browser index, grant reserve/spend/release (`council-grant.ts`) unchanged. Generalise the grant module so later costly runs can use it (bound grants come in the composition ticket).

- [ ] `thin-mcp-council.test.mjs` passes unchanged.
- [ ] New test: the MCP process exits while members run; members settle and the council parent closes with the member digests (main synthesis) without the MCP.
- [ ] Land gate passes.

## Comments
