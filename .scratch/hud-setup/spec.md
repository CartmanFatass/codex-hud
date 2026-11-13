# hud setup: feature spec

Status: **approved by the owner, 2026-11-13** (docs/spec.md §2.1, §2.3, §5 carry it).


Owner direction (2026-11-13):

- **What it is.** A `hud setup` that deploys workers per project, asked like claude-hud's setup. The shipped roles are an extensible reference set.
- **How it is split.** A skill asks the questions; a non-interactive command writes the config.
- **Pi only.** Customisation is done on pi workers only (pi is open and easy to tailor). Main sessions and the official harnesses (Claude Code, Codex, Grok Build, Antigravity) keep their behaviour. Nothing here changes them unless the owner asks.
- **Skills.** Harnesses already load the skills in their own directories on demand. What setup controls is which skills each pi worker gets.

## 1. Shape

- **`hud setup` is non-interactive and testable.**
  - `hud setup --detect [--cwd DIR]` prints one JSON document: the reference roles, the skills found, and what the project has now.
  - `hud setup --apply PLAN.json [--cwd DIR]` writes the project config the plan describes and prints what changed. Applying the same plan twice changes nothing the second time.
  - `hud setup --remove [--cwd DIR]` drops the project's registration (§5) and leaves `.hud/` alone.
- **The `hud-setup` skill does the asking.**
  - It ships next to hud-delegate and is installed the same way.
  - It runs `--detect` and asks the owner with the client's question tool.
  - It writes `PLAN.json` to a temp file and shows it in a few lines.
  - It then runs `--apply` and reports.
- **No TTY wizard.**

## 2. What detect reports

```json
{
  "project": { "root": "/abs/project", "registered": true, "hud_dir": "/abs/project/.hud" },
  "pi": { "pi_role": "/abs/bin/pi-role", "installed": true },
  "reference_roles": [ { "role": "imp", "harness": "pi", "pi_role": "implementer", "model": "...", "thinking": "high", "source": "shipped" } ],
  "project_roles": [ { "role": "frontend", "harness": "pi", "source": ".hud/roles/frontend.json" } ],
  "enabled_roles": ["imp", "reviewer", "sonic", "frontend"],
  "skills": [ { "name": "to-tickets", "path": "/abs/skills/to-tickets" } ],
  "worker_skills": { "imp": ["to-tickets"] }
}
```

- **Project root:** the git top level of `--cwd`, else `--cwd` itself.
- **Skill roots** are listed in `$HUD_HOME/setup.json` as `skill_roots`, which the owner edits.
  - The default is `~/.pi/agent/skills`, `~/.claude/skills` and `~/.agents/skills`. These are read only, to find candidates.
  - A skill is a directory that holds a `SKILL.md`. Its name comes from the frontmatter.

## 3. What setup asks

1. **Workers.** Which roles are on in this project. Multi-select; the default is the current set.
   - Roles not chosen are hidden from this project's roster.
   - Every harness's roles can be shown or hidden, because that is roster display only.
2. **Pi worker tuning.** For each chosen pi role: keep it, or change the model, thinking or pi role.
   - A new role is made as "copy pi role X as name Y, then change".
3. **Worker skills.** For each pi role, which skills it loads.
4. **Worker prompt and convention** (optional).
   - A worker-only prompt file per pi role, `.hud/agents/<role>.md`.
   - Whether the project gets its own `hud-convention.md`, starting from the shipped one.

The harness trust step is left out. `hud trust <dir>` (0.1.1) stays a separate command the owner runs when a CLI role needs it.

## 4. What apply writes

Everything goes under the project's `.hud/`, which is meant to be committed:

```
.hud/
  project.json          { "version": 1, "roles": ["imp", "reviewer", "sonic", "frontend"] }
  roles/frontend.json   { "role": "frontend", "harness": "pi", "pi_role": "implementer", "model": "...",
                          "split": false, "can_continue": true, "skills": ["to-tickets"] }
  roles/imp.json        written only when it differs from the reference role
  skills/to-tickets  -> /abs/skills/to-tickets      (symlink; workers only)
  agents/frontend.md    optional worker-only prompt
  hud-convention.md     optional
```

- **`.hud/skills/` holds symlinks to the chosen skill directories.** Only workers read it, through `--skill`; main sessions never look there.
- **Apply manages only the links it made.** It records them in `project.json` (`"links": [...]`) and touches no others.
- **A broken link** (the source skill was moved) is reported by detect and skipped at dispatch.

## 5. Code changes

1. **Roster by project.**
   - Where it looks:
     - `roleRegistry` reads `<root>/.hud/roles` after `$HUD_HOME/roles`; the project wins by name.
     - The root comes from the job's `cwd` for `hud_create` and from the server's cwd for `hud_roster`.
   - What the project can change:
     - When `project.json` lists `roles`, only those exist for that project; the rest are hidden.
     - The convention lookup adds `<root>/.hud/hud-convention.md`.
2. **Bad files do not break the MCP.**
   - A role file that fails validation is skipped and listed in `hud_roster` as `invalid` with its path.
   - Today it throws `invalid_role` for every tool.
3. **Role `skills` (pi only).**
   - Each name resolves to `<root>/.hud/skills/<name>`, or the entry is an absolute path.
   - Each one becomes `--skill <dir>` after pi-role's `--`.
   - Other harnesses: a role file of another harness that names `skills` is invalid (§5.2 lists it).
4. **Role prompt (pi only).** When `.hud/agents/<role>.md` exists, it is passed to pi as `--append-system-prompt <file>`.
5. **The `hud setup` command** (`src/cli/setup.ts`) and the `hud-setup` skill, which install and uninstall register like hud-delegate.

## 6. Safety

The threat model guards against running commands from an untrusted repository.

- **Why this matters here.** A cloned repo can ship `.hud/` too, with role files, skill links and prompts.
- **The gate.** Project config loads only for a project the owner set up.
  - `hud setup --apply` records the root in `$HUD_HOME/projects.json`.
  - A `.hud/` in any other directory is ignored, and `hud_roster` says so.
  - A committed `.hud/` therefore comes to life on a new clone only after the owner runs setup (or `--apply`) there.

## 7. Spec impact (the owner decides)

- **§2:** a new item 4, "Set up a project's workers in one conversation (pi workers; other harnesses only shown or hidden)".
- **§2.1:**
  - Roles come from shipped files, `$HUD_HOME` and a registered project's `.hud/roles`.
  - Pi role files may name skills and a worker prompt.
- **§2.3:** install also registers the hud-setup skill.
- **Standing rule (owner, 2026-11-13):** customisation goes on pi. Other harnesses are not changed without an explicit ask.
- **§5:** not M4 (frozen). Proposed as **0.1.2**.

## 8. Answered (owner, 2026-11-13)

1. Unchosen roles are hidden.
2. Worker skills are symlinks, kept under `.hud/skills/`. Main-session skills are not managed: harnesses already load their own directories on demand.
3. `.hud/` is committed.
4. Main sessions keep their behaviour; pi workers are the pilot.
5. Pi only. Other harnesses are not adapted further.

## 9. Slices (after approval, via to-tickets)

1. Roster skips bad files (§5.2), alone and first.
2. Project roles, the `projects.json` gate, hiding and the convention lookup (§5.1, §6).
3. `hud setup --detect`.
4. `--apply` and `--remove`, for roles, `project.json` and skill links.
5. Pi role `skills` and `.hud/agents` at dispatch (§5.3, §5.4).
6. The `hud-setup` skill, install registration, docs and 0.1.2 notes.
