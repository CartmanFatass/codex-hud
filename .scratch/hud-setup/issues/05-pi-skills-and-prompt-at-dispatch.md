# 05: Pi workers get their role's skills and worker prompt

**What to build:** when `hud_create` dispatches a pi role from a registered project, each `skills` entry (a name under
`<root>/.hud/skills/`, or an absolute path) becomes `--skill <dir>` after pi-role's `--`, and an existing
`<root>/.hud/agents/<role>.md` becomes `--append-system-prompt <file>`. A broken link is skipped and named in the job's
record; it does not fail the launch. `hud_read` shows the skills and prompt file the job got. Other harnesses: no change.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] pi argv carries `--skill` per skill and `--append-system-prompt` when the file exists
- [ ] Loading check without a model call (`PI_ROLE_DEBUG=exit`) lists the skill and the role section survives
- [ ] Broken link skipped and recorded
- [ ] Real pi job by the orchestrator in a set-up project
