# 01: Archive the dispatch, worktree, stop and answer facts toktrack's workflow diagnostics need

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** toktrack design `docs/design/workflow-diagnostics/README.md` (section 'HUD facts to add') needs a few facts HUD has on the live job but drops at archive time or never writes. Copy into the archive row (`src/roles/job-archive.ts`), all optional so older rows read as unknown: `model_source`, `thinking_source`, `imp_preset`, `requested_on`, `requested_model` (what the caller asked for, from create options); `had_worktree`, `worktree_removed_at`, `worktree_kept_reason`. Record `stop_origin {actor: 'mcp'|'panel'|'pane_vanished', prior_state, at}` on job.json and the archive when a job is stopped or closed while working (MCP hud_close, panel stop, watcher finding the pane gone). Record `answered_by: 'orchestrator'|'owner'` per question in `questions[]`: hud_respond answers are `orchestrator`, panel answers are `owner`. Record each fact once; no new files or event streams; no analysis in HUD.

- [ ] A dispatched, settled and archived job carries the requested and resolved placement fields and the worktree fields in its archive row
- [ ] Stopping a working job through hud_close, the panel, and a vanished pane records the three stop_origin actors (tests)
- [ ] A question answered via hud_respond archives answered_by orchestrator; one answered from the panel archives owner
- [ ] docs/reference.md lists the new archive fields in one short paragraph

## Comments
