# 10: Hotfix: finished job tabs close again when the owner's shell runs startup helpers

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** pi-worker

**What to build:** Observed 2026-11-25: since pi-worker/03 landed (a34ee9fb, watcher reload 20:06:59Z) no finished job tab closes; every reap in `~/.hud/watch.log` ends `exit=1` and `hud-reap` says `original shell identity or idle foreground unverified; not closing` (`src/runtime/reap-tab.ts:172-174`). Cause: `confirmIdleShells` (`src/runtime/tab-shell.ts:46-50`) refuses when any active process other than the shell is in the shell's session. The owner's zsh (powerlevel10k) starts helpers in that session at shell startup: `gitstatusd` and two zsh async workers reparented to the session's subreaper. Real case, job j6daafb3598870be7, shell 2675221 start 3338768: helpers started at 3338778 and 3338846, the agent (pi 2676358) at 3338948; a later prompt helper is a zombie. Fix the rule, not by name: session members that started before the worker's recorded start (pi STATUS `pid_start_time`, CLI witness `start`) are shell startup, not worker leftovers, and do not block the close; anything started after the worker started that is still active still refuses (a background job the worker left). Decide and test what happens to prompt helpers the shell spawns after the worker exits (p10k redraws the prompt): they must not block forever, and must not open a hole for a worker's own background child (which starts while the worker runs). Never match by process name. Tests use a real zsh with an rc that starts a daemon at startup and a helper per prompt (precmd), like p10k (pi-worker/07 lesson: no bare-shell fixtures). Also make the watcher log carry the reaper's refusal reason (today stderr is lost and the log only says exit=1). Process-killing code: extra review before land.

- [ ] A finished pi job and a finished CLI job in a real zsh tab whose rc starts a background daemon and per-prompt helpers are reaped and their tab closes
- [ ] A background process started by the worker while it ran still blocks the close
- [ ] No process is matched by name; identity stays exact PID + start ticks
- [ ] watch.log shows the reaper's refusal reason on exit 1
- [ ] Land gate passes after a separate review

## Comments
