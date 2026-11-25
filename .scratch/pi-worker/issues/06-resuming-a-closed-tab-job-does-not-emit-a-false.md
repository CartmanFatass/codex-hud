# 06: Resuming a closed tab job does not emit a false 'failed | tab closed' notice

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** pi-worker

**What to build:** Observed twice on 2026-11-25 (job j3bd8576dccfd4ee1, imp on pi in a herdr tab): main sent `hud_send` to a closed tab job; the send resumed it (`continuation: resumed`) and the worker kept working in its tab, but the hud-mod wake immediately delivered `imp pi-worker: failed | tab closed | <old report summary>` while `hud_peek` showed `state: working`. Likely cause (verify, do not assume): the watcher's tab-close reaping (tests/unit/thin-mcp-watcher-reap.test.mjs: 'fails only a nonfinal job whose tab closes') sees the previous turn's tab/pane close after the resume has already made the job nonfinal, or the resume opens a new tab and the old one's close is attributed to the resumed job. Spec §2.1: silence or a display label cannot fail a live worker; a completion notice is not a read; no false failure. Fix so a tab close that belongs to a previous turn (or a tab the current turn does not run in) never fails or notifies the resumed job; a real close of the tab the current turn runs in still fails it as today. Out of scope: other notice kinds, reaping rules landed in pi-worker/03. Size: ~60 source lines, 1-2 tests.

- [x] Test: a closed tab job is resumed by a send; the old turn's tab closes afterwards; no failed state and no failure notice for the job, and its next report settles normally
- [x] Test: closing the tab the resumed turn runs in still fails the job as today
- [x] Live try: hud_send to a closed imp tab job; the wake shows no 'failed | tab closed' line while the job works
- [x] Land gate passes

## Comments

- Landed in this commit (replay base b81cb6be5b4db6e2768853e5041e5a1e087b70db); gate 5/5 passed.
