# 02: Owner requests get IDs, receipts and resolve through hud_objective

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.2 (Attention, requests) and §2.3 (request receipts), D-2026-11-23-04. Requests stay `## Waiting for the owner` bullets in `docs/handoff/STATE.md` (the collector is `src/collectors/project-board.ts:535`, ordering `compareOwnerRequests`/`requestOrder` :104-119). Add to `hud_objective`: `op: "request"` with `cwd`, `text`, optional `objective` (must exist in the project's objectives.md), optional `waits: true`; it appends `- <YYYY-MM-DD> [r<N>] <text> (objective <id>) (work waits)` (parts optional; N = next unused number in the project, scanning STATE and the events log) and records `{v:1, kind:"request", project, request:"r<N>", objective?, waits, change:"opened", at, by}`. `op: "resolve"` with `cwd`, `request`, optional `resolution` (`resolved`|`withdrawn`, default resolved), optional `note`: removes that bullet and records `change:"resolved"|"withdrawn"` with the time and `by` (caller harness/session as recorded elsewhere). Lines without an `[rN]` id keep working exactly as today (no receipts). The `[rN]` and `(objective …)` parts show in Home, Project inbox, the band and the HTML board as the id and Objective title (look it up), not as raw syntax. Hand removal of a bullet still clears it everywhere (no receipt). One decision counts once: resolving does not touch tickets. Size budget about 400 lines incl. tests.

- [x] Test: request then resolve round-trips STATE (other lines byte-identical) and writes opened/resolved receipts with ids
- [x] Test: an unknown objective id or request id is an invalid_arguments error and changes nothing
- [x] Render test: a request with id and objective shows the Objective title on Home, the Project inbox and the band text; legacy lines unchanged
- [x] `npm test` passes

## Comments

- Landed in this commit (replay base 4009cd9937014a2206e177da406933df3491d34a); gate 5/5 passed.
