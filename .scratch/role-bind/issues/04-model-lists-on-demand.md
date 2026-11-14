# 04: Model lists come from the harnesses, the catalog is the fallback

**Why:** owner 2026-11-14 asked how the selectable models are obtained. Today they are a hand-kept list
(`packages/hud-mcp/catalog.json` + `$HUD_HOME/harnesses.json` `catalog`), which goes stale.

**What to build:** `placeCatalog` models for pi, agy and grok come from the harness's own list command
(`pi --list-models`, `agy models`, `grok models`), run only when the Control plane page opens or on its refresh key,
never on the refresh tick, bounded (timeout, output cap, no shell), cached under `$HUD_HOME/display` for about a
day. claude and codex keep the catalog list (no list command). A failed or missing command falls back to the
catalog silently. The owner can type a model name on a role row (one-line input); a typed model is saved in the role
and offered again. Model ids only: never read or show credentials or provider config beyond the id.

**Who:** imp (agy) for discovery + cache; the one-line input on the Control plane by frontend-implementer if the
input pattern is not already there · **Size:** about 150 source lines

**Blocked by:** 03 (landed 19333df8)

**Status:** resolved (picker follow-up in PROJECT-UX phase 2)

- [ ] pi/agy/grok lists come from the harness, cached a day; claude/codex from the catalog; failure → catalog
- [ ] No list command runs on a normal refresh (test counts spawns)
- [ ] A typed model is written to the role and shows in the cycle next time

## Comments
- 2026-11-14 (orchestrator): landed f2c17e05 (493/493): discovery for pi/agy/grok with a one-day cache, catalog
  fallback, `r` refresh on the Control plane, typed models from role files join the list. The typed-input box was
  not built (no input pattern existed).
- 2026-11-14 owner: cycling ~170 pi models is unusable. Model choice becomes a provider → model picker with
  filtering; curated by default to arena (all), mistral (deepseek), anthropic (opus), openai (gpt-6 series), newest
  per family only, dated snapshots and old lines (o1…) hidden; include list overridable in
  `$HUD_HOME/harnesses.json` `catalog.pi.include`; a show-all toggle; the role's current model always shown. Built in
  PROJECT-UX phase 2 (frontend-implementer) together with the Control plane rework.
