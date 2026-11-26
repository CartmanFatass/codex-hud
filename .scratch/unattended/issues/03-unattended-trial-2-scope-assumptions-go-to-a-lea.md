# 03: Unattended trial 2: scope assumptions go to a lead; unattended runs can be cancelled

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** unattended

**What to build:** Main's second live trial 2026-11-26 (~/projects/hud-unattended-trial, run q9a4a94e1712eecb8). (1) A correct job (jd12cabdcb50ccc21) wrote `Assumed: scope — the requested wording replaces the old greeting text without removing the greeting feature.` and the assumption breaker held it for the owner. Workers label assumptions `scope` freely, so under the unattended escalation rule (owner hand-back only for visible deletion or spec change) a scope-tagged assumption, or more than three assumptions, goes to a temporary one-decision lead that answers continue (the item lands) or hold (with a reason that names deletion/spec, else repair); only the lead's deletion/spec verdict becomes an owner hold. Runs whose hand-back goes to main keep today's breaker. (2) There is no way to cancel an unattended run: `hud_tickets run cancel` filters unattended receipts out (src/mcp/ticket-queue.ts:59-60) and `cancelTicketQueue` only stops `working` runs, so main had to edit two paused receipts by hand. Add `hud unattended cancel <run>` (and accept it from main's `hud_tickets run cancel` with the run id) that cancels a working or paused run without signalling any process, leaves its holds and evidence visible, and frees the Objective for a new run. (3) `hud_tickets add` folds `what` into one line, so a `**Live try:**` written there is not on its own line; when `what` contains a `Live try:` field and no `live_try` is given, move it to the field line.

- [ ] Tests: scope-tagged assumption under unattended rule -> temporary lead -> continue lands; lead deletion/spec verdict -> owner hold; >3 assumptions same path; main-handback runs unchanged
- [ ] Tests: cancel a paused and a working unattended run: state cancelled, no signal, holds stay, the Objective can start a new run
- [ ] Live try: main reruns the synthetic trial and the clean ticket lands without an owner hold

## Comments
