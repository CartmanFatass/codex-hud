# 05: Sonic jobs record how much tool output they read

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-25 wants to estimate sonic cost/benefit: the main session's saving is roughly the tool output sonic read instead of main. toktrack does the analysis (HUD records facts only, no Insights). When a sonic job settles, record on the job record and archive `reads {tool_calls, tool_result_bytes, by_tool {name: {calls, bytes}} (top 10)}` counted from the sonic's own pi session (headless `sonic-session.jsonl`, or the tab session file), plus `brief_bytes` and `report_bytes`. Bounded: stream the session once, stop counting after 50 MiB with `truncated: true`; no model call. Missing or unreadable session records `reads: null` with no error. Does not change panel output.

- [x] Fixture headless sonic session with three tool calls records tool_calls 3, the exact summed result bytes, by_tool counts, brief_bytes and report_bytes on job.json and the archive record
- [x] Tab-mode sonic fixture records the same from its session file; missing session gives reads null
- [x] docs/reference.md describes the fields in one paragraph; toktrack-facing archive schema note updated if one exists

## Comments

- Landed in this commit (replay base 3b20ba1d33b675b58a056c8516bff8b0fc28a331); gate 5/5 passed.
