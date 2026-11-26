# 04: HUD launches CLI and pi tab workers through the fork and deletes the outside inference

**Status:** done
**Owner try:** no
**Blocked by:** 02, 03
**Objective:** herdr-fork

**What to build:** After main installs the fork (owner-confirmed): HUD detects the fork (version suffix `-hud` or a capability field) and, on it, launches CLI and pi tab workers with direct-exec `agent.start` (explicit env from HUD's own process env plus job variables; declared kind; on_exit close_on_zero), records the returned pid/pid_start_time and launch_id as the job's identity, judges exit from `pane.exited` exit_code, and matches tab events by launch_id. On stock herdr today's path stays. Then delete the fork-path uses of the witness shim, ZDOTDIR wrapper, startup shell snapshot, tab-shell verification, closedTabs reconciliation and most of reap-tab (plan: HUD side). Keep worker-tree for headless and detached descendants. Live check by main on the installed fork: one claude, one agy, one pi tab job start, report, and their tabs close; a crashed worker's tab stays readable.

- [x] On the fork, CLI and pi tab jobs start by direct exec with HUD-passed env; identity is the fork's pid + start; no shell in the worker tab
- [x] A finished job's tab closes by itself (clean exit); a crashed one stays readable until HUD's failure retention closes it
- [x] Tab events are matched by launch_id; a reused public tab ID never affects another job
- [x] On stock herdr the current path still works (test)
- [x] The listed inference code is deleted from the fork path; land gate passes; process-safety review before land

## Comments

- Landed in this commit (replay base dc11e8d8c6b42574f27be1b1de356a8809507826); gate 5/5 passed.

- 2026-11-25 main: landed 26350ad3 (flow f62da6fce5ec7a353; gate repair j59a9e822a81e6288 updated the cancel reap argv test for `--launch`). Reviews: docs/reviews/2026-11-25-herdr-fork-04-review.md. Live check on fork 0.9.5-hud.3027f8dd: claude, agy, pi start direct (parent herdr), PID/start match /proc, tab launch_id matches SESSION. First prompt stalled for all three (fork direct-exec skips the managed launch lifecycle; HUD took idle as ready) → herdr-fork/05, /06. After a manual Enter, claude and pi reported and their tabs closed on the first reap.
