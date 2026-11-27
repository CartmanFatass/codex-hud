# 07: Advisor repair: path-free hud_report result for selection advisors

**Status:** done
**Live try:** Select text, press Ctrl+b a, choose "Ask an advisor", let it answer, then send a follow-up: the advisor answers the follow-up, and the captured/resumed request (probe or provider log) contains no report path or home directory.
**Blocked by:** none

**What to build:** Milestone review j65cc7a44c3a0636f finding 1 (/home/fires/.hud/jobs/j65cc7a44c3a0636f/report.md). A selection advisor answers with `hud_report`; `src/worker/tools.ts` (~169,205) returns `{path: <HUD_HOME>/jobs/<job>/report.md}` and `src/harness/pi/worker/tools.ts:160-161` serialises it into the model-visible tool result. pi keeps that tool result in history and resends it on resume, so an advisor follow-up sends a local absolute path (often including the home directory) to the provider, against Architecture §5's Selection advisor row. The Claude worker MCP wrapper (`src/mcp/mcp/server.ts:224-226`) serialises the same result. For selection-advisor jobs only (job.selection_advisor set), return a path-free acknowledgement (e.g. `{ok: true}` / 'Report recorded.') from hud_report in both the pi tool and the Claude MCP wrapper; keep the ordinary worker tool contract, warnings semantics and the on-disk report unchanged. Extend `tests/probes/selection-advisor-prompt.mjs` so its synthetic provider performs a real `hud_report` tool call on the first turn, then resumes with a follow-up, and asserts no HUD_HOME/job path appears in the resumed provider request.

- [x] A pi selection advisor's hud_report tool result contains no filesystem path; ordinary workers still receive `{path}`
- [x] The Claude Code advisor's hud_report MCP result is path-free too; other Claude workers unchanged
- [x] The advisor prompt probe performs a real hud_report tool turn and a resumed follow-up, and asserts the resumed provider request carries no HUD_HOME or report path
- [x] Architecture §5 / reference wording still accurate (update only if the projection description changes)

## Comments

- Landed in this commit (replay base 7bfec410e91a042b8820a8148ee13960da1826fc); gate 5/5 passed.
