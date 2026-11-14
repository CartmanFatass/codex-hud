# 02: A set-up project's own roles, hidden roles and convention

**What to build:** a project the owner set up is recorded in `$HUD_HOME/projects.json`
(`{ "version": 1, "projects": [{ "root": "/abs", "registered_at": "..." }] }`). For a registered project (root = git
top level of the cwd, else the cwd, realpath), `roleRegistry` also reads `<root>/.hud/roles/*.json` after
`$HUD_HOME/roles` (project wins by name); project role files must be `harness: "pi"` (others are invalid, as in 01).
When `<root>/.hud/project.json` lists `roles`, only those roles exist for that project. The convention lookup puts
`<root>/.hud/hud-convention.md` first. `hud_create` resolves against the job's `cwd`; `hud_roster` takes an optional
`cwd` (default: the server's cwd). An unregistered directory's `.hud/` is ignored and `hud_roster` says
`project_config_ignored: <root>`. The Project tab shows the same roster as `hud_roster` for its project.

**Blocked by:** 01

**Status:** resolved

- [x] Registered project: project roles added/overriding, unlisted roles hidden, project convention used
- [x] Unregistered project with `.hud/`: nothing from it loads; roster says so
- [x] Non-pi project role file is invalid, not loaded
- [x] Unit tests on synthetic HUD_HOME and project dirs

## Comments

- 2026-11-14 orchestrator: resolved in fca81428 (0.1.2). Tests: tests/unit/project-roles.test.mjs.
