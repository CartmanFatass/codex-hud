---
name: hud-setup
description: Set up this project's HUD workers. Use when the user says "hud setup", "set up workers here", "configure workers for this project", "配置这个项目的 worker", "配置 worker" or "/hud-setup". Asks which roles are on, tunes pi workers only, writes `.hud/` through `hud setup --apply`, and reports the changes.
---

# Set up this project's workers

You ask. `hud setup` writes. Do not edit harness files, role files or `.hud/` by hand.

## 1. Detect

In the project, with Bash:

```sh
hud setup --detect
```

It prints one JSON document and writes nothing. Use `enabled_roles` as the default set. Each `skills[]` entry has `name`, `path`, `root` and `model_invocable`. `model_invocable: false` means the skill's frontmatter has `disable-model-invocation: true`: pi loads it but leaves it out of the model's skill list, so a worker will not pick it by itself. It can still be linked. If `pi.installed` is false, say so; show/hide still works, pi launches will not until `pi-role` is on PATH.

## 2. Ask

Use the client's question tool. In Claude Code, AskUserQuestion (multi-select where noted). Where there is no question tool, ask numbered plain questions and accept numbers or names.

1. Which roles are on here? Multi-select. Default: `enabled_roles`. Unchosen roles are hidden in this project. Every harness's roles can be shown or hidden; that is roster display only.
2. For each chosen pi role (`harness` is `pi`): keep it, or change `model`, `thinking` or `pi_role`, or "copy pi role X as new name". A new role is a copy of a pi role, then those changes. Do not ask this for other harnesses.
3. For each chosen pi role, including a copy: which skills? Multi-select from detect's `skills`. Mark manual-only ones (`model_invocable: false`) and say a worker will not pick them by itself. If the same name appears twice, ask which `path`.
4. Optional: a worker-only prompt per pi role (plain markdown), and `convention` `keep` (default) or `copy-default`.

When a chosen role has `harness` `cli`, tell the owner: if grok, agy or claude does not already trust this directory, run `hud trust <project.root>` yourself. Detect does not report trust. Do not read or edit trust files, and never run `hud trust`. Codex is not covered by that command.

## 3. Plan

Write only these fields to a temp file (`mktemp`). Do not put the plan in the repo. Show it in a few lines (roles, pi changes, skills, convention), then apply that file:

```sh
plan=$(mktemp)
hud setup --apply "$plan"
```

```json
{
  "version": 1,
  "roles": ["imp", "reviewer"],
  "pi_roles": {
    "imp": { "model": "example-model", "thinking": "high", "skills": ["to-tickets"] },
    "frontend": { "from": "imp", "pi_role": "implementer", "skills": ["to-tickets"] }
  },
  "skills": { "to-tickets": "/path/to/skills/to-tickets" },
  "agents": { "imp": "Worker-only notes.\n" },
  "convention": "keep"
}
```

- `roles`: every enabled name, including non-pi roles. Each name must be a reference or project role, or a new name in `pi_roles`.
- `pi_roles`: only pi roles the owner changed or copied. Omit one they kept. `from` is required for a new name and must be a pi reference role. `skills` entries must be keys of `skills`. Never put a non-pi role here. Do not set `split` or `can_continue` unless the owner named them.
- `skills`: name to detect's absolute `path`. Only names some pi role uses. The directory must contain `SKILL.md`. Names must match `[A-Za-z0-9._-]+` and not be `.` or `..`; otherwise leave the skill out and say so.
- `agents`: omit if there is no prompt. Pi roles only. Markdown text, not a path, at most 64 KiB.
- `convention`: `keep` or `copy-default` only. No other fields.

## 4. Report

Report the printed lines: `wrote`, `linked`, `removed`, `skipped (exists)`, `registered`, or `no changes`. Exit 1 means a file or link this command did not make was left in place. Exit 2 means the plan was invalid and nothing was written; fix the plan and apply again. Do not repair `.hud/` by hand.

`.hud/` is meant to be committed. A clone still ignores it until the owner runs setup or `--apply` there: registration lives in `$HUD_HOME/projects.json`, not in the repo.

## Rules

- Pi only for tuning. Never edit another harness's files.
- Never run `hud trust`. Never write `.hud/` except through `--apply`.
- Show or hide is allowed for every harness. Model, thinking, pi role, skills and worker prompts are not.
