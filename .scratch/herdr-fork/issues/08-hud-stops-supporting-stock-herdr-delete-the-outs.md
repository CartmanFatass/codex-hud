# 08: HUD stops supporting stock herdr: delete the outside-inference path

**Status:** done
**Owner try:** no
**Blocked by:** herdr-fork/07
**Objective:** herdr-fork

**What to build:** Spec §1 (25.09): HUD stops inferring what the fork provides once the fork provides it. With fork 0.9.5-hud.76b187b0 installed, remove the stock-herdr launch and reap path: `src/runtime/cli-invocation.ts` (shim, ZDOTDIR wrapper, witness, startup shell snapshot), `src/runtime/tab-shell.ts`, `src/runtime/tab-owner.ts`, the hud-cli exec-witness in `packages/hud-mcp/bin/hud-cli.mjs`, `retryBusyPane`/`HUD_TAB_LAUNCH`, stock branches of `reap-tab.ts`, stock close reconciliation in `watch-runtime.ts`/`watch.ts`/`cli-supervisor.ts`, and the `isHudHerdrFork` branches that choose them. Keep `src/roles/worker-tree.ts` (headless and detached descendants), `cli-kinds.ts`, `cli-judge.ts`. When the running herdr is not the fork (ping version lacks `-hud`), dispatch fails with one clear error naming the required fork, and `hud doctor` reports it; no fallback. The milestone review j5521aa747dd52730 lists what is safe to delete; follow its list.

- [x] git grep finds no ZDOTDIR wrapper, exec-witness, tab-shell or HUD_TAB_LAUNCH in src/, packages/, integrations/
- [x] Against a fake stock herdr (version without -hud) hud_create returns one error naming the fork and hud doctor reports it; against the fake fork all dispatch tests pass
- [x] Live: one claude, one agy and one pi tab job on the installed fork start, report and close

## Comments

## Comments

- 2026-11-26 main: the milestone review (docs/reviews/2026-11-26-worker-stage-milestone.md, "Deletion boundary") narrows this ticket. Keep `tab-shell.ts`, `tab-owner.ts` and the stock reaper/close reconciliation: browser jobs (`harness-bro.ts`, `browser-runner.ts`) and the split Pi helper shell still use them. Delete only what the review's Delete list names. Starts after the review-fix job lands (it touches `reap-tab.ts`).

- Landed in this commit (replay base 87e748b73492a11b77108fdc0dfcd0fb47acbdf4); gate 5/5 passed.
