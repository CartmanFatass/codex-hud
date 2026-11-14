# 01: A role is the work; it runs on its first available place

**What to build:** feature spec items 1–6, 8, 9: role files with `instructions` and an ordered `run` list (old files
load unchanged), harness `jev` renamed `bro` (old files saying `jev` still load), `oracle` with three browser places
and `flow` with `kind`, dispatch on the first available place, quota/rate-limit failure marks the place exhausted for
an hour (stored under `$HUD_HOME`, read by roster and panel), `on` with the harness default table, CLI instructions
chosen by role (implementer.md, new read-only reviewer.md), `unsupported_harness`, roster fields `run`, `runs_on`,
`exhausted`. Delete the role files of item 8; update hud-delegate skill, reference (en/zh),
docs/releases/0.1.4.md and the tests that named them.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 350 source lines

**Blocked by:** PROJECT-HUB 02 (it edits the collector's control-plane reads)

**Status:** ready-for-agent

- [ ] `imp` with places [pi sol, agy hydrogen]: pi missing → agy is used; exhausted pi → agy; the failure text names it
- [ ] `hud_create(role: "imp", on: "agy")` uses the table's model; `model` still wins
- [ ] oracle's places reach jev-ask / jev-aistudio; flow `kind: video` reaches jev-flow video
- [ ] Old role files (incl. `harness: "jev"`) and `$HUD_HOME/roles` files load; deleted names are gone
- [ ] Tests with a fake herdr and fake tools, no real model calls
- [ ] Real runs by the orchestrator: `imp` on agy, `reviewer` on claude, an oracle question; recorded below
