# 01: HUD runs prewalk automatically before strong-model jobs

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** pool-pick/01

**What to build:** Spec §2.1 (D-2026-11-24-05). Generalise the existing `scout` flow and pool-pick into one prewalk step HUD runs on its own before a job starts. Owner role files only (`$HUD_HOME/roles`): `"prewalk": {"scout": "auto"|"always"|"off"}` next to the existing `pool` field; shipped defaults: imp, oracle and frontend-imp `auto`, reviewer and sonic `off`. Settings switch `autoPrewalk` (default on). With `auto` and no caller `scout`, no `from_jobs` and no `context_files`, ask the Decision API one fixed-choice question (same discipline as `src/mcp/sonic-thinking.ts`: brief as untrusted quoted data): would a where/what/how-many scout save the target model work (scout / none). On `scout` (or `always`) run the existing scout flow with a fixed question built from the brief: list the files, symbols, commands and facts a worker needs for this brief with path:line citations; no design, diagnosis or judgement. Attach its report via from_jobs as today; a failed or slow scout (cap 5 minutes) leaves the existing note and the target starts anyway. The caller can still pass its own `scout` or skip prewalk for one job (minimal schema addition; the declaration budget test must pass). Record `prewalk: [{kind: 'scout'|'pool', source: 'decision'|'caller'|'role'|'default', result, ms}]` on the job record, archive and hud_create receipt (fold pool-pick's `pool_pick` into it). Update the hud-delegate skill and hud-convention so the main session stops adding routine scouts by hand. Nothing chains after the target.

- [ ] With autoPrewalk on and a stubbed Decision API answering scout, an imp dispatch without scout/context runs a sonic scout first and attaches its report; answering none starts imp directly
- [ ] A caller scout, a caller skip, context_files present, switch off, Decision API failure and a scout over 5 minutes each behave as specified (tests)
- [ ] prewalk entries appear on job.json, the archive row and the receipt; reviewer and sonic never prewalk by default
- [ ] docs/reference.md and the hud-delegate skill describe prewalk briefly; the declaration budget test passes

## Comments
