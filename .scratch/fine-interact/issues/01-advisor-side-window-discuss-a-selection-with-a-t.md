# 01: Advisor side window: discuss a selection with a temporary advisor

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** select-send/02
**Objective:** interaction

**What to build:** D-2026-11-26-02, lower priority. From the selection composer, "Ask an advisor" opens a herdr side window (overlay/popup per the fork's surfaces) with a temporary advisor job (role `oracle` by default, owner-configurable) briefed with only the excerpt, its source and the question; follow-ups in the window continue that job. Closing the window only hides it; the job's answer stays findable on the excerpt card; an explicit "end" closes the job. Opening twice on different excerpts gives two advisors; a busy popup (`ui_busy`) keeps the draft.

- [ ] Tests: open, ask, hide, reopen shows the same conversation; end closes the job; two excerpts give two advisor jobs; ui_busy keeps the draft
- [ ] Owner try: select a diff hunk, ask the advisor why it is needed, hide the window, come back to the answer

## Comments
