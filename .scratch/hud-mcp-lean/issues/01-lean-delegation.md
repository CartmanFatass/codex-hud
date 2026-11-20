# 01: Delegate work and collect the result without redundant context or calls

**Status:** implemented and fixture-verified on private branch; live TUI try pending
**Blocked by:** none

**What to build:** Implement the [lean delegation journey](../spec.md) as one change to the model-facing HUD interface. The unit of delivery is a caller getting a usable result, not a shorter roster, a shorter read or a smaller tool list in isolation. Keep the default path actionable and make optional detail discoverable.

## Acceptance: demonstrate the journey

- [x] From cold context in a synthetic project with a live event channel, an agent can select an available role, create a job idempotently, continue working, then explicitly read the delivered report: roster → create → read, without a poll or diagnostic lookup. On repeat with valid context: create → read. The report-ready notice itself does not consume the report.
- [x] Exercise deviations from that same journey: a changed convention is not silently skipped; a matching caller-supplied version avoids its repeated body; unavailable roles and failed dispatches explain why; a worker question includes what is needed to answer it directly. Ordinary working reads omit empty launch diagnostics. None of these paths discards session changes or hides necessary worktree handoff data.
- [x] A caller inspecting rather than collecting gets useful status/progress without a pane fetch or read-close side effect. Explicit pane lines and rich role/job detail remain obtainable. Without a monitor the existing wait path works. Collecting, rereading and closing retain their distinct semantics.
- [x] Report the before/after call sequence and UTF-8 byte measurements for the journey with the same fixture, listing tool declarations separately from replies. Reduce repeated `hud_create` schema prose while keeping advanced options discoverable, safeguards intact and pi/MCP schemas in sync. Migrate in-tree diagnostic consumers and shipped guidance where needed. Use targeted isolated checks; no production deployment.

## Comments

One implementation and one end-to-end acceptance. The former three command-oriented tickets are superseded.

Offline evidence: the synthetic main pi host delegates twice to `imp` via the real HUD extension and stdio MCP, with a fake worker launcher. Create acknowledges startup before a report exists; the native notice leaves it unread until collection. Cold: roster/create/read; warm: create/read; zero monitor polls. The implementer's cold+warm measured reply total went from 19,235 B to 4,926 B (baseline path strings were longer, and baseline repeat follows the former roster guidance). An independent run under `/tmp` measured 4,169 B cold + 581 B warm, 80 B for a quiet single-job read, and 4,872 B of schemas, down from 5,912 B. In isolated temporary homes both builds and all 208 tests across the six affected suites passed. No installed TUI, live provider, deployment, or merge to the shared branch was exercised.
