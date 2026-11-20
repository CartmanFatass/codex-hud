# 03: Keep eight verbs, shorten declarations and make pane output opt-in

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Keep the differences between inspect, consume, reply, continue and close explicit. Remove repetitive schema prose, chiefly on `hud_create`, and keep noisy pane diagnostics on demand. This ticket is not a rewrite of success receipts. Do not replace tools with `hud(action=...)` or remove advanced overrides.

- [ ] Required fields, validation, idempotency, unsafe-retry warnings, caller-owned model/permission decisions, typed overrides and advanced discoverability survive; both clients expose matching schemas. Record before/after serialized UTF-8 sizes for the eight schemas and create alone, distinct from reply sizes.
- [ ] Do not change create/send/respond/close receipt shapes, failure diagnostics, idempotency or `changes` for this ticket. The package-level byte targets are measurement guidance, not authorization for additional contract changes.
- [ ] `hud_peek(job)` gives status and useful latest progress without fetching a pane by default. Explicit `lines` still returns recent bounded output and unavailability reason. Neither path marks a report read or closes a worker.
- [ ] Guidance describes 3 calls on first monitored dispatch / 2 on repeated same-project dispatch / zero wait polling with active native delivery. Explicit wait is still supported. Use synthetic tests; do not force count/byte limits on failures, actionable content or reports.

## Comments

Scheduled after 02 to avoid overlapping edits; no functional dependency. No generic shell, changes to Monitor or additions to the CLI command tree.
