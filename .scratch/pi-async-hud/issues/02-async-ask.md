# 02: Ask the orchestrator without occupying the worker

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** none

**What to build:** A pi worker on the HUD role path can post a question and receive its ID without waiting for the decision. Keep the existing synchronous path available for genuine dependencies. Do not change the separate managed protocol or CLI workers.

- [ ] The asynchronous tool returns after publication; the worker can do unrelated work while the orchestrator answers through existing `hud_respond`.
- [ ] An answer wakes or informs only its originating live worker as a native, non-user event; it cannot be delivered twice to that worker, overwrite a draft, or reopen a stopped/replaced session.
- [ ] An outstanding decision is not mistaken for completion or permission to use its default. Preserve bounded timeout, stop/abort and reporting semantics; dependency-blocked work must not silently proceed.
- [ ] Test publication, answering during other work and settlement/cleanup with synthetic jobs; document both modes.

## Comments

Implementation belongs in the isolated Fishpref worktree. Coordinate lifecycle edits with 03; no change to real pi settings or deployed bundles.
