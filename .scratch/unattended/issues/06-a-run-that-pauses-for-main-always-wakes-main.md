# 06: A run that pauses for main always wakes main

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-26: ticket queue q7479f30245134311 (unattended) paused with handback {kind: blocker, choices resume/stop} and a pause_notice, but its record's `notices` stayed empty and the main session got no wake; the owner noticed the stall in the panel first. Same for earlier blocker pauses. Every transition of a run into a state that waits on main (blocker, escalate, main hand-back, lead request with no ready tickets) must deliver exactly one notice to the dispatching main session (MCP task / watch line / typed delivery per the existing rules), retried until delivered, and record it in `notices`.

- [ ] Synthetic run paused on each waiting kind (blocker, escalate, hand-back to main, repair with no ready tickets) delivers one notice to the dispatcher and records it; a failed delivery retries on the next watcher pass without duplicates.
- [ ] A run that resumes and pauses again delivers a new notice for the new pause.
- [ ] Bar/panel show the paused run as main load until answered.

## Comments
