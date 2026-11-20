# Pi asynchronous HUD work

Within `docs/spec.md` §1, match the Claude Code `Monitor` + `hud watch` experience for HUD events: dispatch without occupying the caller until completion, surface actionable events without typing, and read/answer explicitly. Pi need not expose a generic command monitor or switch the event transport to MCP push. A running tool need not be preempted. A notice is not a result read, a user instruction, or a new authorization.

Three owner-requested slices: 01 main-session monitor; 02 ask the orchestrator and keep working; 03 start sonic and collect later. 01 is in MyHUD. 02 and the worker-facing part of 03 belong to Fishpref/pi-roles, not a vendored copy or the installed runtime. Do not modify Claude/Codex behavior. Use isolated worktrees and temp homes; do not install, switch live versions, or merge to shared branches during this effort.
