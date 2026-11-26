# 14: HUD: typed delivery to main sessions goes through guarded typing

**Status:** done
**Owner try:** yes
**Blocked by:** herdr-fork/11
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 2c, HUD side. Every typed delivery into a main session (Antigravity when idle, Claude Code without tasks or the mod, the Codex queue-failure fallback, pi if typed) uses the fork's guarded prompt. A refusal waits and retries on the next change (no new wake path, no duplicate wakes); nothing is shown to the owner. Per client: switch only after a live check on that client; delete the old unguarded path for that client in this slice once its check passes.

- [x] Fake fork: each refusal reason leads to a later retry and exactly one delivery; no duplicate wakes (tests)
- [x] Live per client (agy, claude without mod, codex fallback): an idle main session with an empty prompt receives the notice; with a half-typed draft it does not, and receives it after the draft is sent or cleared
- [x] Owner try: type half a sentence in an idle Antigravity main session while a worker finishes: the draft is untouched and the notice arrives after it is sent or cleared

## Comments

- Landed in this commit (replay base 77d7dcf152d1beae349210f8fd7c8f08533cfce2); gate 5/5 passed.
