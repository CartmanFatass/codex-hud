# 03: `hud setup --detect`

**What to build:** `hud setup --detect [--cwd DIR]` prints the JSON of `.scratch/hud-setup/spec.md` §2: project root and
whether it is registered, pi-role found, reference roles (shipped + `$HUD_HOME`), project roles, enabled roles,
skills found under the skill roots (`$HUD_HOME/setup.json` `skill_roots`, default `~/.pi/agent/skills`,
`~/.claude/skills`, `~/.agents/skills`; a skill = directory with `SKILL.md`, name from frontmatter), the project's
worker skills per role, and broken links under `.hud/skills`. Read-only.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Output matches the spec shape; stable key order
- [ ] Writes nothing anywhere
- [ ] Unit tests on synthetic HOME/HUD_HOME/project
