# 03: A council without a synthesizer argument is converged by the main session

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner decision D-2026-11-25-04 (spec §2.1 updated): council synthesis defaults to the main session, which converges the member plans and accepts the result; `pro` and Fable high stay selectable per call. Change the shipped `packages/hud-mcp/roles/council.json` `synthesizer` from `pro` to `main`, update `docs/reference.md` (the Council paragraph says synthesis defaults to `pro`), and adjust `tests/unit/thin-mcp-council.test.mjs`: tests that exercise browser synthesis (`shipped council runs three independent members and one browser synthesis`, `browser overflow fails plainly without sending`, `disabled council, browser switch ...`) must pass `synthesizer: 'pro'` explicitly or configure it, and add a test that a council with no synthesizer argument starts no synthesis job and `hud_read({job})` returns the member digests and synthesis instructions. The owner's `$HUD_HOME/roles/council.json` has no override today, so the shipped default applies.

- [x] Shipped council role file defaults synthesizer to `main`; reference.md says so.
- [x] Browser-synthesis tests pass with explicit `pro`; a new test covers the no-argument main default.
- [x] Land gate passes.

## Comments

- Landed in this commit (replay base 3d0ff1ebdc2dab9b21cf398bb71e36a898c3678a); gate 5/5 passed.
