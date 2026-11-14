# 07: one announcer

**What:** delete the supervisor's `notify` and the pane quota scan on "agent exited" (ticket 10 reads the screen and
fails only on a quota line); `changes` and `hud watch` are the only announcers.

**Who:** imp (agy) · **Size:** deletions · **Blocked by:** 06, QUIET-DECIDE · **Status:** ready-for-agent

- [ ] A worker whose task text mentions "quota" exits → its place is not marked exhausted
