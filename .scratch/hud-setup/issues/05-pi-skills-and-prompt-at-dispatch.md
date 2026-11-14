# 05: Pi workers get their role's skills and worker prompt

**What to build:** when `hud_create` dispatches a pi role from a registered project, each `skills` entry (a name under
`<root>/.hud/skills/`, or an absolute path) becomes `--skill <dir>` after pi-role's `--`, and an existing
`<root>/.hud/agents/<role>.md` becomes `--append-system-prompt <file>`. A broken link is skipped and named in the job's
record; it does not fail the launch. `hud_read` shows the skills and prompt file the job got. Other harnesses: no change.

**Blocked by:** 02

**Status:** resolved

- [x] pi argv carries `--skill` per skill and `--append-system-prompt` when the file exists
- [x] Loading check without a model call (`PI_ROLE_DEBUG=exit`) lists the skill and the role section survives
- [x] Broken link skipped and recorded
- [x] Real pi job by the orchestrator in a set-up project

## Comments

- 2026-11-14 orchestrator: resolved in fca81428 (0.1.2); recorded on the job as role_skills, skipped_skills, worker_prompt. Real run: a pi imp job in a set-up project loaded its skill and followed its worker prompt.
