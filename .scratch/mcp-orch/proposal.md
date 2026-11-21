# MCP-ORCH proposal (summary)

Source: oracle report of job j61e7649cba37181c (2026-11-21), accepted by the owner with every recommendation the
same day. Spec: `docs/spec.md` §2.1 and the MCP-ORCH milestone entry.

## Findings behind it

- One project day's main session (pi, about 500 turns): 22% of its tool calls were HUD calls, 71% its own bash,
  read and edit. Only about 3% of all calls were dispatch mechanics the HUD could absorb (shared-resource notices,
  relays between workers, one answer repeated to several jobs). Most of the session's cost was its own evidence
  reading in a large context: a routing matter (the convention now routes chores to sonic), not a mechanics matter.
- Moving mechanics into the MCP is still worth it: it removes failure modes (an unsupported thinking level surfacing
  as a startup timeout with the tab left open; a failed launch pinned to its request key), parameters the model must
  invent (idempotency keys), and per-harness text every session carries.
- Latency from report written to report read was a median of 20 s; chaining would have saved about 11 of 500 turns.
- Scanning every job directory costs about 3 ms, so scan cost does not justify a resident server.

## Decisions (owner, 2026-11-21)

- Do, in this order: launch facts (01); keys, repair, fan-out send, retry_of (02); standing brief and convention trim
  (03); leases (04); project scope and restart recovery (05); HUD-run checks (06, after 01); MCP tasks for Claude Code,
  verify first (07); coalesced settlement notices (08).
- Not now: plan execution or `after` chaining; a resident server (the on-demand watcher with short-lived helpers is
  enough); project notes (only if repeated answers remain after the standing brief).
- If chaining is ever wanted, the smallest form is a start condition on one job (`after: [jobs]`) that fires only
  when every predecessor has a declared settlement for its current turn, no open question, and passed checks bound
  to the same report signature; anything else wakes the main session.
