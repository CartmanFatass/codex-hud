# 01: A Claude Code mod keeps the main session's HUD context lean

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** none

**What to build:** Spec §2.1.6 (22.23). A Claude Code mod (function-hooks plugin; API: the bundled plugin-authoring skill and its types) under integrations/claude-mod/ that slims what HUD adds to the main session's context, without changing what HUD's MCP returns to other clients: (1) a tool.call hook on mcp__hud__* that awaits the result and rewrites it to a compact text form (drop null/empty fields, collapse changed_files lists to a count plus first few, keep ids, state, summary, questions, read_hint); (2) merge duplicate job notices that reach the conversation in one turn into one row (session.append on the notification rows HUD causes; leave other rows untouched); (3) a tool.call guard that refuses Read/Bash reads of $HUD_HOME/jobs/*/report.md with a one-line hint to use hud_read (the convention says so). Measure on synthetic recorded HUD results/notices (fixtures; repo is public): bytes before vs after. Nothing in the mod may change what the model needs to act (job ids, states, question text and reply method, read hints).

- [ ] integrations/claude-mod/ validates with `claude plugin validate` and its tests pass with `claude plugin test` (fixtures for hud_read digest/full, hud_create, hud_land, a burst of notices)
- [ ] Report states bytes before/after per fixture; total reduction ≥ 40% on the fixture set with no loss of ids, states, questions or hints (test asserts the kept fields)
- [ ] Report read guard: a Read of a synthetic $HUD_HOME/jobs/<id>/report.md is refused with the hud_read hint; other reads untouched
- [ ] docs/reference.md + reference.zh.md describe the mod

## Comments
