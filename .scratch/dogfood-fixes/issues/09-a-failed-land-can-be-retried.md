# 09: A failed land can be retried

**Status:** ready-for-agent
**Blocked by:** flows/02

**What to build:** Found 2026-11-22: the first live hud_land (FLOWS-04, flow fc83df390e83e1029) failed gate[3] on the known statusline-agy.test.mjs:192 flake under load 18–22. Calling hud_land again for the same job returned the stored failed flow at once (land.ts `if (prior) return prior`), so a failed land can never be retried and the caller gets a stale failure that looks like a fresh one. A second hud_land on a job whose flow is terminal and not landed starts a new run (the old record is kept or archived, not silently replaced); an active or landed flow is still returned as is. Also: when a gate test command fails, rerun only the failing test files once before calling it a failure or starting a repair; a rerun pass is recorded in the flow as a flake with the test names, not a failure.

- [ ] hud_land after a failed or cancelled flow starts a fresh run; after an active or landed flow returns it
- [ ] A gate test failure that passes on a rerun of the failing files lands and names the flaky tests in the notice
- [ ] npm test and check:fixtures pass

## Comments
