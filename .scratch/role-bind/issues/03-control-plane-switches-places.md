# 03: The control plane page switches where each role runs

**What to build:** feature spec item 7 on the Control plane page from PROJECT-HUB 01: groups (roles, browser tasks,
harnesses), each role's place, fallbacks and exhausted marks; keys to cycle harness/model/thinking of the primary,
add/remove/reorder fallbacks and clear a mark, written through 02; EN/ZH, 40/80/120 columns; help and reference.

**Who:** frontend-implementer · **Size:** about 300 source lines, frames regenerated

**Blocked by:** 02, PROJECT-HUB 03

**Status:** resolved

- [x] Each role appears once with its place and fallbacks; browser tasks apart; harness availability visible
- [x] A switch made in the panel is what the next `hud_create` uses (test through real input and the roster)
- [x] Enter/`o` still opens the role's source file

## Comments
- 2026-11-14 (orchestrator): landed 19333df8 (480/480). Keys on a role row of the Control plane: p/P harness, m/M
  model, e/E thinking, + add fallback, - remove, K/J reorder, x clear exhausted mark, Enter/o open the file in force.
  A project `.hud/roles` file in force refuses edits. Model lists still come from the static catalog (ROLE-BIND 04).
