# 01: Only `general` takes model overrides on create

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Spec §2.1.2 and §2.1.4 (22.22). Owner 2026-11-22: role files are the single source of where a role runs; the orchestrator should not pick models, and `general` stays the one flexible seat. In `hud_create` (single, batch `jobs`, and `retry_of` overrides), reject `preset`, `on`, `model` and `thinking` for every role except `general`, before anything launches. The error says, in one line, that the role runs as its role file and Control set it, and that a one-job model goes through `general`. `retry_of` without overrides still reuses the original job's place options as today. Internal callers keep their own paths: imp routing (auto-route/03), land repairs, scout's sonic and overflow to `general` must not go through the rejected caller fields.

Update the `hud_create` tool description in `src/roles/tool-definitions.ts` ("Omit preset, on, model and thinking unless the user requests them") to say only `general` accepts them, and the matching lines in `hud_roster` detail text if it advertises per-job overrides for other roles. Document it in docs/reference.md and docs/reference.zh.md. Owner-side choices in the panel (Control preset switch, role files) are unchanged.

- [ ] `hud_create({role:"imp", preset:"astra"})` and `{role:"reviewer", model:...}` fail with the one-line error and create no job; batch items fail per item
- [ ] `hud_create({role:"general", model:..., thinking:...})` works as today
- [ ] Imp routing, land repair and overflow paths still apply their own place; targeted create/roster tests pass

## Comments
