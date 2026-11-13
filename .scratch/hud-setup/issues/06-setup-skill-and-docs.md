# 06: The `hud-setup` skill, install and docs

**What to build:** `integrations/skills/hud-setup/SKILL.md`: runs `hud setup --detect`, asks the owner the questions of
spec §3 with the client's question tool (multi-select for roles and skills), writes the plan to a temp file, shows it
in a few lines, runs `--apply`, reports. Install and uninstall handle it exactly like hud-delegate. Docs: reference
(en/zh), hud-mcp README, `docs/releases/0.1.2.md`; spec stays as the owner wrote it.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] Skill installed/removed with hud-delegate's mechanism (tests)
- [ ] Docs describe today's behaviour; synthetic examples
- [ ] Owner runs `/hud-setup` in a real project
