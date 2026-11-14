# 01: A role is the work; it runs on its first available place

**What to build:** feature spec items 1–6, 8, 9: role files with `instructions` and an ordered `run` list (old files
load unchanged), harness `jev` renamed `bro` (old files saying `jev` still load), `oracle` with three browser places
and `flow` with `kind`, dispatch on the first available place, quota/rate-limit failure marks the place exhausted for
an hour (stored under `$HUD_HOME`, read by roster and panel), `on` with the harness default table, CLI instructions
chosen by role (implementer.md, new read-only reviewer.md), `unsupported_harness`, roster fields `run`, `runs_on`,
`exhausted`. Delete the role files of item 8; update hud-delegate skill, reference (en/zh),
docs/releases/0.1.4.md and the tests that named them.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 350 source lines

**Blocked by:** none (PROJECT-HUB 02 landed)

**Status:** resolved

- [x] `imp` with places [pi sol, agy hydrogen]: pi missing → agy is used; exhausted pi → agy; the failure text names it
- [x] `hud_create(role: "imp", on: "agy")` uses the table's model; `model` still wins
- [x] oracle's places reach jev-ask / jev-aistudio; flow `kind: video` reaches jev-flow video
- [x] Old role files (incl. `harness: "jev"`) and `$HUD_HOME/roles` files load; deleted names are gone
- [x] Tests with a fake herdr and fake tools, no real model calls
- [ ] Real runs by the orchestrator: `imp` on agy, `reviewer` on claude, an oracle question; recorded below

## Comments

- 2026-11-14 orchestrator: first agy session (j2341a54f3f7c0e5d) was quit mid-test by the supervisor bug (cli-workers 09);
  a second agy session (jba3c4d2596162ff8) finished it. Landed as 5b0d5b37. Orchestrator changes: shipped `imp` and
  `reviewer` run on pi only (fallbacks are the owner's, under `$HUD_HOME/roles`), agy's shipped default is
  gemini-4-argon-high; tests adjusted. Full suite green (527), release rehearsal passes. Real runs wait for every
  client's hud MCP to reconnect: older servers read the new role files as invalid.
