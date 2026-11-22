# 01: A review runs on a different provider than the work

**Status:** wontfix
**Blocked by:** none
**Owner try:** no

**What to build:** Spec §2.1.2 "Cross-provider review" (22.22). Owner 2026-11-22: the implementing model and the reviewing model should not come from the same company. On `hud_create` for `reviewer` (or `oracle`) with `from_jobs`:
- Read each reviewed job's provider from its `used_place` (pi model prefix, or the CLI agent: claude → anthropic, agy → google, codex → openai).
- Pick the first available place in the role's run list, presets included, whose provider is in none of them.
- If no place qualifies, avoid the provider of most of the reviewed work.
- Explicit `on`, `preset` or `model` skips the rule.

Record `review_avoid: {providers, chosen, reason}` in job.json, and show it in the create result and `hud_read`. Add a Claude place to the shipped reviewer role's run list (e.g. `claude-opus-5-5` high) after the Gemini and OpenAI ones, so a GPT-plus-Gemini batch has a third provider. Document it in docs/reference.md and docs/reference.zh.md.

- [ ] Reviewing sol-fast jobs picks the Gemini place; reviewing hydrogen jobs picks the OpenAI place; reviewing a mix picks Claude
- [ ] Explicit preset or on wins; no qualifying place falls back with a reason
- [ ] Targeted roster/create tests pass

## Comments

- Owner 2026-11-22, same day: milestone reviews cover mixed implementers anyway, so drop the cross-provider rule. The reviewer runs on astra max by default instead (set in the owner's ~/.hud/roles/reviewer.json, active preset `max`, with neon xhigh as fallback).
