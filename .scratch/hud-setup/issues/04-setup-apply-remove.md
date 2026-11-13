# 04: `hud setup --apply PLAN` and `--remove`

**What to build:** `hud setup --apply PLAN.json [--cwd DIR]` writes a project's `.hud/` from a plan:
`{ "version": 1, "roles": [names enabled], "pi_roles": { "<name>": { "from"?: "<reference role>", "pi_role"?,
"model"?, "thinking"?, "split"?, "can_continue"?, "skills"?: [names] } }, "skills": { "<name>": "/abs/skill/dir" },
"agents": { "<role>": "<markdown>" }, "convention": "keep" | "copy-default" }`. It writes `.hud/project.json`
(roles, links it made), `.hud/roles/<name>.json` only where the role differs from its reference, symlinks
`.hud/skills/<name>` → dir, `.hud/agents/<role>.md`, optionally `.hud/hud-convention.md` from the shipped one, and
registers the root in `$HUD_HOME/projects.json`. Prints what changed; the same plan again changes nothing. Never
replaces a file or link it did not make (reports and skips). `--remove` drops the registration only and leaves `.hud/`.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Plan validated before any write; invalid plan writes nothing
- [ ] Idempotent; foreign files/links never replaced
- [ ] After apply, `--detect` and `hud_roster` show the plan's roles
- [ ] Unit tests on synthetic dirs
