# 03: Sonic reports get an automatic citation check instead of a verdict

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Owner 2026-11-24: neither the main session nor the worker should judge a sonic report. Remove the `hud_read` `verdict` / `verdict_note` parameters, `Job.verdict`, its archive field, docs and the hud-delegate sentence added by sonic-even/01. Instead, when a sonic job settles with a report, HUD checks the report's citations mechanically and records the facts on the job record and archive as `citations {total, verified, failed: [{ref, reason}] (at most 20)}`: a citation is `path:line` or `path:line-line` (relative to the job cwd or absolute); it is verified when the file exists inside the job's cwd or worktree, the line range exists, and, when the report quotes text in backticks on the same row, that text (whitespace-normalised) appears within ±3 lines. No model call, no network; bounded work (stop after 200 citations; a report over 256 KiB is checked on its first 256 KiB). Reports without citations record `total: 0`. HUD does no analysis; toktrack groups by model later. The panel does not show it.

- [ ] hud_read no longer accepts verdict; Job.verdict and its archive field are gone; docs and the skill no longer mention it
- [ ] A fixture sonic report with three citations (one correct, one with a wrong line, one with a quote that is not there) records total 3, verified 1 and two failures with reasons
- [ ] The check runs once per settled report, adds no model call, and finishes within 100 ms on a 256 KiB report in the test
- [ ] docs/reference.md describes the recorded `citations` facts in one paragraph

## Comments
