# 02: A Claude subagent that resumes after a background wait shows running again and gets a fresh result

**What to build:** a Claude Code subagent that pauses to wait for its own background work looks finished for a
moment; when it continues, its card returns to running (◉) and, when it really finishes, its result line is written
from its real last reply. Found in the owner's live test: a Haiku agent showed done while it waited for a background
`sleep`, and its result line stayed "waiting 40 seconds in the background" after it had finished.

**Blocked by:** 01 (uses 01's forward reading to see the messages after the pause)

**Status:** ready-for-agent

- [ ] A subagent whose transcript grows after it was marked finished shows running again
- [ ] Its final sentence is regenerated once for the new settlement (same 2-minute spacing and cap), not frozen on the interim text
- [ ] An agent that really finished stays done; no extra model calls for unchanged transcripts
