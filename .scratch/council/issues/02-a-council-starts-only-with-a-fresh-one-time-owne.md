# 02: A council starts only with a fresh one-time owner grant

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** 01

**What to build:** Spec §2.1 dispatch, D-2026-11-25-02 (grant paragraph). `hud_create({role: "council"})` must consume a grant or refuse with `owner_grant_required` and a message that tells the caller to ask the owner (do not name the grant command in the refusal). Grant: one record under $HUD_HOME (private, atomic), single use, expires 30 minutes after creation, global (not keyed on a pane or session). Only owner actions create it: (1) a `/council` slash command in the Claude mod (integrations/claude-mod), marked not model-invocable, which writes the grant and submits the owner's following text to the session as the council request; (2) the same `/council` command in the HUD pi extension; (3) a panel action on Control → Roles when the council row is selected (key shown in the footer), for Codex and Antigravity sessions; (4) `hud council allow` CLI for the owner in a shell. A second grant while one is unused replaces it (no stacking). The grant is consumed only when the council's member jobs actually start; a refused or failed-before-start create leaves it. Record on the council receipt and archive row `grant: {via, created_at}`. Docs: reference (+zh) and the hud-delegate skill line (council needs the owner's /council; ask, never grant yourself).

- [ ] Without a grant, hud_create(council) refuses with owner_grant_required and starts nothing
- [ ] Each of the four owner paths creates a grant that lets exactly one council start; a second council needs a new grant; a grant older than 30 minutes is refused
- [ ] The Claude mod and pi /council commands cannot be invoked by the model (mod metadata / extension registration says so) and pass the owner's text as the request
- [ ] A create that fails before members start leaves the grant usable
- [ ] Receipt and archive carry grant {via, created_at}; targeted tests including claude plugin test for the mod

## Comments
