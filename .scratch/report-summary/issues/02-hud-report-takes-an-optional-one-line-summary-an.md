# 02: hud_report takes an optional one-line summary and file list

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** Proposal 18 Slice 1 without outcome/verdict (owner 2026-11-22: self-grading dropped). packages/hud-mcp/bin/worker-tools.mjs hud_report gains optional summary (plain one line, normalised to <=160 code points, control/ANSI/BiDi stripped) and files (<=50 relative paths); written atomically (0600) to <job>/report-meta.json bound to report_sig, before done.json; a report without them removes the previous turn's meta. Same for pi's native tool (hud.mjs uses the same definition) and hud-progress.mjs --done (--summary, --file). Role instructions (implementer, frontend-implementer, reviewer, oracle, general, sonic) gain one line asking for a one-line summary and, for code roles, the files changed. This changes worker behaviour (owner approved).

- [x] MCP hud_report, pi's tool and hud-progress --done all write report-meta.json; a rewritten report.md makes it read as absent
- [x] Old calls without the fields behave exactly as before
- [x] npm test passes

## Comments
