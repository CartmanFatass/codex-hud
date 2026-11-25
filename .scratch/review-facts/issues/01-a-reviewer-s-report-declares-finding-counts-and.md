# 01: A reviewer's report declares finding counts and the reviewed range, and the archive row keeps them

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** toktrack (separate repo, do not edit it) will attribute review findings to the imp slices a review covered, reading only structured HUD facts (toktrack docs/design/workflow-diagnostics/README.md 'HUD facts to add', last paragraph; toktrack ticket .scratch/workflow-diag/issues/07). Add two optional fields to the reviewer role's report declaration only: `findings: {blocker, major, minor}` (non-negative integers) and `reviewed: {base, head}` (40-hex commit shas, same meaning as `git rev-list base..head`). Accept them in both declaration paths: the worker tool `hud_report` (src/worker/tools.ts ~342/378, keep pi and MCP schemas in sync) and the CLI workers' fallback report declaration. Validate strictly; an invalid field is dropped with one warn and never fails the report. Record them on job.json and copy them unchanged, under the same names, into the monthly archive row (src/roles/job-archive.ts). Follow how sonic `citations` already travel: type src/mcp/job-contracts.ts:139, preservation across receipt rewrites src/mcp/store/job-store.ts:105, archive src/roles/job-archive.ts:263. Update the reviewer instructions for pi (integrations/pi/roles/reviewer.md) and CLI (packages/hud-mcp/instructions/reviewer.md): at the end of a review declare `findings` by severity and `reviewed` with the base and head of the diff under review; fill `reviewed` only when both shas are known, never guess. Do not infer counts from report text; do not offer the fields to other roles (a non-reviewer declaring them gets them dropped with a warn). Update docs/reference.md (+ zh) where report declaration fields and archive row fields are listed, and docs/ARCHITECTURE.md §5 only if it lists archive fields.

- [x] A reviewer declaration with both fields: job.json and the archive row carry them exactly
- [x] A declaration without them: neither job.json nor the archive row has the keys (not zero, not null)
- [x] Invalid values (negative, fractional, non-number count; short or non-hex sha; extra keys) drop only that field with a warn; the report still publishes
- [x] Both the hud_report tool path and the CLI fallback path are covered by tests; a non-reviewer role's declaration never records the fields
- [x] pi and CLI reviewer instructions state when and how to declare them; tool schema text stays short

## Comments

- Landed in this commit (replay base 96fae113d206709f0072d3d1067fd333eb90f813); gate 5/5 passed.
