# 01: A role runs on any harness it has instructions for

**What to build:** feature spec items 1–4 and 6: role file `instructions` + `run`, legacy pi role files read
unchanged, `hud_create` `on` with the harness default table (`$HUD_HOME/harnesses.json` override), CLI instruction
file chosen by the role (implementer.md, new read-only reviewer.md), `unsupported_harness`, `hud_roster` per-role
`run` and `runs_on`. Delete the four `*-imp` CLI role files; update hud-delegate skill, reference (en/zh),
docs/releases/0.1.4.md, existing tests that named them.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 250 source lines

**Blocked by:** PROJECT-HUB 02 (it edits the collector's control-plane reads)

**Status:** ready-for-agent

- [ ] `hud_create(role: "imp", on: "agy")` starts agy with the table's model; `model` override still wins
- [ ] `on` a CLI for sonic → `unsupported_harness`; reviewer on a CLI gets reviewer.md
- [ ] Old pi role files and `$HUD_HOME/roles` files load unchanged; the four `*-imp` names are gone
- [ ] Roster shows `run` and `runs_on`; tests with a fake herdr, no real model calls
- [ ] One real `imp on agy` and one `reviewer on claude` job by the orchestrator, recorded below
