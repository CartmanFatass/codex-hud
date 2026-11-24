# 01: A commit that only mentions a ticket does not make it landed

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Bug seen 2026-11-24: commit 7d40adef (`spec: advisor shadow ... ; ticket advisor/01`) touched docs/spec.md, docs/decisions-log.md and the new ticket file. `landedTickets` in `src/collectors/project-board.ts:479-511` skips only commits that touch nothing but `.scratch/`, then treats any ticket id in the subject as landed, so the panel showed ADVISOR-01 as ready to try while its imp job was still working, and the owner accepted an unbuilt feature. Fix: a ticket counts as landed from git only through the landing record hud_land writes (the ticket file's status moving to ready-for-human/done in the landed commit, or a `Record landing` commit), or when the ticket's subject mention comes with code changes outside `docs/` and `.scratch/`; a subject mention in a docs/ticket-only commit never lands a ticket. Keep the bounded 64-commit read and no extra git calls per tick.

- [ ] A fixture repo with a docs+ticket commit naming feature/01 leaves the ticket not landed; a hud_land-style commit lands it (test)
- [ ] Existing project-board landing tests pass
- [ ] No extra git invocation per panel tick (existing perf test)

## Comments
