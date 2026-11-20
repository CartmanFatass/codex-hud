# 01: Delegate work and collect the result without redundant context or calls

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Implement the [lean delegation journey](../spec.md) as one change to the model-facing HUD interface. The unit of delivery is a caller getting a usable result, not a shorter roster, a shorter read or a smaller tool list in isolation. Keep the default path actionable and make optional detail discoverable.

## Acceptance: demonstrate the journey

- [ ] From cold context in a synthetic project with a live event channel, an agent can select an available role, create a job idempotently, continue working, then explicitly read the delivered report: roster → create → read, without a poll or diagnostic lookup. On repeat with valid context: create → read. The report-ready notice itself does not consume the report.
- [ ] Exercise deviations from that same journey: a changed convention is not silently skipped; a matching caller-supplied version avoids its repeated body; unavailable roles and failed dispatches explain why; a worker question includes what is needed to answer it directly. Ordinary working reads omit empty launch diagnostics. None of these paths discards session changes or hides necessary worktree handoff data.
- [ ] A caller inspecting rather than collecting gets useful status/progress without a pane fetch or read-close side effect. Explicit pane lines and rich role/job detail remain obtainable. Without a monitor the existing wait path works. Collecting, rereading and closing retain their distinct semantics.
- [ ] Report the before/after call sequence and UTF-8 byte measurements for the journey with the same fixture, listing tool declarations separately from replies. Reduce repeated `hud_create` schema prose while keeping advanced options discoverable, safeguards intact and pi/MCP schemas in sync. Migrate in-tree diagnostic consumers and shipped guidance where needed. Use targeted isolated checks; no production deployment.

## Comments

One implementation and one end-to-end acceptance. The former three command-oriented tickets are superseded; they are not independent deliverables or an execution queue.
