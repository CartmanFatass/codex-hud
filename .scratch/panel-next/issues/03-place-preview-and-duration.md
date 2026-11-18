# 03: Control plane shows the selected place in full; Inspector shows how long a job ran

**Status:** done (ee4bc94f)
**Blocked by:** none

**What to build:** Architect, 2026-11-17: let the owner check a preset without cycling it or opening a JSON file; and
(orchestrator's item kept) show a job's run time where its endpoints are known.

- [ ] Control plane: below the compact role list, the row under the cursor is shown in full: role, harness, model,
      thinking, and whether it is the place the next job uses, a fallback, or exhausted (with until). Long ids wrap,
      never cut. Data from the existing `ControlFacts`; no model-list command on cursor movement.
- [ ] Inspector: a `ran` fact (`12m`, `1h05m`) from started → ended for a settled job, started → now for a running
      one; absent when either endpoint is unknown. No cost and no lane totals.
- [ ] Main-path frame tests: one role with a fallback and an exhausted place; one settled and one running job.

## Comments
