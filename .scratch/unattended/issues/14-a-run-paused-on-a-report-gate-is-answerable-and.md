# 14: A run paused on a report gate is answerable and reaches its decider

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Two runs on 2026-11-26 paused on report gates and nobody could resume them: toktrack q8bce6bb52855af24 (`imp-daily/01: report has 4 Assumed: lines (limit 3)`, handback_to main, paused 21:36Z, main never woken) and MyHUD q4d41eea7199f2815 (`ticket-store/03: report has a Blockers: line`, handback_to lead, paused 00:02Z, no lead dispatched). Both had `state: paused` and a `handback {choices: [resume, stop], kind: assumption|blocker}`, but `steps.tickets.state` was `failed`, not `asking`, so `answerTicketQueueHandback` (src/mcp/ticket-queue.ts ~343) returned `no_pending_handback (paused for assumption|blocker)`. Main had to start a superseding run with `hud_tickets run`, which also dropped the in-flight ticket-store/06 land from the new run's jobs list. Same refusal for a lead escalation: workflow qbc31fee0742a97e8 paused `escalate` with choices [resume, stop] returned `no_pending_handback (paused for escalate)` (2026-11-27). Fix: a report-gate pause (assumption limit, Blockers line, scope assumption) or a lead escalation leaves the step `asking` so `hud_respond resume|stop` works; with handback_to lead the lead is dispatched for it, with handback_to main main gets the wake notice (unattended/06 path); restarting a run carries in-flight lands.

- [x] Test: a run paused for an over-limit Assumed count accepts `hud_respond {job: q..., answer: "resume"}` and continues to land that item
- [x] Test: same for a Blockers-line pause and a scope-assumption pause
- [x] Test: handback_to lead dispatches a lead for a report-gate pause; handback_to main emits the main wake notice
- [x] Test: `hud_tickets run` superseding a paused run keeps an in-flight land of the old run in the new run's jobs
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 21d49f2c7082b509a8035c703ac3783cebc961b1); gate 5/5 passed.
