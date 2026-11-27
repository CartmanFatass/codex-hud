# 27: Queue items can target another repository

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** herdr-fork tickets live in MyHUD's tracker but most change ~/projects/herdr-hud. A queue run started from MyHUD dispatched herdr-fork/30 into a MyHUD worktree; the worker edited herdr-hud's main checkout uncommitted, and the land failed with 'Source has no commits to land' (2026-11-27, run q7aba5d9564d1e161). Main had to commit and install by hand, and `hud_create` refuses a `brief_file` outside the target cwd. Add an optional ticket field `repo` (a registered project root, JSON and Markdown `**Repo:**`); queue admission dispatches that item with cwd = repo, isolation worktree there, the brief rendered from the ticket, and lands it with that repo's land block; the ticket record (done/landing) is still written in the tracker project. A ticket whose repo is not registered stays not-ready with that reason.

- [x] Test: a ticket with repo B in tracker A is dispatched with cwd B in a B worktree and landed with B's land block; A's ticket becomes done with the landing recorded
- [x] Test: unregistered repo → not ready, reason names it
- [x] Test: hud_create with ticket A/NN and cwd B renders the brief from A's tracker
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 078bb2180697fafe8e8bbeb0e83b1c899af864e6); gate 5/5 passed.
