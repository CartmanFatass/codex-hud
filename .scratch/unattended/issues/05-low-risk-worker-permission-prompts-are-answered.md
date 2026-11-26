# 05: Low-risk worker permission prompts are answered automatically; the rest go to main with a recommendation

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none (main session verifies with a synthetic prompt in a scratch pane)
**Blocked by:** none

**What to build:** Owner 2026-11-26: a frontend-imp Claude pane stopped on a native permission prompt (rm of files in its own scratchpad with an unquoted variable path). HUD reported 'claude needs input in its pane' and the prompt waited for the owner. Such prompts are a typical unattended case: low-risk ones must be answered without the owner. When the watcher sees a worker (CLI or pi) waiting on a client permission prompt, HUD reads the prompt from the pane and classifies it. Low risk = the command or edit touches only the job's own worktree, task dir, scratchpad or a temp dir, is reversible or regenerable, and involves no network write, secrets, git push, install, or paths outside those roots. Low risk: HUD selects the approve option in the pane (herdr pane send-keys) and records the prompt, the decision and the reason on the job (one line in the inspector/timeline). Not low risk or unsure: the prompt goes to the main session (or the run's lead) as a job notice with the prompt text, HUD's recommendation and the exact answer action; the owner sees it only if main escalates. The classifier is the configured decision model with a fixed rule prompt and structured output (approve / hand to main, reason); without a decision model only the deterministic path check applies and everything else goes to main. Never auto-deny on the owner's behalf except a client's own timeout. Applies whether or not the unattended service is switched on (it answers for the worker, not for the owner).

- [ ] A synthetic pane showing a Claude Code permission prompt for `rm -f $S/*.png` where S is the job scratchpad is approved automatically within one watcher pass; the job record shows the prompt, decision and reason.
- [ ] A prompt for a command outside the job roots (e.g. writing ~/.local/bin, git push, curl POST) is not answered; main gets a notice with the prompt text, a recommendation and the answer action, and answering it presses the chosen option once.
- [ ] Decision-model failure or timeout falls back to the deterministic path check; anything it cannot prove low-risk goes to main.
- [ ] Each pane prompt is answered at most once (idempotent across watcher restarts); a prompt that disappears before the answer is recorded as gone, not answered.
- [ ] Bar and panel stop showing an auto-answered prompt as owner load; prompts handed to main are shown as main load, not owner load.
- [ ] Docs: docs/reference.md and ARCHITECTURE describe the rule, the roots and the record; synthetic fixtures only.

## Comments
