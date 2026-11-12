# 01: Nested Claude subagents always sit under their parent

**What to build:** on Home's `Claude · this session` lane, every nested Claude Code subagent is shown indented under
the subagent that started it, never as a top-level card, however long the parent's transcript has grown. Found in the
owner's live test (2026-11-12): a nested Explore showed at top level because the call that started it sat 57 KB from
the end of its parent's transcript and only the last 32 KB is read. The parent's transcript is read forward from where
the last read stopped, remembering every subagent-starting call, with a per-pass byte cap and no new watcher.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A child whose starting call is far (> 64 KB) from the end of a long parent transcript is attached to its parent
- [ ] Reads stay incremental and bounded per pass; an unchanged transcript costs no body read
- [ ] A truncated/rotated parent transcript is re-read from the start, not misattributed
- [ ] Home frames at 80 and 120 columns, EN and ZH, show the nested child indented under its parent
