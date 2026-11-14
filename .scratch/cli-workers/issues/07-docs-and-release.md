# 07: Docs and the 0.1.1 notes describe CLI workers

**What to build:** users can find out how to register a CLI role and what it does and does not do: the reference
(en and zh), the hud-mcp README, the hud-delegate skill's role list and options, and the shipped convention mention
CLI roles; `docs/spec.md` §2.1 carries the owner's 2026-11-13 decision (roles may run on interactive CLIs through
herdr; the HUD drives their lifecycle from herdr status; harness behaviour and session places untouched); release notes
for 0.1.1 list the feature. STATE.md's ledger has the CLI-WORKERS line.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** resolved

- [x] Docs describe today's behaviour only; synthetic examples
- [x] spec line added (owner-approved wording)
- [x] npm run check (or the repo's doc checks) green

## Comments

- 2026-11-14 orchestrator: resolved in cbe059a7 (0.1.1): reference en/zh, ARCHITECTURE, hud-delegate skill, docs/releases/0.1.1.md, spec §2.1 owner line.
