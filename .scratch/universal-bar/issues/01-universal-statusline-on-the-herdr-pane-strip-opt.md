# 01: Universal statusline on the herdr pane strip, opt-in per client

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** herdr-fork/13
**Objective:** interaction

**What to build:** Spec §2.2 (26.02): a universal statusline drawn by herdr for every client may follow; native statuslines stay until it matches them. With the pane-strip capability (herdr-fork/10, first used by codexH in herdr-fork/13), HUD can push its compact line to a bottom strip of a Claude Code, pi or Antigravity main session, at the exact width from the fork's width event, using the same renderer and facts as the native line (this session / this machine split, drop optional fields to fit). Off by default; a per-client setting in panel Settings turns it on; native statuslines are untouched. A parity check compares the strip line with the native line on the same synthetic state.

- [x] Parity tests: for Claude, pi and Antigravity synthetic states the strip line equals the native line at 40/80/120 columns
- [x] Off by default; turning it on for one client affects only that client's main sessions; turning it off returns the row to the PTY (fake fork tests)
- [x] Owner try: turn it on for pi: the strip shows the same line as pi's native statusline; turn it off: the row is gone

## Comments

- Landed in this commit (replay base 0a019cbd3c3859534225ba23a5ea449e9c0d6d19); gate 5/5 passed.
