# 28: Ticket writes never commit home-directory paths

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27: 50 committed tickets and review docs in this public repo carried absolute home-directory paths (`/home/<user>/.hud/jobs/<id>/report.md`, worktree paths), written by leads and main through hud_tickets add/update; main replaced them by hand (7048a416). Flake tickets already format paths inside $HOME as `~/` (chores/01). Apply the same normalisation to every hud_tickets add/update/comment text field (title, what, live_try, acceptance, comments) for JSON and Markdown, and to land-written ticket comments, before writing. Paths outside $HOME stay verbatim.

- [x] Test: add/update/comment with `$HOME/.hud/jobs/x/report.md` in what, acceptance and a comment stores `~/.hud/jobs/x/report.md` (JSON and Markdown)
- [x] Test: a path outside $HOME is unchanged
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 23be81d9588a629504f702ecc729cb82d3f910a3); gate 5/5 passed.
