# 04: Land runs as a sealed land step of the workflow engine

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/workflow/spec.md` slice 4. Add the `land` step kind wrapping today's land helper whole (lease, train, gate + flaky rerun, ticket record, base moves, ff, after, push, cleanup are never split into replayable steps); the engine owns the record header, wake, stop intent, notices and the 2-repair bound. Ship `land.toml`; `hud_land` is a shim. Keep `f<job>[-n]` ids, `LandFlow` fields, `landNotice` text, gate log sidecars, attempt ids, `readJobFlow`/`collectLandWork` readers, and the never-replay rule. Replace the per-tick parse of every retained flow receipt (`landEvents`) with the engine's active-run scan.

- [ ] The six `thin-mcp-land*` suites pass unchanged.
- [ ] Kill tests: runner killed during gate and during repair; recovery neither replays publish nor loses the result.
- [ ] Land gate passes.

## Comments
