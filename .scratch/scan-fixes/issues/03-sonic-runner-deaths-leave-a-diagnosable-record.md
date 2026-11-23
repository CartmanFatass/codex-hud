# 03: Sonic runner deaths leave a diagnosable record

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Scans (j5b0fbe7ad17f060f F5, j52c7712b41ba4a70 F2): 6 sonic children failed with `sonic runner exited without an exit receipt`; their sonic-session.jsonl ends `stopReason: aborted`, two died in the same millisecond when the parent imp's session restarted; all 27 headless stderr.log files are empty. Record the runner's exit code/signal and stderr on the receipt-missing path, write a partial report from the session tail when one exists, and name the cause ('parent session restarted' when the parent restarted).

- [ ] Receipt-missing failures record exit code or signal and a stderr tail in STATUS/job record
- [ ] A child aborted by its parent's restart says so in exit_reason
- [ ] If the sonic session has assistant text, a partial report.md marked partial is written
- [ ] Unit tests with a synthetic aborted runner

## Comments
