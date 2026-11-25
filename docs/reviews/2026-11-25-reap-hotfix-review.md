# Risk review: pi-worker/08 (reused tab IDs) and pi-worker/10 (tab close with shell startup helpers) (2026-11-25)

Reviewer job j37458c824666f78b (astra high). Brief: tmp/tasks/review-reap-hotfix/brief.md. Commits: 6414fee6 (/08, base 67ad815a), f42f5e9e (/10, base 602cc810).

Verdict: changes-required — fix first.

## Blocking

1. **/10: age is not ownership.** `src/runtime/tab-shell.ts:64–84` exempts every active background session member with `shellStart <= start < workerStart`; `src/runtime/reap-tab.ts:228–229` then closes the tab. A background command the owner started in the right-hand split before the left-hand worker started falls in that interval and stays active through the reap; closing the tab destroys the owner's terminal and hangs up that job. Require positive evidence of the exempt startup instances (PID + start captured during a startup phase not open to owner commands), or leave the tab open.
2. **/08: a delayed close can still fail the replacement job.** `src/runtime/watch.ts:88–95`, `src/runtime/watch-runtime.ts:98–102,147–155`. Herdr closes A; its notification waits in the watcher's socket while dispatch creates B with the same ID and writes B's receipt; the watcher then reads A's line and stamps it after B's launch (ordinary buffering, not clock skew). A fresh Pi without a PID can get `failed / tab closed` at `watch-runtime.ts:783–795`; for CLI, `watch-runtime.ts:721–725` and `src/mcp/cli-judge.ts:217–223` let the close decide even with a live worker. The tests wait for A's failure before publishing B and so exclude this ordering. Treat the event as a wake-up: confirm the recorded target is gone, recheck that the receipt is still current before publishing, leave a present or unqueryable target alone. Test A's event delivered after B is recorded with B's pane present, then a real close of B.

## Simplicity

/10's nested settle loops, `settled` flag and repeated `tree-owner`/refuse exits (`reap-tab.ts:175–227`) can be one deadline-controlled retry path with fresh pane inspection after each wait. The stderr path stripping (`watch-runtime.ts:505–516`) needn't `realpathSync` on successful reaps. If /08 confirms disappearance on a close hint, drop the wall-clock/SESSION-mtime plumbing rather than keep two clocks as ownership evidence.

## Other answers

- Worker children started while the worker ran (`start >= workerStart`) still block the close. Neither patch signals by name or by the helper cutoff. Recycled shell/tab IDs still have to pass launch env, PID/start, exe/inode, session, pane-set and label checks; the pre-existing last-check/action race remains (observations, not an atomic conditional kill or close).
- Owner reuse of the original shell (typing at the prompt, shell builtins) leaves no different process identity; an unchanged shell receipt is not evidence nobody took the tab over. Protecting that needs owner-interaction evidence, not a process-name test.
- The owner's real zsh case (helpers +10 and +78 ticks, worker +180) closes under /10, but not every such tab is guaranteed to close (persistent post-start helpers, helpers herdr lists in the foreground group, missing worker evidence). The real-zsh test uses pipes and a fake herdr foreground inventory. Exhausted retries can stay open across hot reload (`/10 watch-runtime.ts:413–423,905–908,1109`).
- Reverse ordering: B created, really closed, and the close received before dispatch samples the launch clock (`/08 harness-pi.ts:197–207`, `harness-cli.ts:167–174`) is filtered out; no replay cursor across socket resubscribe (`watch.ts:37–44,84–95,136–144`). Further reasons to reconcile disappearance rather than rely on event delivery.
- No textual conflict between the two commits.

Follow-up: both returned to their implementers (jdb704e2592502bb4; j06cafbb08c34dfa3 continuing j3ae25f16798ee115). Root cause shared with D-2026-11-25-09 (herdr fork).
