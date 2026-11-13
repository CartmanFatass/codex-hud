# 03: CLI workers can ask the orchestrator, and a stuck CLI asks for the owner

**What to build:** a CLI worker asks a question by running the HUD's `hud-ask` command (named by absolute path in
the brief instructions). The question lands in the job's `qa/` in pi-roles' exact format, the orchestrator pane gets
pi-roles' one-line QUESTION notice, `hud_read` lists it, `hud_respond` answers it and the waiting command prints the
answer to the worker; with no answer in 20 minutes it prints the default and the worker carries on and records the
open question in its report. When herdr reports the CLI `blocked` mid-turn (an approval or question UI the bypass flag
did not cover), the panel shows the job as needing the owner and the orchestrator pane gets one line naming the job
and pane; once the CLI works again the job is `working`.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Question round trip with hud_respond, covered by a test (fake herdr for the notice)
- [ ] Timeout path prints the default
- [ ] blocked mid-turn → needs-owner on the card and one notice line; back to working afterwards
- [ ] The implementer instruction file tells the worker how to ask (and never to wait on a terminal prompt)
