# 10: Investigate repair: resolve the project from the captured pane's cwd

**Status:** ready-for-agent
**Live try:** In a herdr worktree workspace for repo A, cd an ordinary shell pane into repo B (with a working job in B), choose "Investigate this" on that pane: the picker offers B's job and not A's, and the delivered excerpt and card name B as the source.
**Blocked by:** none
**Repairs:** fine-interact/02

**What to build:** Milestone review je170bf58fc15643b finding 1 (/home/fires/.hud/jobs/je170bf58fc15643b/report.md). The herdr pane menu (fork commit eb2552af, `src/client/shell/context_menu.rs:492-511`) passes the clicked pane id as `focused_pane_id`; `handleInvestigatePaneAction` (`src/roles/select-send.ts` ~933-954) copies it to `pane_id`. In `resolveSelectionTarget` (~512-521) `clickedOtherPane` is then false, so `ctx.worktree.checkout_path` (workspace repo A) wins over the clicked pane's own cwd (repo B), and `jobTargets.get(projectRoot)` offers only A's jobs: with only a B worker the picker says none; with an A worker the owner can send B's output labelled as A. Fix project resolution for Investigate (ctx.mode === 'investigate') on ordinary (non-worker) panes: use the captured pane's foreground_cwd, then cwd (from live pane info, falling back to the context's focused_pane_cwd for that pane), resolved through sharedRoot; use the workspace checkout / workspace_cwd only as fallback. Keep worker-receipt resolution (matchedJob path), text-selection mode's current order and the capture-once rule unchanged. No fork change is needed. Optional cleanup the review noted: remove `WorkerPi.sendUserMessage?` from `src/harness/pi/worker/host.ts:76` if it has no worker caller left (keep the main-session interface's API).

- [ ] Investigate on an ordinary pane whose cwd is repo B inside a repo-A worktree workspace resolves source.projectRoot to B and offers B's working jobs only
- [ ] A two-repository fixture using the real menu context shape (clicked id as focused_pane_id and pane_id, both pane cwd and workspace worktree present) asserts B's job is offered, A's is absent, and the delivered source and excerpt card identify B
- [ ] Workspace checkout is used only when the captured pane has no known cwd (fixture)
- [ ] Worker-receipt resolution, text-selection mode resolution and capture-once behaviour unchanged (existing select-send tests pass)
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
