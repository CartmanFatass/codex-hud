# 02: MCP server reads jobs through the shared cache

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** Proposal 08 S2, paths now src/mcp/*: thin-main job scans, readRow, openQuestions, observation and withChanges read through JobIndexCache; thin-jobs.ts JobRowExtras extension; src/roles/job-project.ts. Owner default Q2: keep the strict lstat between adoptSessionJobs() and withChanges() on every call; drop only provable duplicates. Tool results unchanged.

- [x] thin-mcp tests pass unchanged; new mcp-job-cache test asserts fewer syscalls for hud_read/hud_roster/hud_respond
- [x] An answered question clears in the next hud_read changes (no stale window)

## Comments
