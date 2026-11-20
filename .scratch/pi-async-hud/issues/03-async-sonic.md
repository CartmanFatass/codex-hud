# 03: Start sonic, keep working, then collect its result

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** For eligible standalone pi roles, provide a nonblocking helper start and separate result collection. For HUD pi workers, expose native worker tools for the existing HUD sonic start/collect backend rather than requiring handwritten shell or replacing the scheduler. Preserve compatibility for other harnesses.

- [ ] Starting returns a scoped handle without waiting for the report; parent work can continue. Nonblocking collection distinguishes pending, ready, and failed without rerunning the child.
- [ ] The parent gets a native report-ready/failure notice without editor input or automatic collection; collection returns the existing result/artifact. Preserve parent settlement, cancellation, role eligibility, parent-child ownership, and existing concurrency limits in each mode.
- [ ] Exercise pending and ready collection and invalid scope in isolated tests; document the two modes and the legacy interface.

## Comments

No functional dependency on 02, but both touch pi-roles dispatch/lifecycle: schedule sequentially on the combined private branch to avoid conflicting lifecycle changes. Never use the live Fishpref checkout.
