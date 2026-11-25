# 04: Land runs as a sealed land step of the workflow engine

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/workflow/spec.md` slice 4. Add the `land` step kind wrapping today's land helper whole (lease, train, gate + flaky rerun, ticket record, base moves, ff, after, push, cleanup are never split into replayable steps); the engine owns the record header, wake, stop intent, notices and the 2-repair bound. Ship `land.toml`; `hud_land` is a shim. Keep `f<job>[-n]` ids, `LandFlow` fields, `landNotice` text, gate log sidecars, attempt ids, `readJobFlow`/`collectLandWork` readers, and the never-replay rule. Replace the per-tick parse of every retained flow receipt (`landEvents`) with the engine's active-run scan.

- [x] The six `thin-mcp-land*` suites pass unchanged.
- [x] Kill tests: runner killed during gate and during repair; recovery neither replays publish nor loses the result.
- [x] Land gate passes.

## Comments

- 2026-11-25 main: scope (owner, D-2026-11-25-08): the engine ships only batch, prewalk, council and land templates; tickets 05-07 are deferred. workflow/02, 03 and 04 are built in parallel on the landed engine (4dbb54ab) and each adds a step kind: keep step-kind registration additive so the lands compose. Run the focused tests once at the end; the full gate is the land's job. Land is the critical path: the land helper stays whole and never-replay holds; the existing ticket queue keeps calling land through the `hud_land` shim (05 deferred).

- Landed in this commit (replay base 9a37797ba319f18ffe84d6e0581299a96f0188e8); gate 5/5 passed.
