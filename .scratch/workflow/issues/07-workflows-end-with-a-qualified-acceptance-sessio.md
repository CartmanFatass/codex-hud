# 07: Workflows end with a qualified acceptance session instead of waking main

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 05, 06

**What to build:** Spec §2.1 (D-2026-11-25-07): main is the owner's discussion session and is decoupled from runs. A `handback` step goes by default to a qualified acceptance session, not main: an `oracle` job on Claude Opus 5.5 at thinking high (same as the main session, owner 2026-11-25; ship an `opus` preset on `packages/hud-mcp/roles/oracle.json` running `cli/claude` `claude-opus-5-5` `high` and use it as the acceptance default; the owner's `$HUD_HOME/roles/oracle.json` already has this preset; a step or template may name another role/preset) receives the run's report refs, the declared choices and the acceptance criteria, decides one branch (finish / repair / continue) with reasons via its report, and its session is closed through herdr when it answers (normal HUD closure). It may escalate to main only for owner matters (scope, value trade-off, visible deletion, irreversible act) — an `escalate` choice that pauses the run and wakes main once. `to: "main"` stays available per step. The shipped ticket-queue template gains a closing acceptance step: after the last ticket lands, the acceptance session does the two-axis review (spec; simplicity/quality, per `docs/delegation.md` step 5) on the feature diff plus a live try where the brief says how, then finishes, or adds repair tickets and continues the queue (bounded: at most 2 repair rounds, then escalate). Main receives only the one end notice (with the acceptance verdict line) and escalations. The acceptance job runs outside the batch/role cap reservations like scouts; it is cheap-class unless its role is costly.

- [ ] A composed run with a default hand-back is answered by an oracle job (fake pi in tests) and continues without any main wake; `to: main` still wakes main.
- [ ] Ticket queue end-to-end (synthetic): tickets land, acceptance session runs, a repair round adds a ticket and continues, the second clean verdict finishes; main gets exactly one end notice; escalate wakes main once.
- [ ] reference.md and delegation.md describe the acceptance session.
- [ ] Land gate passes.

## Comments
